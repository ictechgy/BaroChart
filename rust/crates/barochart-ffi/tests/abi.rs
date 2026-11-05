use std::ffi::c_void;
use std::mem::{align_of, size_of};
use std::ptr;
use std::slice;
use std::sync::atomic::{AtomicI32, AtomicPtr, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};

#[cfg(debug_assertions)]
use barochart_ffi::bc_debug_panic_on;
use barochart_ffi::{
    BC_FLAG_LOSSLESS, BcBuf, BcEngine, BcF64Buf, BcF64WriteReceipt, BcHost, BcStatus, bc_buf_free,
    bc_buf_new_copy, bc_call, bc_engine_free, bc_engine_new, bc_engine_new_with_limit,
    bc_f64_buf_free, bc_memory_stats, bc_packet, bc_read_f64, bc_read_f64_snapshot,
    bc_read_f64_snapshot_with_flags, bc_supports, bc_write_f64, bc_write_f64_observe,
    bc_write_f64_snapshot,
};
#[cfg(debug_assertions)]
use barochart_js::json::{JsValue, JsonMode, parse_json, stringify_json};
#[cfg(debug_assertions)]
use barochart_js::string::JsString;

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
const DISPOSED: &[u8] = br#"{"name":"Error","message":"Chart disposed"}"#;

static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn serial() -> MutexGuard<'static, ()> {
    TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[test]
fn flagged_f64_snapshot_preserves_lossless_arguments_without_changing_the_standard_api() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine(&mut host) };
    let name = b"__bcReadF64ForTest";
    let args = b"[undefined,NaN,-0]";
    let mut output = BcF64Buf::default();
    let mut error = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_read_f64_snapshot(
                engine,
                name.as_ptr(),
                name.len(),
                args.as_ptr(),
                args.len(),
                &mut output,
                &mut error,
            )
        },
        BcStatus::BC_INVALID
    );
    assert!(output.ptr.is_null() && error.ptr.is_null());
    assert_eq!(
        unsafe {
            bc_read_f64_snapshot_with_flags(
                engine,
                name.as_ptr(),
                name.len(),
                args.as_ptr(),
                args.len(),
                BC_FLAG_LOSSLESS,
                &mut output,
                &mut error,
            )
        },
        BcStatus::BC_OK
    );
    assert!(error.ptr.is_null());
    assert_eq!(output.len, 4);
    assert_eq!(
        unsafe { slice::from_raw_parts(output.ptr, output.len) }
            .iter()
            .map(|x| x.to_bits())
            .collect::<Vec<_>>(),
        [
            0,
            (-0.0f64).to_bits(),
            0x7ff8_0000_0000_0042,
            f64::INFINITY.to_bits()
        ]
    );
    unsafe { bc_f64_buf_free(output) };
    output = BcF64Buf::default();
    assert_eq!(
        unsafe {
            bc_read_f64_snapshot_with_flags(
                engine,
                name.as_ptr(),
                name.len(),
                b"[]".as_ptr(),
                2,
                u32::MAX,
                &mut output,
                &mut error,
            )
        },
        BcStatus::BC_INVALID
    );
    assert!(output.ptr.is_null() && error.ptr.is_null());
    unsafe { bc_engine_free(engine) };
}

#[test]
fn bulk_set_data_fits_a_quota_that_rejects_dom_expansion_and_keeps_live_owner() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine_with_limit(&mut host, 4 * 1024 * 1024) };
    let (init, _) = unsafe { call(engine, b"nativeInit", b"[0]", 0) };
    assert_eq!(init, BcStatus::BC_OK);
    let bars = (0..10_000)
        .map(|index| {
            format!("{{\"time\":{index},\"open\":2,\"high\":4,\"low\":1,\"close\":3,\"volume\":5}}")
        })
        .collect::<Vec<_>>()
        .join(",");
    let args = format!("[[{bars}]]");
    let (status, out) = unsafe { call(engine, b"nativeSetData", args.as_bytes(), 0) };
    assert_eq!(status, BcStatus::BC_OK, "{}", String::from_utf8_lossy(&out));
    assert_eq!(out, b"null");
    let (status, out) = unsafe { call(engine, b"nativeEcho", args.as_bytes(), 0) };
    assert_eq!(status, BcStatus::BC_OOM_LIMIT);
    assert!(out.is_empty());
    let (status, out) = unsafe { call(engine, b"nativeCommand", br#"["inspect"]"#, 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert!(String::from_utf8_lossy(&out).contains("\"storedBars\":10000"));
    let (status, out) = unsafe { call(engine, b"nativeSetData", b"[[],]", 0) };
    assert_eq!(status, BcStatus::BC_INVALID);
    assert!(out.is_empty());
    unsafe { bc_engine_free(engine) };
    assert_eq!(host.release_count.load(Ordering::SeqCst), 1);
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

unsafe fn new_engine_with_limit(host: &mut HostContext, limit: u64) -> *mut BcEngine {
    let raw = callbacks(host);
    let mut engine = ptr::null_mut();
    let mut error = BcBuf::default();
    let status = unsafe { bc_engine_new_with_limit(&raw, limit, &mut engine, &mut error) };
    assert_eq!(status, BcStatus::BC_OK);
    assert!(!engine.is_null());
    assert!(error.ptr.is_null());
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

#[cfg(debug_assertions)]
unsafe fn arm_native_panic(engine: *mut BcEngine, name: &[u8]) {
    assert_eq!(
        unsafe { bc_debug_panic_on(engine, name.as_ptr(), name.len()) },
        BcStatus::BC_OK
    );
}

#[cfg(debug_assertions)]
fn json_field<'a>(value: &'a JsValue, name: &str) -> &'a JsValue {
    let JsValue::Object(object) = value else {
        panic!("object required: {value:?}")
    };
    object
        .get(&JsString::from_str(name))
        .unwrap_or_else(|| panic!("missing {name}: {value:?}"))
}

#[cfg(debug_assertions)]
fn json_number(value: &JsValue) -> f64 {
    let JsValue::Number(value) = value else {
        panic!("number required: {value:?}")
    };
    *value
}

#[cfg(debug_assertions)]
fn json_args(values: Vec<JsValue>) -> Vec<u8> {
    stringify_json(&JsValue::Array(values), JsonMode::Standard)
}

#[cfg(debug_assertions)]
unsafe fn call_value(engine: *mut BcEngine, name: &[u8], args: Vec<JsValue>) -> JsValue {
    let args = json_args(args);
    let (status, output) = unsafe { call(engine, name, &args, 0) };
    assert_eq!(
        status,
        BcStatus::BC_OK,
        "{}: {}",
        String::from_utf8_lossy(name),
        String::from_utf8_lossy(&output)
    );
    parse_json(&output, JsonMode::Standard).expect("valid ABI JSON")
}

fn stats_number(stats: &str, key: &str) -> u64 {
    let marker = format!("\"{key}\":");
    let start = stats
        .find(&marker)
        .unwrap_or_else(|| panic!("missing {key}: {stats}"));
    let digits = &stats[start + marker.len()..];
    let end = digits
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(digits.len());
    digits[..end].parse().unwrap()
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
    assert_eq!(BcStatus::BC_OOM_LIMIT as i32, 7);
    assert_eq!(BcStatus::BC_OOM_SYSTEM as i32, 8);
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
fn limited_constructor_and_output_oom_use_empty_status_only() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let raw = callbacks(&mut host);
    let mut engine = ptr::dangling_mut();
    let mut error = BcBuf::default();
    assert_eq!(
        unsafe { bc_engine_new_with_limit(&raw, 1, &mut engine, &mut error) },
        BcStatus::BC_OOM_LIMIT
    );
    assert!(engine.is_null());
    assert!(error.ptr.is_null());
    assert_eq!((error.len, error.cap), (0, 0));
    assert_eq!(host.release_count.load(Ordering::SeqCst), 0);

    let mut probe_host = Box::new(HostContext::new());
    let probe = unsafe { new_engine(&mut probe_host) };
    let (_, baseline) = unsafe { memory_stats(probe) };
    let baseline_live = stats_number(&baseline, "requestedLiveBytes");
    unsafe { bc_engine_free(probe) };

    let limit = baseline_live + 1_024;
    let engine = unsafe { new_engine_with_limit(&mut host, limit) };
    let large = format!("[\"{}\"]", "x".repeat(8_192));
    let mut out = BcBuf::default();
    let status = unsafe {
        bc_call(
            engine,
            b"nativeEcho".as_ptr(),
            b"nativeEcho".len(),
            large.as_ptr(),
            large.len(),
            0,
            &mut out,
        )
    };
    assert_eq!(status, BcStatus::BC_OOM_LIMIT);
    assert!(out.ptr.is_null());
    assert_eq!((out.len, out.cap), (0, 0));
    let (status, small) = unsafe { call(engine, b"nativeEcho", br#"["ok"]"#, 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(small, br#""ok""#);
    let (_, stats) = unsafe { memory_stats(engine) };
    assert_eq!(stats_number(&stats, "limitBytes"), limit);
    assert!(!stats.contains("\"poisoned\":true"));
    unsafe { bc_engine_free(engine) };
}

#[test]
fn persistent_core_oom_tag_maps_to_empty_status_and_keeps_engine_usable() {
    let _guard = serial();
    let mut probe_host = Box::new(HostContext::new());
    let probe = unsafe { new_engine(&mut probe_host) };
    let (_, baseline) = unsafe { memory_stats(probe) };
    let base = stats_number(&baseline, "requestedLiveBytes");
    unsafe { bc_engine_free(probe) };

    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine_with_limit(&mut host, base + 3_071) };
    let (status, output) = unsafe { call(engine, b"nativeInit", b"[]", 0) };
    assert_eq!(status, BcStatus::BC_OOM_LIMIT);
    assert!(output.is_empty());
    let (_, after) = unsafe { memory_stats(engine) };
    assert_eq!(stats_number(&after, "requestedLiveBytes"), base);
    assert!(!after.contains("\"poisoned\":true"));
    let (status, output) = unsafe { call(engine, b"nativeEcho", br#"["ok"]"#, 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(output, br#""ok""#);
    unsafe { bc_engine_free(engine) };
}

#[test]
fn scoped_json_parse_and_echo_clone_oom_are_empty_recoverable_and_syntax_stays_invalid() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let probe = unsafe { new_engine(&mut host) };
    let (_, base_stats) = unsafe { memory_stats(probe) };
    let engine_base = stats_number(&base_stats, "requestedLiveBytes");
    unsafe { bc_engine_free(probe) };
    // Keep parser headroom stable as Core gains controller/job fields.
    let engine = unsafe { new_engine_with_limit(&mut host, engine_base + 2_432) };
    let (_, baseline) = unsafe { memory_stats(engine) };
    let baseline_live = stats_number(&baseline, "requestedLiveBytes");

    // An unavailable function has a tiny result. The wide argument must therefore fail while the
    // scoped parser grows, rather than parse unaccounted and reach dispatch.
    let huge = format!("[\"{}\"]", "x".repeat(8_192));
    let (status, output) = unsafe { call(engine, b"missing", huge.as_bytes(), 0) };
    assert_eq!(status, BcStatus::BC_OOM_LIMIT);
    assert!(output.is_empty());
    let (_, after_parse) = unsafe { memory_stats(engine) };
    assert_eq!(
        stats_number(&after_parse, "requestedLiveBytes"),
        baseline_live
    );
    assert_eq!(stats_number(&after_parse, "retainedOutputBytes"), 0);

    // This size fits parse + a small UnavailableError, while nativeEcho's additional deep clone,
    // serialization, and retained output must all share the same cumulative call scope.
    let clone_wide = format!("[\"{}\"]", "y".repeat(512));
    let (status, unavailable) = unsafe { call(engine, b"missing", clone_wide.as_bytes(), 0) };
    assert_eq!(status, BcStatus::BC_UNAVAILABLE);
    assert!(!unavailable.is_empty());
    let (status, output) = unsafe { call(engine, b"nativeEcho", clone_wide.as_bytes(), 0) };
    assert_eq!(status, BcStatus::BC_OOM_LIMIT);
    assert!(output.is_empty());

    let (status, output) = unsafe { call(engine, b"nativeEcho", b"[1,]", 0) };
    assert_eq!(status, BcStatus::BC_INVALID);
    assert!(output.is_empty());
    let (status, output) = unsafe { call(engine, b"nativeEcho", br#"["ok"]"#, 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(output, br#""ok""#);
    let (_, recovered) = unsafe { memory_stats(engine) };
    assert_eq!(
        stats_number(&recovered, "requestedLiveBytes"),
        baseline_live
    );
    assert_eq!(stats_number(&recovered, "retainedOutputBytes"), 0);
    unsafe { bc_engine_free(engine) };
}

#[test]
fn scoped_large_echo_preserves_result_and_releases_call_temporaries() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine(&mut host) };
    let (_, baseline) = unsafe { memory_stats(engine) };
    let baseline_live = stats_number(&baseline, "requestedLiveBytes");
    let payload = "한".repeat(128 * 1024);
    let args = format!("[\"{payload}\"]");
    let (status, output) = unsafe { call(engine, b"nativeEcho", args.as_bytes(), 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(output.first(), Some(&b'"'));
    assert_eq!(output.last(), Some(&b'"'));
    assert_eq!(&output[1..output.len() - 1], payload.as_bytes());
    let (_, recovered) = unsafe { memory_stats(engine) };
    assert_eq!(
        stats_number(&recovered, "requestedLiveBytes"),
        baseline_live
    );
    assert_eq!(stats_number(&recovered, "retainedOutputBytes"), 0);
    assert!(
        stats_number(&recovered, "requestedPeakBytes")
            > stats_number(&baseline, "requestedPeakBytes")
    );
    unsafe { bc_engine_free(engine) };
}

#[test]
fn retained_output_is_engine_scoped_and_survives_engine_free() {
    let _guard = serial();
    let mut first_host = Box::new(HostContext::new());
    let mut second_host = Box::new(HostContext::new());
    let first = unsafe { new_engine(&mut first_host) };
    let second = unsafe { new_engine(&mut second_host) };
    let (_, first_base) = unsafe { memory_stats(first) };
    let (_, second_base) = unsafe { memory_stats(second) };
    let mut retained = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_call(
                first,
                b"nativeEcho".as_ptr(),
                b"nativeEcho".len(),
                br#"["retained"]"#.as_ptr(),
                br#"["retained"]"#.len(),
                0,
                &mut retained,
            )
        },
        BcStatus::BC_OK
    );
    let (_, first_live) = unsafe { memory_stats(first) };
    let (_, second_live) = unsafe { memory_stats(second) };
    assert!(
        stats_number(&first_live, "requestedLiveBytes")
            > stats_number(&first_base, "requestedLiveBytes")
    );
    assert!(stats_number(&first_live, "retainedOutputBytes") >= retained.cap as u64);
    assert_eq!(
        stats_number(&second_live, "requestedLiveBytes"),
        stats_number(&second_base, "requestedLiveBytes")
    );
    assert_eq!(stats_number(&second_live, "retainedOutputBytes"), 0);
    unsafe { bc_engine_free(first) };
    assert_eq!(first_host.release_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        unsafe { slice::from_raw_parts(retained.ptr, retained.len) },
        br#""retained""#
    );
    let descriptor = (retained.ptr.addr(), retained.len, retained.cap);
    std::thread::spawn(move || unsafe {
        bc_buf_free(BcBuf {
            ptr: ptr::without_provenance_mut(descriptor.0),
            len: descriptor.1,
            cap: descriptor.2,
        })
    })
    .join()
    .unwrap();
    unsafe { bc_engine_free(second) };
}

#[test]
fn ordinary_error_output_is_accounted_until_free() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine(&mut host) };
    let (_, baseline) = unsafe { memory_stats(engine) };
    let mut error = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_call(
                engine,
                b"missing".as_ptr(),
                b"missing".len(),
                b"[]".as_ptr(),
                2,
                0,
                &mut error,
            )
        },
        BcStatus::BC_UNAVAILABLE
    );
    let (_, retained) = unsafe { memory_stats(engine) };
    assert!(stats_number(&retained, "retainedOutputBytes") >= error.cap as u64);
    assert!(
        stats_number(&retained, "requestedLiveBytes")
            > stats_number(&baseline, "requestedLiveBytes")
    );
    unsafe { bc_buf_free(error) };
    let (_, released) = unsafe { memory_stats(engine) };
    assert_eq!(
        stats_number(&released, "requestedLiveBytes"),
        stats_number(&baseline, "requestedLiveBytes")
    );
    assert_eq!(stats_number(&released, "retainedOutputBytes"), 0);
    unsafe { bc_engine_free(engine) };
}

#[test]
fn memory_stats_control_output_does_not_charge_itself() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine(&mut host) };
    let (_, first) = unsafe { memory_stats(engine) };
    let (_, second) = unsafe { memory_stats(engine) };
    assert_eq!(
        stats_number(&first, "requestedLiveBytes"),
        stats_number(&second, "requestedLiveBytes")
    );
    assert_eq!(
        stats_number(&first, "requestedPeakBytes"),
        stats_number(&second, "requestedPeakBytes")
    );
    unsafe { bc_engine_free(engine) };
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
    assert!(stats_number(&stats, "requestedLiveBytes") > 0, "{stats}");
    assert_eq!(stats_number(&stats, "limitBytes"), 0, "{stats}");

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
    let baseline_live = stats_number(&baseline, "requestedLiveBytes");
    assert_eq!(stats_number(&baseline, "retainedOutputBytes"), 0);

    host.mode.store(ZONE_REENTER, Ordering::SeqCst);
    let (status, out) = unsafe { call(engine, b"__bcZoneResolveForTest", br#"["Etc/UTC"]"#, 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(out, br#""UTC""#);
    assert_eq!(
        host.nested_status.load(Ordering::SeqCst),
        BcStatus::BC_BUSY as i32
    );

    let mut initialized_live = None;
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
        let (_, stats) = unsafe { memory_stats(engine) };
        let live = stats_number(&stats, "requestedLiveBytes");
        match initialized_live {
            Some(expected) => assert_eq!(live, expected, "same empty chart payload"),
            None => initialized_live = Some(live),
        }
    }
    let (_, after) = unsafe { memory_stats(engine) };
    assert!(stats_number(&after, "requestedLiveBytes") > baseline_live);
    assert_eq!(
        stats_number(&after, "requestedLiveBytes"),
        initialized_live.expect("nativeInit ran")
    );
    assert_eq!(stats_number(&after, "retainedOutputBytes"), 0);
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
    let mut receipt = BcF64WriteReceipt::default();
    let mut before = BcF64Buf::default();
    assert_eq!(
        unsafe {
            bc_write_f64_observe(
                engine,
                ptr::null(),
                1,
                ptr::null(),
                1,
                u32::MAX,
                ptr::null(),
                i64::MIN,
                &mut receipt,
                &mut before,
                &mut error,
            )
        },
        BcStatus::BC_BUSY
    );
    assert_eq!(receipt, BcF64WriteReceipt::default());
    assert!(before.ptr.is_null() && error.ptr.is_null());
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
    let (_, baseline) = unsafe { memory_stats(engine) };
    let baseline_live = stats_number(&baseline, "requestedLiveBytes");
    let (status, output) = unsafe { call(engine, b"nativeInit", b"[4096]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(output, b"4096");
    let (_, initialized) = unsafe { memory_stats(engine) };
    let core_payload = stats_number(&initialized, "requestedLiveBytes") - baseline_live;
    assert!(core_payload > 0);
    assert!(core_payload < 4 * 1024 * 1024, "{initialized}");
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
    error = BcBuf::default();
    let mut receipt = BcF64WriteReceipt::default();
    let mut before = BcF64Buf::default();
    assert_eq!(
        unsafe {
            bc_write_f64_observe(
                engine,
                b"missing".as_ptr(),
                7,
                b"[]".as_ptr(),
                2,
                u32::MAX,
                ptr::null(),
                -1,
                &mut receipt,
                &mut before,
                &mut error,
            )
        },
        BcStatus::BC_POISONED
    );
    assert_eq!(receipt, BcF64WriteReceipt::default());
    assert!(before.ptr.is_null());
    unsafe { bc_buf_free(error) };
    let (status, stats) = unsafe { memory_stats(engine) };
    assert_eq!(status, BcStatus::BC_OK);
    assert!(stats.contains("\"poisoned\":true"), "{stats}");
    assert_eq!(stats_number(&stats, "requestedLiveBytes"), baseline_live);
    assert_eq!(host.log_count.load(Ordering::SeqCst), 1);
    unsafe { bc_engine_free(engine) };
    assert_eq!(host.release_count.load(Ordering::SeqCst), 1);
}

#[cfg(debug_assertions)]
#[test]
fn poisoned_call_whitelist_answers_all_seven_names_and_validates_registrations() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine(&mut host) };

    unsafe { arm_native_panic(engine, b"nativeReleaseFrameCaches") };
    let (status, output) = unsafe { call(engine, b"nativeReleaseFrameCaches", b"[]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(output, b"true");
    assert_eq!(host.log_count.load(Ordering::SeqCst), 1);
    assert_eq!(host.release_count.load(Ordering::SeqCst), 0);

    let cases: &[(&[u8], &[u8], &[u8])] = &[
        (b"nativeWorkspaceSourceAbort", b"[1]", b"false"),
        (
            b"nativeParamsSourceStatus",
            b"[1]",
            br#"{"registration":1,"ticket":0,"status":"failed"}"#,
        ),
        (
            b"nativeParamsSourceAbort",
            b"[2]",
            br#"{"registration":2,"ticket":0,"status":"failed"}"#,
        ),
        (b"nativeAsyncRelease", br#"[null,"ignored"]"#, b"true"),
        (
            b"nativeReleaseFrameCache",
            br#"[{"ignored":true}]"#,
            b"true",
        ),
        (b"nativeReleaseFrameCaches", b"[1,2,3]", b"true"),
        (
            b"nativeReleaseDataIngestion",
            b"[false]",
            br#"{"cancelled":0,"pendingEvents":0,"ownedBytes":0}"#,
        ),
    ];
    for (name, args, expected) in cases {
        let (status, output) = unsafe { call(engine, name, args, 0) };
        assert_eq!(status, BcStatus::BC_OK, "{}", String::from_utf8_lossy(name));
        assert_eq!(&output, expected, "{}", String::from_utf8_lossy(name));
    }

    for args in [
        b"[0]".as_slice(),
        b"[-0]",
        b"[-1]",
        b"[1.5]",
        br#"["1"]"#,
        b"[true]",
        b"[null]",
        b"[9007199254740992]",
        b"[[1]]",
    ] {
        let (status, output) = unsafe { call(engine, b"nativeWorkspaceSourceAbort", args, 0) };
        assert_eq!(
            status,
            BcStatus::BC_THROW,
            "{}",
            String::from_utf8_lossy(args)
        );
        assert_eq!(
            output,
            br#"{"name":"RangeError","message":"Workspace registration","code":null}"#
        );
    }
    for args in [b"[undefined]".as_slice(), b"[NaN]", b"[Infinity]"] {
        let (status, output) = unsafe {
            call(
                engine,
                b"nativeWorkspaceSourceAbort",
                args,
                BC_FLAG_LOSSLESS,
            )
        };
        assert_eq!(status, BcStatus::BC_THROW);
        assert_eq!(
            output,
            br#"{"name":"RangeError","message":"Workspace registration","code":null}"#
        );
    }
    for name in [
        b"nativeParamsSourceStatus".as_slice(),
        b"nativeParamsSourceAbort".as_slice(),
    ] {
        let (status, output) = unsafe { call(engine, name, b"[0]", 0) };
        assert_eq!(status, BcStatus::BC_THROW);
        assert_eq!(
            output,
            br#"{"name":"RangeError","message":"Params registration","code":null}"#
        );
    }
    let (status, output) = unsafe { call(engine, b"nativeWorkspaceSourceAbort", b"[", 0) };
    assert_eq!(status, BcStatus::BC_INVALID);
    assert!(output.is_empty());
    let (status, output) = unsafe { call(engine, b"nativeInit", b"[", u32::MAX) };
    assert_eq!(status, BcStatus::BC_POISONED);
    assert_eq!(output, DISPOSED);
    assert!(unsafe { bc_supports(engine, b"nativeReleaseFrameCaches".as_ptr(), 24) });
    assert_eq!(host.release_count.load(Ordering::SeqCst), 0);

    unsafe { bc_engine_free(engine) };
    assert_eq!(host.release_count.load(Ordering::SeqCst), 1);
}

#[cfg(debug_assertions)]
#[test]
fn panic_after_real_params_begin_fails_durable_active_row_and_synthesizes_future_rows() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine(&mut host) };
    let (status, output) = unsafe { call(engine, b"nativeInit", b"[8]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(output, b"8");
    let (status, begin) = unsafe {
        call(
            engine,
            b"nativeParamsSourceBegin",
            br#"["ema",{"period":3},1,805306368,1]"#,
            0,
        )
    };
    assert_eq!(
        status,
        BcStatus::BC_OK,
        "{}",
        String::from_utf8_lossy(&begin)
    );
    assert!(String::from_utf8_lossy(&begin).contains("\"registration\":1"));

    unsafe { arm_native_panic(engine, b"nativeParamsSourcePublish") };
    let (status, output) = unsafe { call(engine, b"nativeParamsSourcePublish", b"[1,1]", 0) };
    assert_eq!(status, BcStatus::BC_POISONED);
    assert_eq!(output, DISPOSED);
    let (status, active) = unsafe { call(engine, b"nativeParamsSourceStatus", b"[1]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(
        active,
        br#"{"registration":1,"ticket":1,"status":"failed"}"#
    );
    let (status, synthetic) = unsafe { call(engine, b"nativeParamsSourceAbort", b"[2]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(
        synthetic,
        br#"{"registration":2,"ticket":0,"status":"failed"}"#
    );
    assert_eq!(host.release_count.load(Ordering::SeqCst), 0);
    unsafe { bc_engine_free(engine) };
    assert_eq!(host.release_count.load(Ordering::SeqCst), 1);
}

#[cfg(debug_assertions)]
#[test]
fn poisoned_params_ledger_keeps_four_terminal_rows_and_distinguishes_evicted_and_synthetic() {
    let _guard = serial();
    let mut source_host = Box::new(HostContext::new());
    let mut target_host = Box::new(HostContext::new());
    let source = unsafe { new_engine(&mut source_host) };
    let target = unsafe { new_engine(&mut target_host) };
    let (status, _) = unsafe { call(source, b"nativeInit", b"[8]", 0) };
    assert_eq!(status, BcStatus::BC_OK);

    let (status, _) = unsafe {
        call(
            source,
            b"nativeParamsSourceBegin",
            br#"["missing",{},1,805306368,1]"#,
            0,
        )
    };
    assert_eq!(status, BcStatus::BC_THROW);

    let begin = unsafe {
        call_value(
            source,
            b"nativeParamsSourceBegin",
            vec![
                JsValue::String(JsString::from_str("ema")),
                parse_json(br#"{"period":3}"#, JsonMode::Standard).unwrap(),
                JsValue::Number(1.0),
                JsValue::Number(805_306_368.0),
                JsValue::Number(2.0),
            ],
        )
    };
    let ticket = json_number(json_field(&begin, "ticket"));
    let admission = loop {
        let row = unsafe {
            call_value(
                source,
                b"nativeParamsSourceStep",
                vec![
                    JsValue::Number(ticket),
                    JsValue::Number(64.0),
                    JsValue::Number(1.0),
                ],
            )
        };
        if matches!(json_field(&row, "complete"), JsValue::Bool(true)) {
            break row;
        }
    };
    let JsValue::String(metadata_text) = json_field(&admission, "metadataJSON") else {
        panic!("metadata text")
    };
    let metadata = parse_json(
        metadata_text.to_string_lossy().as_bytes(),
        JsonMode::Standard,
    )
    .expect("params metadata");
    let length = json_number(json_field(&metadata, "length")) as usize;
    unsafe {
        call_value(
            target,
            b"nativeParamsTargetCreate",
            vec![JsValue::String(metadata_text.clone())],
        )
    };

    for slot in 0..6 {
        let args = json_args(vec![
            JsValue::Number(ticket),
            JsValue::Number(slot as f64),
            JsValue::Number(0.0),
            JsValue::Number(length as f64),
        ]);
        let mut values = BcF64Buf::default();
        let mut error = BcBuf::default();
        assert_eq!(
            unsafe {
                bc_read_f64_snapshot(
                    source,
                    b"nativeAsyncBuffer".as_ptr(),
                    b"nativeAsyncBuffer".len(),
                    args.as_ptr(),
                    args.len(),
                    &mut values,
                    &mut error,
                )
            },
            BcStatus::BC_OK
        );
        assert!(error.ptr.is_null());
        let target_args = json_args(vec![
            JsValue::Number(slot as f64),
            JsValue::Number(0.0),
            JsValue::Number(length as f64),
        ]);
        assert_eq!(
            unsafe {
                bc_write_f64(
                    target,
                    b"nativeAsyncTargetBuffer".as_ptr(),
                    b"nativeAsyncTargetBuffer".len(),
                    target_args.as_ptr(),
                    target_args.len(),
                    values.ptr,
                    values.len,
                    &mut error,
                )
            },
            BcStatus::BC_OK
        );
        assert!(error.ptr.is_null());
        unsafe { bc_f64_buf_free(values) };
    }
    unsafe { call_value(target, b"nativeParamsTargetStart", Vec::new()) };
    loop {
        let row = unsafe {
            call_value(
                target,
                b"nativeParamsTargetStep",
                vec![JsValue::Number(64.0)],
            )
        };
        if matches!(json_field(&row, "complete"), JsValue::Bool(true)) {
            break;
        }
    }
    let descriptor_text =
        unsafe { call_value(target, b"nativeParamsTargetDescriptor", Vec::new()) };
    let JsValue::String(ref descriptor_text) = descriptor_text else {
        panic!("descriptor text")
    };
    let descriptor = parse_json(
        descriptor_text.to_string_lossy().as_bytes(),
        JsonMode::Standard,
    )
    .expect("params descriptor");
    unsafe {
        call_value(
            source,
            b"nativeParamsSourceReceive",
            vec![
                JsValue::Number(ticket),
                JsValue::String(descriptor_text.clone()),
                JsValue::Number(1.0),
            ],
        )
    };
    let capacity = json_number(json_field(&descriptor, "capacity")) as usize;
    let JsValue::Array(outputs) = json_field(&descriptor, "outputs") else {
        panic!("outputs")
    };
    for slot in 0..outputs.len() {
        let args = json_args(vec![
            JsValue::Number(2.0),
            JsValue::Number(slot as f64),
            JsValue::Number(0.0),
            JsValue::Number(capacity as f64),
        ]);
        let mut values = BcF64Buf::default();
        let mut error = BcBuf::default();
        assert_eq!(
            unsafe {
                bc_read_f64_snapshot(
                    target,
                    b"nativeAsyncBuffer".as_ptr(),
                    b"nativeAsyncBuffer".len(),
                    args.as_ptr(),
                    args.len(),
                    &mut values,
                    &mut error,
                )
            },
            BcStatus::BC_OK
        );
        unsafe {
            call_value(
                source,
                b"nativeParamsSourceArmWrite",
                vec![
                    JsValue::Number(ticket),
                    JsValue::Number(slot as f64),
                    JsValue::Number(0.0),
                    JsValue::Number(capacity as f64),
                    JsValue::Number(1.0),
                ],
            )
        };
        let source_args = json_args(vec![
            JsValue::Number(slot as f64),
            JsValue::Number(0.0),
            JsValue::Number(capacity as f64),
        ]);
        assert_eq!(
            unsafe {
                bc_write_f64(
                    source,
                    b"nativeAsyncTargetBuffer".as_ptr(),
                    b"nativeAsyncTargetBuffer".len(),
                    source_args.as_ptr(),
                    source_args.len(),
                    values.ptr,
                    values.len,
                    &mut error,
                )
            },
            BcStatus::BC_OK
        );
        assert!(error.ptr.is_null());
        unsafe { bc_f64_buf_free(values) };
    }
    let checkpoint_count = json_number(json_field(&descriptor, "checkpointCount")) as usize;
    for ordinal in 0..checkpoint_count {
        let row = unsafe {
            call_value(
                target,
                b"nativeParamsTargetCheckpoint",
                vec![JsValue::Number(ordinal as f64)],
            )
        };
        unsafe {
            call_value(
                source,
                b"nativeParamsSourceCheckpoint",
                vec![
                    JsValue::Number(ticket),
                    json_field(&row, "index").clone(),
                    json_field(&row, "text").clone(),
                    JsValue::Number(1.0),
                ],
            )
        };
    }
    loop {
        let row = unsafe {
            call_value(
                source,
                b"nativeParamsSourceValidate",
                vec![
                    JsValue::Number(ticket),
                    JsValue::Number(16_384.0),
                    JsValue::Number(1.0),
                ],
            )
        };
        if matches!(json_field(&row, "complete"), JsValue::Bool(true)) {
            break;
        }
    }
    unsafe { bc_engine_free(target) };
    assert_eq!(target_host.release_count.load(Ordering::SeqCst), 1);
    unsafe {
        call_value(
            source,
            b"nativeParamsSourcePrepare",
            vec![JsValue::Number(ticket), JsValue::Number(1.0)],
        )
    };
    let published = unsafe {
        call_value(
            source,
            b"nativeParamsSourcePublish",
            vec![JsValue::Number(ticket), JsValue::Number(1.0)],
        )
    };
    assert!(
        matches!(json_field(&published, "status"), JsValue::String(value) if value == &JsString::from_str("committed"))
    );

    for registration in 3..=5 {
        let args = format!(r#"["missing",{{}},1,805306368,{registration}]"#);
        let (status, _) = unsafe { call(source, b"nativeParamsSourceBegin", args.as_bytes(), 0) };
        assert_eq!(status, BcStatus::BC_THROW);
    }
    let (status, output) = unsafe { call(source, b"__bcPanicForTest", b"[]", 0) };
    assert_eq!(status, BcStatus::BC_POISONED);
    assert_eq!(output, DISPOSED);
    let (status, evicted) = unsafe { call(source, b"nativeParamsSourceStatus", b"[1]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(evicted, b"null");
    let (status, committed) = unsafe { call(source, b"nativeParamsSourceStatus", b"[2]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert!(String::from_utf8_lossy(&committed).contains("\"status\":\"committed\""));
    let (status, failed) = unsafe { call(source, b"nativeParamsSourceStatus", b"[3]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert!(String::from_utf8_lossy(&failed).contains("\"status\":\"failed\""));
    let (status, synthetic) = unsafe { call(source, b"nativeParamsSourceStatus", b"[6]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(
        synthetic,
        br#"{"registration":6,"ticket":0,"status":"failed"}"#
    );

    unsafe { bc_engine_free(source) };
    assert_eq!(target_host.release_count.load(Ordering::SeqCst), 1);
    assert_eq!(source_host.release_count.load(Ordering::SeqCst), 1);
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
fn native_async_buffer_stale_routes_throw_without_writes_or_poisoning() {
    let _guard = serial();

    unsafe fn assert_stale(engine: *mut BcEngine, args: &[u8]) {
        let mut destination = [91.0_f64, 92.0];
        let mut error = BcBuf::default();
        let status = unsafe {
            bc_read_f64(
                engine,
                b"nativeAsyncBuffer".as_ptr(),
                b"nativeAsyncBuffer".len(),
                args.as_ptr(),
                args.len(),
                destination.as_mut_ptr(),
                destination.len(),
                &mut error,
            )
        };
        assert_eq!(status, BcStatus::BC_THROW);
        assert_eq!(destination, [91.0, 92.0]);
        assert_eq!(
            unsafe { bytes_and_free(error) },
            br#"{"name":"Error","message":"Async stale: source replaced/released","code":null}"#
        );
        let (status, output) = unsafe { call(engine, b"nativeEcho", br#"["usable"]"#, 0) };
        assert_eq!(status, BcStatus::BC_OK);
        assert_eq!(output, br#""usable""#);
    }

    let mut fresh_host = Box::new(HostContext::new());
    let fresh = unsafe { new_engine(&mut fresh_host) };
    unsafe { assert_stale(fresh, b"[1,0,0,2]") };
    unsafe { bc_engine_free(fresh) };

    let mut released_host = Box::new(HostContext::new());
    let released = unsafe { new_engine(&mut released_host) };
    let (status, _) = unsafe { call(released, b"nativeInit", b"[8]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    let (status, begin) = unsafe {
        call(
            released,
            b"nativePrepareBegin",
            br#"["{\"kind\":\"seeded\",\"count\":4,\"seed\":7,\"visibleBars\":3}"]"#,
            0,
        )
    };
    assert_eq!(
        status,
        BcStatus::BC_OK,
        "{}",
        String::from_utf8_lossy(&begin)
    );
    assert!(String::from_utf8_lossy(&begin).contains("\\\"ticket\\\":1"));
    let (status, output) = unsafe { call(released, b"nativeAsyncRelease", b"[1]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(output, b"true");
    unsafe { assert_stale(released, b"[1,0,0,2]") };
    unsafe { bc_engine_free(released) };

    let mut params_host = Box::new(HostContext::new());
    let params = unsafe { new_engine(&mut params_host) };
    let (status, _) = unsafe { call(params, b"nativeInit", b"[8]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    let (status, begin) = unsafe {
        call(
            params,
            b"nativeParamsSourceBegin",
            br#"["ema",{"period":3},1,805306368,1]"#,
            0,
        )
    };
    assert_eq!(
        status,
        BcStatus::BC_OK,
        "{}",
        String::from_utf8_lossy(&begin)
    );
    assert!(String::from_utf8_lossy(&begin).contains("\"ticket\":1"));
    unsafe { assert_stale(params, b"[2,0,0,2]") };
    let (status, active) = unsafe { call(params, b"nativeParamsSourceStatus", b"[1]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert!(String::from_utf8_lossy(&active).contains("\"status\":\"active\""));
    let (status, _) = unsafe { call(params, b"nativeParamsSourceAbort", b"[1]", 0) };
    assert_eq!(status, BcStatus::BC_OK);
    unsafe { bc_engine_free(params) };
}

#[test]
fn write_snapshot_returns_actual_previous_bits_and_outlives_engine() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine(&mut host) };
    let original_bits = [
        0.0_f64.to_bits(),
        (-0.0_f64).to_bits(),
        0x7ff8_0000_0000_0042,
        f64::INFINITY.to_bits(),
    ];
    let original = original_bits.map(f64::from_bits);
    let mut error = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_write_f64(
                engine,
                b"__bcWriteF64ForTest".as_ptr(),
                b"__bcWriteF64ForTest".len(),
                b"[]".as_ptr(),
                2,
                original.as_ptr(),
                original.len(),
                &mut error,
            )
        },
        BcStatus::BC_OK
    );
    let replacement_bits = [
        9.0_f64.to_bits(),
        (-9.0_f64).to_bits(),
        0x7ff8_0000_0000_1234,
        42.0_f64.to_bits(),
    ];
    let replacement = replacement_bits.map(f64::from_bits);
    let mut before = BcF64Buf::default();
    error = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_write_f64_snapshot(
                engine,
                b"__bcWriteF64ForTest".as_ptr(),
                b"__bcWriteF64ForTest".len(),
                b"[]".as_ptr(),
                2,
                replacement.as_ptr(),
                replacement.len(),
                &mut before,
                &mut error,
            )
        },
        BcStatus::BC_OK
    );
    assert!(error.ptr.is_null());
    assert_eq!((before.len, before.cap), (4, 4));
    let mut current = [0.0; 4];
    assert_eq!(
        unsafe {
            bc_read_f64(
                engine,
                b"__bcReadLastF64ForTest".as_ptr(),
                b"__bcReadLastF64ForTest".len(),
                b"[]".as_ptr(),
                2,
                current.as_mut_ptr(),
                current.len(),
                &mut error,
            )
        },
        BcStatus::BC_OK
    );
    assert_eq!(current.map(f64::to_bits), replacement_bits);
    let (_, stats) = unsafe { memory_stats(engine) };
    assert!(stats_number(&stats, "retainedOutputBytes") >= 4 * size_of::<f64>() as u64);
    unsafe { bc_engine_free(engine) };
    assert_eq!(host.release_count.load(Ordering::SeqCst), 1);
    let previous = unsafe { slice::from_raw_parts(before.ptr, before.len) };
    assert_eq!(
        previous
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
        original_bits
    );
    unsafe { bc_f64_buf_free(before) };
}

#[test]
fn observed_write_is_bit_exact_and_invalid_source_never_mutates() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine(&mut host) };
    let original_bits = [
        0.0_f64.to_bits(),
        (-0.0_f64).to_bits(),
        0x7ff8_0000_0000_0042,
        f64::INFINITY.to_bits(),
    ];
    let original = original_bits.map(f64::from_bits);
    let replacement_bits = [
        9.0_f64.to_bits(),
        (-9.0_f64).to_bits(),
        0x7ff8_0000_0000_1234,
        42.0_f64.to_bits(),
    ];
    let replacement = replacement_bits.map(f64::from_bits);
    let name = b"__bcWriteF64ForTest";
    let mut error = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_write_f64(
                engine,
                name.as_ptr(),
                name.len(),
                b"[]".as_ptr(),
                2,
                original.as_ptr(),
                original.len(),
                &mut error,
            )
        },
        BcStatus::BC_OK
    );

    let mut receipt = BcF64WriteReceipt::default();
    let mut before = BcF64Buf::default();
    assert_eq!(
        unsafe {
            bc_write_f64_observe(
                engine,
                name.as_ptr(),
                name.len(),
                b"[]".as_ptr(),
                2,
                0,
                replacement.as_ptr(),
                replacement.len() as i64,
                &mut receipt,
                &mut before,
                &mut error,
            )
        },
        BcStatus::BC_OK
    );
    assert_eq!(receipt.actual_count, 4);
    assert!(receipt.did_write);
    assert_eq!(
        unsafe { slice::from_raw_parts(before.ptr, before.len) }
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
        original_bits
    );
    unsafe { bc_f64_buf_free(before) };

    for host_count in [0, -1, 262_145, 3] {
        receipt = BcF64WriteReceipt::default();
        assert_eq!(
            unsafe {
                bc_write_f64_observe(
                    engine,
                    name.as_ptr(),
                    name.len(),
                    b"[]".as_ptr(),
                    2,
                    0,
                    original.as_ptr(),
                    host_count,
                    &mut receipt,
                    ptr::null_mut(),
                    &mut error,
                )
            },
            BcStatus::BC_OK
        );
        assert_eq!(receipt.actual_count, 4);
        assert!(!receipt.did_write);
        assert!(error.ptr.is_null());
    }

    before = BcF64Buf::default();
    receipt = BcF64WriteReceipt::default();
    assert_eq!(
        unsafe {
            bc_write_f64_observe(
                engine,
                name.as_ptr(),
                name.len(),
                b"[]".as_ptr(),
                2,
                0,
                ptr::null(),
                4,
                &mut receipt,
                &mut before,
                &mut error,
            )
        },
        BcStatus::BC_OK
    );
    assert_eq!(receipt.actual_count, 4);
    assert!(!receipt.did_write);
    assert_eq!(
        unsafe { slice::from_raw_parts(before.ptr, before.len) }
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
        replacement_bits
    );
    unsafe { bc_f64_buf_free(before) };

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
    assert_eq!(copied_back.map(f64::to_bits), replacement_bits);
    unsafe { bc_engine_free(engine) };
}

#[test]
fn observed_write_snapshot_oom_is_empty_recoverable_and_does_not_mutate() {
    let _guard = serial();
    let mut probe_host = Box::new(HostContext::new());
    let probe = unsafe { new_engine(&mut probe_host) };
    let (_, baseline) = unsafe { memory_stats(probe) };
    let baseline_live = stats_number(&baseline, "requestedLiveBytes");
    unsafe { bc_engine_free(probe) };

    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine_with_limit(&mut host, baseline_live + 2_048) };
    let original = vec![7.0; 1_024];
    let name = b"__bcWriteF64ForTest";
    let mut error = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_write_f64(
                engine,
                name.as_ptr(),
                name.len(),
                b"[]".as_ptr(),
                2,
                original.as_ptr(),
                original.len(),
                &mut error,
            )
        },
        BcStatus::BC_OK
    );

    let mut receipt = BcF64WriteReceipt::default();
    let mut before = BcF64Buf::default();
    assert_eq!(
        unsafe {
            bc_write_f64_observe(
                engine,
                name.as_ptr(),
                name.len(),
                b"[]".as_ptr(),
                2,
                0,
                ptr::null(),
                0,
                &mut receipt,
                &mut before,
                &mut error,
            )
        },
        BcStatus::BC_OOM_LIMIT
    );
    assert_eq!(receipt.actual_count, original.len());
    assert!(!receipt.did_write);
    assert!(before.ptr.is_null() && error.ptr.is_null());

    let mut unchanged = vec![0.0; original.len()];
    assert_eq!(
        unsafe {
            bc_read_f64(
                engine,
                b"__bcReadLastF64ForTest".as_ptr(),
                b"__bcReadLastF64ForTest".len(),
                b"[]".as_ptr(),
                2,
                unchanged.as_mut_ptr(),
                unchanged.len(),
                &mut error,
            )
        },
        BcStatus::BC_OK
    );
    assert_eq!(unchanged, original);
    let (_, stats) = unsafe { memory_stats(engine) };
    assert!(!stats.contains("\"poisoned\":true"));
    assert_eq!(stats_number(&stats, "retainedOutputBytes"), 0);
    unsafe { bc_engine_free(engine) };
}

#[cfg(debug_assertions)]
#[test]
fn observed_write_calls_the_real_target_before_host_validation_exactly_once() {
    let _guard = serial();
    let mut source_host = Box::new(HostContext::new());
    let mut target_host = Box::new(HostContext::new());
    let source = unsafe { new_engine(&mut source_host) };
    let target = unsafe { new_engine(&mut target_host) };
    unsafe { call_value(source, b"nativeInit", vec![JsValue::Number(2.0)]) };
    let begin = unsafe {
        call_value(
            source,
            b"nativePrepareBegin",
            vec![JsValue::String(JsString::from_str(
                r#"{"kind":"columns","length":2,"visibleBars":1}"#,
            ))],
        )
    };
    let JsValue::String(ref begin) = begin else {
        panic!("prepare begin JSON string")
    };
    let begin = parse_json(begin.to_string_lossy().as_bytes(), JsonMode::Standard)
        .expect("prepare begin JSON");
    let JsValue::String(metadata) = json_field(&begin, "metadataJSON") else {
        panic!("prepare metadata JSON string")
    };
    unsafe {
        call_value(
            target,
            b"nativePrepareCreate",
            vec![JsValue::String(metadata.clone())],
        )
    };

    let arguments = b"[5,0,1]";
    let mut receipt = BcF64WriteReceipt::default();
    let mut before = BcF64Buf::default();
    let mut error = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_write_f64_observe(
                target,
                b"nativeAsyncTargetBuffer".as_ptr(),
                b"nativeAsyncTargetBuffer".len(),
                arguments.as_ptr(),
                arguments.len(),
                u32::MAX,
                ptr::null(),
                0,
                &mut receipt,
                &mut before,
                &mut error,
            )
        },
        BcStatus::BC_INVALID
    );
    assert_eq!(receipt, BcF64WriteReceipt::default());
    assert!(before.ptr.is_null() && error.ptr.is_null());
    assert_eq!(
        unsafe {
            bc_write_f64_observe(
                target,
                b"nativeAsyncTargetBuffer".as_ptr(),
                b"nativeAsyncTargetBuffer".len(),
                arguments.as_ptr(),
                arguments.len(),
                0,
                ptr::null(),
                0,
                &mut receipt,
                &mut before,
                &mut error,
            )
        },
        BcStatus::BC_OK
    );
    assert_eq!(
        receipt.actual_count, 1,
        "invalid flags must not consume the Core target"
    );
    assert!(!receipt.did_write);
    unsafe { bc_f64_buf_free(before) };

    receipt = BcF64WriteReceipt::default();
    before = BcF64Buf::default();
    assert_eq!(
        unsafe {
            bc_write_f64_observe(
                target,
                b"\xff".as_ptr(),
                1,
                b"[4,0,1]".as_ptr(),
                7,
                0,
                ptr::null(),
                0,
                &mut receipt,
                &mut before,
                &mut error,
            )
        },
        BcStatus::BC_INVALID
    );
    assert_eq!(receipt, BcF64WriteReceipt::default());
    assert!(before.ptr.is_null() && error.ptr.is_null());

    let source_value = [f64::from_bits(0x7ff8_0000_0000_0042), -0.0];
    for (slot, host_count) in [(0, 0), (1, -1), (2, 262_145), (3, 2)] {
        let arguments = json_args(vec![
            JsValue::Number(slot as f64),
            JsValue::Number(0.0),
            JsValue::Number(1.0),
        ]);
        let mut receipt = BcF64WriteReceipt::default();
        let mut before = BcF64Buf::default();
        let mut error = BcBuf::default();
        assert_eq!(
            unsafe {
                bc_write_f64_observe(
                    target,
                    b"nativeAsyncTargetBuffer".as_ptr(),
                    b"nativeAsyncTargetBuffer".len(),
                    arguments.as_ptr(),
                    arguments.len(),
                    0,
                    ptr::null(),
                    host_count,
                    &mut receipt,
                    &mut before,
                    &mut error,
                )
            },
            BcStatus::BC_OK
        );
        assert_eq!(receipt.actual_count, 1);
        assert!(!receipt.did_write);
        assert!(error.ptr.is_null());
        assert_eq!(
            unsafe { slice::from_raw_parts(before.ptr, before.len) },
            [0.0]
        );
        unsafe { bc_f64_buf_free(before) };

        // The first call handed out this exact target slice once even though the host copy was
        // rejected. Repeating offset zero therefore reaches Core and fails its cursor check.
        receipt = BcF64WriteReceipt::default();
        before = BcF64Buf::default();
        assert_eq!(
            unsafe {
                bc_write_f64_observe(
                    target,
                    b"nativeAsyncTargetBuffer".as_ptr(),
                    b"nativeAsyncTargetBuffer".len(),
                    arguments.as_ptr(),
                    arguments.len(),
                    0,
                    source_value.as_ptr(),
                    1,
                    &mut receipt,
                    &mut before,
                    &mut error,
                )
            },
            BcStatus::BC_THROW
        );
        assert_eq!(receipt, BcF64WriteReceipt::default());
        assert!(before.ptr.is_null());
        assert!(!error.ptr.is_null());
        unsafe { bc_buf_free(error) };

        // The next cursor position remains usable and performs one exact write.
        let next = json_args(vec![
            JsValue::Number(slot as f64),
            JsValue::Number(1.0),
            JsValue::Number(1.0),
        ]);
        error = BcBuf::default();
        assert_eq!(
            unsafe {
                bc_write_f64_observe(
                    target,
                    b"nativeAsyncTargetBuffer".as_ptr(),
                    b"nativeAsyncTargetBuffer".len(),
                    next.as_ptr(),
                    next.len(),
                    0,
                    source_value.as_ptr(),
                    1,
                    &mut receipt,
                    ptr::null_mut(),
                    &mut error,
                )
            },
            BcStatus::BC_OK
        );
        assert_eq!(receipt.actual_count, 1);
        assert!(receipt.did_write);
    }

    // A Core exception wins over the same invalid host count and publishes no fake receipt.
    let mut absent_host = Box::new(HostContext::new());
    let absent = unsafe { new_engine(&mut absent_host) };
    let arguments = b"[0,0,1]";
    let mut receipt = BcF64WriteReceipt::default();
    let mut before = BcF64Buf::default();
    let mut error = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_write_f64_observe(
                absent,
                b"nativeAsyncTargetBuffer".as_ptr(),
                b"nativeAsyncTargetBuffer".len(),
                arguments.as_ptr(),
                arguments.len(),
                0,
                ptr::null(),
                -1,
                &mut receipt,
                &mut before,
                &mut error,
            )
        },
        BcStatus::BC_THROW
    );
    assert_eq!(receipt, BcF64WriteReceipt::default());
    assert!(before.ptr.is_null());
    assert!(!error.ptr.is_null());
    unsafe {
        bc_buf_free(error);
        bc_engine_free(absent);
        bc_engine_free(target);
    }
    receipt = BcF64WriteReceipt::default();
    before = BcF64Buf::default();
    error = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_write_f64_observe(
                target,
                b"nativeAsyncTargetBuffer".as_ptr(),
                b"nativeAsyncTargetBuffer".len(),
                b"[4,0,1]".as_ptr(),
                7,
                0,
                ptr::null(),
                0,
                &mut receipt,
                &mut before,
                &mut error,
            )
        },
        BcStatus::BC_CLOSED
    );
    assert_eq!(receipt, BcF64WriteReceipt::default());
    assert!(before.ptr.is_null());
    assert_eq!(unsafe { bytes_and_free(error) }, DISPOSED);
    unsafe { bc_engine_free(source) };
}

#[test]
fn read_snapshot_owns_actual_length_empty_and_error_results() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine(&mut host) };
    let mut output = BcF64Buf::default();
    let mut error = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_read_f64_snapshot(
                engine,
                b"__bcReadLastF64ForTest".as_ptr(),
                b"__bcReadLastF64ForTest".len(),
                b"[]".as_ptr(),
                2,
                &mut output,
                &mut error,
            )
        },
        BcStatus::BC_OK
    );
    assert!(output.ptr.is_null());
    assert_eq!((output.len, output.cap), (0, 0));
    assert!(error.ptr.is_null());

    assert_eq!(
        unsafe {
            bc_read_f64_snapshot(
                engine,
                b"__bcReadF64ForTest".as_ptr(),
                b"__bcReadF64ForTest".len(),
                b"[]".as_ptr(),
                2,
                &mut output,
                &mut error,
            )
        },
        BcStatus::BC_OK
    );
    assert_eq!((output.len, output.cap), (4, 4));
    let expected = [
        0.0_f64.to_bits(),
        (-0.0_f64).to_bits(),
        0x7ff8_0000_0000_0042,
        f64::INFINITY.to_bits(),
    ];
    assert_eq!(
        unsafe { slice::from_raw_parts(output.ptr, output.len) }
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
        expected
    );
    unsafe { bc_f64_buf_free(output) };

    output = BcF64Buf::default();
    error = BcBuf::default();
    assert_eq!(
        unsafe {
            bc_read_f64_snapshot(
                engine,
                b"missing".as_ptr(),
                b"missing".len(),
                b"[]".as_ptr(),
                2,
                &mut output,
                &mut error,
            )
        },
        BcStatus::BC_UNAVAILABLE
    );
    assert!(output.ptr.is_null());
    assert_eq!((output.len, output.cap), (0, 0));
    assert!(!error.ptr.is_null());
    let (_, stats) = unsafe { memory_stats(engine) };
    assert!(stats_number(&stats, "retainedOutputBytes") >= error.cap as u64);
    unsafe {
        bc_buf_free(error);
        bc_engine_free(engine);
    }
}

#[test]
fn packet_f64_buffers_are_aligned_bit_exact_and_return_to_baseline() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine(&mut host) };
    let (_, baseline) = unsafe { memory_stats(engine) };
    let baseline_live = stats_number(&baseline, "requestedLiveBytes");
    assert_eq!(stats_number(&baseline, "retainedOutputBytes"), 0);

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
    let (_, retained_stats) = unsafe { memory_stats(engine) };
    assert!(stats_number(&retained_stats, "retainedOutputBytes") >= 4 * 8);
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
    assert_eq!(stats_number(&after, "requestedLiveBytes"), baseline_live);
    assert_eq!(stats_number(&after, "retainedOutputBytes"), 0);

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

#[test]
fn packet_second_output_oom_rolls_back_first_output() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine_with_limit(&mut host, 16_384) };
    let mut metadata = BcBuf::default();
    let mut numbers = BcF64Buf::default();
    let args = br#"["__bcPacketForTestLarge"]"#;
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
        BcStatus::BC_OOM_LIMIT
    );
    assert!(metadata.ptr.is_null());
    assert_eq!((metadata.len, metadata.cap), (0, 0));
    assert!(numbers.ptr.is_null());
    assert_eq!((numbers.len, numbers.cap), (0, 0));
    let (_, stats) = unsafe { memory_stats(engine) };
    assert_eq!(stats_number(&stats, "retainedOutputBytes"), 0);
    let (status, output) = unsafe { call(engine, b"nativeEcho", br#"["ok"]"#, 0) };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(output, br#""ok""#);
    unsafe { bc_engine_free(engine) };
}

#[test]
fn real_indicator_f64_transport_preserves_warmup_nan_and_uses_slice_arguments() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine(&mut host) };
    let (status, _) = unsafe { call(engine, b"nativeInit", br#"[32,{}]"#, 0) };
    assert_eq!(status, BcStatus::BC_OK);
    let (status, _) = unsafe {
        call(
            engine,
            b"nativeCommand",
            br#"["addIndicator",["e","ema",{"period":3}]]"#,
            0,
        )
    };
    assert_eq!(status, BcStatus::BC_OK);
    let mut out = [123.0; 4];
    let mut error = BcBuf::default();
    let args = br#"["e","value",0,4]"#;
    let status = unsafe {
        bc_read_f64(
            engine,
            b"nativeIndicatorBuffer".as_ptr(),
            21,
            args.as_ptr(),
            args.len(),
            out.as_mut_ptr(),
            out.len(),
            &mut error,
        )
    };
    assert_eq!(status, BcStatus::BC_OK);
    assert!(error.ptr.is_null());
    assert!(out[0].is_nan() && out[1].is_nan());
    assert!(out[2].is_finite() && out[3].is_finite());
    let mut snapshot = BcF64Buf::default();
    assert_eq!(
        unsafe {
            bc_read_f64_snapshot(
                engine,
                b"nativeIndicatorBuffer".as_ptr(),
                21,
                args.as_ptr(),
                args.len(),
                &mut snapshot,
                &mut error,
            )
        },
        BcStatus::BC_OK
    );
    assert_eq!((snapshot.len, snapshot.cap), (4, 4));
    assert_eq!(
        unsafe { slice::from_raw_parts(snapshot.ptr, snapshot.len) }
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
        out.map(f64::to_bits)
    );
    unsafe { bc_f64_buf_free(snapshot) };
    let mut coerced = [0.0; 2];
    let args = br#"["e",["value"],2,2]"#;
    let status = unsafe {
        bc_read_f64(
            engine,
            b"nativeIndicatorBuffer".as_ptr(),
            21,
            args.as_ptr(),
            args.len(),
            coerced.as_mut_ptr(),
            coerced.len(),
            &mut error,
        )
    };
    assert_eq!(status, BcStatus::BC_OK);
    assert_eq!(
        coerced.map(f64::to_bits),
        [out[2].to_bits(), out[3].to_bits()]
    );
    let previous = out.map(f64::to_bits);
    let args = br#"["e","value",31,4]"#;
    let status = unsafe {
        bc_read_f64(
            engine,
            b"nativeIndicatorBuffer".as_ptr(),
            21,
            args.as_ptr(),
            args.len(),
            out.as_mut_ptr(),
            out.len(),
            &mut error,
        )
    };
    assert_eq!(status, BcStatus::BC_THROW);
    assert_eq!(out.map(f64::to_bits), previous);
    unsafe {
        bc_buf_free(error);
        bc_engine_free(engine)
    };
}

#[test]
fn scene_packet_abi_returns_real_metadata_and_owned_renderer_numbers() {
    let _guard = serial();
    let mut host = Box::new(HostContext::new());
    let engine = unsafe { new_engine(&mut host) };
    let (status, _) = unsafe { call(engine, b"nativeInit", br#"[32,{}]"#, 0) };
    assert_eq!(status, BcStatus::BC_OK);
    let args = br#"["scene",null,400,300,false]"#;
    let mut metadata = BcBuf::default();
    let mut numbers = BcF64Buf::default();
    let status = unsafe {
        bc_packet(
            engine,
            args.as_ptr(),
            args.len(),
            &mut metadata,
            &mut numbers,
        )
    };
    assert_eq!(status, BcStatus::BC_OK);
    assert!(!metadata.ptr.is_null());
    assert!(!numbers.ptr.is_null());
    assert!(numbers.len > 15);
    let text = unsafe { bytes_and_free(metadata) };
    let text = String::from_utf8(text).unwrap();
    assert!(text.contains("aster.native.commands"));
    assert!(text.contains("\"mode\":\"scene\""));
    assert!(text.contains("\"storedBars\":32"));
    assert!(
        unsafe { std::slice::from_raw_parts(numbers.ptr, numbers.len) }
            .iter()
            .all(|v| v.is_finite())
    );
    unsafe {
        bc_f64_buf_free(numbers);
        bc_engine_free(engine)
    };
}
