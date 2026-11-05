//! BaroChart Rust 코어의 공통 C ABI.
//!
//! 이 크레이트만 `unsafe`를 담당한다. 날 포인터는 헤더에 적힌 유효성과 소유권 조건을
//! 호출자가 지키는 동안만 유효하다. 모든 C export는 Rust panic을 C로 넘기지 않는다.

#![warn(missing_docs)]

#[cfg(not(target_arch = "wasm32"))]
use std::alloc::{Layout, alloc, dealloc};
use std::cell::UnsafeCell;
use std::collections::BTreeMap;
use std::ffi::c_void;
use std::mem::{ManuallyDrop, align_of, size_of};
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

use barochart_core::native_runtime::NativeParamsStatusLedger;
use barochart_core::{Engine, Host, HostError};
use barochart_js::error::JsError;
use barochart_js::json::{
    JsObject, JsValue, JsonFailure, JsonMode, parse_json_scoped, stringify_json_scoped,
};
use barochart_js::memory::{
    MemoryAccount, MemoryContext, MemoryFailure, MemoryLease, MemoryScope, OomStyle,
    oom_style_from_error,
};
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

#[cfg(target_arch = "wasm32")]
mod wasm_web;

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
    /// 제한된 엔진의 requested-byte 한도 또는 allocation이 실패했다.
    BC_OOM_LIMIT = 7,
    /// 무제한 엔진의 system allocation이 실패했다.
    BC_OOM_SYSTEM = 8,
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

/// 관찰형 typed write의 실제 target 길이와 복사 여부다.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BcF64WriteReceipt {
    /// Core가 한 번 handout한 실제 `double` 원소 수다.
    pub actual_count: usize,
    /// Host source가 유효하고 실제 길이와 정확히 같아 복사됐는지 나타낸다.
    pub did_write: bool,
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
    host_release_armed: AtomicBool,
    host: BcHost,
    account: Arc<MemoryAccount>,
    _base_memory: MemoryLease,
    params_ledger: NativeParamsStatusLedger,
    core: UnsafeCell<Option<ManuallyDrop<Engine>>>,
    #[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
    test_f64: Mutex<Vec<u64>>,
    #[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
    test_panic_name: Mutex<Option<String>>,
}

// SAFETY: core는 busy CAS를 통해 한 스레드만 접근하고 Arc lease가 활성 호출 중 drop을 막는다.
unsafe impl Send for EngineSlot {}
// SAFETY: 위와 같은 gate가 `UnsafeCell<Option<ManuallyDrop<Engine>>>`의 배타적 접근을 보장한다.
unsafe impl Sync for EngineSlot {}

struct FfiHost {
    raw: BcHost,
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

impl EngineSlot {
    /// busy holder 또는 마지막 Arc drop만 호출해 core 소유권을 한 번 가져간다.
    unsafe fn retire_core(&self) {
        // SAFETY: 호출자는 busy 배타권을 보유하거나 마지막 Arc 소유자다.
        let core = unsafe { (&mut *self.core.get()).take() };
        if let Some(mut core) = core {
            // ManuallyDrop이라 중첩 drop panic 뒤에도 같은 Engine을 다시 drop하지 않는다.
            let _ = catch_unwind(AssertUnwindSafe(|| {
                // SAFETY: Option에서 가져온 유일한 Engine 소유권이다.
                unsafe { ManuallyDrop::drop(&mut core) };
            }));
        }
    }
}

impl Drop for EngineSlot {
    fn drop(&mut self) {
        // SAFETY: 마지막 Arc를 drop 중이므로 활성 core 접근자가 없다.
        unsafe { self.retire_core() };
        if self.host_release_armed.swap(false, Ordering::AcqRel)
            && let Some(release) = self.host.release
        {
            let raw = self.host;
            let _ = catch_unwind(AssertUnwindSafe(|| {
                // SAFETY: 성공한 new가 넘긴 context를 Slot lifetime이 정확히 한 번 해제한다.
                unsafe { release(raw.context) };
            }));
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

#[cfg(not(target_arch = "wasm32"))]
unsafe fn empty_f64_write_receipt(out: *mut BcF64WriteReceipt) -> bool {
    if out.is_null()
        || !wasm_memory_range(
            out.addr(),
            size_of::<BcF64WriteReceipt>(),
            align_of::<BcF64WriteReceipt>(),
        )
    {
        return false;
    }
    // SAFETY: 호출자가 writable receipt 출력을 넘긴다는 export 계약을 따른다.
    unsafe { out.write(BcF64WriteReceipt::default()) };
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

#[cfg(not(target_arch = "wasm32"))]
const OUTPUT_MAGIC: u64 = 0x4243_4f55_5450_5554;
#[cfg(not(target_arch = "wasm32"))]
const OUTPUT_KIND_BYTES: u32 = 1;
#[cfg(not(target_arch = "wasm32"))]
const OUTPUT_KIND_F64: u32 = 2;

#[cfg(not(target_arch = "wasm32"))]
struct OutputHeader {
    magic: u64,
    kind: u32,
    len: usize,
    cap: usize,
    _lease: Option<MemoryLease>,
}

fn oom_status(style: OomStyle) -> BcStatus {
    match style {
        OomStyle::InternalErrorLowercase => BcStatus::BC_OOM_LIMIT,
        OomStyle::RangeErrorCapitalized => BcStatus::BC_OOM_SYSTEM,
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn output_layout<T>(capacity: usize) -> Result<(Layout, usize), BcStatus> {
    let payload = Layout::array::<T>(capacity).map_err(|_| BcStatus::BC_OOM_SYSTEM)?;
    let (layout, offset) = Layout::new::<OutputHeader>()
        .extend(payload)
        .map_err(|_| BcStatus::BC_OOM_SYSTEM)?;
    Ok((layout.pad_to_align(), offset))
}

#[cfg(not(target_arch = "wasm32"))]
fn allocate_output_uninit<T>(
    length: usize,
    kind: u32,
    account: Option<&Arc<MemoryAccount>>,
    style: OomStyle,
) -> Result<(*mut T, usize), BcStatus> {
    if length == 0 {
        return Ok((ptr::null_mut(), 0));
    }
    let (layout, offset) = output_layout::<T>(length).map_err(|_| oom_status(style))?;
    let lease = match account {
        Some(account) => Some(
            account
                .reserve_output(layout.size() as u64)
                .map_err(|failure| oom_status(failure.style()))?,
        ),
        None => None,
    };
    // SAFETY: layout은 nonzero payload를 포함한 유효 layout이다.
    let allocation = unsafe { alloc(layout) };
    if allocation.is_null() {
        drop(lease);
        return Err(oom_status(style));
    }
    let header = allocation.cast::<OutputHeader>();
    let payload = allocation.wrapping_add(offset).cast::<T>();
    // SAFETY: header와 payload는 layout의 겹치지 않는 초기화 구간이다.
    unsafe {
        header.write(OutputHeader {
            magic: OUTPUT_MAGIC,
            kind,
            len: length,
            cap: length,
            _lease: lease,
        });
    }
    Ok((payload, length))
}

#[cfg(not(target_arch = "wasm32"))]
fn allocate_output_copy<T: Copy>(
    source: &[T],
    kind: u32,
    account: Option<&Arc<MemoryAccount>>,
    style: OomStyle,
) -> Result<(*mut T, usize), BcStatus> {
    let (payload, capacity) = allocate_output_uninit(source.len(), kind, account, style)?;
    if !source.is_empty() {
        // SAFETY: payload는 source.len() 원소의 초기화되지 않은 output 구간이다.
        unsafe { ptr::copy_nonoverlapping(source.as_ptr(), payload, source.len()) };
    }
    Ok((payload, capacity))
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn free_output<T>(pointer: *mut T, len: usize, cap: usize, kind: u32) -> bool {
    if pointer.is_null() || cap == 0 || len > cap {
        return false;
    }
    let Ok((layout, offset)) = output_layout::<T>(cap) else {
        return false;
    };
    let allocation = pointer.cast::<u8>().wrapping_sub(offset);
    let header_pointer = allocation.cast::<OutputHeader>();
    // SAFETY: caller contract requires an unchanged live descriptor from this allocator.
    let header = unsafe { &*header_pointer };
    if header.magic != OUTPUT_MAGIC || header.kind != kind || header.len != len || header.cap != cap
    {
        return false;
    }
    // SAFETY: exact descriptor proves the header is uniquely owned and initialized.
    let owned = unsafe { header_pointer.read() };
    // SAFETY: allocation was created with the same recomputed layout.
    unsafe { dealloc(allocation, layout) };
    drop(owned);
    true
}

fn allocate_bytes_with_style(source: &[u8], style: OomStyle) -> Result<BcBuf, BcStatus> {
    #[cfg(target_arch = "wasm32")]
    let _ = style;
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
        let (pointer, capacity) = allocate_output_copy(source, OUTPUT_KIND_BYTES, None, style)?;
        BYTE_BUFFERS.fetch_add(1, Ordering::Relaxed);
        BYTE_CAPACITY.fetch_add(capacity, Ordering::Relaxed);
        Ok(BcBuf {
            ptr: pointer,
            len: source.len(),
            cap: capacity,
        })
    }
}

fn allocate_bytes(source: &[u8]) -> Result<BcBuf, BcStatus> {
    allocate_bytes_with_style(source, OomStyle::RangeErrorCapitalized)
}

#[cfg(not(target_arch = "wasm32"))]
fn allocate_accounted_bytes(
    source: &[u8],
    account: &Arc<MemoryAccount>,
) -> Result<BcBuf, BcStatus> {
    if source.is_empty() {
        return Ok(BcBuf::default());
    }
    let (pointer, capacity) = allocate_output_copy(
        source,
        OUTPUT_KIND_BYTES,
        Some(account),
        account.allocation_failure().style(),
    )?;
    BYTE_BUFFERS.fetch_add(1, Ordering::Relaxed);
    BYTE_CAPACITY.fetch_add(capacity, Ordering::Relaxed);
    Ok(BcBuf {
        ptr: pointer,
        len: source.len(),
        cap: capacity,
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn allocate_accounted_f64(
    source: &[f64],
    account: &Arc<MemoryAccount>,
) -> Result<BcF64Buf, BcStatus> {
    if source.is_empty() {
        return Ok(BcF64Buf::default());
    }
    let (pointer, capacity) = allocate_output_copy(
        source,
        OUTPUT_KIND_F64,
        Some(account),
        account.allocation_failure().style(),
    )?;
    F64_BUFFERS.fetch_add(1, Ordering::Relaxed);
    F64_CAPACITY.fetch_add(capacity, Ordering::Relaxed);
    Ok(BcF64Buf {
        ptr: pointer,
        len: source.len(),
        cap: capacity,
    })
}

/// Publication 전에 실제 최종 owned byte allocation을 보유한다.
///
/// 고정 reply는 이 값이 만들어진 뒤 Core 상태를 게시하고, 추가 allocation 없이 payload를 채운다.
#[derive(Debug)]
struct PendingByteOutput {
    buffer: BcBuf,
}

impl PendingByteOutput {
    fn new(length: usize, account: &Arc<MemoryAccount>) -> Result<Self, BcStatus> {
        if length == 0 {
            return Ok(Self {
                buffer: BcBuf::default(),
            });
        }
        #[cfg(not(target_arch = "wasm32"))]
        let (pointer, capacity) = allocate_output_uninit(
            length,
            OUTPUT_KIND_BYTES,
            Some(account),
            account.allocation_failure().style(),
        )?;
        #[cfg(target_arch = "wasm32")]
        let (pointer, capacity) = {
            let _ = account;
            let layout = std::alloc::Layout::from_size_align(length, WASM_ALLOC_ALIGN)
                .map_err(|_| BcStatus::BC_THROW)?;
            // SAFETY: fixed reply length는 nonzero이고 free_buf가 같은 layout으로 반환한다.
            let pointer = unsafe { std::alloc::alloc(layout) };
            if pointer.is_null() {
                return Err(BcStatus::BC_THROW);
            }
            (pointer, length)
        };
        BYTE_BUFFERS.fetch_add(1, Ordering::Relaxed);
        BYTE_CAPACITY.fetch_add(capacity, Ordering::Relaxed);
        Ok(Self {
            buffer: BcBuf {
                ptr: pointer,
                len: length,
                cap: capacity,
            },
        })
    }

    fn publish(mut self, source: &[u8]) -> BcBuf {
        assert_eq!(source.len(), self.buffer.len, "fixed reply byte length");
        if !source.is_empty() {
            // SAFETY: pending payload는 source.len() 바이트 writable이고 아직 공개되지 않았다.
            unsafe { ptr::copy_nonoverlapping(source.as_ptr(), self.buffer.ptr, source.len()) };
        }
        std::mem::take(&mut self.buffer)
    }
}

impl Drop for PendingByteOutput {
    fn drop(&mut self) {
        // SAFETY: 아직 게시하지 않은 정확한 output descriptor를 소유한다.
        unsafe { free_buf(std::mem::take(&mut self.buffer)) };
    }
}

#[cfg(not(target_arch = "wasm32"))]
struct PendingF64Output {
    buffer: BcF64Buf,
}

#[cfg(not(target_arch = "wasm32"))]
impl PendingF64Output {
    fn new(count: usize, account: &Arc<MemoryAccount>) -> Result<Self, BcStatus> {
        if count == 0 {
            return Ok(Self {
                buffer: BcF64Buf::default(),
            });
        }
        let (pointer, capacity) = allocate_output_uninit(
            count,
            OUTPUT_KIND_F64,
            Some(account),
            account.allocation_failure().style(),
        )?;
        F64_BUFFERS.fetch_add(1, Ordering::Relaxed);
        F64_CAPACITY.fetch_add(capacity, Ordering::Relaxed);
        Ok(Self {
            buffer: BcF64Buf {
                ptr: pointer,
                len: count,
                cap: capacity,
            },
        })
    }

    #[cfg(debug_assertions)]
    fn publish(mut self, values: &[f64]) -> Result<BcF64Buf, BcStatus> {
        self.copy_from(values)?;
        Ok(self.finish())
    }

    fn copy_from(&mut self, values: &[f64]) -> Result<(), BcStatus> {
        if values.len() != self.buffer.len {
            return Err(BcStatus::BC_INVALID);
        }
        if !values.is_empty() {
            // SAFETY: pending payload는 values.len() 원소 writable이며 아직 공개되지 않았다.
            unsafe {
                ptr::copy_nonoverlapping(values.as_ptr(), self.buffer.ptr, values.len());
            }
        }
        Ok(())
    }

    fn finish(mut self) -> BcF64Buf {
        std::mem::take(&mut self.buffer)
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Drop for PendingF64Output {
    fn drop(&mut self) {
        // SAFETY: 아직 게시하지 않은 정확한 output descriptor를 소유한다.
        unsafe { free_f64_buf(std::mem::take(&mut self.buffer)) };
    }
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
        // SAFETY: 호출자는 Rust가 만든 변경하지 않은 고유 BcBuf를 정확히 한 번 반환한다.
        if unsafe { free_output(buf.ptr, buf.len, buf.cap, OUTPUT_KIND_BYTES) } {
            subtract(&BYTE_BUFFERS, 1);
            subtract(&BYTE_CAPACITY, buf.cap);
        }
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
    // SAFETY: 호출자는 Rust가 만든 변경하지 않은 고유 BcF64Buf를 정확히 한 번 반환한다.
    if unsafe { free_output(buf.ptr, buf.len, buf.cap, OUTPUT_KIND_F64) } {
        subtract(&F64_BUFFERS, 1);
        subtract(&F64_CAPACITY, buf.cap);
    }
}

unsafe fn write_bytes(out: *mut BcBuf, source: &[u8]) -> Result<(), BcStatus> {
    // SAFETY: 기본 control 경계는 무제한/Apple OOM 종류를 쓴다.
    unsafe { write_bytes_with_style(out, source, OomStyle::RangeErrorCapitalized) }
}

unsafe fn write_bytes_with_style(
    out: *mut BcBuf,
    source: &[u8],
    style: OomStyle,
) -> Result<(), BcStatus> {
    let allocated = allocate_bytes_with_style(source, style)?;
    // SAFETY: 출력은 export 진입 시 writable임을 확인했다.
    unsafe { out.write(allocated) };
    Ok(())
}

unsafe fn write_accounted_bytes(
    out: *mut BcBuf,
    source: &[u8],
    account: &Arc<MemoryAccount>,
) -> Result<(), BcStatus> {
    #[cfg(not(target_arch = "wasm32"))]
    let allocated = allocate_accounted_bytes(source, account)?;
    #[cfg(target_arch = "wasm32")]
    let allocated = {
        let _ = account;
        allocate_bytes(source)?
    };
    // SAFETY: 출력은 export 진입 시 writable임을 확인했다.
    unsafe { out.write(allocated) };
    Ok(())
}

fn error_json_scoped(error: &JsError, scope: &mut MemoryScope) -> Result<Vec<u8>, MemoryFailure> {
    let mut object = JsObject::new();
    object.insert(
        JsString::try_from_str("name", scope)?,
        JsValue::String(JsString::try_from_str(error.name, scope)?),
    );
    object.insert(
        JsString::try_from_str("message", scope)?,
        JsValue::String(error.message.try_clone_scoped(scope)?),
    );
    object.insert(
        JsString::try_from_str("code", scope)?,
        match error.code.as_deref() {
            Some(code) => JsValue::String(JsString::try_from_str(code, scope)?),
            None => JsValue::Null,
        },
    );
    stringify_json_scoped(
        &JsValue::Object(object),
        JsonMode::Standard,
        NumberDialect::PLATFORM,
        scope,
    )
}

unsafe fn write_error(out: *mut BcBuf, error: &JsError) -> BcStatus {
    // SAFETY: 엔진 account가 없는 생성/전송 경계다.
    unsafe { write_error_with_style(out, error, OomStyle::RangeErrorCapitalized) }
}

unsafe fn write_error_with_style(out: *mut BcBuf, error: &JsError, style: OomStyle) -> BcStatus {
    if let Some(style) = oom_style_from_error(error) {
        return oom_status(style);
    }
    let status = if error.name == "UnavailableError" {
        BcStatus::BC_UNAVAILABLE
    } else {
        BcStatus::BC_THROW
    };
    let mut scope = MemoryScope::unaccounted(style);
    let encoded = match error_json_scoped(error, &mut scope) {
        Ok(encoded) => encoded,
        Err(failure) => return oom_status(failure.style()),
    };
    // SAFETY: 호출자가 유효한 출력을 넘겼고 진입에서 빈 값으로 초기화했다.
    match unsafe { write_bytes_with_style(out, &encoded, style) } {
        Ok(()) => status,
        Err(allocation) => allocation,
    }
}

unsafe fn write_accounted_error(
    out: *mut BcBuf,
    error: &JsError,
    account: &Arc<MemoryAccount>,
) -> BcStatus {
    if let Some(style) = oom_style_from_error(error) {
        return oom_status(style);
    }
    #[cfg(target_arch = "wasm32")]
    {
        let _ = account;
        // SAFETY: WASM Phase A는 기존 unscoped output 경계를 유지한다.
        unsafe { write_error(out, error) }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let status = if error.name == "UnavailableError" {
            BcStatus::BC_UNAVAILABLE
        } else {
            BcStatus::BC_THROW
        };
        let mut scope = MemoryScope::new(account);
        let encoded = match error_json_scoped(error, &mut scope) {
            Ok(encoded) => encoded,
            Err(failure) => return oom_status(failure.style()),
        };
        match allocate_accounted_bytes(&encoded, account) {
            Ok(buffer) => {
                // SAFETY: caller validated the canonical-empty writable output slot.
                unsafe { out.write(buffer) };
                status
            }
            Err(allocation) => allocation,
        }
    }
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

fn poison_slot(slot: &EngineSlot) {
    slot.poisoned.store(true, Ordering::Release);
    slot.params_ledger.poison();
    // SAFETY: stateful은 poison transition 전체 동안 busy 배타권을 보유한다.
    unsafe { slot.retire_core() };
    // log callback 동안도 busy gate를 유지해 재진입을 BC_BUSY로 만든다.
    log_panic(slot);
}

fn cleanup_whitelisted(name: &str) -> bool {
    matches!(
        name,
        "nativeWorkspaceSourceAbort"
            | "nativeParamsSourceStatus"
            | "nativeParamsSourceAbort"
            | "nativeAsyncRelease"
            | "nativeReleaseFrameCaches"
            | "nativeReleaseFrameCache"
            | "nativeReleaseDataIngestion"
    )
}

fn cleanup_registration(value: &JsValue, message: &'static str) -> Result<u64, JsError> {
    let JsValue::Number(value) = value else {
        return Err(JsError::new("RangeError", JsString::from_str(message)));
    };
    if !value.is_finite()
        || value.fract() != 0.0
        || !(1.0..=9_007_199_254_740_991.0).contains(value)
    {
        return Err(JsError::new("RangeError", JsString::from_str(message)));
    }
    Ok(*value as u64)
}

fn poisoned_cleanup_value(
    slot: &EngineSlot,
    name: &str,
    arguments: &[JsValue],
    scope: &mut MemoryScope,
) -> Result<JsValue, JsError> {
    let undefined = JsValue::Undefined;
    let first = arguments.first().unwrap_or(&undefined);
    match name {
        "nativeWorkspaceSourceAbort" => {
            cleanup_registration(first, "Workspace registration")?;
            Ok(JsValue::Bool(false))
        }
        "nativeParamsSourceStatus" => slot.params_ledger.status_scoped(first, scope),
        "nativeParamsSourceAbort" => slot.params_ledger.abort_scoped(first, scope),
        "nativeAsyncRelease" | "nativeReleaseFrameCaches" | "nativeReleaseFrameCache" => {
            Ok(JsValue::Bool(true))
        }
        "nativeReleaseDataIngestion" => {
            let mut output = JsObject::new();
            output.insert(JsString::from_str("cancelled"), JsValue::Number(0.0));
            output.insert(JsString::from_str("pendingEvents"), JsValue::Number(0.0));
            output.insert(JsString::from_str("ownedBytes"), JsValue::Number(0.0));
            Ok(JsValue::Object(output))
        }
        _ => unreachable!("checked cleanup whitelist"),
    }
}

unsafe fn poisoned_call_answer(
    slot: &EngineSlot,
    name: &str,
    args: *const u8,
    args_len: usize,
    flags: u32,
    out: *mut BcBuf,
) -> BcStatus {
    let Some(json_mode) = mode(flags) else {
        return BcStatus::BC_INVALID;
    };
    // SAFETY: bc_call의 입력 포인터 계약을 그대로 검사한다.
    let Some(args) = (unsafe { bytes(args, args_len) }) else {
        return BcStatus::BC_INVALID;
    };
    let mut scope = MemoryScope::new(&slot.account);
    let parsed = match parse_args(args, json_mode, &mut scope) {
        Ok(parsed) => parsed,
        Err(status) => return status,
    };
    let JsValue::Array(arguments) = &parsed else {
        unreachable!("validated array")
    };
    match poisoned_cleanup_value(slot, name, arguments, &mut scope) {
        Err(error) => {
            // SAFETY: bc_call 진입에서 out을 canonical empty로 만들었다.
            unsafe { write_accounted_error(out, &error, &slot.account) }
        }
        Ok(value) => {
            let encoded =
                match stringify_json_scoped(&value, json_mode, NumberDialect::PLATFORM, &mut scope)
                {
                    Ok(encoded) => encoded,
                    Err(failure) => return oom_status(failure.style()),
                };
            // SAFETY: bc_call 진입에서 out을 canonical empty로 만들었다.
            match unsafe { write_accounted_bytes(out, &encoded, &slot.account) } {
                Ok(()) => BcStatus::BC_OK,
                Err(status) => status,
            }
        }
    }
}

#[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
fn debug_panic_if_armed(slot: &EngineSlot, name: &str) {
    let mut armed = slot
        .test_panic_name
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if armed.as_deref() == Some(name) {
        *armed = None;
        drop(armed);
        panic!("armed native test panic");
    }
}

#[cfg(any(not(debug_assertions), target_arch = "wasm32"))]
fn debug_panic_if_armed(_: &EngineSlot, _: &str) {}

unsafe fn stateful<Prepared: Copy>(
    slot: &Arc<EngineSlot>,
    error_out: *mut BcBuf,
    prepare_name: impl FnOnce() -> Result<Prepared, BcStatus>,
    run: impl FnOnce(&mut Engine, Prepared) -> BcStatus,
    poison_answer: impl Fn(Prepared) -> Option<BcStatus>,
) -> BcStatus {
    if slot.closed.load(Ordering::Acquire) {
        // SAFETY: export 진입에서 error_out을 writable canonical empty로 만들었다.
        let _ =
            unsafe { write_bytes_with_style(error_out, DISPOSED_ERROR, slot.account.oom_style()) };
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
        let _ =
            unsafe { write_bytes_with_style(error_out, DISPOSED_ERROR, slot.account.oom_style()) };
        return BcStatus::BC_CLOSED;
    }
    let prepared = match prepare_name() {
        Ok(prepared) => prepared,
        Err(status) => return status,
    };
    if slot.poisoned.load(Ordering::Acquire) {
        if let Some(status) = poison_answer(prepared) {
            return status;
        }
        // SAFETY: export 진입에서 error_out을 writable canonical empty로 만들었다.
        let _ =
            unsafe { write_bytes_with_style(error_out, DISPOSED_ERROR, slot.account.oom_style()) };
        return BcStatus::BC_POISONED;
    }
    let result = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: busy gate가 core에 대한 유일한 가변 접근을 보장한다.
        let core = unsafe { &mut *slot.core.get() }
            .as_mut()
            .expect("open slot owns core");
        run(core, prepared)
    }));
    let status = match result {
        Ok(status) => status,
        Err(_) => {
            poison_slot(slot);
            if let Some(status) = poison_answer(prepared) {
                status
            } else {
                // SAFETY: export 진입에서 error_out을 writable canonical empty로 만들었다.
                let _ = unsafe {
                    write_bytes_with_style(error_out, DISPOSED_ERROR, slot.account.oom_style())
                };
                BcStatus::BC_POISONED
            }
        }
    };
    // dispatch catch_unwind 범위 밖에서 guard를 항상 해제한다.
    drop(_busy);
    status
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

fn parse_args(source: &[u8], mode: JsonMode, scope: &mut MemoryScope) -> Result<JsValue, BcStatus> {
    match parse_json_scoped(source, mode, NumberDialect::PLATFORM, scope) {
        Ok(parsed @ JsValue::Array(_)) => Ok(parsed),
        Ok(_) | Err(JsonFailure::Syntax(_)) => Err(BcStatus::BC_INVALID),
        Err(JsonFailure::Memory(failure)) => Err(oom_status(failure.style())),
    }
}

fn scoped_echo(
    name: &str,
    parsed: &JsValue,
    scope: &mut MemoryScope,
) -> Option<Result<JsValue, BcStatus>> {
    let JsValue::Array(arguments) = parsed else {
        return None;
    };
    if name == "nativeEcho" {
        return Some(
            arguments
                .first()
                .unwrap_or(&JsValue::Undefined)
                .try_clone_scoped(scope)
                .map_err(|failure| oom_status(failure.style())),
        );
    }
    #[cfg(debug_assertions)]
    if name == "__bcEchoForTest" {
        return Some(
            parsed
                .try_clone_scoped(scope)
                .map_err(|failure| oom_status(failure.style())),
        );
    }
    None
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
    memory_limit: u64,
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
        let style = if memory_limit == 0 {
            OomStyle::RangeErrorCapitalized
        } else {
            OomStyle::InternalErrorLowercase
        };
        let account = MemoryAccount::new(memory_limit, style);
        let base_memory = match account.reserve(size_of::<EngineSlot>() as u64) {
            Ok(lease) => lease,
            Err(failure) => return oom_status(failure.style()),
        };
        let mut core = Engine::new(Box::new(FfiHost { raw }));
        if let Err(error) = core.set_memory_context(MemoryContext::accounted(&account)) {
            // SAFETY: 생성 출력은 canonical empty이며 host ownership은 아직 이전되지 않았다.
            return unsafe { write_error_with_style(error_out, &error, style) };
        }
        let params_ledger = core.params_status_ledger();
        let slot = Arc::new(EngineSlot {
            busy: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            poisoned: AtomicBool::new(false),
            host_release_armed: AtomicBool::new(false),
            host: raw,
            account,
            _base_memory: base_memory,
            params_ledger,
            core: UnsafeCell::new(Some(ManuallyDrop::new(core))),
            #[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
            test_f64: Mutex::new(Vec::new()),
            #[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
            test_panic_name: Mutex::new(None),
        });
        {
            let mut engines = locked_registry();
            let std::collections::btree_map::Entry::Vacant(entry) = engines.entry(id) else {
                return BcStatus::BC_INVALID;
            };
            entry.insert(Arc::clone(&slot));
            // registry lock을 유지한 채 ownership을 arm하고 token을 게시해 중간 상태 조회를 막는다.
            slot.host_release_armed.store(true, Ordering::Release);
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
        unsafe { engine_new_prepared(raw, 0, engine_out, error_out) }
    })
}

/// 요청 바이트 한도를 가진 빈 Rust 엔진을 만든다. 0은 무제한이다.
///
/// # Safety
/// `bc_engine_new`과 같은 포인터·alias·host 수명 계약을 따른다.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_engine_new_with_limit(
    host: *const BcHost,
    memory_limit: u64,
    engine_out: *mut *mut BcEngine,
    error_out: *mut BcBuf,
) -> BcStatus {
    ffi_status(|| {
        // SAFETY: 네이티브 출력 slot을 먼저 canonical empty로 만든다.
        if !unsafe { clear_engine_new_outputs(engine_out, error_out) } || host.is_null() {
            return BcStatus::BC_INVALID;
        }
        // SAFETY: 호출자가 C ABI에 따라 읽기 가능한 BcHost를 보장한다.
        let raw = unsafe { *host };
        // SAFETY: 출력 slot은 검증되어 비어 있다.
        unsafe { engine_new_prepared(raw, memory_limit, engine_out, error_out) }
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
        unsafe { engine_new_prepared(raw, 0, engine_out, error_out) }
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
                    debug_panic_if_armed(&slot, name);
                    let Some(json_mode) = mode(flags) else {
                        return BcStatus::BC_INVALID;
                    };
                    let Some(args) = bytes(args, args_len) else {
                        return BcStatus::BC_INVALID;
                    };
                    let mut scope = MemoryScope::new(&slot.account);
                    let bulk = if matches!(name, "nativeSetData" | "nativeCommand") {
                        match barochart_bridge::bulk::decode_bulk_call(
                            name,
                            args,
                            json_mode,
                            NumberDialect::PLATFORM,
                            &mut scope,
                        ) {
                            Ok(decoded) => decoded,
                            Err(barochart_bridge::bulk::BulkFailure::Syntax { .. }) => {
                                return BcStatus::BC_INVALID;
                            }
                            Err(barochart_bridge::bulk::BulkFailure::Memory(failure)) => {
                                return oom_status(failure.style());
                            }
                        }
                    } else {
                        None
                    };
                    let mut pending_reply = None;
                    let mut admitted_reply = None;
                    let result = {
                        let mut admit_reply =
                            |reply: barochart_bridge::reply_policy::FixedReply| {
                                assert!(pending_reply.is_none(), "fixed reply admitted once");
                                let pending = PendingByteOutput::new(
                                    reply.encoded(json_mode).len(),
                                    &slot.account,
                                )
                                .map_err(|_| slot.account.allocation_failure().into_js_error())?;
                                pending_reply = Some(pending);
                                admitted_reply = Some(reply);
                                Ok(())
                            };
                        if let Some(decoded) = bulk {
                            barochart_bridge::call_bulk_with_reply_admission(
                                core,
                                decoded,
                                &mut admit_reply,
                            )
                        } else {
                            let parsed = match parse_args(args, json_mode, &mut scope) {
                                Ok(parsed) => parsed,
                                Err(status) => return status,
                            };
                            match scoped_echo(name, &parsed, &mut scope) {
                                Some(Ok(value)) => Ok(value),
                                Some(Err(status)) => return status,
                                None => debug_call(core, name, &parsed).unwrap_or_else(|| {
                                    let JsValue::Array(values) = &parsed else {
                                        unreachable!()
                                    };
                                    barochart_bridge::call_scoped_with_reply_admission(
                                        core,
                                        name,
                                        values,
                                        &mut scope,
                                        &mut admit_reply,
                                    )
                                }),
                            }
                        }
                    };
                    match result {
                        Ok(value) => {
                            if let Some(pending) = pending_reply {
                                let reply = admitted_reply.expect("pending fixed reply kind");
                                assert!(
                                    reply.matches(&value),
                                    "fixed reply census/handler mismatch"
                                );
                                // SAFETY: admission allocated the final owned descriptor and the
                                // fixed literal copy cannot allocate or fail after publication.
                                out.write(pending.publish(reply.encoded(json_mode)));
                                return BcStatus::BC_OK;
                            }
                            let encoded = match stringify_json_scoped(
                                &value,
                                json_mode,
                                NumberDialect::PLATFORM,
                                &mut scope,
                            ) {
                                Ok(encoded) => encoded,
                                Err(failure) => return oom_status(failure.style()),
                            };
                            match write_accounted_bytes(out, &encoded, &slot.account) {
                                Ok(()) => BcStatus::BC_OK,
                                Err(status) => status,
                            }
                        }
                        Err(error) => {
                            // Source-ordered fixed calls may fail after admission. Their unused
                            // success buffer must release quota before the actual error payload.
                            drop(pending_reply.take());
                            write_accounted_error(out, &error, &slot.account)
                        }
                    }
                },
                |name| {
                    cleanup_whitelisted(name)
                        .then(|| poisoned_call_answer(&slot, name, args, args_len, flags, out))
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

/// 다음 한 번의 알려진 native 함수 dispatch에서 정적 test panic을 일으킨다.
/// debug 빌드에만 존재하며 release artifact에는 export되지 않는다.
/// cbindgen:ignore
///
/// # Safety
/// token은 live `bc_engine_new` 반환값이어야 하고 nonempty name 구간은 읽기 가능해야 한다.
#[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_debug_panic_on(
    engine: *mut BcEngine,
    name: *const u8,
    name_len: usize,
) -> BcStatus {
    ffi_status(|| {
        let slot = match lease(engine) {
            Ok(slot) => slot,
            Err(status) => return status,
        };
        if slot.closed.load(Ordering::Acquire) {
            return BcStatus::BC_CLOSED;
        }
        if slot
            .busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            return BcStatus::BC_BUSY;
        }
        let busy = BusyGuard(&slot);
        let result = if slot.closed.load(Ordering::Acquire) {
            BcStatus::BC_CLOSED
        } else if slot.poisoned.load(Ordering::Acquire) {
            BcStatus::BC_POISONED
        } else {
            // SAFETY: helper가 raw name 구간을 구조 검증한 뒤 slice로 만든다.
            let Some(name) = (unsafe { bytes(name, name_len) }) else {
                return BcStatus::BC_INVALID;
            };
            let Ok(name) = str::from_utf8(name) else {
                return BcStatus::BC_INVALID;
            };
            if !barochart_bridge::supports(name) {
                BcStatus::BC_INVALID
            } else {
                *slot
                    .test_panic_name
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(name.to_owned());
                BcStatus::BC_OK
            }
        };
        drop(busy);
        result
    })
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
                    debug_panic_if_armed(&slot, name);
                    if count > F64_TRANSFER_LIMIT || !valid_f64_output(dst, count) {
                        return BcStatus::BC_INVALID;
                    }
                    let Some(args) = bytes(args, args_len) else {
                        return BcStatus::BC_INVALID;
                    };
                    let mut scope = MemoryScope::new(&slot.account);
                    let parsed = match parse_args(args, JsonMode::Standard, &mut scope) {
                        Ok(parsed) => parsed,
                        Err(status) => return status,
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
                                return write_accounted_error(
                                    error_out,
                                    &JsError::new(
                                        "RangeError",
                                        JsString::from_str("Float64Array length"),
                                    ),
                                    &slot.account,
                                );
                            }
                            for (index, bits) in bits.iter().copied().enumerate() {
                                // SAFETY: dst는 위에서 count 원소 writable임을 검증했다.
                                dst.add(index).write(f64::from_bits(bits));
                            }
                            return BcStatus::BC_OK;
                        }
                    }
                    match barochart_bridge::read_f64_scoped(core, name, arguments, &mut scope) {
                        Err(error) => write_accounted_error(error_out, &error, &slot.account),
                        Ok(values) if values.len() == count => {
                            if count != 0 {
                                // SAFETY: dst 정렬과 count는 위에서 검증했고 같은 호출에서만 원본을 빌린다.
                                ptr::copy_nonoverlapping(values.as_ptr(), dst, count);
                            }
                            BcStatus::BC_OK
                        }
                        Ok(_) => write_accounted_error(
                            error_out,
                            &JsError::new(
                                "TypeError",
                                JsString::from_str("Float64Array result required"),
                            ),
                            &slot.account,
                        ),
                    }
                },
                |_| None,
            )
        }
    })
}

/// Rust 함수의 실제 숫자 배열 결과 전체를 소유 snapshot으로 돌려준다.
///
/// 기존 fast read와 달리 host destination/count를 받거나 검증하지 않는다. Core 함수는 정확히 한 번
/// 실행하며, caller가 payload를 기록한 뒤 별도로 길이를 검증할 수 있다.
///
/// # Safety
/// token/name/args는 `bc_read_f64`와 같은 계약을 따르고, `out`과 `error_out`은 비어 있는 writable
/// output slot이며 서로와 입력에 alias하지 않아야 한다.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_read_f64_snapshot(
    engine: *mut BcEngine,
    name: *const u8,
    name_len: usize,
    args: *const u8,
    args_len: usize,
    out: *mut BcF64Buf,
    error_out: *mut BcBuf,
) -> BcStatus {
    // SAFETY: 기존 Standard JSON 계약을 확장 함수의 flags=0으로 전달한다.
    unsafe {
        bc_read_f64_snapshot_with_flags(engine, name, name_len, args, args_len, 0, out, error_out)
    }
}

/// JSON/BCJSON 인자를 보존하며 실제 typed 결과 전체를 소유 snapshot으로 돌려준다.
/// `flags`는 `bc_call`과 같고, 숫자 결과는 JSON으로 펼치지 않는다.
///
/// # Safety
/// token/name/args와 비어 있는 두 output slot은 `bc_read_f64_snapshot`의 계약을 따른다.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_read_f64_snapshot_with_flags(
    engine: *mut BcEngine,
    name: *const u8,
    name_len: usize,
    args: *const u8,
    args_len: usize,
    flags: u32,
    out: *mut BcF64Buf,
    error_out: *mut BcBuf,
) -> BcStatus {
    ffi_status(|| {
        // SAFETY: 두 출력을 상태 gate 전에 canonical empty로 만든다.
        if !unsafe { empty_f64_buf(out) }
            || !unsafe { empty_buf(error_out) }
            || out.cast::<u8>() == error_out.cast::<u8>()
        {
            return BcStatus::BC_INVALID;
        }
        let slot = match lease(engine) {
            Ok(slot) => slot,
            Err(status) => return unsafe { lease_error(status, error_out) },
        };
        // SAFETY: Arc lease가 slot을 유지하고 두 output은 비어 있다.
        unsafe {
            stateful(
                &slot,
                error_out,
                || {
                    let name = bytes(name, name_len).ok_or(BcStatus::BC_INVALID)?;
                    str::from_utf8(name).map_err(|_| BcStatus::BC_INVALID)
                },
                |core, name| {
                    debug_panic_if_armed(&slot, name);
                    let Some(json_mode) = mode(flags) else {
                        return BcStatus::BC_INVALID;
                    };
                    let Some(args) = bytes(args, args_len) else {
                        return BcStatus::BC_INVALID;
                    };
                    let mut scope = MemoryScope::new(&slot.account);
                    let parsed = match parse_args(args, json_mode, &mut scope) {
                        Ok(parsed) => parsed,
                        Err(status) => return status,
                    };
                    let JsValue::Array(arguments) = &parsed else {
                        unreachable!()
                    };
                    #[cfg(debug_assertions)]
                    {
                        let fixed = [
                            0.0,
                            -0.0,
                            f64::from_bits(0x7ff8_0000_0000_0042),
                            f64::INFINITY,
                        ];
                        if name == "__bcReadF64ForTest" {
                            return match allocate_accounted_f64(&fixed, &slot.account) {
                                Ok(buffer) => {
                                    out.write(buffer);
                                    BcStatus::BC_OK
                                }
                                Err(status) => status,
                            };
                        }
                        if name == "__bcReadLastF64ForTest" {
                            let locked = slot
                                .test_f64
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            let mut values = Vec::new();
                            if values.try_reserve_exact(locked.len()).is_err() {
                                return oom_status(slot.account.allocation_failure().style());
                            }
                            values.extend(locked.iter().copied().map(f64::from_bits));
                            return match allocate_accounted_f64(&values, &slot.account) {
                                Ok(buffer) => {
                                    out.write(buffer);
                                    BcStatus::BC_OK
                                }
                                Err(status) => status,
                            };
                        }
                    }
                    match barochart_bridge::read_f64_scoped(core, name, arguments, &mut scope) {
                        Err(error) => write_accounted_error(error_out, &error, &slot.account),
                        Ok(values) => match allocate_accounted_f64(values, &slot.account) {
                            Ok(buffer) => {
                                out.write(buffer);
                                BcStatus::BC_OK
                            }
                            Err(status) => status,
                        },
                    }
                },
                |_| None,
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
    // SAFETY: 공개 함수의 포인터 계약을 공통 구현에 그대로 전달한다.
    unsafe {
        write_f64_impl(
            engine, name, name_len, args, args_len, src, count, None, error_out,
        )
    }
}

/// 호스트 `double` 배열을 쓰면서 write 직전 target-owned 값을 소유 snapshot으로 돌려준다.
///
/// # Safety
/// `bc_write_f64` 계약에 더해 `before_out`은 비어 있는 writable `BcF64Buf` slot이어야 하며
/// 다른 입출력과 alias하지 않아야 한다.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_write_f64_snapshot(
    engine: *mut BcEngine,
    name: *const u8,
    name_len: usize,
    args: *const u8,
    args_len: usize,
    src: *const f64,
    count: usize,
    before_out: *mut BcF64Buf,
    error_out: *mut BcBuf,
) -> BcStatus {
    // SAFETY: 공개 함수의 확장 포인터 계약을 공통 구현에 그대로 전달한다.
    unsafe {
        write_f64_impl(
            engine,
            name,
            name_len,
            args,
            args_len,
            src,
            count,
            Some(before_out),
            error_out,
        )
    }
}

/// Core typed target을 한 번 관찰한 뒤 host source가 정확할 때만 쓴다.
///
/// `host_count`는 signed host 값 그대로 받는다. Core target handout과 선택적 `before_out` snapshot이
/// 먼저 일어나며, 이후 count가 `1...262144`가 아니거나 실제 길이와 다르거나 source가 유효하지 않으면
/// `BC_OK`와 `did_write=false`를 돌려준다. 따라서 host는 실제 Core 결과를 기록한 뒤 자체 protocol 오류를
/// 만들 수 있다. Core 오류는 host count 오류보다 먼저 반환된다.
///
/// # Safety
/// token/name/args는 `bc_write_f64`와 같은 계약을 따른다. `receipt_out`은 writable slot이어야 한다.
/// `before_out`은 NULL이거나 비어 있는 writable `BcF64Buf` slot이어야 하고, `error_out`은 비어 있는
/// writable `BcBuf` slot이어야 한다. 출력들은 서로 alias하지 않아야 한다. `src`는 실제 target 길이와
/// 일치하는 유효 host count에서만 읽으며, 그때 정렬된 readable `double[host_count]`여야 한다.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn bc_write_f64_observe(
    engine: *mut BcEngine,
    name: *const u8,
    name_len: usize,
    args: *const u8,
    args_len: usize,
    flags: u32,
    src: *const f64,
    host_count: i64,
    receipt_out: *mut BcF64WriteReceipt,
    before_out: *mut BcF64Buf,
    error_out: *mut BcBuf,
) -> BcStatus {
    ffi_status(|| {
        // SAFETY: 모든 필수 출력을 상태 gate 전에 canonical empty로 만든다. before는 선택적이다.
        let receipt_ready = unsafe { empty_f64_write_receipt(receipt_out) };
        let before_ready = before_out.is_null() || unsafe { empty_f64_buf(before_out) };
        let error_ready = unsafe { empty_buf(error_out) };
        let receipt_address = receipt_out.cast::<u8>();
        let before_address = before_out.cast::<u8>();
        let error_address = error_out.cast::<u8>();
        if !receipt_ready
            || !before_ready
            || !error_ready
            || receipt_address == error_address
            || (!before_out.is_null()
                && (before_address == receipt_address || before_address == error_address))
        {
            return BcStatus::BC_INVALID;
        }
        let slot = match lease(engine) {
            Ok(slot) => slot,
            Err(status) => return unsafe { lease_error(status, error_out) },
        };
        // SAFETY: Arc lease가 slot을 유지하고 출력들은 위에서 검증·초기화했다.
        unsafe {
            stateful(
                &slot,
                error_out,
                || {
                    let name = bytes(name, name_len).ok_or(BcStatus::BC_INVALID)?;
                    str::from_utf8(name).map_err(|_| BcStatus::BC_INVALID)
                },
                |core, name| {
                    debug_panic_if_armed(&slot, name);
                    let Some(json_mode) = mode(flags) else {
                        return BcStatus::BC_INVALID;
                    };
                    let Some(args) = bytes(args, args_len) else {
                        return BcStatus::BC_INVALID;
                    };
                    let mut scope = MemoryScope::new(&slot.account);
                    let parsed = match parse_args(args, json_mode, &mut scope) {
                        Ok(parsed) => parsed,
                        Err(status) => return status,
                    };
                    let JsValue::Array(arguments) = &parsed else {
                        unreachable!()
                    };

                    let mut pending_before: Option<PendingF64Output> = None;
                    let mut callback_status = None;
                    let access = |target: &mut [f64]| -> Result<(), JsError> {
                        receipt_out.write(BcF64WriteReceipt {
                            actual_count: target.len(),
                            did_write: false,
                        });
                        if !before_out.is_null() {
                            let mut output =
                                match PendingF64Output::new(target.len(), &slot.account) {
                                    Ok(output) => output,
                                    Err(status) => {
                                        callback_status = Some(status);
                                        return Err(JsError::new(
                                            "RangeError",
                                            JsString::from_str("Out of memory"),
                                        ));
                                    }
                                };
                            if let Err(status) = output.copy_from(target) {
                                callback_status = Some(status);
                                return Err(JsError::new(
                                    "TypeError",
                                    JsString::from_str("Float64Array result required"),
                                ));
                            }
                            pending_before = Some(output);
                        }

                        let Ok(count) = usize::try_from(host_count) else {
                            return Ok(());
                        };
                        if count == 0 || count > F64_TRANSFER_LIMIT || count != target.len() {
                            return Ok(());
                        }
                        let Some(source) = f64_input(src, count) else {
                            return Ok(());
                        };
                        target.copy_from_slice(source);
                        receipt_out.write(BcF64WriteReceipt {
                            actual_count: target.len(),
                            did_write: true,
                        });
                        Ok(())
                    };
                    #[cfg(debug_assertions)]
                    let mut access = access;

                    #[cfg(debug_assertions)]
                    let result = if name == "__bcWriteF64ForTest" {
                        let mut locked = slot
                            .test_f64
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        let mut values = Vec::new();
                        if values.try_reserve_exact(locked.len()).is_err() {
                            return oom_status(slot.account.allocation_failure().style());
                        }
                        values.extend(locked.iter().copied().map(f64::from_bits));
                        let result = access(&mut values);
                        if receipt_out.read().did_write {
                            locked.clear();
                            locked.extend(values.iter().map(|value| value.to_bits()));
                        }
                        result
                    } else {
                        barochart_bridge::with_write_f64_target_scoped(
                            core, name, arguments, &mut scope, access,
                        )
                    };
                    #[cfg(not(debug_assertions))]
                    let result = barochart_bridge::with_write_f64_target_scoped(
                        core, name, arguments, &mut scope, access,
                    );

                    if let Some(status) = callback_status {
                        return status;
                    }
                    match result {
                        Err(error) => write_accounted_error(error_out, &error, &slot.account),
                        Ok(()) => {
                            if let Some(output) = pending_before {
                                before_out.write(output.finish());
                            }
                            BcStatus::BC_OK
                        }
                    }
                },
                |_| None,
            )
        }
    })
}

#[cfg(not(target_arch = "wasm32"))]
#[allow(clippy::too_many_arguments)]
unsafe fn write_f64_impl(
    engine: *mut BcEngine,
    name: *const u8,
    name_len: usize,
    args: *const u8,
    args_len: usize,
    src: *const f64,
    count: usize,
    before_out: Option<*mut BcF64Buf>,
    error_out: *mut BcBuf,
) -> BcStatus {
    ffi_status(|| {
        // SAFETY: 모든 출력을 상태 gate 전에 canonical empty로 만든다.
        if !unsafe { empty_buf(error_out) }
            || before_out.is_some_and(|output| !unsafe { empty_f64_buf(output) })
            || before_out.is_some_and(|output| output.cast::<u8>() == error_out.cast::<u8>())
        {
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
                    debug_panic_if_armed(&slot, name);
                    if count > F64_TRANSFER_LIMIT {
                        return BcStatus::BC_INVALID;
                    }
                    let Some(source) = f64_input(src, count) else {
                        return BcStatus::BC_INVALID;
                    };
                    let Some(args) = bytes(args, args_len) else {
                        return BcStatus::BC_INVALID;
                    };
                    let mut scope = MemoryScope::new(&slot.account);
                    let parsed = match parse_args(args, JsonMode::Standard, &mut scope) {
                        Ok(parsed) => parsed,
                        Err(status) => return status,
                    };
                    let JsValue::Array(arguments) = &parsed else {
                        unreachable!()
                    };
                    let mut pending = if before_out.is_some() {
                        match PendingF64Output::new(count, &slot.account) {
                            Ok(output) => Some(output),
                            Err(status) => return status,
                        }
                    } else {
                        None
                    };
                    #[cfg(debug_assertions)]
                    if name == "__bcWriteF64ForTest" {
                        let mut locked = slot
                            .test_f64
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        let before = if pending.is_some() {
                            if locked.len() != count {
                                return write_accounted_error(
                                    error_out,
                                    &JsError::new(
                                        "RangeError",
                                        JsString::from_str("Float64Array length"),
                                    ),
                                    &slot.account,
                                );
                            }
                            let mut values = Vec::new();
                            if values.try_reserve_exact(count).is_err() {
                                return oom_status(slot.account.allocation_failure().style());
                            }
                            values.extend(locked.iter().copied().map(f64::from_bits));
                            Some(values)
                        } else {
                            None
                        };
                        let mut copied = Vec::new();
                        if copied.try_reserve_exact(count).is_err() {
                            return oom_status(slot.account.allocation_failure().style());
                        }
                        copied.extend(source.iter().map(|value| value.to_bits()));
                        *locked = copied;
                        drop(locked);
                        if let (Some(output), Some(before)) = (pending, before) {
                            let buffer = match output.publish(&before) {
                                Ok(buffer) => buffer,
                                Err(status) => return status,
                            };
                            // SAFETY: snapshot export validated the writable output slot.
                            before_out.expect("snapshot output").write(buffer);
                        }
                        return BcStatus::BC_OK;
                    }
                    match barochart_bridge::write_f64_scoped(
                        core,
                        name,
                        arguments,
                        source,
                        &mut scope,
                        |before| {
                            if let Some(output) = pending.as_mut() {
                                output.copy_from(before).map_err(|_| {
                                    JsError::new(
                                        "TypeError",
                                        JsString::from_str("Float64Array result required"),
                                    )
                                })?;
                            }
                            Ok(())
                        },
                    ) {
                        Err(error) => write_accounted_error(error_out, &error, &slot.account),
                        Ok(()) => {
                            if let Some(output) = pending {
                                before_out.expect("snapshot output").write(output.finish());
                            }
                            BcStatus::BC_OK
                        }
                    }
                },
                |_| None,
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
                |core, ()| {
                    let Some(args) = bytes(args, args_len) else {
                        return BcStatus::BC_INVALID;
                    };
                    let mut scope = MemoryScope::new(&slot.account);
                    let _parsed = match parse_args(args, JsonMode::Standard, &mut scope) {
                        Ok(parsed) => parsed,
                        Err(status) => return status,
                    };
                    #[cfg(debug_assertions)]
                    if let JsValue::Array(values) = &_parsed
                        && let Some(JsValue::String(name)) = values.first()
                    {
                        let name = name.to_string_lossy();
                        if matches!(
                            name.as_str(),
                            "__bcPacketForTest"
                                | "__bcEmptyPacketForTest"
                                | "__bcPacketForTestLarge"
                        ) {
                            let mut numbers = Vec::new();
                            let needed = match name.as_str() {
                                "__bcPacketForTest" => 4,
                                "__bcPacketForTestLarge" => 8_192,
                                _ => 0,
                            };
                            if numbers.try_reserve_exact(needed).is_err() {
                                return BcStatus::BC_THROW;
                            }
                            if needed != 0 {
                                numbers.resize(needed, 0.0);
                                numbers[..4].copy_from_slice(&[
                                    0.0,
                                    -0.0,
                                    f64::from_bits(0x7ff8_0000_0000_0042),
                                    f64::INFINITY,
                                ]);
                            }
                            let metadata = match allocate_accounted_bytes(
                                br#"{"kind":"test"}"#,
                                &slot.account,
                            ) {
                                Ok(metadata) => metadata,
                                Err(status) => return status,
                            };
                            let numbers = match allocate_accounted_f64(&numbers, &slot.account) {
                                Ok(numbers) => numbers,
                                Err(status) => {
                                    free_buf(metadata);
                                    return status;
                                }
                            };
                            metadata_out.write(metadata);
                            numbers_out.write(numbers);
                            return BcStatus::BC_OK;
                        }
                    }
                    let JsValue::Array(arguments) = &_parsed else {
                        unreachable!("validated array")
                    };
                    match barochart_bridge::packet_scoped(core, arguments, &mut scope) {
                        Err(error) => write_accounted_error(metadata_out, &error, &slot.account),
                        Ok(packet) => {
                            let text = match packet.metadata.try_to_string_lossy_scoped(&mut scope)
                            {
                                Ok(text) => text,
                                Err(error) => return oom_status(error.style()),
                            };
                            let metadata =
                                match allocate_accounted_bytes(text.as_bytes(), &slot.account) {
                                    Ok(value) => value,
                                    Err(status) => return status,
                                };
                            let numbers =
                                match allocate_accounted_f64(&packet.numbers, &slot.account) {
                                    Ok(numbers) => numbers,
                                    Err(status) => {
                                        free_buf(metadata);
                                        return status;
                                    }
                                };
                            metadata_out.write(metadata);
                            numbers_out.write(numbers);
                            BcStatus::BC_OK
                        }
                    }
                },
                |_| None,
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
        let snapshot = slot.account.snapshot();
        let json = format!(
            "{{\"requestedLiveBytes\":{},\"requestedPeakBytes\":{},\"limitBytes\":{},\"retainedOutputBytes\":{},\"poisoned\":{}}}",
            snapshot.requested_live_bytes,
            snapshot.requested_peak_bytes,
            snapshot.limit_bytes,
            snapshot.retained_output_bytes,
            slot.poisoned.load(Ordering::Acquire),
        );
        // SAFETY: out은 진입에서 writable임을 확인했다.
        match unsafe { write_bytes_with_style(out, json.as_bytes(), slot.account.oom_style()) } {
            Ok(()) => BcStatus::BC_OK,
            Err(status) => status,
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
    let _ = wasm_web::bc_web_abi_version as extern "C" fn() -> u32;
    let _ = wasm_web::bc_web_capabilities
        as unsafe extern "C" fn(*mut BcEngine, *mut BcBuf) -> BcStatus;
    let _ = wasm_web::bc_web_read_f64
        as unsafe extern "C" fn(
            *mut BcEngine,
            *const u8,
            usize,
            *const u8,
            usize,
            u32,
            *mut BcBuf,
        ) -> BcStatus;
    let _ = wasm_web::bc_web_write_f64
        as unsafe extern "C" fn(
            *mut BcEngine,
            *const u8,
            usize,
            *const u8,
            usize,
            u32,
            *const f64,
            u32,
            *mut u32,
            *mut BcBuf,
        ) -> BcStatus;
    let _ = wasm_web::bc_web_packet
        as unsafe extern "C" fn(
            *mut BcEngine,
            *const u8,
            usize,
            *mut BcBuf,
            *mut BcBuf,
        ) -> BcStatus;
    let _ = wasm_web::bc_web_memory_stats
        as unsafe extern "C" fn(*const BcEngine, *mut BcBuf) -> BcStatus;
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
    use std::slice;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Mutex, MutexGuard, OnceLock};

    use super::{
        BC_FLAG_LOSSLESS, BcBuf, BcEngine, BcHost, BcStatus, EngineSlot, NEXT_ENGINE_ID,
        PendingByteOutput, bc_buf_free, bc_buf_new_copy, bc_call, bc_engine_free, bc_engine_new,
        bc_engine_new_with_limit, lease, next_engine_id,
    };
    use barochart_js::json::{JsObject, JsValue, JsonMode, stringify_json};
    use barochart_js::memory::{MemoryAccount, OomStyle};
    use barochart_js::string::JsString;

    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn serial() -> MutexGuard<'static, ()> {
        TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

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

    unsafe extern "C" fn zone_resolve_ok(
        _: *mut c_void,
        _: *const u8,
        _: usize,
        out: *mut BcBuf,
    ) -> i32 {
        // SAFETY: callback receives a writable BcBuf output and copies a static UTF-8 zone.
        let status = unsafe { bc_buf_new_copy(b"UTC".as_ptr(), 3, out) };
        i32::from(status != BcStatus::BC_OK)
    }

    unsafe extern "C" fn zone_offset_ok(
        _: *mut c_void,
        _: *const u8,
        _: usize,
        _: f64,
        out: *mut i32,
    ) -> i32 {
        if !out.is_null() {
            // SAFETY: callback contract provides one writable i32.
            unsafe { out.write(0) };
        }
        0
    }

    unsafe extern "C" fn release(context: *mut c_void) {
        // SAFETY: 테스트 context는 호출 동안 유효한 AtomicUsize다.
        unsafe { &*context.cast::<AtomicUsize>() }.fetch_add(1, Ordering::SeqCst);
    }

    #[test]
    fn handle_id_exhaustion_never_wraps_or_reuses_zero() {
        let _guard = serial();
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

    #[test]
    fn pending_byte_output_is_final_owned_storage_and_drops_without_retention() {
        let _guard = serial();
        let account = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
        let pending = PendingByteOutput::new(4, &account).expect("fixed reply allocation");
        let admitted = account.snapshot();
        assert!(admitted.retained_output_bytes >= 4);
        let output = pending.publish(b"null");
        // SAFETY: pending output owns exactly output.len initialized bytes until bc_buf_free.
        assert_eq!(
            unsafe { slice::from_raw_parts(output.ptr, output.len) },
            b"null"
        );
        assert_eq!(
            account.snapshot().retained_output_bytes,
            admitted.retained_output_bytes
        );
        // SAFETY: PendingByteOutput published this exact unique descriptor once.
        unsafe { bc_buf_free(output) };
        assert_eq!(account.snapshot().retained_output_bytes, 0);

        let denied = MemoryAccount::new(1, OomStyle::InternalErrorLowercase);
        assert_eq!(
            PendingByteOutput::new(4, &denied).unwrap_err(),
            BcStatus::BC_OOM_LIMIT
        );
        assert_eq!(denied.snapshot().requested_live_bytes, 0);
        assert_eq!(denied.snapshot().retained_output_bytes, 0);
    }

    unsafe fn call_bytes(engine: *mut BcEngine, name: &[u8], args: &[u8]) -> (BcStatus, BcBuf) {
        let mut output = BcBuf::default();
        // SAFETY: test engine/name/args/output satisfy bc_call's ownership contract.
        let status = unsafe {
            bc_call(
                engine,
                name.as_ptr(),
                name.len(),
                args.as_ptr(),
                args.len(),
                0,
                &mut output,
            )
        };
        (status, output)
    }

    fn capture_model(slot: &EngineSlot) -> barochart_core::model_state::ModelWorkspaceCaptureToken {
        // SAFETY: these serialized tests own an idle engine and make only immutable observations.
        let core = unsafe { &*slot.core.get() }.as_ref().expect("open core");
        core.chart()
            .expect("initialized chart")
            .model()
            .capture_workspace_state()
    }

    fn model_matches(
        slot: &EngineSlot,
        token: &barochart_core::model_state::ModelWorkspaceCaptureToken,
    ) -> bool {
        // SAFETY: the preceding call completed and the engine is idle.
        let core = unsafe { &*slot.core.get() }.as_ref().expect("open core");
        core.chart()
            .expect("initialized chart")
            .model()
            .validate_workspace_state(token)
    }

    fn capture_view(slot: &EngineSlot) -> (u64, u64, bool) {
        // SAFETY: immutable observation of an idle serialized test engine.
        let core = unsafe { &*slot.core.get() }.as_ref().expect("open core");
        let model = core.chart().expect("initialized chart").model();
        (
            model.view.from.to_bits(),
            model.view.to.to_bits(),
            model.follow,
        )
    }

    fn capture_store(slot: &EngineSlot) -> (barochart_core::data::DataIdentity, u64, usize) {
        // SAFETY: immutable observation of an idle serialized test engine.
        let core = unsafe { &*slot.core.get() }.as_ref().expect("open core");
        let store = core.chart().expect("initialized chart").data().store();
        (
            store.data_identity(),
            store.version().to_bits(),
            store.length(),
        )
    }

    fn store_matches(
        slot: &EngineSlot,
        token: &(barochart_core::data::DataIdentity, u64, usize),
    ) -> bool {
        // SAFETY: immutable observation after the completed serialized call.
        let core = unsafe { &*slot.core.get() }.as_ref().expect("open core");
        let store = core.chart().expect("initialized chart").data().store();
        store.data_identity().matches(&token.0)
            && store.version().to_bits() == token.1
            && store.length() == token.2
    }

    fn capture_interaction(slot: &EngineSlot) -> Vec<u8> {
        // SAFETY: immutable observation of an idle serialized test engine.
        let core = unsafe { &*slot.core.get() }.as_ref().expect("open core");
        let input = core.input().expect("initialized input");
        stringify_json(
            &object([
                ("tool", JsValue::String(input.tool().clone())),
                ("text", input.text().clone()),
                (
                    "drawingTarget",
                    input.drawing_target().cloned().unwrap_or(JsValue::Null),
                ),
                ("drawingMagnet", input.drawing_magnet()),
                ("crosshairSnap", input.crosshair_snap()),
                ("pointers", JsValue::Number(input.pointer_count() as f64)),
                (
                    "gesture",
                    input.gesture_kind().map_or(JsValue::Null, |value| {
                        JsValue::String(JsString::from_str(value))
                    }),
                ),
            ]),
            JsonMode::Standard,
        )
    }

    fn capture_native_size(slot: &EngineSlot) -> Option<Vec<u8>> {
        // SAFETY: immutable observation of an idle serialized test engine.
        let core = unsafe { &*slot.core.get() }.as_ref().expect("open core");
        core.native_size().map(|size| {
            stringify_json(
                &JsValue::Array(vec![size.width().clone(), size.height().clone()]),
                JsonMode::Standard,
            )
        })
    }

    fn capture_drawings(
        slot: &EngineSlot,
    ) -> barochart_core::drawings::DrawingWorkspaceCaptureToken {
        // SAFETY: immutable observation of an idle serialized test engine.
        let core = unsafe { &*slot.core.get() }.as_ref().expect("open core");
        core.chart()
            .expect("initialized chart")
            .drawings()
            .capture_workspace_state()
            .expect("drawing capture")
    }

    fn drawings_match(
        slot: &EngineSlot,
        token: &barochart_core::drawings::DrawingWorkspaceCaptureToken,
    ) -> bool {
        // SAFETY: immutable observation after a completed serialized call.
        let core = unsafe { &*slot.core.get() }.as_ref().expect("open core");
        core.chart()
            .expect("initialized chart")
            .drawings()
            .validate_workspace_state(token)
    }

    fn object<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
        let mut object = JsObject::new();
        for (name, value) in entries {
            object.insert(JsString::from_str(name), value);
        }
        JsValue::Object(object)
    }

    #[test]
    fn fixed_navigation_reply_quota_is_admitted_before_one_publication() {
        let _guard = serial();
        const LIMIT: u64 = 16 * 1024 * 1024;
        let host = BcHost {
            context: ptr::null_mut(),
            zone_resolve: Some(zone_resolve),
            zone_offset_seconds: Some(zone_offset),
            log: None,
            release: None,
        };
        let mut engine = ptr::null_mut();
        let mut error = BcBuf::default();
        // SAFETY: outputs are writable and callbacks live for the engine lifetime.
        assert_eq!(
            unsafe { bc_engine_new_with_limit(&host, LIMIT, &mut engine, &mut error) },
            BcStatus::BC_OK
        );
        assert!(error.ptr.is_null());
        let (status, init) = unsafe { call_bytes(engine, b"nativeInit", b"[0]") };
        assert_eq!(status, BcStatus::BC_OK);
        // SAFETY: bc_call returned one unique owned buffer.
        unsafe { bc_buf_free(init) };

        let slot = lease(engine).expect("live test engine");
        let account = Arc::clone(&slot.account);
        let args = br#"["setVisibleRange",[-0.5,20.5]]"#;
        let attempt = |headroom: u64| -> bool {
            let before = capture_model(&slot);
            let live = account.snapshot().requested_live_bytes;
            let pressure = account
                .reserve(LIMIT - live - headroom)
                .expect("headroom pressure");
            let (status, output) = unsafe { call_bytes(engine, b"nativeCommand", args) };
            let unchanged = model_matches(&slot, &before);
            let succeeded = match status {
                BcStatus::BC_OOM_LIMIT => {
                    assert!(output.ptr.is_null());
                    assert!(
                        unchanged,
                        "reply denial published the view at {headroom} bytes"
                    );
                    assert_eq!(account.snapshot().retained_output_bytes, 0);
                    false
                }
                BcStatus::BC_OK => {
                    assert!(
                        !unchanged,
                        "successful navigation must publish one new view identity"
                    );
                    // SAFETY: successful bc_call returned initialized output.len bytes.
                    assert_eq!(
                        unsafe { slice::from_raw_parts(output.ptr, output.len) },
                        b"null"
                    );
                    true
                }
                other => panic!("unexpected navigation status at {headroom}: {other:?}"),
            };
            // SAFETY: exact successful descriptor or canonical empty is returned once.
            unsafe { bc_buf_free(output) };
            assert_eq!(account.snapshot().retained_output_bytes, 0);
            drop(pressure);
            succeeded
        };
        let mut last_denied = 0_u64;
        let mut first_success = None;
        let mut headroom = 1_u64;

        while headroom <= 65_536 {
            if attempt(headroom) {
                first_success = Some(headroom);
                break;
            }
            last_denied = headroom;
            headroom *= 2;
        }
        let mut first_success = first_success.expect("bounded fixed reply headroom");
        while first_success - last_denied > 1 {
            let middle = last_denied + (first_success - last_denied) / 2;
            if attempt(middle) {
                first_success = middle;
            } else {
                last_denied = middle;
            }
        }
        assert_eq!(last_denied + 1, first_success);

        // The exact byte immediately below a known success must still leave state untouched.
        assert!(!attempt(last_denied));
        assert!(attempt(first_success));

        // Semantic validation precedes reply admission even when that admission would be denied.
        let malformed_before = capture_model(&slot);
        let mut admission_called = false;
        let result = {
            // SAFETY: this test exclusively owns the idle engine during the direct Core call.
            let core = unsafe { &mut *slot.core.get() }
                .as_mut()
                .expect("open core");
            let mut scope = core.memory_context().scope();
            barochart_bridge::call_scoped_with_reply_admission(
                core,
                "nativeCommand",
                &[
                    JsValue::String(JsString::from_str("setVisibleRange")),
                    JsValue::Array(vec![
                        JsValue::String(JsString::from_str("bad")),
                        JsValue::Number(20.5),
                    ]),
                ],
                &mut scope,
                &mut |_| {
                    admission_called = true;
                    Err(account.allocation_failure().into_js_error())
                },
            )
        };
        let malformed = result.expect_err("malformed range");
        assert_eq!(malformed.name, "RangeError");
        assert_eq!(malformed.message.to_string_lossy(), "Visible range");
        assert!(!admission_called);
        assert!(model_matches(&slot, &malformed_before));

        drop(slot);
        // SAFETY: terminally release the unique engine token.
        unsafe { bc_engine_free(engine) };
        assert_eq!(account.snapshot().requested_live_bytes, 0);
    }

    #[test]
    fn bulk_fixed_reply_owns_output_before_store_publication() {
        let _guard = serial();
        const LIMIT: u64 = 16 * 1024 * 1024;
        let host = BcHost {
            context: ptr::null_mut(),
            zone_resolve: Some(zone_resolve),
            zone_offset_seconds: Some(zone_offset),
            log: None,
            release: None,
        };
        let mut engine = ptr::null_mut();
        let mut error = BcBuf::default();
        // SAFETY: outputs and callbacks satisfy the constructor contract.
        assert_eq!(
            unsafe { bc_engine_new_with_limit(&host, LIMIT, &mut engine, &mut error) },
            BcStatus::BC_OK
        );
        let (status, init) = unsafe { call_bytes(engine, b"nativeInit", b"[0]") };
        assert_eq!(status, BcStatus::BC_OK);
        // SAFETY: exact successful descriptor.
        unsafe { bc_buf_free(init) };
        let slot = lease(engine).expect("live engine");
        let account = Arc::clone(&slot.account);
        let args = br#"["setData",[[{"time":1,"open":2,"high":3,"low":1,"close":2,"volume":4}]]]"#;
        let mut headroom = 1_u64;
        let mut observed_denial = false;
        let mut observed_success = false;
        while headroom <= 65_536 {
            let before = capture_store(&slot);
            let live = account.snapshot().requested_live_bytes;
            let pressure = account
                .reserve(LIMIT - live - headroom)
                .expect("bulk headroom pressure");
            let (status, output) = unsafe { call_bytes(engine, b"nativeCommand", args) };
            match status {
                BcStatus::BC_OOM_LIMIT => {
                    observed_denial = true;
                    assert!(output.ptr.is_null());
                    assert!(
                        store_matches(&slot, &before),
                        "bulk reply denial published store"
                    );
                }
                BcStatus::BC_OK => {
                    observed_success = true;
                    assert!(!store_matches(&slot, &before));
                    // SAFETY: successful fixed reply owns output.len initialized bytes.
                    assert_eq!(
                        unsafe { slice::from_raw_parts(output.ptr, output.len) },
                        b"null"
                    );
                }
                other => panic!("unexpected bulk status at {headroom}: {other:?}"),
            }
            // SAFETY: exact successful descriptor or canonical empty.
            unsafe { bc_buf_free(output) };
            assert_eq!(account.snapshot().retained_output_bytes, 0);
            drop(pressure);
            if observed_success {
                break;
            }
            headroom *= 2;
        }
        assert!(observed_denial && observed_success);
        drop(slot);
        // SAFETY: terminal unique engine release.
        unsafe { bc_engine_free(engine) };
    }

    #[test]
    fn every_staged_navigation_alias_reaches_admission_before_publication() {
        let _guard = serial();
        use barochart_bridge::reply_policy::FixedReply;

        let host = BcHost {
            context: ptr::null_mut(),
            zone_resolve: Some(zone_resolve),
            zone_offset_seconds: Some(zone_offset),
            log: None,
            release: None,
        };
        let mut engine = ptr::null_mut();
        let mut error = BcBuf::default();
        // SAFETY: outputs and callbacks satisfy the constructor contract.
        assert_eq!(
            unsafe { bc_engine_new(&host, &mut engine, &mut error) },
            BcStatus::BC_OK
        );
        let (status, init) = unsafe { call_bytes(engine, b"nativeInit", b"[0]") };
        assert_eq!(status, BcStatus::BC_OK);
        // SAFETY: exact successful output descriptor.
        unsafe { bc_buf_free(init) };
        let slot = lease(engine).expect("live engine");
        let account = Arc::clone(&slot.account);
        let command = |name: &str, args: Vec<JsValue>| {
            vec![
                JsValue::String(JsString::from_str(name)),
                JsValue::Array(args),
            ]
        };
        let empty_columns = || {
            object([
                ("time", JsValue::Array(vec![])),
                ("open", JsValue::Array(vec![])),
                ("high", JsValue::Array(vec![])),
                ("low", JsValue::Array(vec![])),
                ("close", JsValue::Array(vec![])),
                ("volume", JsValue::Array(vec![])),
            ])
        };
        let cases = [
            (
                "nativeCommand",
                command("setData", vec![JsValue::Array(vec![])]),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command("setColumns", vec![empty_columns()]),
                FixedReply::Null,
            ),
            (
                "nativeView",
                vec![JsValue::Number(-0.5), JsValue::Number(20.5)],
                FixedReply::Undefined,
            ),
            ("nativeFit", vec![], FixedReply::Undefined),
            (
                "nativeCommand",
                command(
                    "setVisibleRange",
                    vec![JsValue::Number(-0.5), JsValue::Number(20.5)],
                ),
                FixedReply::Null,
            ),
            ("nativeCommand", command("fit", vec![]), FixedReply::Null),
            (
                "nativeCommand",
                command("zoom", vec![JsValue::Number(0.8)]),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command("pan", vec![JsValue::Number(1.0)]),
                FixedReply::Null,
            ),
        ];
        for (name, args, expected) in cases {
            let before = capture_model(&slot);
            let view_before = capture_view(&slot);
            let mut admitted = None;
            let result = {
                // SAFETY: serialized unit test owns the idle engine exclusively.
                let core = unsafe { &mut *slot.core.get() }
                    .as_mut()
                    .expect("open core");
                let mut scope = core.memory_context().scope();
                barochart_bridge::call_scoped_with_reply_admission(
                    core,
                    name,
                    &args,
                    &mut scope,
                    &mut |reply| {
                        admitted = Some(reply);
                        Err(account.allocation_failure().into_js_error())
                    },
                )
            };
            assert!(
                barochart_js::memory::oom_style_from_error(
                    &result.expect_err("denied reply admission")
                )
                .is_some()
            );
            assert_eq!(admitted, Some(expected), "{name}");
            if name == "nativeWheel" {
                // Source layout may publish lazy indicator/cache effects before zoom validation.
                assert_eq!(capture_view(&slot), view_before, "{name}");
            } else {
                assert!(model_matches(&slot, &before), "{name}");
            }
        }
        for (name, args, expected) in [
            ("nativeView", "[-0.5,20.5]", b"undefined".as_slice()),
            ("nativeFit", "[]", b"undefined".as_slice()),
            ("nativeCommand", "[\"fit\"]", b"null".as_slice()),
        ] {
            let mut output = BcBuf::default();
            // SAFETY: live engine and borrowed UTF-8 inputs remain valid for the call.
            let status = unsafe {
                bc_call(
                    engine,
                    name.as_ptr(),
                    name.len(),
                    args.as_ptr(),
                    args.len(),
                    BC_FLAG_LOSSLESS,
                    &mut output,
                )
            };
            assert_eq!(status, BcStatus::BC_OK, "{name}");
            // SAFETY: successful fixed reply owns output.len initialized bytes.
            assert_eq!(
                unsafe { slice::from_raw_parts(output.ptr, output.len) },
                expected
            );
            // SAFETY: exact successful descriptor is returned once.
            unsafe { bc_buf_free(output) };
        }
        drop(slot);
        // SAFETY: terminal unique engine release.
        unsafe { bc_engine_free(engine) };
    }

    #[test]
    fn staged_model_fixed_replies_deny_before_publication() {
        use barochart_bridge::reply_policy::FixedReply;

        let _guard = serial();
        let host = BcHost {
            context: ptr::null_mut(),
            zone_resolve: Some(zone_resolve_ok),
            zone_offset_seconds: Some(zone_offset_ok),
            log: None,
            release: None,
        };
        let mut engine = ptr::null_mut();
        let mut error = BcBuf::default();
        // SAFETY: outputs and callbacks satisfy the constructor contract.
        assert_eq!(
            unsafe { bc_engine_new(&host, &mut engine, &mut error) },
            BcStatus::BC_OK
        );
        let (status, init) = unsafe { call_bytes(engine, b"nativeInit", b"[0]") };
        assert_eq!(status, BcStatus::BC_OK);
        // SAFETY: exact successful descriptor.
        unsafe { bc_buf_free(init) };
        for setup in [
            br#"["addPanel",[{"id":"aux-panel"}]]"#.as_slice(),
            br#"["addAxis",[{"id":"aux","panel":"price"}]]"#.as_slice(),
            br#"["addSeries",[{"id":"external","type":"line","panel":"price"}]]"#.as_slice(),
            br#"["addIndicator",["gate-ind","sma",{"period":2}]]"#.as_slice(),
        ] {
            let (status, output) = unsafe { call_bytes(engine, b"nativeCommand", setup) };
            assert_eq!(status, BcStatus::BC_OK);
            // SAFETY: exact successful setup descriptor.
            unsafe { bc_buf_free(output) };
        }
        for setup in [
            br#"["addDrawing",[{"id":"gate-d1","type":"horizontal","panel":"price","seriesId":"price","points":[{"time":1,"price":2}]}]]"#.as_slice(),
            br#"["addDrawing",[{"id":"gate-d2","type":"horizontal","panel":"price","seriesId":"price","points":[{"time":2,"price":3}]}]]"#.as_slice(),
            br#"["undo",[]]"#.as_slice(),
            br#"["selectDrawing",[null]]"#.as_slice(),
        ] {
            let (status, output) = unsafe { call_bytes(engine, b"nativeCommand", setup) };
            assert_eq!(status, BcStatus::BC_OK, "{}", String::from_utf8_lossy(setup));
            // SAFETY: exact successful setup descriptor.
            unsafe { bc_buf_free(output) };
        }

        let slot = lease(engine).expect("live engine");
        let account = Arc::clone(&slot.account);
        let command = |name: &str, args: Vec<JsValue>| {
            vec![
                JsValue::String(JsString::from_str(name)),
                JsValue::Array(args),
            ]
        };
        let empty_columns = || {
            object([
                ("time", JsValue::Array(vec![])),
                ("open", JsValue::Array(vec![])),
                ("high", JsValue::Array(vec![])),
                ("low", JsValue::Array(vec![])),
                ("close", JsValue::Array(vec![])),
                ("volume", JsValue::Array(vec![])),
            ])
        };
        let drawing_document = {
            // SAFETY: immutable observation of the idle engine.
            let core = unsafe { &*slot.core.get() }.as_ref().expect("open core");
            core.chart()
                .expect("initialized chart")
                .drawings()
                .save()
                .expect("drawing document")
        };
        let symbol = object([
            ("id", JsValue::String(JsString::from_str("TEST"))),
            ("exchange", JsValue::String(JsString::from_str("DEMO"))),
            ("timezone", JsValue::String(JsString::from_str("UTC"))),
            ("currency", JsValue::String(JsString::from_str("USD"))),
            ("volumeUnit", JsValue::String(JsString::from_str("shares"))),
            ("priceDecimals", JsValue::Number(2.0)),
            ("tickSize", JsValue::Number(0.01)),
            ("adjustment", JsValue::String(JsString::from_str("raw"))),
        ]);
        let cases = [
            (
                "nativeCommand",
                command(
                    "setPanel",
                    vec![
                        JsValue::String(JsString::from_str("price")),
                        object([("weight", JsValue::Number(2.0))]),
                    ],
                ),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command(
                    "setSeries",
                    vec![
                        JsValue::String(JsString::from_str("external")),
                        object([("color", JsValue::String(JsString::from_str("#abcdef")))]),
                    ],
                ),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command(
                    "removePanel",
                    vec![JsValue::String(JsString::from_str("aux-panel"))],
                ),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command(
                    "removeSeries",
                    vec![JsValue::String(JsString::from_str("external"))],
                ),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command(
                    "removeIndicator",
                    vec![JsValue::String(JsString::from_str("gate-ind"))],
                ),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command(
                    "setAxis",
                    vec![
                        JsValue::String(JsString::from_str("aux")),
                        object([("width", JsValue::Number(40.0))]),
                    ],
                ),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command(
                    "removeAxis",
                    vec![JsValue::String(JsString::from_str("aux"))],
                ),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command(
                    "setSeriesValues",
                    vec![
                        JsValue::String(JsString::from_str("external")),
                        JsValue::Array(vec![]),
                    ],
                ),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command(
                    "setTheme",
                    vec![object([(
                        "background",
                        JsValue::String(JsString::from_str("#010203")),
                    )])],
                ),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command("setSymbol", vec![symbol]),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command(
                    "editDrawing",
                    vec![
                        JsValue::String(JsString::from_str("gate-d1")),
                        object([("visible", JsValue::Bool(false))]),
                    ],
                ),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command(
                    "selectDrawing",
                    vec![JsValue::String(JsString::from_str("gate-d1"))],
                ),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command(
                    "loadDrawings",
                    vec![JsValue::String(drawing_document.clone())],
                ),
                FixedReply::Null,
            ),
            ("nativeCommand", command("undo", vec![]), FixedReply::Null),
            ("nativeCommand", command("redo", vec![]), FixedReply::Null),
            (
                "nativeLoad",
                vec![JsValue::String(drawing_document)],
                FixedReply::Undefined,
            ),
            (
                "nativeCommand",
                command("setDrawingTarget", vec![JsValue::Null]),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command(
                    "setDrawingMagnet",
                    vec![object([
                        ("mode", JsValue::String(JsString::from_str("weak"))),
                        ("radiusPx", JsValue::Number(8.0)),
                    ])],
                ),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command(
                    "setCrosshairSnap",
                    vec![object([(
                        "mode",
                        JsValue::String(JsString::from_str("free")),
                    )])],
                ),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command(
                    "setTool",
                    vec![JsValue::String(JsString::from_str("horizontal"))],
                ),
                FixedReply::Null,
            ),
            (
                "nativeCommand",
                command(
                    "setText",
                    vec![JsValue::String(JsString::from_str("reply-gated"))],
                ),
                FixedReply::Null,
            ),
            (
                "nativeSetData",
                vec![JsValue::Array(vec![])],
                FixedReply::Undefined,
            ),
            (
                "nativeDataEvent",
                vec![object([
                    ("kind", JsValue::String(JsString::from_str("reset"))),
                    ("columns", empty_columns()),
                ])],
                FixedReply::Undefined,
            ),
            (
                "nativeSetPanel",
                vec![
                    JsValue::String(JsString::from_str("price")),
                    object([("weight", JsValue::Number(2.0))]),
                ],
                FixedReply::Undefined,
            ),
            (
                "nativeRemoveSeries",
                vec![JsValue::String(JsString::from_str("external"))],
                FixedReply::Undefined,
            ),
            (
                "nativeTheme",
                vec![object([(
                    "background",
                    JsValue::String(JsString::from_str("#010203")),
                )])],
                FixedReply::Undefined,
            ),
            (
                "nativeTool",
                vec![JsValue::String(JsString::from_str("horizontal"))],
                FixedReply::Undefined,
            ),
            (
                "nativeWheel",
                vec![JsValue::Number(1.0), JsValue::Number(100.0)],
                FixedReply::Undefined,
            ),
            (
                "nativeResize",
                vec![JsValue::Number(800.0), JsValue::Number(600.0)],
                FixedReply::Undefined,
            ),
            (
                "nativePointer",
                vec![JsValue::String(JsString::from_str("cancel"))],
                FixedReply::Undefined,
            ),
            (
                "nativeKey",
                vec![
                    JsValue::String(JsString::from_str("Home")),
                    JsValue::Bool(false),
                    JsValue::Bool(false),
                ],
                FixedReply::Undefined,
            ),
        ];
        for (name, args, expected) in cases {
            let before = capture_model(&slot);
            let store_before = capture_store(&slot);
            let view_before = capture_view(&slot);
            let interaction_before = capture_interaction(&slot);
            let size_before = capture_native_size(&slot);
            let drawings_before = capture_drawings(&slot);
            let formatter = {
                // SAFETY: immutable observation of the idle engine.
                let core = unsafe { &*slot.core.get() }.as_ref().expect("open core");
                core.chart()
                    .expect("initialized chart")
                    .capture_formatter_identity()
            };
            let mut admitted = None;
            let result = {
                // SAFETY: serialized unit test owns the idle engine exclusively.
                let core = unsafe { &mut *slot.core.get() }
                    .as_mut()
                    .expect("open core");
                let mut scope = core.memory_context().scope();
                barochart_bridge::call_scoped_with_reply_admission(
                    core,
                    name,
                    &args,
                    &mut scope,
                    &mut |reply| {
                        admitted = Some(reply);
                        Err(account.allocation_failure().into_js_error())
                    },
                )
            };
            assert!(
                barochart_js::memory::oom_style_from_error(
                    &result.expect_err("denied reply admission")
                )
                .is_some()
            );
            assert_eq!(admitted, Some(expected), "{name}");
            if name == "nativeWheel" {
                // Source layout may publish lazy indicator/cache effects before zoom validation.
                assert_eq!(capture_view(&slot), view_before, "{name}");
            } else {
                assert!(model_matches(&slot, &before), "{name}");
            }
            assert!(store_matches(&slot, &store_before), "{name}");
            assert_eq!(capture_interaction(&slot), interaction_before, "{name}");
            assert_eq!(capture_native_size(&slot), size_before, "{name}");
            assert!(drawings_match(&slot, &drawings_before), "{name}");
            // SAFETY: immutable observation after the completed call.
            let core = unsafe { &*slot.core.get() }.as_ref().expect("open core");
            assert!(
                core.chart()
                    .expect("initialized chart")
                    .validate_formatter_identity(&formatter),
                "{name}"
            );
        }
        {
            let name = "nativePointer";
            let args = vec![JsValue::String(JsString::from_str("invalid"))];
            let model_before = capture_model(&slot);
            let interaction_before = capture_interaction(&slot);
            let drawings_before = capture_drawings(&slot);
            let mut admission_called = false;
            let result = {
                // SAFETY: serialized unit test owns the idle engine exclusively.
                let core = unsafe { &mut *slot.core.get() }
                    .as_mut()
                    .expect("open core");
                let mut scope = core.memory_context().scope();
                barochart_bridge::call_scoped_with_reply_admission(
                    core,
                    name,
                    &args,
                    &mut scope,
                    &mut |_| {
                        admission_called = true;
                        Err(account.allocation_failure().into_js_error())
                    },
                )
            };
            let error = result.expect_err("operation kind validation must win");
            assert_eq!(error.name, "TypeError");
            assert_eq!(error.message.to_string_lossy(), "Pointer operation");
            assert!(!admission_called);
            assert!(model_matches(&slot, &model_before));
            assert_eq!(capture_interaction(&slot), interaction_before);
            assert!(drawings_match(&slot, &drawings_before));
        }
        for (name, args, expected_name, expected_message) in [
            (
                "nativePointer",
                vec![
                    JsValue::String(JsString::from_str("down")),
                    JsValue::Number(1.0),
                    JsValue::Number(0.0),
                    JsValue::Number(0.0),
                    JsValue::Number(0.0),
                ],
                "RangeError",
                "Pointer hit tolerance must be 1..32 logical pixels",
            ),
            (
                "nativeKey",
                vec![JsValue::Number(1.0), JsValue::Bool(true)],
                "TypeError",
                "key.toLowerCase is not a function",
            ),
        ] {
            let model_before = capture_model(&slot);
            let interaction_before = capture_interaction(&slot);
            let drawings_before = capture_drawings(&slot);
            let mut admission_called = false;
            let result = {
                // SAFETY: serialized unit test owns the idle engine exclusively.
                let core = unsafe { &mut *slot.core.get() }
                    .as_mut()
                    .expect("open core");
                let mut scope = core.memory_context().scope();
                barochart_bridge::call_scoped_with_reply_admission(
                    core,
                    name,
                    &args,
                    &mut scope,
                    &mut |_| {
                        admission_called = true;
                        Err(account.allocation_failure().into_js_error())
                    },
                )
            };
            let error = result.expect_err("source-ordered semantic error");
            assert_eq!(error.name, expected_name, "{name}");
            assert_eq!(error.message.to_string_lossy(), expected_message, "{name}");
            assert!(!admission_called, "{name}");
            assert!(model_matches(&slot, &model_before), "{name}");
            assert_eq!(capture_interaction(&slot), interaction_before, "{name}");
            assert!(drawings_match(&slot, &drawings_before), "{name}");
        }
        drop(slot);
        // SAFETY: terminal unique engine release.
        unsafe { bc_engine_free(engine) };
    }
}
