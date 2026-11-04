use std::ffi::c_void;
use std::mem::{align_of, size_of};
use std::ptr;
use std::slice;
use std::sync::atomic::{AtomicI32, AtomicPtr, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};

use barochart_ffi::{
    BC_FLAG_LOSSLESS, BcBuf, BcEngine, BcF64Buf, BcHost, BcStatus, bc_buf_free, bc_buf_new_copy,
    bc_call, bc_engine_free, bc_engine_new, bc_f64_buf_free, bc_memory_stats, bc_packet,
    bc_read_f64, bc_supports, bc_write_f64,
};

const ZONE_OK: usize = 0;
const ZONE_FAIL: usize = 1;
const ZONE_FAIL_WITH_BUFFER: usize = 2;
const ZONE_BAD_UTF8: usize = 3;
const ZONE_TOO_LONG: usize = 4;
const ZONE_REENTER: usize = 5;
const ZONE_BLOCK: usize = 6;
const ZONE_FREE: usize = 7;
const LOG_REENTER: usize = 8;
const LOG_FREE: usize = 9;
const RELEASE_REENTER: usize = 10;
const ZONE_FORGED_EMPTY: usize = 11;
const ZONE_FORGED_DANGLING_EMPTY: usize = 12;
const ZONE_EMPTY: usize = 13;

static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn serial() -> MutexGuard<'static, ()> {
    TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct HostContext {
    engine: AtomicPtr<BcEngine>,
    mode: AtomicUsize,
    release_count: AtomicUsize,
    zone_count: AtomicUsize,
    log_count: AtomicUsize,
    log_message: Mutex<Vec<u8>>,
    nested_status: AtomicI32,
    latch: (Mutex<(bool, bool)>, Condvar),
}

impl HostContext {
    fn new() -> Self {
        Self {
            engine: AtomicPtr::new(ptr::null_mut()),
            mode: AtomicUsize::new(ZONE_OK),
            release_count: AtomicUsize::new(0),
            zone_count: AtomicUsize::new(0),
            log_count: AtomicUsize::new(0),
            log_message: Mutex::new(Vec::new()),
            nested_status: AtomicI32::new(-1),
            latch: (Mutex::new((false, false)), Condvar::new()),
        }
    }
}

unsafe fn context<'a>(raw: *mut c_void) -> &'a HostContext {
    // SAFETY: 테스트는 엔진보다 HostContext를 길게 유지한다.
    unsafe { &*raw.cast::<HostContext>() }
}

unsafe extern "C" fn zone_resolve(
    raw: *mut c_void,
    _name: *const u8,
    _len: usize,
    out: *mut BcBuf,
) -> i32 {
    // SAFETY: BcHost 계약으로 받은 context와 out이다.
    let host = unsafe { context(raw) };
    host.zone_count.fetch_add(1, Ordering::SeqCst);
    let mode = host.mode.load(Ordering::SeqCst);
    if mode == ZONE_BLOCK {
        let (lock, changed) = &host.latch;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.0 = true;
        changed.notify_all();
        while !state.1 {
            state = changed
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
    if mode == ZONE_REENTER {
        let mut nested = BcBuf::default();
        let status = unsafe {
            bc_call(
                host.engine.load(Ordering::SeqCst),
                b"nativeInit".as_ptr(),
                b"nativeInit".len(),
                b"[]".as_ptr(),
                2,
                0,
                &mut nested,
            )
        };
        host.nested_status.store(status as i32, Ordering::SeqCst);
        unsafe { bc_buf_free(nested) };
    }
    if mode == ZONE_FREE {
        let engine = host.engine.load(Ordering::SeqCst);
        unsafe { bc_engine_free(engine) };
        let mut nested = BcBuf::default();
        let status = unsafe {
            bc_call(
                engine,
                b"nativeInit".as_ptr(),
                b"nativeInit".len(),
                b"[]".as_ptr(),
                2,
                0,
                &mut nested,
            )
        };
        host.nested_status.store(status as i32, Ordering::SeqCst);
        unsafe { bc_buf_free(nested) };
    }
    let bytes: &[u8] = match mode {
        ZONE_BAD_UTF8 => &[0xff],
        ZONE_TOO_LONG => &[b'x'; 129],
        _ => b"UTC",
    };
    if mode == ZONE_FAIL {
        return 17;
    }
    if mode == ZONE_EMPTY {
        return 0;
    }
    if mode == ZONE_FORGED_EMPTY {
        // SAFETY: callback 출력은 writable이다. NULL/nonzero 구조를 Rust가 역참조하지 않고 거부해야 한다.
        unsafe {
            out.write(BcBuf {
                ptr: ptr::null_mut(),
                len: 1,
                cap: 1,
            })
        };
        return 0;
    }
    if mode == ZONE_FORGED_DANGLING_EMPTY {
        // SAFETY: 구조적으로 틀린 dangling empty를 Rust가 allocator에 반환하지 않아야 한다.
        unsafe {
            out.write(BcBuf {
                ptr: ptr::dangling_mut(),
                len: 0,
                cap: 0,
            })
        };
        return 0;
    }
    let status = unsafe { bc_buf_new_copy(bytes.as_ptr(), bytes.len(), out) };
    assert_eq!(status, BcStatus::BC_OK);
    if mode == ZONE_FAIL_WITH_BUFFER { 18 } else { 0 }
}

unsafe extern "C" fn zone_offset(
    _raw: *mut c_void,
    _zone: *const u8,
    _len: usize,
    _epoch_ms: f64,
    out: *mut i32,
) -> i32 {
    if !out.is_null() {
        // SAFETY: 호출자가 유효한 i32 출력을 넘긴다.
        unsafe { *out = 0 };
    }
    0
}

unsafe extern "C" fn log_message(raw: *mut c_void, _level: i32, message: *const u8, len: usize) {
    // SAFETY: BcHost 계약으로 받은 context다.
    let host = unsafe { context(raw) };
    host.log_count.fetch_add(1, Ordering::SeqCst);
    let copy = if len == 0 {
        Vec::new()
    } else {
        // SAFETY: log 입력은 callback 중 len 바이트 유효하다.
        unsafe { slice::from_raw_parts(message, len) }.to_vec()
    };
    *host
        .log_message
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = copy;
    if host.mode.load(Ordering::SeqCst) == LOG_REENTER {
        let mut nested = BcBuf::default();
        let status = unsafe {
            bc_call(
                host.engine.load(Ordering::SeqCst),
                b"nativeInit".as_ptr(),
                b"nativeInit".len(),
                b"[]".as_ptr(),
                2,
                0,
                &mut nested,
            )
        };
        host.nested_status.store(status as i32, Ordering::SeqCst);
        unsafe { bc_buf_free(nested) };
    }
    if host.mode.load(Ordering::SeqCst) == LOG_FREE {
        let engine = host.engine.load(Ordering::SeqCst);
        unsafe { bc_engine_free(engine) };
        let mut nested = BcBuf::default();
        let status = unsafe {
            bc_call(
                engine,
                b"nativeInit".as_ptr(),
                b"nativeInit".len(),
                b"[]".as_ptr(),
                2,
                0,
                &mut nested,
            )
        };
        host.nested_status.store(status as i32, Ordering::SeqCst);
        unsafe { bc_buf_free(nested) };
    }
}

unsafe extern "C" fn release(raw: *mut c_void) {
    // SAFETY: BcHost 계약으로 받은 context다.
    let host = unsafe { context(raw) };
    host.release_count.fetch_add(1, Ordering::SeqCst);
    if host.mode.load(Ordering::SeqCst) == RELEASE_REENTER {
        unsafe { bc_engine_free(host.engine.load(Ordering::SeqCst)) };
    }
}

fn callbacks(host: &mut HostContext) -> BcHost {
    BcHost {
        context: ptr::from_mut(host).cast(),
        zone_resolve: Some(zone_resolve),
        zone_offset_seconds: Some(zone_offset),
        log: Some(log_message),
        release: Some(release),
    }
}

unsafe fn new_engine(host: &mut HostContext) -> *mut BcEngine {
    let raw = callbacks(host);
    let mut engine = ptr::null_mut();
    let mut error = BcBuf::default();
    let status = unsafe { bc_engine_new(&raw, &mut engine, &mut error) };
    assert_eq!(status, BcStatus::BC_OK);
    assert!(!engine.is_null());
    assert!(error.ptr.is_null());
    assert_eq!((error.len, error.cap), (0, 0));
    host.engine.store(engine, Ordering::SeqCst);
    engine
}

unsafe fn bytes_and_free(buf: BcBuf) -> Vec<u8> {
    let bytes = if buf.len == 0 {
        assert!(buf.ptr.is_null());
        Vec::new()
    } else {
        assert!(!buf.ptr.is_null());
        // SAFETY: Rust 소유 BcBuf를 해제하기 전에 복사한다.
        unsafe { slice::from_raw_parts(buf.ptr, buf.len) }.to_vec()
    };
    unsafe { bc_buf_free(buf) };
    bytes
}

unsafe fn call(engine: *mut BcEngine, name: &[u8], args: &[u8], flags: u32) -> (BcStatus, Vec<u8>) {
    let mut out = BcBuf::default();
    let status = unsafe {
        bc_call(
            engine,
            name.as_ptr(),
            name.len(),
            args.as_ptr(),
            args.len(),
            flags,
            &mut out,
        )
    };
    (status, unsafe { bytes_and_free(out) })
}

unsafe fn memory_stats(engine: *mut BcEngine) -> (BcStatus, String) {
    let mut out = BcBuf::default();
    let status = unsafe { bc_memory_stats(engine, &mut out) };
    let bytes = unsafe { bytes_and_free(out) };
    (status, String::from_utf8(bytes).expect("stats UTF-8"))
}

#[test]
fn status_values_and_layout_are_stable() {
    let _guard = serial();
    assert_eq!(BcStatus::BC_OK as i32, 0);
    assert_eq!(BcStatus::BC_THROW as i32, 1);
    assert_eq!(BcStatus::BC_UNAVAILABLE as i32, 2);
    assert_eq!(BcStatus::BC_CLOSED as i32, 3);
    assert_eq!(BcStatus::BC_POISONED as i32, 4);
    assert_eq!(BcStatus::BC_BUSY as i32, 5);
    assert_eq!(BcStatus::BC_INVALID as i32, 6);
    assert_eq!(BC_FLAG_LOSSLESS, 1);
    assert_eq!(size_of::<f64>(), 8);
    assert_eq!(align_of::<BcF64Buf>(), align_of::<usize>());
}

#[test]
fn construction_transfers_host_only_on_success_and_release_is_once() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let raw = callbacks(&mut host);
    let invalid = BcHost {
        zone_resolve: None,
        ..raw
    };
    let mut engine = ptr::dangling_mut::<BcEngine>();
    let mut error = BcBuf {
        ptr: ptr::dangling_mut::<u8>(),
        len: 1,
        cap: 1,
    };
    assert_eq!(
        unsafe { bc_engine_new(&invalid, &mut engine, &mut error) },
        BcStatus::BC_INVALID
    );
    assert!(engine.is_null());
    assert_eq!((error.ptr, error.len, error.cap), (ptr::null_mut(), 0, 0));
    assert_eq!(host.release_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        unsafe { bc_engine_new(&raw, ptr::null_mut(), &mut error) },
        BcStatus::BC_INVALID
    );
    assert_eq!(host.release_count.load(Ordering::SeqCst), 0);
    engine = ptr::dangling_mut();
    assert_eq!(
        unsafe { bc_engine_new(&raw, &mut engine, ptr::null_mut()) },
        BcStatus::BC_INVALID
    );
    assert!(engine.is_null());
    assert_eq!(host.release_count.load(Ordering::SeqCst), 0);
    engine = ptr::dangling_mut();
    assert_eq!(
        unsafe { bc_engine_new(ptr::null(), &mut engine, &mut error) },
        BcStatus::BC_INVALID
    );
    assert!(engine.is_null());
    assert_eq!(host.release_count.load(Ordering::SeqCst), 0);

    let engine = unsafe { new_engine(&mut host) };
    let mut pending = BcBuf::default();
    let status = unsafe {
        bc_call(
            engine,
            b"missing".as_ptr(),
            7,
            b"[]".as_ptr(),
            2,
            0,
            &mut pending,
        )
    };
    assert_eq!(status, BcStatus::BC_UNAVAILABLE);
    assert!(!pending.ptr.is_null());
    host.mode.store(RELEASE_REENTER, Ordering::SeqCst);
    unsafe { bc_engine_free(engine) };
    assert_eq!(host.release_count.load(Ordering::SeqCst), 1);
    assert!(!unsafe { bytes_and_free(pending) }.is_empty());
    assert!(!unsafe { bc_supports(engine, b"nativeInit".as_ptr(), 10) });
    let (status, out) = unsafe { call(engine, b"nativeInit", b"[]", 0) };
    assert_eq!(status, BcStatus::BC_CLOSED);
    assert_eq!(out, br#"{"name":"Error","message":"Chart disposed"}"#);
    unsafe { bc_engine_free(engine) };
    assert_eq!(host.release_count.load(Ordering::SeqCst), 1);
    unsafe { bc_engine_free(ptr::null_mut()) };
    assert_eq!(host.release_count.load(Ordering::SeqCst), 1);
}

#[test]
fn monotonic_tokens_prevent_aba_and_forged_tokens_are_never_dereferenced() {
    let _guard = serial();
    let (status, out) = unsafe { call(ptr::null_mut(), b"nativeInit", b"[]", 0) };
    assert_eq!(status, BcStatus::BC_INVALID);
    assert!(out.is_empty());
    let mut first_host = Box::new(HostContext::new());
    let first = unsafe { new_engine(&mut first_host) };
    assert_eq!(first.addr() & 7, 0);
    unsafe { bc_engine_free(first) };

    let mut second_host = Box::new(HostContext::new());
    let second = unsafe { new_engine(&mut second_host) };
    assert_ne!(first.addr(), second.addr());
    let (status, _) = unsafe { call(first, b"nativeInit", b"[]", 0) };
    assert_eq!(status, BcStatus::BC_CLOSED);
    let (status, out) = unsafe { call(first, b"\xff", b"[", u32::MAX) };
    assert_eq!(status, BcStatus::BC_CLOSED);
    assert_eq!(out, br#"{"name":"Error","message":"Chart disposed"}"#);
    let (status, out) = unsafe { call(second, b"nativeInit", b"[]", 0) };
    assert_eq!(
        (status, out.as_slice()),
        (BcStatus::BC_OK, b"100000".as_slice())
    );
    let (status, stats) = unsafe { memory_stats(second) };
    assert_eq!(status, BcStatus::BC_OK);
    assert!(stats.contains("\"liveEngines\":1"), "{stats}");

    for forged in [
        ptr::without_provenance_mut::<BcEngine>(1),
        ptr::without_provenance_mut::<BcEngine>(usize::MAX & !7),
    ] {
        let (status, out) = unsafe { call(forged, b"nativeInit", b"[]", 0) };
        assert_eq!(status, BcStatus::BC_CLOSED);
        assert_eq!(out, br#"{"name":"Error","message":"Chart disposed"}"#);
        assert!(!unsafe { bc_supports(forged, b"nativeInit".as_ptr(), 10) });
        unsafe { bc_engine_free(forged) };
    }
    unsafe { bc_engine_free(second) };
    assert_eq!(first_host.release_count.load(Ordering::SeqCst), 1);
    assert_eq!(second_host.release_count.load(Ordering::SeqCst), 1);
}

#[test]
fn call_validates_transport_flags_and_preserves_number_mode() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine(&mut host) };

    let (status, out) = unsafe { call(engine, b"nativeInit", b"[42]", 0) };
    assert_eq!(
        (status, out.as_slice()),
        (BcStatus::BC_OK, b"42".as_slice())
    );
    let (status, out) = unsafe { call(engine, b"missing", b"[]", BC_FLAG_LOSSLESS) };
    assert_eq!(status, BcStatus::BC_UNAVAILABLE);
    assert_eq!(
        out,
        br#"{"name":"UnavailableError","message":"missing is not available in the Rust backend","code":null}"#
    );

    for flags in [2, 3, u32::MAX] {
        let (status, out) = unsafe { call(engine, b"nativeInit", b"[42]", flags) };
        assert_eq!(status, BcStatus::BC_INVALID);
        assert!(out.is_empty());
    }
    for (name, args) in [
        (&b"\xff"[..], &b"[]"[..]),
        (&b"nativeInit"[..], &b"["[..]),
        (&b"nativeInit"[..], &b"{}"[..]),
    ] {
        let (status, out) = unsafe { call(engine, name, args, 0) };
        assert_eq!(status, BcStatus::BC_INVALID);
        assert!(out.is_empty());
    }
    let mut out = BcBuf {
        ptr: ptr::dangling_mut::<u8>(),
        len: 1,
        cap: 1,
    };
    assert_eq!(
        unsafe { bc_call(engine, ptr::null(), 1, b"[]".as_ptr(), 2, 0, &mut out) },
        BcStatus::BC_INVALID
    );
    assert_eq!((out.ptr, out.len, out.cap), (ptr::null_mut(), 0, 0));

    let (status, out) = unsafe {
        call(
            engine,
            b"__bcEchoForTest",
            b"[NaN,-0,Infinity,-Infinity,undefined]",
            BC_FLAG_LOSSLESS,
        )
    };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(out, b"[NaN,-0,Infinity,-Infinity,undefined]");
    let (status, out) = unsafe { call(engine, b"nativeInit", b"[NaN,false]", BC_FLAG_LOSSLESS) };
    assert_eq!(status, BcStatus::BC_THROW);
    assert_eq!(
        out,
        br#"{"name":"TypeError","message":"Chart options object","code":null}"#
    );
    let (status, out) = unsafe { call(engine, b"__bcErrorCodeForTest", b"[]", BC_FLAG_LOSSLESS) };
    assert_eq!(status, BcStatus::BC_THROW);
    assert_eq!(
        out,
        br#"{"name":"IngestionError","message":"debug failure","code":"TEST"}"#
    );

    let (status, out) = unsafe { call(engine, b"__bcEchoForTest", b"[5.9604644775390625e-8]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    let power_expected: &[u8] = if cfg!(target_os = "android") {
        b"[5.9604644775390625e-8]"
    } else {
        b"[5.960464477539063e-8]"
    };
    assert_eq!(out, power_expected);
    let long_number = format!("[9007199254740993{}1e-301]", "0".repeat(300));
    let (status, out) = unsafe { call(engine, b"__bcEchoForTest", long_number.as_bytes(), 0) };
    assert_eq!(status, BcStatus::BC_OK);
    let parse_expected: &[u8] = if cfg!(target_os = "android") {
        b"[9007199254740992]"
    } else {
        b"[9007199254740994]"
    };
    assert_eq!(out, parse_expected);
    let (status, out) = unsafe { call(engine, b"__bcSpecialValuesForTest", b"[]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(out, b"[null,0,null,null,null]");
    let (status, out) =
        unsafe { call(engine, b"__bcSpecialValuesForTest", b"[]", BC_FLAG_LOSSLESS) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(out, b"[NaN,-0,Infinity,-Infinity,undefined]");

    assert!(unsafe { bc_supports(engine, b"nativeInit".as_ptr(), 10) });
    assert!(!unsafe { bc_supports(engine, b"missing".as_ptr(), 7) });
    assert!(!unsafe { bc_supports(ptr::null(), b"nativeInit".as_ptr(), 10) });
    unsafe { bc_engine_free(engine) };
}

#[test]
fn zone_callback_buffers_failures_and_reentry_are_bounded() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine(&mut host) };
    let (_, baseline) = unsafe { memory_stats(engine) };
    assert!(baseline.contains("\"byteBuffers\":0"), "{baseline}");

    host.mode.store(ZONE_REENTER, Ordering::SeqCst);
    let (status, out) = unsafe { call(engine, b"__bcZoneResolveForTest", br#"["Etc/UTC"]"#, 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(out, br#""UTC""#);
    assert_eq!(
        host.nested_status.load(Ordering::SeqCst),
        BcStatus::BC_BUSY as i32
    );

    for (mode, expected) in [
        (ZONE_FAIL, BcStatus::BC_THROW),
        (ZONE_FAIL_WITH_BUFFER, BcStatus::BC_THROW),
        (ZONE_BAD_UTF8, BcStatus::BC_THROW),
        (ZONE_TOO_LONG, BcStatus::BC_THROW),
        (ZONE_FORGED_EMPTY, BcStatus::BC_THROW),
        (ZONE_FORGED_DANGLING_EMPTY, BcStatus::BC_THROW),
        (ZONE_EMPTY, BcStatus::BC_THROW),
    ] {
        host.mode.store(mode, Ordering::SeqCst);
        let (status, out) = unsafe { call(engine, b"__bcZoneResolveForTest", br#"["UTC"]"#, 0) };
        assert_eq!(status, expected);
        assert!(!out.is_empty());
        let (status, _) = unsafe { call(engine, b"nativeInit", b"[]", 0) };
        assert_eq!(status, BcStatus::BC_OK, "callback failure must not poison");
    }
    let (_, after) = unsafe { memory_stats(engine) };
    assert!(after.contains("\"byteBuffers\":0"), "{after}");
    unsafe { bc_engine_free(engine) };
}

#[test]
fn concurrent_stateful_entry_is_busy_then_recovers() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    host.mode.store(ZONE_BLOCK, Ordering::SeqCst);
    let engine = unsafe { new_engine(&mut host) };
    let engine_bits = engine.addr();
    let worker = std::thread::spawn(move || unsafe {
        call(
            ptr::without_provenance_mut(engine_bits),
            b"__bcZoneResolveForTest",
            br#"["UTC"]"#,
            0,
        )
    });
    {
        let (lock, changed) = &host.latch;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        while !state.0 {
            state = changed
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
    let (status, out) = unsafe { call(engine, b"nativeInit", b"[]", 0) };
    assert_eq!(status, BcStatus::BC_BUSY);
    assert!(out.is_empty());
    let (status, out) = unsafe { call(engine, b"\xff", b"[", u32::MAX) };
    assert_eq!(status, BcStatus::BC_BUSY);
    assert!(out.is_empty());
    let mut error = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_write_f64(
                engine,
                ptr::null(),
                1,
                ptr::null(),
                1,
                ptr::null(),
                usize::MAX,
                &mut error,
            )
        },
        BcStatus::BC_BUSY
    );
    assert!(error.ptr.is_null());
    {
        let (lock, changed) = &host.latch;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.1 = true;
        changed.notify_all();
    }
    let (status, out) = worker.join().expect("worker");
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(out, br#""UTC""#);
    let (status, _) = unsafe { call(engine, b"nativeInit", b"[]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    unsafe { bc_engine_free(engine) };
}

#[test]
fn callback_free_defers_release_but_admitted_output_stays_valid() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    host.mode.store(ZONE_FREE, Ordering::SeqCst);
    let engine = unsafe { new_engine(&mut host) };
    let (status, out) = unsafe { call(engine, b"__bcZoneResolveForTest", br#"["UTC"]"#, 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(out, br#""UTC""#);
    assert_eq!(
        host.nested_status.load(Ordering::SeqCst),
        BcStatus::BC_CLOSED as i32
    );
    assert_eq!(host.release_count.load(Ordering::SeqCst), 1);
    assert!(!unsafe { bc_supports(engine, b"nativeInit".as_ptr(), 10) });
    let (status, out) = unsafe { call(engine, b"nativeInit", b"[]", 0) };
    assert_eq!(status, BcStatus::BC_CLOSED);
    assert_eq!(out, br#"{"name":"Error","message":"Chart disposed"}"#);
    unsafe { bc_engine_free(engine) };
    assert_eq!(host.release_count.load(Ordering::SeqCst), 1);
}

#[test]
fn concurrent_free_closes_new_entries_and_releases_after_admitted_call() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    host.mode.store(ZONE_BLOCK, Ordering::SeqCst);
    let engine = unsafe { new_engine(&mut host) };
    let engine_bits = engine.addr();
    let worker = std::thread::spawn(move || unsafe {
        call(
            ptr::without_provenance_mut(engine_bits),
            b"__bcZoneResolveForTest",
            br#"["UTC"]"#,
            0,
        )
    });
    {
        let (lock, changed) = &host.latch;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        while !state.0 {
            state = changed
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
    unsafe { bc_engine_free(engine) };
    assert_eq!(host.release_count.load(Ordering::SeqCst), 0);
    let (status, out) = unsafe { call(engine, b"nativeInit", b"[]", 0) };
    assert_eq!(status, BcStatus::BC_CLOSED);
    assert_eq!(out, br#"{"name":"Error","message":"Chart disposed"}"#);
    {
        let (lock, changed) = &host.latch;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.1 = true;
        changed.notify_all();
    }
    let (status, out) = worker.join().expect("worker");
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(out, br#""UTC""#);
    assert_eq!(host.release_count.load(Ordering::SeqCst), 1);
    unsafe { bc_engine_free(engine) };
    assert_eq!(host.release_count.load(Ordering::SeqCst), 1);
}

#[test]
fn panic_poison_is_latched_before_log_and_cleanup_still_runs() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    host.mode.store(LOG_REENTER, Ordering::SeqCst);
    let engine = unsafe { new_engine(&mut host) };
    let (status, out) = unsafe { call(engine, b"__bcPanicForTest", b"[]", 0) };
    assert_eq!(status, BcStatus::BC_POISONED);
    assert_eq!(out, br#"{"name":"Error","message":"Chart disposed"}"#);
    assert_eq!(host.log_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        *host
            .log_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        b"Rust core panic"
    );
    assert_eq!(
        host.nested_status.load(Ordering::SeqCst),
        BcStatus::BC_BUSY as i32
    );
    assert_eq!(host.zone_count.load(Ordering::SeqCst), 0);
    assert!(unsafe { bc_supports(engine, b"nativeInit".as_ptr(), 10) });

    let (status, out) = unsafe { call(engine, b"nativeInit", b"[]", 0) };
    assert_eq!(status, BcStatus::BC_POISONED);
    assert_eq!(out, br#"{"name":"Error","message":"Chart disposed"}"#);
    let (status, out) = unsafe { call(engine, b"nativeInit", b"[", u32::MAX) };
    assert_eq!(status, BcStatus::BC_POISONED);
    assert_eq!(out, br#"{"name":"Error","message":"Chart disposed"}"#);
    let (status, out) = unsafe { call(engine, b"\xff", b"[]", 0) };
    assert_eq!(status, BcStatus::BC_INVALID);
    assert!(out.is_empty());
    let mut error = BcBuf::default();
    let mut dst = [123.0];
    assert_eq!(
        unsafe {
            bc_read_f64(
                engine,
                b"missing".as_ptr(),
                7,
                b"[]".as_ptr(),
                2,
                dst.as_mut_ptr(),
                1,
                &mut error,
            )
        },
        BcStatus::BC_POISONED
    );
    assert_eq!(dst, [123.0]);
    unsafe { bc_buf_free(error) };
    let mut metadata = BcBuf::default();
    let mut numbers = BcF64Buf::default();
    assert_eq!(
        unsafe { bc_packet(engine, b"[]".as_ptr(), 2, &mut metadata, &mut numbers) },
        BcStatus::BC_POISONED
    );
    assert_eq!(
        unsafe { bytes_and_free(metadata) },
        br#"{"name":"Error","message":"Chart disposed"}"#
    );
    assert!(numbers.ptr.is_null());
    error = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_write_f64(
                engine,
                b"missing".as_ptr(),
                7,
                b"[]".as_ptr(),
                2,
                ptr::null(),
                0,
                &mut error,
            )
        },
        BcStatus::BC_POISONED
    );
    unsafe { bc_buf_free(error) };
    let (status, stats) = unsafe { memory_stats(engine) };
    assert_eq!(status, BcStatus::BC_OK);
    assert!(stats.contains("\"poisoned\":true"), "{stats}");
    assert_eq!(host.log_count.load(Ordering::SeqCst), 1);
    unsafe { bc_engine_free(engine) };
    assert_eq!(host.release_count.load(Ordering::SeqCst), 1);
}

#[test]
fn panic_result_wins_for_admitted_call_when_log_frees_engine() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    host.mode.store(LOG_FREE, Ordering::SeqCst);
    let engine = unsafe { new_engine(&mut host) };
    let (status, out) = unsafe { call(engine, b"__bcPanicForTest", br#"["secret-sentinel"]"#, 0) };
    assert_eq!(status, BcStatus::BC_POISONED);
    assert_eq!(out, br#"{"name":"Error","message":"Chart disposed"}"#);
    assert_eq!(
        host.nested_status.load(Ordering::SeqCst),
        BcStatus::BC_CLOSED as i32
    );
    assert_eq!(host.log_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        *host
            .log_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        b"Rust core panic"
    );
    assert_eq!(host.release_count.load(Ordering::SeqCst), 1);
    let (status, out) = unsafe { call(engine, b"nativeInit", b"[]", 0) };
    assert_eq!(status, BcStatus::BC_CLOSED);
    assert_eq!(out, br#"{"name":"Error","message":"Chart disposed"}"#);
    unsafe { bc_engine_free(engine) };
    assert_eq!(host.release_count.load(Ordering::SeqCst), 1);
}

#[test]
fn f64_transport_rejects_null_misalignment_and_overflow_without_writes() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine(&mut host) };
    let mut error = BcBuf::default();
    let sentinel = [7.0_f64, 8.0];

    assert_eq!(
        unsafe {
            bc_read_f64(
                engine,
                b"missing".as_ptr(),
                7,
                b"[]".as_ptr(),
                2,
                ptr::null_mut(),
                1,
                &mut error,
            )
        },
        BcStatus::BC_INVALID
    );
    assert_eq!(sentinel, [7.0, 8.0]);
    let mut bytes = [0_u8; 24];
    let misaligned = unsafe { bytes.as_mut_ptr().add(1).cast::<f64>() };
    assert_eq!(
        unsafe {
            bc_read_f64(
                engine,
                b"missing".as_ptr(),
                7,
                b"[]".as_ptr(),
                2,
                misaligned,
                1,
                &mut error,
            )
        },
        BcStatus::BC_INVALID
    );
    assert_eq!(
        unsafe {
            bc_write_f64(
                engine,
                b"missing".as_ptr(),
                7,
                b"[]".as_ptr(),
                2,
                misaligned,
                1,
                &mut error,
            )
        },
        BcStatus::BC_INVALID
    );
    assert_eq!(
        unsafe {
            bc_write_f64(
                engine,
                b"missing".as_ptr(),
                7,
                b"[]".as_ptr(),
                2,
                sentinel.as_ptr(),
                usize::MAX,
                &mut error,
            )
        },
        BcStatus::BC_INVALID
    );
    assert_eq!(sentinel, [7.0, 8.0]);
    unsafe { bc_buf_free(error) };

    error = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_write_f64(
                engine,
                b"missing".as_ptr(),
                7,
                b"[]".as_ptr(),
                2,
                ptr::null(),
                0,
                &mut error,
            )
        },
        BcStatus::BC_UNAVAILABLE
    );
    unsafe { bc_buf_free(error) };

    let expected = [
        0.0_f64.to_bits(),
        (-0.0_f64).to_bits(),
        0x7ff8_0000_0000_0042,
        f64::INFINITY.to_bits(),
    ];
    let mut copied_out = [99.0_f64; 4];
    error = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_read_f64(
                engine,
                b"__bcReadF64ForTest".as_ptr(),
                b"__bcReadF64ForTest".len(),
                b"[]".as_ptr(),
                2,
                copied_out.as_mut_ptr(),
                copied_out.len(),
                &mut error,
            )
        },
        BcStatus::BC_OK
    );
    assert_eq!(copied_out.map(f64::to_bits), expected);
    assert!(error.ptr.is_null());

    let mut unchanged = [11.0_f64; 3];
    assert_eq!(
        unsafe {
            bc_read_f64(
                engine,
                b"__bcReadF64ForTest".as_ptr(),
                b"__bcReadF64ForTest".len(),
                b"[]".as_ptr(),
                2,
                unchanged.as_mut_ptr(),
                unchanged.len(),
                &mut error,
            )
        },
        BcStatus::BC_THROW
    );
    assert_eq!(unchanged, [11.0; 3]);
    unsafe { bc_buf_free(error) };

    let mut copied_in = expected.map(f64::from_bits);
    error = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_write_f64(
                engine,
                b"__bcWriteF64ForTest".as_ptr(),
                b"__bcWriteF64ForTest".len(),
                b"[]".as_ptr(),
                2,
                copied_in.as_ptr(),
                copied_in.len(),
                &mut error,
            )
        },
        BcStatus::BC_OK
    );
    copied_in.fill(123.0);
    let mut copied_back = [0.0; 4];
    assert_eq!(
        unsafe {
            bc_read_f64(
                engine,
                b"__bcReadLastF64ForTest".as_ptr(),
                b"__bcReadLastF64ForTest".len(),
                b"[]".as_ptr(),
                2,
                copied_back.as_mut_ptr(),
                copied_back.len(),
                &mut error,
            )
        },
        BcStatus::BC_OK
    );
    assert_eq!(copied_back.map(f64::to_bits), expected);
    unsafe { bc_engine_free(engine) };
}

#[test]
fn packet_f64_buffers_are_aligned_bit_exact_and_return_to_baseline() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine(&mut host) };
    let (_, baseline) = unsafe { memory_stats(engine) };
    assert!(baseline.contains("\"f64Buffers\":0"), "{baseline}");

    let mut metadata = BcBuf::default();
    let mut numbers = BcF64Buf::default();
    let args = br#"["__bcPacketForTest"]"#;
    assert_eq!(
        unsafe {
            bc_packet(
                engine,
                args.as_ptr(),
                args.len(),
                &mut metadata,
                &mut numbers,
            )
        },
        BcStatus::BC_OK
    );
    assert_eq!(unsafe { bytes_and_free(metadata) }, br#"{"kind":"test"}"#);
    assert!(!numbers.ptr.is_null());
    assert_eq!((numbers.ptr as usize) % align_of::<f64>(), 0);
    assert!(numbers.len <= numbers.cap);
    let bits: Vec<u64> = unsafe { slice::from_raw_parts(numbers.ptr, numbers.len) }
        .iter()
        .map(|value| value.to_bits())
        .collect();
    assert_eq!(
        bits,
        [
            0_u64,
            (-0.0_f64).to_bits(),
            0x7ff8_0000_0000_0042,
            f64::INFINITY.to_bits(),
        ]
    );
    unsafe { bc_f64_buf_free(numbers) };

    let empty = br#"["__bcEmptyPacketForTest"]"#;
    assert_eq!(
        unsafe {
            bc_packet(
                engine,
                empty.as_ptr(),
                empty.len(),
                &mut metadata,
                &mut numbers,
            )
        },
        BcStatus::BC_OK
    );
    assert!(numbers.ptr.is_null());
    assert_eq!((numbers.len, numbers.cap), (0, 0));
    unsafe { bc_buf_free(metadata) };
    unsafe { bc_f64_buf_free(numbers) };
    let (_, after) = unsafe { memory_stats(engine) };
    assert!(after.contains("\"f64Buffers\":0"), "{after}");

    metadata = BcBuf {
        ptr: ptr::dangling_mut(),
        len: 1,
        cap: 1,
    };
    numbers = BcF64Buf {
        ptr: ptr::dangling_mut(),
        len: 1,
        cap: 1,
    };
    assert_eq!(
        unsafe { bc_packet(engine, b"[".as_ptr(), 1, &mut metadata, &mut numbers) },
        BcStatus::BC_INVALID
    );
    assert_eq!(
        (metadata.ptr, metadata.len, metadata.cap),
        (ptr::null_mut(), 0, 0)
    );
    assert_eq!(
        (numbers.ptr, numbers.len, numbers.cap),
        (ptr::null_mut(), 0, 0)
    );
    unsafe { bc_engine_free(engine) };
}

#[test]
fn rust_owned_copy_accepts_canonical_empty_and_preserves_utf8() {
    let _guard = serial();
    let mut out = BcBuf {
        ptr: ptr::dangling_mut::<u8>(),
        len: 1,
        cap: 1,
    };
    assert_eq!(
        unsafe { bc_buf_new_copy(ptr::null(), 0, &mut out) },
        BcStatus::BC_OK
    );
    assert_eq!((out.ptr, out.len, out.cap), (ptr::null_mut(), 0, 0));
    unsafe { bc_buf_free(out) };
    assert_eq!(
        unsafe { bc_buf_new_copy(ptr::null(), 1, &mut out) },
        BcStatus::BC_INVALID
    );
    let text = "서울/UTC".as_bytes();
    assert_eq!(
        unsafe { bc_buf_new_copy(text.as_ptr(), text.len(), &mut out) },
        BcStatus::BC_OK
    );
    assert_eq!(unsafe { bytes_and_free(out) }, text);
    unsafe {
        bc_buf_free(BcBuf {
            ptr: ptr::null_mut(),
            len: 1,
            cap: 1,
        })
    };
}
