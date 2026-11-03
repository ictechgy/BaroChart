//! BaroChart Rust 코어의 공통 C ABI.
//!
//! 이 크레이트만 `unsafe`를 담당한다. 날 포인터는 헤더에 적힌 유효성과 소유권 조건을
//! 호출자가 지키는 동안만 유효하다. 모든 C export는 Rust panic을 C로 넘기지 않는다.

#![warn(missing_docs)]

use std::cell::UnsafeCell;
use std::collections::BTreeMap;
use std::ffi::c_void;
use std::mem::{align_of, size_of};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::slice;
use std::str;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn js_log(value: f64) -> f64;
    fn js_exp(value: f64) -> f64;
    fn js_hypot(left: f64, right: f64) -> f64;
    fn zone_resolve(
        host_id: u32,
        name: *const u8,
        name_len: u32,
        output: *mut u8,
        output_cap: u32,
    ) -> i32;
    fn zone_offset_seconds(host_id: u32, zone: *const u8, zone_len: u32, epoch_ms: f64) -> i32;
    fn host_release(host_id: u32);
}

use barochart_core::{Engine, Host, HostError};
use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue, JsonMode, parse_json, stringify_json};
use barochart_js::string::JsString;

/// 무손실 BCJSON 입력과 출력을 선택하는 플래그다.
pub const BC_FLAG_LOSSLESS: u32 = 1;

#[cfg(not(target_arch = "wasm32"))]
const F64_TRANSFER_LIMIT: usize = 262_144;
#[cfg(target_arch = "wasm32")]
const WASM_ALLOC_ALIGN: usize = 8;
const DISPOSED_ERROR: &[u8] = br#"{"name":"Error","message":"Chart disposed"}"#;
#[cfg(debug_assertions)]
const HOST_ERROR: &str = "Host time-zone callback failed";
#[cfg(debug_assertions)]
const ZONE_LIMIT_ERROR: &str = "Timezone string, at most 128 characters required";

static BYTE_BUFFERS: AtomicUsize = AtomicUsize::new(0);
static BYTE_CAPACITY: AtomicUsize = AtomicUsize::new(0);
#[cfg(not(target_arch = "wasm32"))]
static F64_BUFFERS: AtomicUsize = AtomicUsize::new(0);
#[cfg(not(target_arch = "wasm32"))]
static F64_CAPACITY: AtomicUsize = AtomicUsize::new(0);
static NEXT_ENGINE_ID: AtomicUsize = AtomicUsize::new(1);
static ENGINES: OnceLock<Mutex<BTreeMap<usize, Arc<EngineSlot>>>> = OnceLock::new();

/// C ABI 호출 상태다.
#[allow(non_camel_case_types)]
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BcStatus {
    /// 성공했다.
    BC_OK = 0,
    /// 코어가 JavaScript 오류를 던졌다.
    BC_THROW = 1,
    /// Rust 백엔드에 아직 이식되지 않은 함수다.
    BC_UNAVAILABLE = 2,
    /// 이미 해제된 단조 핸들 ID다.
    BC_CLOSED = 3,
    /// Rust panic 뒤 poison된 엔진이다.
    BC_POISONED = 4,
    /// 동시 진입이나 콜백 재진입이 거부됐다.
    BC_BUSY = 5,
    /// 포인터·UTF-8·JSON·플래그 같은 전송 계약이 틀렸다.
    BC_INVALID = 6,
}

/// Rust가 할당한 바이트 버퍼다.
/// `ptr == NULL`이면 `len == cap == 0`이다. 소유자는 값을 바꾸지 말고 정확히 한 번 `bc_buf_free`로 돌려준다.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BcBuf {
    /// 바이트 시작 포인터다. 비어 있으면 NULL이다.
    pub ptr: *mut u8,
    /// 유효한 바이트 수다.
    pub len: usize,
    /// Rust 할당 용량이다.
    pub cap: usize,
}

impl Default for BcBuf {
    fn default() -> Self {
        Self {
            ptr: ptr::null_mut(),
            len: 0,
            cap: 0,
        }
    }
}

/// Rust가 할당한 `double` 버퍼다.
/// `len`과 `cap`은 바이트가 아니라 원소 수고, 포인터는 `double`에 맞게 정렬된다.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BcF64Buf {
    /// `double` 원소의 시작 포인터다. 비어 있으면 NULL이다.
    pub ptr: *mut f64,
    /// 유효한 `double` 원소 수다.
    pub len: usize,
    /// Rust 할당 용량인 `double` 원소 수다.
    pub cap: usize,
}

impl Default for BcF64Buf {
    fn default() -> Self {
        Self {
            ptr: ptr::null_mut(),
            len: 0,
            cap: 0,
        }
    }
}

/// 엔진이 소유하는 플랫폼 콜백 표다.
/// 모든 콜백은 unwind하지 않아야 하고, 바이트 입력은 해당 콜백 중에만 유효하다.
/// `bc_engine_new == BC_OK`일 때만 context 소유권이 엔진으로 넘어간다.
/// 엔진은 순차적으로 다른 스레드로 옮겨갈 수 있고 terminal `release`는 마지막 lease 스레드에서 불릴 수 있다.
/// context를 여러 엔진이 공유하면 호스트가 retain/refcount와 엔진별 `release` 1회를 동기화해야 한다.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct BcHost {
    /// 모든 콜백에 넘길 호스트 context다. NULL을 허용한다.
    pub context: *mut c_void,
    /// 시간대 이름을 표준 이름으로 동기 해석한다. 필수 콜백이다.
    /// 반환 코드와 무관하게 nonempty 출력은 `bc_buf_new_copy`가 만든 고유한 버퍼여야 한다.
    pub zone_resolve:
        Option<unsafe extern "C" fn(*mut c_void, *const u8, usize, *mut BcBuf) -> i32>,
    /// 지정 시각의 시간대 오프셋을 초 단위로 동기 작성한다. 필수 콜백이다.
    pub zone_offset_seconds:
        Option<unsafe extern "C" fn(*mut c_void, *const u8, usize, f64, *mut i32) -> i32>,
    /// 선택적 개발자 진단 로그 콜백이다.
    pub log: Option<unsafe extern "C" fn(*mut c_void, i32, *const u8, usize)>,
    /// 선택적 context 정리 콜백이다. terminal이며 context를 쓰는 export 재진입은 금지다.
    /// registry lock은 이미 풀려 있으므로 제거된 같은 token의 반복 `bc_engine_free`는 no-op으로 허용한다.
    pub release: Option<unsafe extern "C" fn(*mut c_void)>,
}

/// C에서는 역참조하지 않는 단조 핸들 ID 타입이다.
pub struct BcEngine {
    _opaque: [u8; 0],
}

struct EngineSlot {
    busy: AtomicBool,
    closed: AtomicBool,
    poisoned: AtomicBool,
    host: BcHost,
    core: UnsafeCell<Engine>,
    #[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
    test_f64: Mutex<Vec<u64>>,
}

// SAFETY: core는 busy CAS를 통해 한 스레드만 접근하고 Arc lease가 활성 호출 중 drop을 막는다.
unsafe impl Send for EngineSlot {}
// SAFETY: 위와 같은 gate가 `UnsafeCell<Engine>`의 배타적 접근을 보장한다.
unsafe impl Sync for EngineSlot {}

struct FfiHost {
    raw: BcHost,
    release_armed: Arc<AtomicBool>,
}

// SAFETY: BcHost 계약은 엔진과 함께 스레드 간 순차 이동해도 context가 유효하다고 정한다.
unsafe impl Send for FfiHost {}

impl Host for FfiHost {
    fn zone_resolve(&self, name: &JsString) -> Result<JsString, HostError> {
        let callback = self.raw.zone_resolve.ok_or(HostError)?;
        let name = name.to_string_lossy();
        let mut out = BcBuf::default();
        // SAFETY: callback은 생성 때 검증되었고 context는 FfiHost 수명 동안 유효하다.
        let result = unsafe {
            callback(
                self.raw.context,
                name.as_bytes().as_ptr(),
                name.len(),
                &mut out,
            )
        };
        let owned = OwnedBuf(out);
        if result != 0 || !valid_buf(owned.0) || owned.0.len == 0 {
            return Err(HostError);
        }
        // SAFETY: valid_buf가 구조를 확인했고 callback 계약상 Rust 할당이다.
        let bytes = unsafe { slice::from_raw_parts(owned.0.ptr, owned.0.len) };
        let text = str::from_utf8(bytes).map_err(|_| HostError)?;
        if !(1..=128).contains(&text.encode_utf16().count()) {
            return Err(HostError);
        }
        Ok(JsString::from_str(text))
    }

    fn zone_offset_seconds(&self, zone: &JsString, epoch_ms: f64) -> Result<i32, HostError> {
        let callback = self.raw.zone_offset_seconds.ok_or(HostError)?;
        let zone = zone.to_string_lossy();
        let mut offset = 0;
        // SAFETY: callback/context는 BcHost 수명 계약을 따른다.
        let result = unsafe {
            callback(
                self.raw.context,
                zone.as_bytes().as_ptr(),
                zone.len(),
                epoch_ms,
                &mut offset,
            )
        };
        if result == 0 {
            Ok(offset)
        } else {
            Err(HostError)
        }
    }

    fn log(&self, level: i32, message: &str) {
        if let Some(callback) = self.raw.log {
            // SAFETY: log callback은 unwind하지 않고 입력을 보관하지 않는 BcHost 계약을 따른다.
            unsafe {
                callback(
                    self.raw.context,
                    level,
                    message.as_bytes().as_ptr(),
                    message.len(),
                )
            };
        }
    }
}

impl Drop for FfiHost {
    fn drop(&mut self) {
        if self.release_armed.swap(false, Ordering::AcqRel)
            && let Some(release) = self.raw.release
        {
            // SAFETY: 소유권은 성공한 new에서 이 FfiHost로 한 번만 이동했다.
            unsafe { release(self.raw.context) };
        }
    }
}

struct OwnedBuf(BcBuf);

impl Drop for OwnedBuf {
    fn drop(&mut self) {
        // SAFETY: callback 계약상 nonempty 버퍼는 bc_buf_new_copy가 만든 고유 버퍼다.
        unsafe { free_buf(self.0) };
    }
}

fn registry() -> &'static Mutex<BTreeMap<usize, Arc<EngineSlot>>> {
    ENGINES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn locked_registry() -> std::sync::MutexGuard<'static, BTreeMap<usize, Arc<EngineSlot>>> {
    // lock 안에서는 BTreeMap의 정수 키 get/clone/insert/remove만 한다. callback·core·소멸자를
    // 부르지 않으므로 panic 복구 후에도 모든 entry는 완전한 Arc 하나를 가리킨다.
    registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn engine_id(engine: *const BcEngine) -> Result<usize, BcStatus> {
    let encoded = engine.addr();
    if encoded == 0 {
        Err(BcStatus::BC_INVALID)
    } else if encoded & 7 != 0 || encoded >> 3 == 0 {
        Err(BcStatus::BC_CLOSED)
    } else {
        Ok(encoded >> 3)
    }
}

fn handle_from_id(id: usize) -> *mut BcEngine {
    ptr::without_provenance_mut(id << 3)
}

fn next_engine_id() -> Option<usize> {
    let maximum = (usize::MAX >> 3).min((i64::MAX as usize) >> 3);
    NEXT_ENGINE_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            (current <= maximum).then(|| current + 1)
        })
        .ok()
}

fn lease(engine: *const BcEngine) -> Result<Arc<EngineSlot>, BcStatus> {
    let id = engine_id(engine)?;
    locked_registry()
        .get(&id)
        .cloned()
        .ok_or(BcStatus::BC_CLOSED)
}

fn ffi_status(run: impl FnOnce() -> BcStatus) -> BcStatus {
    catch_unwind(AssertUnwindSafe(run)).unwrap_or(BcStatus::BC_INVALID)
}

fn ffi_void(run: impl FnOnce()) {
    let _ = catch_unwind(AssertUnwindSafe(run));
}

fn valid_buf(buf: BcBuf) -> bool {
    (buf.ptr.is_null() && buf.len == 0 && buf.cap == 0)
        || (!buf.ptr.is_null()
            && buf.cap > 0
            && buf.len <= buf.cap
            && buf.cap <= isize::MAX as usize)
}

#[cfg(target_arch = "wasm32")]
fn wasm_memory_range(address: usize, len: usize, alignment: usize) -> bool {
    let total = (core::arch::wasm32::memory_size::<0>() as u64) * 65_536;
    let address = address as u64;
    let len = len as u64;
    address <= total && len <= total - address && address.is_multiple_of(alignment as u64)
}

#[cfg(not(target_arch = "wasm32"))]
fn wasm_memory_range(_: usize, _: usize, _: usize) -> bool {
    true
}

fn wasm_pointer_range(pointer: *const u8, len: usize, alignment: usize) -> bool {
    wasm_memory_range(pointer.addr(), len, alignment)
}

unsafe fn empty_buf(out: *mut BcBuf) -> bool {
    if out.is_null() || !wasm_memory_range(out.addr(), size_of::<BcBuf>(), align_of::<BcBuf>()) {
        return false;
    }
    // SAFETY: 호출자가 writable BcBuf 출력을 넘긴다는 export 계약을 따른다.
    unsafe { out.write(BcBuf::default()) };
    true
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn empty_f64_buf(out: *mut BcF64Buf) -> bool {
    if out.is_null()
        || !wasm_memory_range(out.addr(), size_of::<BcF64Buf>(), align_of::<BcF64Buf>())
    {
        return false;
    }
    // SAFETY: 호출자가 writable BcF64Buf 출력을 넘긴다는 export 계약을 따른다.
    unsafe { out.write(BcF64Buf::default()) };
    true
}

unsafe fn bytes<'a>(data: *const u8, len: usize) -> Option<&'a [u8]> {
    if len == 0 {
        return Some(&[]);
    }
    if data.is_null() || len > isize::MAX as usize || !wasm_pointer_range(data, len, 1) {
        return None;
    }
    // SAFETY: 호출자는 len 바이트를 읽을 수 있는 포인터를 넘긴다.
    Some(unsafe { slice::from_raw_parts(data, len) })
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn f64_input<'a>(data: *const f64, count: usize) -> Option<&'a [f64]> {
    if count == 0 {
        return Some(&[]);
    }
    if data.is_null()
        || !(data as usize).is_multiple_of(align_of::<f64>())
        || count > isize::MAX as usize / size_of::<f64>()
        || !wasm_memory_range(
            data.addr(),
            count.saturating_mul(size_of::<f64>()),
            align_of::<f64>(),
        )
    {
        return None;
    }
    // SAFETY: 호출자는 count개 f64를 읽을 수 있는 정렬된 포인터를 넘긴다.
    Some(unsafe { slice::from_raw_parts(data, count) })
}

#[cfg(not(target_arch = "wasm32"))]
fn valid_f64_output(data: *mut f64, count: usize) -> bool {
    count == 0
        || (!data.is_null()
            && (data as usize).is_multiple_of(align_of::<f64>())
            && count <= isize::MAX as usize / size_of::<f64>()
            && wasm_memory_range(
                data.addr(),
                count.saturating_mul(size_of::<f64>()),
                align_of::<f64>(),
            ))
}

fn allocate_bytes(source: &[u8]) -> Result<BcBuf, BcStatus> {
    if source.is_empty() {
        return Ok(BcBuf::default());
    }
    #[cfg(target_arch = "wasm32")]
    {
        use std::alloc::{Layout, alloc};
        let layout = Layout::from_size_align(source.len(), WASM_ALLOC_ALIGN)
            .map_err(|_| BcStatus::BC_THROW)?;
        // SAFETY: Layout은 유효하고 0이 아니며 free_buf까지 이 할당을 소유한다.
        let pointer = unsafe { alloc(layout) };
        if pointer.is_null() {
            return Err(BcStatus::BC_THROW);
        }
        // SAFETY: pointer에는 source.len()만큼 쓸 수 있고 source는 살아 있는 slice다.
        unsafe { ptr::copy_nonoverlapping(source.as_ptr(), pointer, source.len()) };
        BYTE_BUFFERS.fetch_add(1, Ordering::Relaxed);
        BYTE_CAPACITY.fetch_add(source.len(), Ordering::Relaxed);
        Ok(BcBuf {
            ptr: pointer,
            len: source.len(),
            cap: source.len(),
        })
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let mut owned = Vec::new();
        owned
            .try_reserve_exact(source.len())
            .map_err(|_| BcStatus::BC_THROW)?;
        owned.extend_from_slice(source);
        Ok(leak_bytes(owned))
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn leak_bytes(mut owned: Vec<u8>) -> BcBuf {
    if owned.is_empty() {
        return BcBuf::default();
    }
    let result = BcBuf {
        ptr: owned.as_mut_ptr(),
        len: owned.len(),
        cap: owned.capacity(),
    };
    BYTE_BUFFERS.fetch_add(1, Ordering::Relaxed);
    BYTE_CAPACITY.fetch_add(result.cap, Ordering::Relaxed);
    std::mem::forget(owned);
    result
}

#[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
fn leak_f64(mut owned: Vec<f64>) -> BcF64Buf {
    if owned.is_empty() {
        return BcF64Buf::default();
    }
    let result = BcF64Buf {
        ptr: owned.as_mut_ptr(),
        len: owned.len(),
        cap: owned.capacity(),
    };
    F64_BUFFERS.fetch_add(1, Ordering::Relaxed);
    F64_CAPACITY.fetch_add(result.cap, Ordering::Relaxed);
    std::mem::forget(owned);
    result
}

fn subtract(counter: &AtomicUsize, amount: usize) {
    let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
        Some(current.saturating_sub(amount))
    });
}

unsafe fn free_buf(buf: BcBuf) {
    if buf.ptr.is_null() {
        return;
    }
    if buf.cap == 0 || buf.len > buf.cap || buf.cap > isize::MAX as usize {
        return;
    }
    #[cfg(target_arch = "wasm32")]
    {
        if buf.len != buf.cap {
            return;
        }
        let Ok(layout) = std::alloc::Layout::from_size_align(buf.cap, WASM_ALLOC_ALIGN) else {
            return;
        };
        subtract(&BYTE_BUFFERS, 1);
        subtract(&BYTE_CAPACITY, buf.cap);
        // SAFETY: WASM 할당은 allocate_bytes가 이와 동일한 layout으로 만든다.
        unsafe { std::alloc::dealloc(buf.ptr, layout) };
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        subtract(&BYTE_BUFFERS, 1);
        subtract(&BYTE_CAPACITY, buf.cap);
        // SAFETY: 호출자는 Rust가 만든 변경하지 않은 고유 BcBuf를 정확히 한 번 반환한다.
        drop(unsafe { Vec::from_raw_parts(buf.ptr, buf.len, buf.cap) });
    }
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn free_f64_buf(buf: BcF64Buf) {
    if buf.ptr.is_null() {
        return;
    }
    if buf.cap == 0
        || buf.len > buf.cap
        || !(buf.ptr as usize).is_multiple_of(align_of::<f64>())
        || buf.cap > isize::MAX as usize / size_of::<f64>()
    {
        return;
    }
    subtract(&F64_BUFFERS, 1);
    subtract(&F64_CAPACITY, buf.cap);
    // SAFETY: 호출자는 Rust가 만든 변경하지 않은 고유 BcF64Buf를 정확히 한 번 반환한다.
    drop(unsafe { Vec::from_raw_parts(buf.ptr, buf.len, buf.cap) });
}

unsafe fn write_bytes(out: *mut BcBuf, source: &[u8]) -> Result<(), BcStatus> {
    let allocated = allocate_bytes(source)?;
    // SAFETY: 출력은 export 진입 시 writable임을 확인했다.
    unsafe { out.write(allocated) };
    Ok(())
}

fn error_json(error: &JsError) -> Vec<u8> {
    let mut object = JsObject::new();
    object.insert(
        JsString::from_str("name"),
        JsValue::String(JsString::from_str(error.name)),
    );
    object.insert(
        JsString::from_str("message"),
        JsValue::String(error.message.clone()),
    );
    object.insert(
        JsString::from_str("code"),
        error.code.as_ref().map_or(JsValue::Null, |code| {
            JsValue::String(JsString::from_str(code))
        }),
    );
    stringify_json(&JsValue::Object(object), JsonMode::Standard)
}

unsafe fn write_error(out: *mut BcBuf, error: &JsError) -> BcStatus {
    let status = if error.name == "UnavailableError" {
        BcStatus::BC_UNAVAILABLE
    } else {
        BcStatus::BC_THROW
    };
    // SAFETY: 호출자가 유효한 출력을 넘겼고 진입에서 빈 값으로 초기화했다.
    if unsafe { write_bytes(out, &error_json(error)) }.is_err() {
        BcStatus::BC_THROW
    } else {
        status
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn unavailable(name: &str) -> JsError {
    JsError::new(
        "UnavailableError",
        JsString::from_str(&format!("{name} is not available in the Rust backend yet")),
    )
}

struct BusyGuard<'a>(&'a EngineSlot);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::Release);
    }
}

fn log_panic(slot: &EngineSlot) {
    const MESSAGE: &[u8] = b"Rust core panic";
    if let Some(log) = slot.host.log {
        // SAFETY: BcHost log callback은 unwind하지 않고 입력을 보관하지 않는 계약이다.
        unsafe { log(slot.host.context, 3, MESSAGE.as_ptr(), MESSAGE.len()) };
    }
}

unsafe fn stateful<Prepared>(
    slot: &Arc<EngineSlot>,
    error_out: *mut BcBuf,
    prepare_name: impl FnOnce() -> Result<Prepared, BcStatus>,
    run: impl FnOnce(&mut Engine, Prepared) -> BcStatus,
) -> BcStatus {
    if slot.closed.load(Ordering::Acquire) {
        // SAFETY: export 진입에서 error_out을 writable canonical empty로 만들었다.
        let _ = unsafe { write_bytes(error_out, DISPOSED_ERROR) };
        return BcStatus::BC_CLOSED;
    }
    if slot
        .busy
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        return BcStatus::BC_BUSY;
    }
    let _busy = BusyGuard(slot);
    if slot.closed.load(Ordering::Acquire) {
        // SAFETY: export 진입에서 error_out을 writable canonical empty로 만들었다.
        let _ = unsafe { write_bytes(error_out, DISPOSED_ERROR) };
        return BcStatus::BC_CLOSED;
    }
    let prepared = match prepare_name() {
        Ok(prepared) => prepared,
        Err(status) => return status,
    };
    if slot.poisoned.load(Ordering::Acquire) {
        // SAFETY: export 진입에서 error_out을 writable canonical empty로 만들었다.
        let _ = unsafe { write_bytes(error_out, DISPOSED_ERROR) };
        return BcStatus::BC_POISONED;
    }
    let result = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: busy gate가 core에 대한 유일한 가변 접근을 보장한다.
        run(unsafe { &mut *slot.core.get() }, prepared)
    }));
    match result {
        Ok(status) => status,
        Err(_) => {
            slot.poisoned.store(true, Ordering::Release);
            // log callback 동안도 busy gate를 유지해 재진입을 BC_BUSY로 만든다.
            log_panic(slot);
            // SAFETY: export 진입에서 error_out을 writable canonical empty로 만들었다.
            let _ = unsafe { write_bytes(error_out, DISPOSED_ERROR) };
            BcStatus::BC_POISONED
        }
    }
}

fn mode(flags: u32) -> Option<JsonMode> {
    if flags & !BC_FLAG_LOSSLESS != 0 {
        None
    } else if flags & BC_FLAG_LOSSLESS != 0 {
        Some(JsonMode::Lossless)
    } else {
        Some(JsonMode::Standard)
    }
}

fn parse_args(source: &[u8], mode: JsonMode) -> Option<JsValue> {
    let parsed = parse_json(source, mode).ok()?;
    matches!(parsed, JsValue::Array(_)).then_some(parsed)
}

#[cfg(debug_assertions)]
fn debug_call(engine: &mut Engine, name: &str, args: &JsValue) -> Option<Result<JsValue, JsError>> {
    match name {
        "__bcPanicForTest" => panic!("__bcPanicForTest"),
        "__bcEchoForTest" => Some(Ok(args.clone())),
        "__bcSpecialValuesForTest" => Some(Ok(JsValue::Array(vec![
            JsValue::Number(f64::NAN),
            JsValue::Number(-0.0),
            JsValue::Number(f64::INFINITY),
            JsValue::Number(f64::NEG_INFINITY),
            JsValue::Undefined,
        ]))),
        "__bcAllocationStatsForTest" => Some(Ok(JsValue::Array(vec![
            JsValue::Number(BYTE_BUFFERS.load(Ordering::Relaxed) as f64),
            JsValue::Number(BYTE_CAPACITY.load(Ordering::Relaxed) as f64),
        ]))),
        "__bcErrorCodeForTest" => {
            let mut error = JsError::new("IngestionError", JsString::from_str("debug failure"));
            error.code = Some("TEST".to_owned());
            Some(Err(error))
        }
        "__bcZoneResolveForTest" => {
            let JsValue::Array(items) = args else {
                return Some(Err(JsError::new(
                    "TypeError",
                    JsString::from_str(ZONE_LIMIT_ERROR),
                )));
            };
            let Some(JsValue::String(zone)) = items.first() else {
                return Some(Err(JsError::new(
                    "TypeError",
                    JsString::from_str(ZONE_LIMIT_ERROR),
                )));
            };
            Some(
                engine
                    .zone_resolve(zone)
                    .map(JsValue::String)
                    .map_err(|_| JsError::new("TypeError", JsString::from_str(HOST_ERROR))),
            )
        }
        "__bcZoneOffsetForTest" => {
            let JsValue::Array(items) = args else {
                return Some(Err(JsError::new(
                    "TypeError",
                    JsString::from_str("Expected time zone and epoch"),
                )));
            };
            let (Some(JsValue::String(zone)), Some(JsValue::Number(epoch_ms))) =
                (items.first(), items.get(1))
            else {
                return Some(Err(JsError::new(
                    "TypeError",
                    JsString::from_str("Expected time zone and epoch"),
                )));
            };
            Some(
                engine
                    .zone_offset_seconds(zone, *epoch_ms)
                    .map(|offset| JsValue::Number(offset as f64))
                    .map_err(|_| JsError::new("TypeError", JsString::from_str(HOST_ERROR))),
            )
        }
        "__bcMathForTest" => {
            let JsValue::Array(items) = args else {
                return Some(Err(JsError::new(
                    "TypeError",
                    JsString::from_str("Expected operation and numbers"),
                )));
            };
            let (Some(JsValue::String(operation)), Some(JsValue::Number(left))) =
                (items.first(), items.get(1))
            else {
                return Some(Err(JsError::new(
                    "TypeError",
                    JsString::from_str("Expected operation and numbers"),
                )));
            };
            let result = match operation.to_string_lossy().as_str() {
                "log" => barochart_js::math::js_log(*left),
                "exp" => barochart_js::math::js_exp(*left),
                "hypot" => {
                    let Some(JsValue::Number(right)) = items.get(2) else {
                        return Some(Err(JsError::new(
                            "TypeError",
                            JsString::from_str("Expected operation and numbers"),
                        )));
                    };
                    barochart_js::math::js_hypot(*left, *right)
                }
                _ => {
                    return Some(Err(JsError::new(
                        "TypeError",
                        JsString::from_str("Unknown math probe"),
                    )));
                }
            };
            Some(Ok(JsValue::Number(result)))
        }
        _ => None,
    }
}

#[cfg(not(debug_assertions))]
fn debug_call(_: &mut Engine, _: &str, _: &JsValue) -> Option<Result<JsValue, JsError>> {
    None
}

/// 호스트 메모리에서 바이트를 복사해 Rust 소유 `BcBuf`를 만든다.
/// `src == NULL`은 `len == 0`일 때만 허용한다. 반환된 nonempty 버퍼는 정확히 한 번
/// `bc_buf_free`로 돌려주거나 `zone_resolve` 출력으로 소유권을 Rust에 넘긴다.
///
/// # Safety
/// `out`은 기존 live `BcBuf`를 담지 않은 writable slot이어야 하고 `src`와 alias하지 않아야 한다.
/// nonzero `len`이면 `src`에서 그 길이만큼 읽을 수 있어야 한다.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_buf_new_copy(src: *const u8, len: usize, out: *mut BcBuf) -> BcStatus {
    ffi_status(|| {
        // SAFETY: export 계약을 지키는 포인터만 접근한다.
        if !unsafe { empty_buf(out) } {
            return BcStatus::BC_INVALID;
        }
        // SAFETY: bytes가 NULL/len 구조를 먼저 검사한다.
        let Some(source) = (unsafe { bytes(src, len) }) else {
            return BcStatus::BC_INVALID;
        };
        match allocate_bytes(source) {
            Ok(buf) => {
                // SAFETY: out은 위에서 writable임을 확인했다.
                unsafe { out.write(buf) };
                BcStatus::BC_OK
            }
            Err(status) => status,
        }
    })
}

unsafe fn lease_error(status: BcStatus, out: *mut BcBuf) -> BcStatus {
    if status == BcStatus::BC_CLOSED {
        // SAFETY: export 진입에서 out을 writable canonical empty로 만들었다.
        let _ = unsafe { write_bytes(out, DISPOSED_ERROR) };
    }
    status
}

unsafe fn clear_engine_new_outputs(engine_out: *mut *mut BcEngine, error_out: *mut BcBuf) -> bool {
    if engine_out.is_null()
        || !wasm_memory_range(
            engine_out.addr(),
            size_of::<*mut BcEngine>(),
            align_of::<*mut BcEngine>(),
        )
    {
        return false;
    }
    // SAFETY: 호출자가 쓰기 가능한 엔진 출력 slot을 제공했다.
    unsafe { engine_out.write(ptr::null_mut()) };
    if error_out.is_null()
        || !wasm_memory_range(error_out.addr(), size_of::<BcBuf>(), align_of::<BcBuf>())
    {
        return false;
    }
    // SAFETY: error_out은 출력 descriptor이며 현재 canonical empty다.
    unsafe { empty_buf(error_out) }
}

unsafe fn engine_new_prepared(
    raw: BcHost,
    engine_out: *mut *mut BcEngine,
    error_out: *mut BcBuf,
) -> BcStatus {
    ffi_status(|| {
        if raw.zone_resolve.is_none() || raw.zone_offset_seconds.is_none() {
            return BcStatus::BC_INVALID;
        }
        let Some(id) = next_engine_id() else {
            let error = JsError::new("Error", JsString::from_str("Rust engine handle limit"));
            // SAFETY: error_out은 비운 writable 출력이다.
            return unsafe { write_error(error_out, &error) };
        };
        let release_armed = Arc::new(AtomicBool::new(false));
        let core = Engine::new(Box::new(FfiHost {
            raw,
            release_armed: Arc::clone(&release_armed),
        }));
        let slot = Arc::new(EngineSlot {
            busy: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            poisoned: AtomicBool::new(false),
            host: raw,
            core: UnsafeCell::new(core),
            #[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
            test_f64: Mutex::new(Vec::new()),
        });
        {
            let mut engines = locked_registry();
            let std::collections::btree_map::Entry::Vacant(entry) = engines.entry(id) else {
                return BcStatus::BC_INVALID;
            };
            entry.insert(Arc::clone(&slot));
            // registry lock을 유지한 채 ownership을 arm하고 token을 게시해 중간 상태 조회를 막는다.
            release_armed.store(true, Ordering::Release);
            // SAFETY: engine_out은 writable고 token은 역참조하지 않는다.
            unsafe { engine_out.write(handle_from_id(id)) };
        }
        BcStatus::BC_OK
    })
}

/// 호스트 콜백을 소유하는 빈 Rust 엔진을 만든다.
/// 성공할 때만 context 소유권이 엔진으로 넘어간다. 반환된 `BcEngine *`는 64-bit Apple/Android에서
/// 저장·비교·재전달만 하는 8-byte 배수 token이며 역참조하면 안 된다.
///
/// # Safety
/// `host`, `engine_out`, `error_out`은 각각 읽기/쓰기 가능하고 서로 alias하지 않아야 한다.
/// `error_out`은 기존 live `BcBuf`를 담지 않은 slot이어야 하며, 콜백과 context는 헤더 수명 계약을 따른다.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_engine_new(
    host: *const BcHost,
    engine_out: *mut *mut BcEngine,
    error_out: *mut BcBuf,
) -> BcStatus {
    ffi_status(|| {
        // SAFETY: 네이티브에는 WASM 경계가 없지만 출력 slot에는 여전히 쓸 수 있어야 한다.
        if !unsafe { clear_engine_new_outputs(engine_out, error_out) } || host.is_null() {
            return BcStatus::BC_INVALID;
        }
        // SAFETY: 호출자가 C ABI에 따라 읽기 가능한 BcHost를 보장한다.
        let raw = unsafe { *host };
        // SAFETY: 출력 slot을 검증하고 초기화했다.
        unsafe { engine_new_prepared(raw, engine_out, error_out) }
    })
}

#[cfg(target_arch = "wasm32")]
unsafe extern "C" fn wasm_zone_resolve(
    context: *mut c_void,
    name: *const u8,
    name_len: usize,
    output: *mut BcBuf,
) -> i32 {
    let host_id = context.addr() as u32;
    if host_id == 0
        || output.is_null()
        || !wasm_memory_range(output.addr(), size_of::<BcBuf>(), align_of::<BcBuf>())
    {
        return 1;
    }
    // SAFETY: bytes가 slice를 만들기 전에 원본 구간을 검사한다.
    let Some(name) = (unsafe { bytes(name, name_len) }) else {
        return 1;
    };
    let mut scratch = [0_u8; 512];
    let written = unsafe {
        zone_resolve(
            host_id,
            name.as_ptr(),
            name.len() as u32,
            scratch.as_mut_ptr(),
            scratch.len() as u32,
        )
    };
    if written <= 0 || written as usize > scratch.len() {
        return 1;
    }
    match allocate_bytes(&scratch[..written as usize]) {
        Ok(buffer) => {
            // SAFETY: FFI는 쓰기 가능하고 비어 있는 BcBuf 출력을 제공한다.
            unsafe { output.write(buffer) };
            0
        }
        Err(_) => 1,
    }
}

#[cfg(target_arch = "wasm32")]
unsafe extern "C" fn wasm_zone_offset(
    context: *mut c_void,
    zone: *const u8,
    zone_len: usize,
    epoch_ms: f64,
    output: *mut i32,
) -> i32 {
    let host_id = context.addr() as u32;
    if host_id == 0
        || output.is_null()
        || !wasm_memory_range(output.addr(), size_of::<i32>(), align_of::<i32>())
    {
        return 1;
    }
    // SAFETY: bytes가 slice를 만들기 전에 원본 구간을 검사한다.
    let Some(zone) = (unsafe { bytes(zone, zone_len) }) else {
        return 1;
    };
    let offset =
        unsafe { zone_offset_seconds(host_id, zone.as_ptr(), zone.len() as u32, epoch_ms) };
    if offset == i32::MIN {
        return 1;
    }
    // SAFETY: 위에서 출력 구간을 검사했다.
    unsafe { output.write(offset) };
    0
}

#[cfg(target_arch = "wasm32")]
unsafe extern "C" fn wasm_release(context: *mut c_void) {
    let host_id = context.addr() as u32;
    if host_id != 0 {
        unsafe { host_release(host_id) }
    }
}

#[cfg(target_arch = "wasm32")]
fn wasm_math_log(value: f64) -> f64 {
    unsafe { js_log(value) }
}
#[cfg(target_arch = "wasm32")]
fn wasm_math_exp(value: f64) -> f64 {
    unsafe { js_exp(value) }
}
#[cfg(target_arch = "wasm32")]
fn wasm_math_hypot(left: f64, right: f64) -> f64 {
    unsafe { js_hypot(left, right) }
}

/// import가 식별하는 `host_id`를 소유하는 WASM 엔진을 만든다.
///
/// # Safety
/// 출력 slot은 쓰기 가능하고 서로 겹치지 않는 선형 메모리 구간이어야 한다.
/// 0이 아닌 host id는 release까지 유효해야 한다.
/// cbindgen:ignore
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_engine_new(
    host_id: u32,
    engine_out: *mut *mut BcEngine,
    error_out: *mut BcBuf,
) -> BcStatus {
    ffi_status(|| {
        // SAFETY: helper가 현재 선형 메모리에 대해 두 출력 구간을 검사하고 초기화한다.
        if !unsafe { clear_engine_new_outputs(engine_out, error_out) }
            || host_id == 0
            || !barochart_js::math::install_wasm_math(wasm_math_log, wasm_math_exp, wasm_math_hypot)
        {
            return BcStatus::BC_INVALID;
        }
        let raw = BcHost {
            context: ptr::without_provenance_mut(host_id as usize),
            zone_resolve: Some(wasm_zone_resolve),
            zone_offset_seconds: Some(wasm_zone_offset),
            log: None,
            release: Some(wasm_release),
        };
        // SAFETY: 출력 slot을 검증하고 초기화했다.
        unsafe { engine_new_prepared(raw, engine_out, error_out) }
    })
}

/// 함수 이름과 JSON/BCJSON 배열 인자로 Rust 코어를 부른다.
/// `BC_THROW`/`BC_UNAVAILABLE`의 출력은 flags와 무관한 Standard JSON이며 `code`가 없으면 `null`이다.
/// stale token은 `BC_CLOSED`, 활성 호출 중 재진입은 `BC_BUSY`다.
///
/// # Safety
/// 핸들 token은 변조하지 않아야 하고 입력 구간은 읽기 가능해야 한다.
/// `out`은 기존 live `BcBuf`를 담지 않고 name/args와 alias하지 않는 writable slot이어야 한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_call(
    engine: *mut BcEngine,
    name: *const u8,
    name_len: usize,
    args: *const u8,
    args_len: usize,
    flags: u32,
    out: *mut BcBuf,
) -> BcStatus {
    ffi_status(|| {
        // SAFETY: export 입출력 구조를 검사한다.
        if !unsafe { empty_buf(out) } {
            return BcStatus::BC_INVALID;
        }
        let slot = match lease(engine) {
            Ok(slot) => slot,
            Err(status) => return unsafe { lease_error(status, out) },
        };
        // SAFETY: Arc lease가 slot을 유지하고 out은 비운 writable 출력이다.
        unsafe {
            stateful(
                &slot,
                out,
                || {
                    let name = bytes(name, name_len).ok_or(BcStatus::BC_INVALID)?;
                    str::from_utf8(name).map_err(|_| BcStatus::BC_INVALID)
                },
                |core, name| {
                    let Some(json_mode) = mode(flags) else {
                        return BcStatus::BC_INVALID;
                    };
                    let Some(args) = bytes(args, args_len) else {
                        return BcStatus::BC_INVALID;
                    };
                    let Some(parsed) = parse_args(args, json_mode) else {
                        return BcStatus::BC_INVALID;
                    };
                    let result = debug_call(core, name, &parsed).unwrap_or_else(|| {
                        let JsValue::Array(values) = &parsed else {
                            unreachable!()
                        };
                        barochart_bridge::call(core, name, values)
                    });
                    match result {
                        Ok(value) => {
                            let encoded = stringify_json(&value, json_mode);
                            if write_bytes(out, &encoded).is_ok() {
                                BcStatus::BC_OK
                            } else {
                                BcStatus::BC_THROW
                            }
                        }
                        Err(error) => write_error(out, &error),
                    }
                },
            )
        }
    })
}

/// 현재 live Rust 함수 표가 이름을 지원하는지 묻는 정적 메타데이터 조회다.
/// busy/poison gate를 취득하지 않고, stale·NULL·변조 token은 `false`다.
///
/// # Safety
/// non-NULL token은 `bc_engine_new`의 반환값 그대로여야 하고 이름 구간은 읽기 가능해야 한다.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_supports(
    engine: *const BcEngine,
    name: *const u8,
    name_len: usize,
) -> bool {
    catch_unwind(AssertUnwindSafe(|| {
        let Ok(id) = engine_id(engine) else {
            return false;
        };
        if !locked_registry().contains_key(&id) {
            return false;
        }
        // SAFETY: bytes가 NULL/len을 검증한다.
        let Some(name) = (unsafe { bytes(name, name_len) }) else {
            return false;
        };
        str::from_utf8(name).is_ok_and(barochart_bridge::supports)
    }))
    .unwrap_or(false)
}

/// Rust 함수의 숫자 배열 결과를 호스트 `double` 배열로 복사한다.
/// 인자는 Standard JSON 배열만 받는다. 실패·busy·poison에서 destination은 바뀌지 않는다.
///
/// # Safety
/// token과 입력은 유효해야 하며, nonzero count의 `dst`는 정렬된 writable `double[count]`여야 한다.
/// `error_out`은 기존 live 버퍼를 담지 않고 입력·destination과 alias하지 않는 writable slot이어야 한다.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_read_f64(
    engine: *mut BcEngine,
    name: *const u8,
    name_len: usize,
    args: *const u8,
    args_len: usize,
    dst: *mut f64,
    count: usize,
    error_out: *mut BcBuf,
) -> BcStatus {
    ffi_status(|| {
        // SAFETY: 오류 출력만 상태 gate 전에 비운다.
        if !unsafe { empty_buf(error_out) } {
            return BcStatus::BC_INVALID;
        }
        let slot = match lease(engine) {
            Ok(slot) => slot,
            Err(status) => return unsafe { lease_error(status, error_out) },
        };
        // SAFETY: Arc lease가 slot을 유지하고 error_out은 비운 writable 출력이다.
        unsafe {
            stateful(
                &slot,
                error_out,
                || {
                    let name = bytes(name, name_len).ok_or(BcStatus::BC_INVALID)?;
                    str::from_utf8(name).map_err(|_| BcStatus::BC_INVALID)
                },
                |core, name| {
                    if count > F64_TRANSFER_LIMIT || !valid_f64_output(dst, count) {
                        return BcStatus::BC_INVALID;
                    }
                    let Some(args) = bytes(args, args_len) else {
                        return BcStatus::BC_INVALID;
                    };
                    let Some(parsed) = parse_args(args, JsonMode::Standard) else {
                        return BcStatus::BC_INVALID;
                    };
                    let JsValue::Array(arguments) = &parsed else {
                        unreachable!()
                    };
                    #[cfg(debug_assertions)]
                    {
                        let fixed = [
                            0.0_f64.to_bits(),
                            (-0.0_f64).to_bits(),
                            0x7ff8_0000_0000_0042,
                            f64::INFINITY.to_bits(),
                        ];
                        let locked;
                        let bits: &[u64] = if name == "__bcReadF64ForTest" {
                            &fixed
                        } else if name == "__bcReadLastF64ForTest" {
                            locked = slot
                                .test_f64
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            &locked
                        } else {
                            &[]
                        };
                        if !bits.is_empty() {
                            if bits.len() != count {
                                return write_error(
                                    error_out,
                                    &JsError::new(
                                        "RangeError",
                                        JsString::from_str("Float64Array length"),
                                    ),
                                );
                            }
                            for (index, bits) in bits.iter().copied().enumerate() {
                                // SAFETY: dst는 위에서 count 원소 writable임을 검증했다.
                                dst.add(index).write(f64::from_bits(bits));
                            }
                            return BcStatus::BC_OK;
                        }
                    }
                    let result = barochart_bridge::call(core, name, arguments);
                    match &result {
                        Err(error) => write_error(error_out, error),
                        Ok(JsValue::Array(values)) if values.len() == count => {
                            let mut copied = Vec::new();
                            if copied.try_reserve_exact(count).is_err() {
                                return BcStatus::BC_THROW;
                            }
                            for value in values {
                                let JsValue::Number(number) = value else {
                                    return write_error(
                                        error_out,
                                        &JsError::new(
                                            "TypeError",
                                            JsString::from_str("Float64Array result required"),
                                        ),
                                    );
                                };
                                copied.push(*number);
                            }
                            if count != 0 {
                                // SAFETY: dst는 위에서 정렬·길이를 검증했고 여기까지 쓰지 않았다.
                                ptr::copy_nonoverlapping(copied.as_ptr(), dst, count);
                            }
                            BcStatus::BC_OK
                        }
                        Ok(_) => write_error(
                            error_out,
                            &JsError::new(
                                "TypeError",
                                JsString::from_str("Float64Array result required"),
                            ),
                        ),
                    }
                },
            )
        }
    })
}

/// 호스트 `double` 배열을 Rust 함수에 소유 복사로 넘긴다.
/// 인자는 Standard JSON 배열만 받는다.
///
/// # Safety
/// token과 입력은 유효해야 하며, nonzero count의 `src`는 정렬된 readable `double[count]`여야 한다.
/// `error_out`은 기존 live 버퍼를 담지 않고 입력·source와 alias하지 않는 writable slot이어야 한다.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_write_f64(
    engine: *mut BcEngine,
    name: *const u8,
    name_len: usize,
    args: *const u8,
    args_len: usize,
    src: *const f64,
    count: usize,
    error_out: *mut BcBuf,
) -> BcStatus {
    ffi_status(|| {
        // SAFETY: 오류 출력만 상태 gate 전에 비운다.
        if !unsafe { empty_buf(error_out) } {
            return BcStatus::BC_INVALID;
        }
        let slot = match lease(engine) {
            Ok(slot) => slot,
            Err(status) => return unsafe { lease_error(status, error_out) },
        };
        // SAFETY: Arc lease가 slot을 유지하고 error_out은 비운 writable 출력이다.
        unsafe {
            stateful(
                &slot,
                error_out,
                || {
                    let name = bytes(name, name_len).ok_or(BcStatus::BC_INVALID)?;
                    str::from_utf8(name).map_err(|_| BcStatus::BC_INVALID)
                },
                |core, name| {
                    if count > F64_TRANSFER_LIMIT {
                        return BcStatus::BC_INVALID;
                    }
                    let Some(_source) = f64_input(src, count) else {
                        return BcStatus::BC_INVALID;
                    };
                    let Some(args) = bytes(args, args_len) else {
                        return BcStatus::BC_INVALID;
                    };
                    let Some(parsed) = parse_args(args, JsonMode::Standard) else {
                        return BcStatus::BC_INVALID;
                    };
                    #[cfg(debug_assertions)]
                    if name == "__bcWriteF64ForTest" {
                        let mut copied = Vec::new();
                        if copied.try_reserve_exact(count).is_err() {
                            return BcStatus::BC_THROW;
                        }
                        copied.extend(_source.iter().map(|value| value.to_bits()));
                        *slot
                            .test_f64
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) = copied;
                        return BcStatus::BC_OK;
                    }
                    let JsValue::Array(arguments) = &parsed else {
                        unreachable!()
                    };
                    match barochart_bridge::call(core, name, arguments) {
                        Err(error) => write_error(error_out, &error),
                        Ok(_) => write_error(
                            error_out,
                            &JsError::new(
                                "TypeError",
                                JsString::from_str("Float64Array result required"),
                            ),
                        ),
                    }
                },
            )
        }
    })
}

/// packet v1 메타데이터와 숫자를 소유 버퍼로 돌려준다.
/// 인자는 Standard JSON 배열이다. 실패 오류는 `metadata_out`의 Standard JSON에 담고 numbers는 비운다.
///
/// # Safety
/// token과 입력은 유효해야 한다. 두 출력은 기존 live 버퍼를 담지 않고
/// 입력·서로와 alias하지 않는 writable slot이어야 하며, 두 할당이 모두 준비된 뒤에만 게시된다.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_packet(
    engine: *mut BcEngine,
    args: *const u8,
    args_len: usize,
    metadata_out: *mut BcBuf,
    numbers_out: *mut BcF64Buf,
) -> BcStatus {
    ffi_status(|| {
        // SAFETY: 두 출력을 항상 먼저 비운다.
        let metadata_ready = unsafe { empty_buf(metadata_out) };
        let numbers_ready = unsafe { empty_f64_buf(numbers_out) };
        if !metadata_ready || !numbers_ready {
            return BcStatus::BC_INVALID;
        }
        let slot = match lease(engine) {
            Ok(slot) => slot,
            Err(status) => return unsafe { lease_error(status, metadata_out) },
        };
        // SAFETY: Arc lease가 slot을 유지하고 metadata_out은 오류 carrier로 비웠다.
        unsafe {
            stateful(
                &slot,
                metadata_out,
                || Ok(()),
                |_core, ()| {
                    let Some(args) = bytes(args, args_len) else {
                        return BcStatus::BC_INVALID;
                    };
                    let Some(_parsed) = parse_args(args, JsonMode::Standard) else {
                        return BcStatus::BC_INVALID;
                    };
                    #[cfg(debug_assertions)]
                    if let JsValue::Array(values) = &_parsed
                        && let Some(JsValue::String(name)) = values.first()
                    {
                        let name = name.to_string_lossy();
                        if name == "__bcPacketForTest" || name == "__bcEmptyPacketForTest" {
                            let mut numbers = Vec::new();
                            let needed = usize::from(name == "__bcPacketForTest") * 4;
                            if numbers.try_reserve_exact(needed).is_err() {
                                return BcStatus::BC_THROW;
                            }
                            if needed != 0 {
                                numbers.extend([
                                    0.0,
                                    -0.0,
                                    f64::from_bits(0x7ff8_0000_0000_0042),
                                    f64::INFINITY,
                                ]);
                            }
                            let metadata = match allocate_bytes(br#"{"kind":"test"}"#) {
                                Ok(metadata) => metadata,
                                Err(status) => return status,
                            };
                            let numbers = leak_f64(numbers);
                            metadata_out.write(metadata);
                            numbers_out.write(numbers);
                            return BcStatus::BC_OK;
                        }
                    }
                    write_error(metadata_out, &unavailable("nativeScenePacket"))
                },
            )
        }
    })
}

/// live token의 FFI shell 메모리 통계를 Standard JSON으로 돌려준다.
/// poison 뒤에도 진단을 위해 동작하지만 busy 중에는 `BC_BUSY`, stale token은 `BC_CLOSED`다.
///
/// # Safety
/// token은 `bc_engine_new`의 반환값 그대로여야 한다. `out`은 기존 live `BcBuf`를 담지 않는
/// writable slot이어야 하며 다른 입출력과 alias하지 않아야 한다.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_memory_stats(engine: *const BcEngine, out: *mut BcBuf) -> BcStatus {
    ffi_status(|| {
        // SAFETY: out을 비운다.
        if !unsafe { empty_buf(out) } {
            return BcStatus::BC_INVALID;
        }
        let slot = match lease(engine) {
            Ok(slot) => slot,
            Err(status) => return unsafe { lease_error(status, out) },
        };
        if slot.closed.load(Ordering::Acquire) {
            return unsafe { lease_error(BcStatus::BC_CLOSED, out) };
        }
        if slot
            .busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            return BcStatus::BC_BUSY;
        }
        let _busy = BusyGuard(&slot);
        if slot.closed.load(Ordering::Acquire) {
            return unsafe { lease_error(BcStatus::BC_CLOSED, out) };
        }
        let json = format!(
            "{{\"byteBuffers\":{},\"byteCapacity\":{},\"f64Buffers\":{},\"f64Capacity\":{},\"liveEngines\":{},\"poisoned\":{}}}",
            BYTE_BUFFERS.load(Ordering::Relaxed),
            BYTE_CAPACITY.load(Ordering::Relaxed),
            F64_BUFFERS.load(Ordering::Relaxed),
            F64_CAPACITY.load(Ordering::Relaxed),
            locked_registry().len(),
            slot.poisoned.load(Ordering::Acquire)
        );
        // SAFETY: out은 진입에서 writable임을 확인했다.
        if unsafe { write_bytes(out, json.as_bytes()) }.is_ok() {
            BcStatus::BC_OK
        } else {
            BcStatus::BC_THROW
        }
    })
}

/// 엔진 token을 닫고 호스트 context를 해제한다.
///
/// NULL과 stale/반복 token은 no-op이다. free 선형화 시점부터 새 호출은 `BC_CLOSED`를 받는다.
/// 이미 승인된 호출이 있으면 그 호출은 소유 출력을 게시하고, 마지막 Arc lease가 떨어진
/// 스레드에서 terminal `release` 콜백을 한 번 부른다. 따라서 이 함수는 callback 안에서도 부를 수 있다.
///
/// # Safety
/// non-NULL token은 `bc_engine_new`의 반환값 그대로여야 하며 호출자는 free 후 자신의 저장 핸들을 NULL로 바꾸어야 한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_engine_free(engine: *mut BcEngine) {
    ffi_void(|| {
        let Ok(id) = engine_id(engine) else { return };
        let removed = {
            let mut engines = locked_registry();
            let removed = engines.remove(&id);
            if let Some(slot) = &removed {
                slot.closed.store(true, Ordering::Release);
            }
            removed
        };
        // Arc 마지막 drop과 host.release는 registry lock 밖에서만 실행한다.
        drop(removed);
    });
}

/// Rust 소유 바이트 버퍼를 해제한다. canonical empty는 no-op이다.
///
/// # Safety
/// nonempty 버퍼는 Rust export가 만든 값을 변경하지 않은 고유 값이어야 하고 정확히 한 번만 넘겨야 한다.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_buf_free(buf: BcBuf) {
    // SAFETY: 해제 논리의 Rust panic을 C로 넘기지 않는다.
    ffi_void(|| unsafe { free_buf(buf) });
}

/// WASM 선형 메모리에 길이가 정확하고 0으로 초기화된 구간을 할당한다.
///
/// 길이가 0이거나 할당 실패 시 null이다. 호스트는 정확한 포인터·길이 쌍을 한 번만 반환한다.
/// cbindgen:ignore
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn bc_alloc(len: u32) -> *mut u8 {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if len == 0 {
            return ptr::null_mut();
        }
        let Ok(layout) = std::alloc::Layout::from_size_align(len as usize, WASM_ALLOC_ALIGN) else {
            return ptr::null_mut();
        };
        // SAFETY: layout은 0이 아니며 호스트가 소유권을 받아 정확한 쌍을 한 번 해제한다.
        let pointer = unsafe { std::alloc::alloc_zeroed(layout) };
        if !pointer.is_null() {
            BYTE_BUFFERS.fetch_add(1, Ordering::Relaxed);
            BYTE_CAPACITY.fetch_add(len as usize, Ordering::Relaxed);
        }
        pointer
    }));
    result.unwrap_or(ptr::null_mut())
}

/// `bc_alloc`이 할당한 정확한 크기의 구간을 해제한다.
///
/// # Safety
/// `pointer`와 `len`은 `bc_alloc` 또는 WASM 출력의 살아 있는 쌍이며 한 번만 반환해야 한다.
/// cbindgen:ignore
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_free(pointer: *mut u8, len: u32) {
    if len == 0 || pointer.is_null() || !wasm_pointer_range(pointer, len as usize, WASM_ALLOC_ALIGN)
    {
        return;
    }
    let Ok(layout) = std::alloc::Layout::from_size_align(len as usize, WASM_ALLOC_ALIGN) else {
        return;
    };
    let _ = catch_unwind(AssertUnwindSafe(|| {
        subtract(&BYTE_BUFFERS, 1);
        subtract(&BYTE_CAPACITY, len as usize);
        // SAFETY: 호스트 계약은 bc_alloc이 만든 정확한 크기의 살아 있는 할당을 요구한다.
        unsafe { std::alloc::dealloc(pointer, layout) };
    }));
}

/// 링크 인자만 전달하는 `cdylib`에서 날것의 WASM 진입점이 도달 가능하게 한다.
#[cfg(target_arch = "wasm32")]
pub fn wasm_link_anchor() {
    let _ = bc_alloc as extern "C" fn(u32) -> *mut u8;
    let _ = bc_free as unsafe extern "C" fn(*mut u8, u32);
    let _ = bc_engine_new as unsafe extern "C" fn(u32, *mut *mut BcEngine, *mut BcBuf) -> BcStatus;
    let _ = bc_call
        as unsafe extern "C" fn(
            *mut BcEngine,
            *const u8,
            usize,
            *const u8,
            usize,
            u32,
            *mut BcBuf,
        ) -> BcStatus;
    let _ = bc_engine_free as unsafe extern "C" fn(*mut BcEngine);
}

/// Rust 소유 `double` 버퍼를 해제한다. canonical empty는 no-op이다.
///
/// # Safety
/// nonempty 버퍼는 Rust export가 만든 값을 변경하지 않은 고유 값이어야 하고 정확히 한 번만 넘겨야 한다.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_f64_buf_free(buf: BcF64Buf) {
    // SAFETY: 해제 논리의 Rust panic을 C로 넘기지 않는다.
    ffi_void(|| unsafe { free_f64_buf(buf) });
}

#[cfg(test)]
mod tests {
    use std::ffi::c_void;
    use std::ptr;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::{
        BcBuf, BcEngine, BcHost, BcStatus, NEXT_ENGINE_ID, bc_buf_free, bc_engine_new,
        next_engine_id,
    };

    unsafe extern "C" fn zone_resolve(
        _: *mut c_void,
        _: *const u8,
        _: usize,
        _: *mut BcBuf,
    ) -> i32 {
        1
    }

    unsafe extern "C" fn zone_offset(
        _: *mut c_void,
        _: *const u8,
        _: usize,
        _: f64,
        _: *mut i32,
    ) -> i32 {
        1
    }

    unsafe extern "C" fn release(context: *mut c_void) {
        // SAFETY: 테스트 context는 호출 동안 유효한 AtomicUsize다.
        unsafe { &*context.cast::<AtomicUsize>() }.fetch_add(1, Ordering::SeqCst);
    }

    #[test]
    fn handle_id_exhaustion_never_wraps_or_reuses_zero() {
        let maximum = (usize::MAX >> 3).min((i64::MAX as usize) >> 3);
        NEXT_ENGINE_ID.store(maximum, Ordering::Relaxed);
        assert_eq!(next_engine_id(), Some(maximum));
        assert_eq!(next_engine_id(), None);

        let releases = AtomicUsize::new(0);
        let host = BcHost {
            context: ptr::from_ref(&releases).cast_mut().cast(),
            zone_resolve: Some(zone_resolve),
            zone_offset_seconds: Some(zone_offset),
            log: None,
            release: Some(release),
        };
        let mut engine = ptr::dangling_mut::<BcEngine>();
        let mut error = BcBuf::default();
        // SAFETY: 테스트 입출력은 모두 유효하고 핸들 한도 실패를 유발한다.
        let status = unsafe { bc_engine_new(&host, &mut engine, &mut error) };
        assert_eq!(status, BcStatus::BC_THROW);
        assert!(engine.is_null());
        assert_eq!(releases.load(Ordering::SeqCst), 0);
        // SAFETY: bc_engine_new이 만든 Rust 소유 오류 버퍼다.
        unsafe { bc_buf_free(error) };
        NEXT_ENGINE_ID.store(1, Ordering::Relaxed);
    }
}
