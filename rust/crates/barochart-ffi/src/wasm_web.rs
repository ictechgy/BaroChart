//! 브라우저용 WASM transport ABI.
//!
//! Native C ABI와 별개로 브라우저가 소유한 선형 메모리의 바이트 버퍼만 사용한다.
//! `BcF64Buf`의 native allocator 계약을 WASM에서 재사용하지 않는다.

use std::mem::{align_of, size_of};
use std::ptr;
use std::slice;
use std::str;

use super::{
    BcBuf, BcEngine, BcStatus, MemoryScope, bytes, empty_buf, free_buf, lease, mode, oom_status,
    parse_args, stateful, wasm_memory_range, write_accounted_bytes, write_accounted_error,
};
use barochart_js::error::JsError;
use barochart_js::json::JsValue;
use barochart_js::string::JsString;

const ABI_VERSION: u32 = 1;
const PACKET_VERSION: u32 = 1;
const MAX_TRANSFER: usize = 262_144;

fn json_escape(value: &str, out: &mut String) {
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            character if character.is_control() => {
                use std::fmt::Write;
                let _ = write!(out, "\\u{:04x}", character as u32);
            }
            character => out.push(character),
        }
    }
}

fn capabilities_json() -> String {
    let mut implemented = String::new();
    let mut unavailable = String::new();
    for entry in barochart_bridge::FUNCTIONS {
        let target = match entry.status {
            barochart_bridge::FunctionStatus::Implemented => &mut implemented,
            barochart_bridge::FunctionStatus::Reject
            | barochart_bridge::FunctionStatus::Pending => &mut unavailable,
        };
        if !target.is_empty() {
            target.push(',');
        }
        target.push('"');
        json_escape(entry.name, target);
        target.push('"');
    }
    format!(
        "{{\"schema\":\"barochart.web-wasm.capabilities\",\"version\":1,\"abi\":1,\"transfer\":\"f64-le\",\"maxTransfer\":{},\"packetVersion\":{},\"implemented\":[{}],\"unavailable\":[{}]}}",
        MAX_TRANSFER, PACKET_VERSION, implemented, unavailable
    )
}

fn overlap(first: usize, first_len: usize, second: usize, second_len: usize) -> bool {
    let Some(first_end) = first.checked_add(first_len) else {
        return true;
    };
    let Some(second_end) = second.checked_add(second_len) else {
        return true;
    };
    first < second_end && second < first_end
}

fn byte_overlap(first: *const u8, first_len: usize, second: *const u8, second_len: usize) -> bool {
    overlap(first.addr(), first_len, second.addr(), second_len)
}

unsafe fn web_f64_input<'a>(data: *const f64, count: u32) -> Option<&'a [f64]> {
    let count = count as usize;
    if count == 0 {
        return Some(&[]);
    }
    let byte_len = count.checked_mul(size_of::<f64>())?;
    if data.is_null()
        || !data.addr().is_multiple_of(align_of::<f64>())
        || !wasm_memory_range(data.addr(), byte_len, align_of::<f64>())
    {
        return None;
    }
    // SAFETY: the WASM range and alignment were checked above; the caller owns the input for this call.
    Some(unsafe { slice::from_raw_parts(data, count) })
}

fn encode_f64_le(values: &[f64]) -> Result<Vec<u8>, BcStatus> {
    let byte_len = values
        .len()
        .checked_mul(size_of::<f64>())
        .ok_or(BcStatus::BC_INVALID)?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(byte_len)
        .map_err(|_| BcStatus::BC_OOM_SYSTEM)?;
    for value in values {
        output.extend_from_slice(&value.to_bits().to_le_bytes());
    }
    Ok(output)
}

unsafe fn write_invalid_error(
    out: *mut BcBuf,
    account: &std::sync::Arc<super::MemoryAccount>,
) -> BcStatus {
    let error = JsError::new("TypeError", JsString::from_str("Invalid WASM arguments"));
    let status = unsafe { write_accounted_error(out, &error, account) };
    if status == BcStatus::BC_THROW {
        BcStatus::BC_INVALID
    } else {
        status
    }
}

/// WASM 웹 ABI 버전이다.
#[unsafe(no_mangle)]
pub extern "C" fn bc_web_abi_version() -> u32 {
    ABI_VERSION
}

/// 브라우저용 실행 가능 함수와 전송 계약을 JSON으로 돌려준다.
///
/// # Safety
/// `engine`은 살아 있는 엔진 토큰이어야 하고 `out`은 비어 있는 writable `BcBuf` slot이어야 한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_web_capabilities(engine: *mut BcEngine, out: *mut BcBuf) -> BcStatus {
    let capabilities = capabilities_json();
    if !unsafe { empty_buf(out) } {
        return BcStatus::BC_INVALID;
    }
    let slot = match lease(engine) {
        Ok(slot) => slot,
        Err(status) => return unsafe { super::lease_error(status, out) },
    };
    // SAFETY: `out` was canonicalized and the leased slot owns the core for this call.
    unsafe {
        stateful(
            &slot,
            out,
            || Ok(()),
            |_core, ()| match write_accounted_bytes(out, capabilities.as_bytes(), &slot.account) {
                Ok(()) => BcStatus::BC_OK,
                Err(status) => status,
            },
            |_| None,
        )
    }
}

/// 숫자 결과를 little-endian IEEE754 바이트로 돌려준다.
///
/// # Safety
/// 입력 구간과 `out`은 WASM 선형 메모리 안에 있고, `out`은 빈 writable `BcBuf` slot이어야 한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_web_read_f64(
    engine: *mut BcEngine,
    name: *const u8,
    name_len: usize,
    args: *const u8,
    args_len: usize,
    flags: u32,
    out: *mut BcBuf,
) -> BcStatus {
    if !unsafe { empty_buf(out) }
        || byte_overlap(out.cast::<u8>(), size_of::<BcBuf>(), name, name_len)
        || byte_overlap(out.cast::<u8>(), size_of::<BcBuf>(), args, args_len)
    {
        return BcStatus::BC_INVALID;
    }
    let slot = match lease(engine) {
        Ok(slot) => slot,
        Err(status) => return unsafe { super::lease_error(status, out) },
    };
    // SAFETY: stateful validates the live engine and keeps the core exclusively leased.
    unsafe {
        stateful(
            &slot,
            out,
            || {
                let source = bytes(name, name_len).ok_or(BcStatus::BC_INVALID)?;
                str::from_utf8(source).map_err(|_| BcStatus::BC_INVALID)
            },
            |core, function| {
                let Some(json_mode) = mode(flags) else {
                    return BcStatus::BC_INVALID;
                };
                let Some(input) = bytes(args, args_len) else {
                    return BcStatus::BC_INVALID;
                };
                let mut scope = MemoryScope::new(&slot.account);
                let parsed = match parse_args(input, json_mode, &mut scope) {
                    Ok(parsed) => parsed,
                    Err(BcStatus::BC_INVALID) => {
                        return write_invalid_error(out, &slot.account);
                    }
                    Err(status) => return status,
                };
                let JsValue::Array(arguments) = &parsed else {
                    unreachable!("parse_args validates an array")
                };
                #[cfg(debug_assertions)]
                if function == "__bcReadF64ForTest" {
                    let fixed = [
                        0.0_f64,
                        -0.0_f64,
                        f64::from_bits(0x7ff8_0000_0000_0042),
                        f64::INFINITY,
                    ];
                    let raw = match encode_f64_le(&fixed) {
                        Ok(raw) => raw,
                        Err(status) => return status,
                    };
                    return match write_accounted_bytes(out, &raw, &slot.account) {
                        Ok(()) => BcStatus::BC_OK,
                        Err(status) => status,
                    };
                }
                match barochart_bridge::read_f64_scoped(core, function, arguments, &mut scope) {
                    Err(error) => write_accounted_error(out, &error, &slot.account),
                    Ok(values) if values.len() <= MAX_TRANSFER => {
                        let raw = match encode_f64_le(values) {
                            Ok(raw) => raw,
                            Err(status) => return status,
                        };
                        match write_accounted_bytes(out, &raw, &slot.account) {
                            Ok(()) => BcStatus::BC_OK,
                            Err(status) => status,
                        }
                    }
                    Ok(_) => BcStatus::BC_INVALID,
                }
            },
            |_| None,
        )
    }
}

/// 호스트의 float64 배열을 Rust target에 복사한다.
///
/// # Safety
/// source/count, `did_write_out`, `error_out`은 같은 WASM 선형 메모리 안에 있고 서로 alias하지 않아야 한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_web_write_f64(
    engine: *mut BcEngine,
    name: *const u8,
    name_len: usize,
    args: *const u8,
    args_len: usize,
    flags: u32,
    src: *const f64,
    count: u32,
    did_write_out: *mut u32,
    error_out: *mut BcBuf,
) -> BcStatus {
    if !unsafe { empty_buf(error_out) } {
        return BcStatus::BC_INVALID;
    }
    if did_write_out.is_null()
        || !wasm_memory_range(did_write_out.addr(), size_of::<u32>(), align_of::<u32>())
    {
        return BcStatus::BC_INVALID;
    }
    // SAFETY: the aligned u32 range was validated above; initialize the receipt before alias checks.
    if byte_overlap(error_out.cast::<u8>(), size_of::<BcBuf>(), name, name_len)
        || byte_overlap(error_out.cast::<u8>(), size_of::<BcBuf>(), args, args_len)
        || overlap(
            did_write_out.addr(),
            size_of::<u32>(),
            error_out.addr(),
            size_of::<BcBuf>(),
        )
        || overlap(
            did_write_out.addr(),
            size_of::<u32>(),
            name.addr(),
            name_len,
        )
        || overlap(
            did_write_out.addr(),
            size_of::<u32>(),
            args.addr(),
            args_len,
        )
    {
        return BcStatus::BC_INVALID;
    }
    // SAFETY: the aligned u32 range was validated above and does not alias any request bytes.
    unsafe { did_write_out.write(0) };
    let source = match unsafe { web_f64_input(src, count) } {
        Some(source) => source,
        None => return BcStatus::BC_INVALID,
    };
    let source_bytes = source.len().saturating_mul(size_of::<f64>());
    if overlap(
        src.addr(),
        source_bytes,
        did_write_out.addr(),
        size_of::<u32>(),
    ) || byte_overlap(src.cast::<u8>(), source_bytes, name, name_len)
        || byte_overlap(src.cast::<u8>(), source_bytes, args, args_len)
        || byte_overlap(
            src.cast::<u8>(),
            source_bytes,
            error_out.cast::<u8>(),
            size_of::<BcBuf>(),
        )
    {
        return BcStatus::BC_INVALID;
    }
    let slot = match lease(engine) {
        Ok(slot) => slot,
        Err(status) => return unsafe { super::lease_error(status, error_out) },
    };
    // SAFETY: stateful validates lifecycle and serializes access to the core.
    unsafe {
        stateful(
            &slot,
            error_out,
            || {
                let source = bytes(name, name_len).ok_or(BcStatus::BC_INVALID)?;
                str::from_utf8(source).map_err(|_| BcStatus::BC_INVALID)
            },
            |core, function| {
                let Some(json_mode) = mode(flags) else {
                    return BcStatus::BC_INVALID;
                };
                let Some(input) = bytes(args, args_len) else {
                    return BcStatus::BC_INVALID;
                };
                let mut scope = MemoryScope::new(&slot.account);
                let parsed = match parse_args(input, json_mode, &mut scope) {
                    Ok(parsed) => parsed,
                    Err(BcStatus::BC_INVALID) => {
                        return write_invalid_error(error_out, &slot.account);
                    }
                    Err(status) => return status,
                };
                let JsValue::Array(arguments) = &parsed else {
                    unreachable!("parse_args validates an array")
                };
                match barochart_bridge::write_f64_scoped(
                    core,
                    function,
                    arguments,
                    source,
                    &mut scope,
                    |_| Ok(()),
                ) {
                    Ok(()) => {
                        // SAFETY: did_write_out remains a live, non-aliasing u32 slot for this call.
                        did_write_out.write(1);
                        BcStatus::BC_OK
                    }
                    Err(error) => write_accounted_error(error_out, &error, &slot.account),
                }
            },
            |_| None,
        )
    }
}

/// packet v1 metadata와 raw float64 숫자 바이트를 돌려준다.
///
/// # Safety
/// 두 output slot은 빈 writable `BcBuf`이고 서로 또는 입력과 alias하지 않아야 한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_web_packet(
    engine: *mut BcEngine,
    args: *const u8,
    args_len: usize,
    metadata_out: *mut BcBuf,
    numbers_out: *mut BcBuf,
) -> BcStatus {
    if !unsafe { empty_buf(metadata_out) }
        || !unsafe { empty_buf(numbers_out) }
        || metadata_out == numbers_out
        || byte_overlap(
            metadata_out.cast::<u8>(),
            size_of::<BcBuf>(),
            args,
            args_len,
        )
        || byte_overlap(numbers_out.cast::<u8>(), size_of::<BcBuf>(), args, args_len)
        || byte_overlap(
            metadata_out.cast::<u8>(),
            size_of::<BcBuf>(),
            numbers_out.cast::<u8>(),
            size_of::<BcBuf>(),
        )
    {
        return BcStatus::BC_INVALID;
    }
    let slot = match lease(engine) {
        Ok(slot) => slot,
        Err(status) => return unsafe { super::lease_error(status, metadata_out) },
    };
    // SAFETY: stateful validates lifecycle; metadata is the documented error carrier.
    unsafe {
        stateful(
            &slot,
            metadata_out,
            || Ok(()),
            |core, ()| {
                let Some(input) = bytes(args, args_len) else {
                    return BcStatus::BC_INVALID;
                };
                let mut scope = MemoryScope::new(&slot.account);
                let parsed =
                    match parse_args(input, barochart_js::json::JsonMode::Standard, &mut scope) {
                        Ok(parsed) => parsed,
                        Err(BcStatus::BC_INVALID) => {
                            return write_invalid_error(metadata_out, &slot.account);
                        }
                        Err(status) => return status,
                    };
                let JsValue::Array(arguments) = &parsed else {
                    unreachable!("parse_args validates an array")
                };
                let packet = match barochart_bridge::packet_scoped(core, arguments, &mut scope) {
                    Ok(packet) => packet,
                    Err(error) => {
                        return write_accounted_error(metadata_out, &error, &slot.account);
                    }
                };
                let metadata_text = match packet.metadata.try_to_string_lossy_scoped(&mut scope) {
                    Ok(text) => text,
                    Err(error) => return oom_status(error.style()),
                };
                let metadata = match encode_bytes_unaccounted(metadata_text.as_bytes()) {
                    Ok(buffer) => buffer,
                    Err(status) => return status,
                };
                let numbers_raw = match encode_f64_le(&packet.numbers) {
                    Ok(raw) => raw,
                    Err(status) => {
                        free_buf(metadata);
                        return status;
                    }
                };
                let numbers = match encode_bytes_unaccounted(&numbers_raw) {
                    Ok(buffer) => buffer,
                    Err(status) => {
                        free_buf(metadata);
                        return status;
                    }
                };
                // Both output allocations are ready before either descriptor is published.
                metadata_out.write(metadata);
                numbers_out.write(numbers);
                BcStatus::BC_OK
            },
            |_| None,
        )
    }
}

/// 현재 Rust 메모리 account와 WASM transport counter를 JSON으로 돌려준다.
///
/// # Safety
/// `engine`은 살아 있는 엔진 토큰이어야 하고 `out`은 빈 writable `BcBuf` slot이어야 한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bc_web_memory_stats(engine: *const BcEngine, out: *mut BcBuf) -> BcStatus {
    if !unsafe { empty_buf(out) } {
        return BcStatus::BC_INVALID;
    }
    let slot = match lease(engine) {
        Ok(slot) => slot,
        Err(status) => return unsafe { super::lease_error(status, out) },
    };
    // SAFETY: stats is generated while the slot is exclusively leased.
    unsafe {
        stateful(
            &slot,
            out,
            || Ok(()),
            |_core, ()| {
                let snapshot = slot.account.snapshot();
                let json = format!(
                    "{{\"requestedLiveBytes\":{},\"requestedPeakBytes\":{},\"limitBytes\":{},\"retainedOutputBytes\":{},\"byteBuffers\":{},\"byteCapacity\":{},\"poisoned\":{}}}",
                    snapshot.requested_live_bytes,
                    snapshot.requested_peak_bytes,
                    snapshot.limit_bytes,
                    snapshot.retained_output_bytes,
                    super::BYTE_BUFFERS.load(std::sync::atomic::Ordering::Relaxed),
                    super::BYTE_CAPACITY.load(std::sync::atomic::Ordering::Relaxed),
                    slot.poisoned.load(std::sync::atomic::Ordering::Acquire),
                );
                match write_accounted_bytes(out, json.as_bytes(), &slot.account) {
                    Ok(()) => BcStatus::BC_OK,
                    Err(status) => status,
                }
            },
            |_| None,
        )
    }
}

fn encode_bytes_unaccounted(source: &[u8]) -> Result<BcBuf, BcStatus> {
    if source.is_empty() {
        return Ok(BcBuf::default());
    }
    let layout =
        std::alloc::Layout::from_size_align(source.len(), 8).map_err(|_| BcStatus::BC_INVALID)?;
    // SAFETY: layout is non-zero and aligned for the WASM byte-buffer contract.
    let pointer = unsafe { std::alloc::alloc(layout) };
    if pointer.is_null() {
        return Err(BcStatus::BC_OOM_SYSTEM);
    }
    // SAFETY: destination contains source.len() writable bytes.
    unsafe { ptr::copy_nonoverlapping(source.as_ptr(), pointer, source.len()) };
    super::BYTE_BUFFERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    super::BYTE_CAPACITY.fetch_add(source.len(), std::sync::atomic::Ordering::Relaxed);
    Ok(BcBuf {
        ptr: pointer,
        len: source.len(),
        cap: source.len(),
    })
}
