//! 엔진별 requested-byte 회계와 이동 전용 수명 lease다.
//!
//! 이 회계는 RSS나 allocator usable size가 아니다. 호출자가 명시적으로 예약한 payload/header
//! 바이트만 세며, 실제 allocation은 각 소유 crate가 fallible API로 별도 수행한다.

use std::mem::size_of;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::JsError;
use crate::string::JsString;

/// 내부 OOM tag다. FFI는 이 code를 wire error로 쓰지 않고 canonical-empty status 7로 바꾼다.
pub const OOM_LIMIT_CODE: &str = "__BAROCHART_OOM_LIMIT__";
/// 내부 OOM tag다. FFI는 이 code를 wire error로 쓰지 않고 canonical-empty status 8로 바꾼다.
pub const OOM_SYSTEM_CODE: &str = "__BAROCHART_OOM_SYSTEM__";

/// allocation/account 실패를 host-visible OOM 종류로 분류한다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OomStyle {
    /// Android/QuickJS 호환 `InternalError: out of memory`다.
    InternalErrorLowercase,
    /// Apple/JSC 호환 `RangeError: Out of memory`다.
    RangeErrorCapitalized,
}

/// fallible allocation 경계가 반환하는 OOM 분류다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemoryFailure {
    style: OomStyle,
}

impl MemoryFailure {
    /// host-visible OOM 종류다.
    pub const fn style(self) -> OomStyle {
        self.style
    }

    /// Core의 기존 `JsError` 결과 표면을 통과하는 내부 전용 오류로 바꾼다.
    ///
    /// FFI는 reserved code를 status 7/8로 소비하고 JSON 오류로 직렬화하지 않는다.
    pub fn into_js_error(self) -> JsError {
        let (name, message, code) = match self.style {
            OomStyle::InternalErrorLowercase => ("InternalError", "out of memory", OOM_LIMIT_CODE),
            OomStyle::RangeErrorCapitalized => ("RangeError", "Out of memory", OOM_SYSTEM_CODE),
        };
        let mut error = JsError::new(name, JsString::from_str(message));
        error.code = Some(code.to_owned());
        error
    }
}

/// reserved internal OOM code면 host status 종류를 돌려준다.
pub fn oom_style_from_error(error: &JsError) -> Option<OomStyle> {
    match error.code.as_deref() {
        Some(OOM_LIMIT_CODE) => Some(OomStyle::InternalErrorLowercase),
        Some(OOM_SYSTEM_CODE) => Some(OomStyle::RangeErrorCapitalized),
        _ => None,
    }
}

/// 한 시점의 엔진별 requested-byte 통계다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemorySnapshot {
    /// 현재 live requested bytes다.
    pub requested_live_bytes: u64,
    /// 엔진 수명 동안의 단조 peak다.
    pub requested_peak_bytes: u64,
    /// 0이면 무제한인 엔진 한도다.
    pub limit_bytes: u64,
    /// live 중 host가 보유한 FFI output bytes다.
    pub retained_output_bytes: u64,
}

/// 엔진 하나의 thread-safe requested-byte account다.
#[derive(Debug)]
pub struct MemoryAccount {
    live: AtomicU64,
    peak: AtomicU64,
    retained_output: AtomicU64,
    limit: u64,
    style: OomStyle,
}

impl MemoryAccount {
    /// 빈 account를 공유 소유로 만든다. `limit == 0`은 무제한이다.
    pub fn new(limit: u64, style: OomStyle) -> Arc<Self> {
        Arc::new(Self {
            live: AtomicU64::new(0),
            peak: AtomicU64::new(0),
            retained_output: AtomicU64::new(0),
            limit,
            style,
        })
    }

    /// 일반 requested bytes를 원자 예약한다.
    pub fn reserve(self: &Arc<Self>, bytes: u64) -> Result<MemoryLease, MemoryFailure> {
        self.reserve_inner(bytes, false)
    }

    /// host가 해제할 때까지 살아 있는 FFI output bytes를 원자 예약한다.
    pub fn reserve_output(self: &Arc<Self>, bytes: u64) -> Result<MemoryLease, MemoryFailure> {
        self.reserve_inner(bytes, true)
    }

    /// 실제 system allocation 실패를 이 엔진의 OOM 종류로 바꾼다.
    pub const fn allocation_failure(&self) -> MemoryFailure {
        MemoryFailure { style: self.style }
    }

    /// 이 account의 host-visible OOM 종류다.
    pub const fn oom_style(&self) -> OomStyle {
        self.style
    }

    /// 현재 통계를 lock 없이 읽는다.
    pub fn snapshot(&self) -> MemorySnapshot {
        MemorySnapshot {
            requested_live_bytes: self.live.load(Ordering::Acquire),
            requested_peak_bytes: self.peak.load(Ordering::Acquire),
            limit_bytes: self.limit,
            retained_output_bytes: self.retained_output.load(Ordering::Acquire),
        }
    }

    fn reserve_inner(
        self: &Arc<Self>,
        bytes: u64,
        retained_output: bool,
    ) -> Result<MemoryLease, MemoryFailure> {
        if bytes != 0 {
            let mut current = self.live.load(Ordering::Acquire);
            loop {
                let next = current
                    .checked_add(bytes)
                    .ok_or_else(|| self.allocation_failure())?;
                if self.limit != 0 && next > self.limit {
                    return Err(self.allocation_failure());
                }
                match self.live.compare_exchange_weak(
                    current,
                    next,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                ) {
                    Ok(_) => {
                        self.peak.fetch_max(next, Ordering::AcqRel);
                        break;
                    }
                    Err(actual) => current = actual,
                }
            }
            if retained_output {
                self.retained_output.fetch_add(bytes, Ordering::AcqRel);
            }
        }
        Ok(MemoryLease {
            account: Arc::clone(self),
            bytes,
            retained_output,
        })
    }

    fn release(&self, bytes: u64, retained_output: bool) {
        if bytes == 0 {
            return;
        }
        let previous = self.live.fetch_sub(bytes, Ordering::AcqRel);
        debug_assert!(previous >= bytes, "memory account live underflow");
        if retained_output {
            let previous = self.retained_output.fetch_sub(bytes, Ordering::AcqRel);
            debug_assert!(previous >= bytes, "memory account output underflow");
        }
    }
}

/// 예약한 bytes를 이동해 소유하고 drop 때 정확히 한 번 반환하는 lease다.
#[derive(Debug)]
pub struct MemoryLease {
    account: Arc<MemoryAccount>,
    bytes: u64,
    retained_output: bool,
}

/// 한 엔진 account 또는 기존 unaccounted 테스트 경계를 명시적으로 선택한다.
#[derive(Clone, Debug)]
pub struct MemoryContext {
    account: Option<Arc<MemoryAccount>>,
    style: OomStyle,
}

/// persistent payload 묶음과 함께 이동하는 requested-byte lease다.
#[derive(Debug)]
pub struct MemoryGroup {
    context: MemoryContext,
    lease: Option<MemoryLease>,
    requested: u64,
}

impl PartialEq for MemoryGroup {
    fn eq(&self, other: &Self) -> bool {
        self.requested == other.requested
    }
}

impl Eq for MemoryGroup {}

impl MemoryContext {
    /// FFI 엔진 account를 쓰는 context다.
    pub fn accounted(account: &Arc<MemoryAccount>) -> Self {
        Self {
            account: Some(Arc::clone(account)),
            style: account.oom_style(),
        }
    }

    /// 기존 Core 테스트/도구가 쓰는 account 없는 context다.
    pub const fn unaccounted(style: OomStyle) -> Self {
        Self {
            account: None,
            style,
        }
    }

    /// 이 context의 OOM 종류다.
    pub const fn oom_style(&self) -> OomStyle {
        self.style
    }

    /// 실제 account에 연결됐는지 본다.
    pub const fn is_accounted(&self) -> bool {
        self.account.is_some()
    }

    /// 두 context가 같은 account(또는 같은 종류의 unaccounted 경계)를 선택했는지 본다.
    pub fn shares_account(&self, other: &Self) -> bool {
        self.same_account(other)
    }

    /// persistent payload bytes를 allocation 전에 예약한다.
    pub fn reserve_group(&self, bytes: usize) -> Result<MemoryGroup, MemoryFailure> {
        let requested = u64::try_from(bytes).map_err(|_| self.allocation_failure())?;
        let lease = match (&self.account, requested) {
            (Some(account), bytes) if bytes != 0 => Some(account.reserve(bytes)?),
            _ => None,
        };
        Ok(MemoryGroup {
            context: self.clone(),
            lease,
            requested,
        })
    }

    /// persistent owner와 같은 account에 연결한 temporary scope다.
    pub fn scope(&self) -> MemoryScope {
        match &self.account {
            Some(account) => MemoryScope::new(account),
            None => MemoryScope::unaccounted(self.style),
        }
    }

    /// payload capacity를 예약하고 빈 fallible Vec를 만든다.
    pub fn try_vec_capacity<T>(
        &self,
        capacity: usize,
    ) -> Result<(Vec<T>, MemoryGroup), MemoryFailure> {
        let bytes = capacity
            .checked_mul(size_of::<T>())
            .ok_or_else(|| self.allocation_failure())?;
        let mut group = self.reserve_group(bytes)?;
        let mut values = Vec::new();
        values
            .try_reserve_exact(capacity)
            .map_err(|_| self.allocation_failure())?;
        let actual = values
            .capacity()
            .checked_mul(size_of::<T>())
            .ok_or_else(|| self.allocation_failure())?;
        group.try_resize(actual)?;
        Ok((values, group))
    }

    /// payload capacity를 예약하고 같은 값으로 채운 fallible Vec를 만든다.
    pub fn try_vec_filled<T: Clone>(
        &self,
        length: usize,
        value: T,
    ) -> Result<(Vec<T>, MemoryGroup), MemoryFailure> {
        let (mut values, group) = self.try_vec_capacity(length)?;
        values.resize(length, value);
        Ok((values, group))
    }

    /// slice payload를 fallible Vec로 복제한다.
    pub fn try_clone_slice<T: Clone>(
        &self,
        source: &[T],
    ) -> Result<(Vec<T>, MemoryGroup), MemoryFailure> {
        let (mut values, group) = self.try_vec_capacity(source.len())?;
        values.extend_from_slice(source);
        Ok((values, group))
    }

    /// allocation/account 실패를 이 context의 종류로 만든다.
    pub const fn allocation_failure(&self) -> MemoryFailure {
        MemoryFailure { style: self.style }
    }

    fn same_account(&self, other: &Self) -> bool {
        match (&self.account, &other.account) {
            (Some(left), Some(right)) => Arc::ptr_eq(left, right),
            (None, None) => self.style == other.style,
            _ => false,
        }
    }
}

impl MemoryGroup {
    /// 0-byte persistent 묶음이다.
    pub fn empty(context: MemoryContext) -> Self {
        Self {
            context,
            lease: None,
            requested: 0,
        }
    }

    /// 이 묶음이 선택한 context다.
    pub const fn context(&self) -> &MemoryContext {
        &self.context
    }

    /// 이 묶음이 보유한 requested bytes다.
    pub const fn requested_bytes(&self) -> u64 {
        self.requested
    }

    /// 같은 payload 묶음의 reservation을 원자적으로 바꾼다.
    pub fn try_resize(&mut self, bytes: usize) -> Result<(), MemoryFailure> {
        let requested = u64::try_from(bytes).map_err(|_| self.context.allocation_failure())?;
        match self.lease.as_mut() {
            Some(lease) => lease.try_resize(requested)?,
            None if requested != 0 => {
                if let Some(account) = &self.context.account {
                    self.lease = Some(account.reserve(requested)?);
                }
            }
            None => {}
        }
        if requested == 0 {
            self.lease = None;
        }
        self.requested = requested;
        Ok(())
    }

    /// 이미 과금된 bytes를 새 owner 묶음으로 이동한다. account live 합은 바뀌지 않는다.
    pub fn split(&mut self, bytes: usize) -> Result<Self, MemoryFailure> {
        let bytes = u64::try_from(bytes).map_err(|_| self.context.allocation_failure())?;
        if bytes > self.requested {
            return Err(self.context.allocation_failure());
        }
        let lease = match self.lease.as_mut() {
            Some(lease) if bytes != 0 => Some(lease.split(bytes)?),
            _ => None,
        };
        self.requested -= bytes;
        if self.requested == 0 {
            self.lease = None;
        }
        Ok(Self {
            context: self.context.clone(),
            lease,
            requested: bytes,
        })
    }

    /// 같은 account에서 이미 과금한 묶음을 합친다. 새 reservation은 하지 않는다.
    pub fn absorb(&mut self, mut other: Self) -> Result<(), MemoryFailure> {
        if !self.context.same_account(&other.context) {
            return Err(self.context.allocation_failure());
        }
        let requested = self
            .requested
            .checked_add(other.requested)
            .ok_or_else(|| self.context.allocation_failure())?;
        match (&mut self.lease, &mut other.lease) {
            (Some(left), Some(right)) => left.absorb(right)?,
            (None, Some(_)) => self.lease = other.lease.take(),
            _ => {}
        }
        self.requested = requested;
        other.requested = 0;
        Ok(())
    }
}

/// 한 call/parser/writer 동안 누적 requested bytes를 보수적으로 보유하는 scope다.
///
/// 파서·복제·writer가 돌려준 값이나 바이트를 다음 단계가 쓰는 동안 이 scope를 살려 둬야 한다. scope drop은 누적
/// temporary lease를 한 번에 반환하며, 반환값 자체의 Rust allocation 수명을 추적하거나 연장하지 않는다.
#[derive(Debug)]
pub struct MemoryScope {
    account: Option<Arc<MemoryAccount>>,
    lease: Option<MemoryLease>,
    requested: u64,
    style: OomStyle,
}

impl MemoryScope {
    /// 엔진 account에 연결한 빈 temporary scope다.
    pub fn new(account: &Arc<MemoryAccount>) -> Self {
        Self {
            account: Some(Arc::clone(account)),
            lease: None,
            requested: 0,
            style: account.oom_style(),
        }
    }

    /// 기존 unscoped API와 테스트가 쓰는 회계 없는 fallible scope다.
    pub const fn unaccounted(style: OomStyle) -> Self {
        Self {
            account: None,
            lease: None,
            requested: 0,
            style,
        }
    }

    /// 이후 실제 allocation 전에 requested bytes를 누적 예약한다.
    pub fn try_grow(&mut self, bytes: usize) -> Result<(), MemoryFailure> {
        let bytes = u64::try_from(bytes).map_err(|_| self.allocation_failure())?;
        let next = self
            .requested
            .checked_add(bytes)
            .ok_or_else(|| self.allocation_failure())?;
        if let Some(lease) = self.lease.as_mut() {
            lease.try_resize(next)?;
        } else if let Some(account) = &self.account {
            self.lease = Some(account.reserve(next)?);
        }
        self.requested = next;
        Ok(())
    }

    /// 이 scope가 누적한 requested bytes다.
    pub const fn requested_bytes(&self) -> u64 {
        self.requested
    }

    /// system reserve 실패를 scope의 host-visible OOM 종류로 바꾼다.
    pub const fn allocation_failure(&self) -> MemoryFailure {
        MemoryFailure { style: self.style }
    }

    /// 같은 account의 이미 과금된 payload를 재예약 없이 호출 수명으로 이동한다.
    pub fn absorb_persistent(&mut self, mut group: MemoryGroup) -> Result<(), MemoryFailure> {
        let context = match &self.account {
            Some(account) => MemoryContext::accounted(account),
            None => MemoryContext::unaccounted(self.style),
        };
        if !context.shares_account(group.context()) {
            return Err(self.allocation_failure());
        }
        let requested = self
            .requested
            .checked_add(group.requested)
            .ok_or_else(|| self.allocation_failure())?;
        match (&mut self.lease, &mut group.lease) {
            (Some(left), Some(right)) => left.absorb(right)?,
            (None, Some(_)) => self.lease = group.lease.take(),
            _ => {}
        }
        self.requested = requested;
        group.requested = 0;
        Ok(())
    }

    /// 이 scope에 이미 과금된 persistent payload bytes를 새 owner 묶음으로 이동한다.
    pub fn split_persistent(&mut self, bytes: usize) -> Result<MemoryGroup, MemoryFailure> {
        let bytes = u64::try_from(bytes).map_err(|_| self.allocation_failure())?;
        if bytes > self.requested {
            return Err(self.allocation_failure());
        }
        let context = match &self.account {
            Some(account) => MemoryContext::accounted(account),
            None => MemoryContext::unaccounted(self.style),
        };
        let lease = match self.lease.as_mut() {
            Some(lease) if bytes != 0 => Some(lease.split(bytes)?),
            _ => None,
        };
        self.requested -= bytes;
        if self.requested == 0 {
            self.lease = None;
        }
        Ok(MemoryGroup {
            context,
            lease,
            requested: bytes,
        })
    }
}

impl MemoryLease {
    /// 이 lease가 보유한 requested bytes다.
    pub const fn bytes(&self) -> u64 {
        self.bytes
    }

    /// 같은 종류의 reservation을 원자적으로 늘리거나 줄인다.
    pub fn try_resize(&mut self, bytes: u64) -> Result<(), MemoryFailure> {
        if bytes == self.bytes {
            return Ok(());
        }
        if bytes < self.bytes {
            self.account
                .release(self.bytes - bytes, self.retained_output);
            self.bytes = bytes;
            return Ok(());
        }
        let extra = bytes - self.bytes;
        let mut extra_lease = self.account.reserve_inner(extra, self.retained_output)?;
        self.bytes = bytes;
        // bytes는 이 lease로 이동했다. 임시 lease는 Arc만 정상 반환한다.
        extra_lease.bytes = 0;
        Ok(())
    }

    fn split(&mut self, bytes: u64) -> Result<Self, MemoryFailure> {
        if bytes > self.bytes {
            return Err(self.account.allocation_failure());
        }
        self.bytes -= bytes;
        Ok(Self {
            account: Arc::clone(&self.account),
            bytes,
            retained_output: self.retained_output,
        })
    }

    fn absorb(&mut self, other: &mut Self) -> Result<(), MemoryFailure> {
        if !Arc::ptr_eq(&self.account, &other.account)
            || self.retained_output != other.retained_output
        {
            return Err(self.account.allocation_failure());
        }
        self.bytes = self
            .bytes
            .checked_add(other.bytes)
            .ok_or_else(|| self.account.allocation_failure())?;
        other.bytes = 0;
        Ok(())
    }
}

impl Drop for MemoryLease {
    fn drop(&mut self) {
        self.account.release(self.bytes, self.retained_output);
        self.bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::{MemoryAccount, MemoryContext, OomStyle};

    #[test]
    fn exact_limit_resize_and_peak_are_atomic() {
        let account = MemoryAccount::new(1_024, OomStyle::InternalErrorLowercase);
        let base = account.reserve(64).unwrap();
        let mut first = account.reserve(640).unwrap();
        let second = account.reserve(320).unwrap();
        assert_eq!(account.snapshot().requested_live_bytes, 1_024);
        assert_eq!(account.snapshot().requested_peak_bytes, 1_024);
        assert_eq!(
            account.reserve(1).unwrap_err().style(),
            OomStyle::InternalErrorLowercase
        );
        assert_eq!(account.snapshot().requested_live_bytes, 1_024);
        drop(second);
        assert_eq!(account.snapshot().requested_live_bytes, 704);
        first.try_resize(800).unwrap();
        assert_eq!(account.snapshot().requested_live_bytes, 864);
        assert!(first.try_resize(u64::MAX).is_err());
        assert_eq!(account.snapshot().requested_live_bytes, 864);
        drop(first);
        drop(base);
        assert_eq!(account.snapshot().requested_live_bytes, 0);
        assert_eq!(account.snapshot().requested_peak_bytes, 1_024);
    }

    #[test]
    fn output_lease_is_accounted_and_can_drop_on_another_thread() {
        let account = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
        let output = account.reserve_output(4_096).unwrap();
        assert_eq!(output.bytes(), 4_096);
        assert_eq!(account.snapshot().retained_output_bytes, 4_096);
        std::thread::spawn(move || drop(output)).join().unwrap();
        assert_eq!(account.snapshot().requested_live_bytes, 0);
        assert_eq!(account.snapshot().retained_output_bytes, 0);
        assert_eq!(account.snapshot().requested_peak_bytes, 4_096);
    }

    #[test]
    fn accounts_are_isolated_and_preserve_failure_style() {
        let limited = MemoryAccount::new(8, OomStyle::InternalErrorLowercase);
        let unlimited = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
        let _limited = limited.reserve(8).unwrap();
        assert_eq!(
            limited.reserve(1).unwrap_err().style(),
            OomStyle::InternalErrorLowercase
        );
        let _unlimited = unlimited.reserve(65_536).unwrap();
        assert_eq!(limited.snapshot().requested_live_bytes, 8);
        assert_eq!(unlimited.snapshot().requested_live_bytes, 65_536);
        assert_eq!(
            unlimited.allocation_failure().style(),
            OomStyle::RangeErrorCapitalized
        );
    }

    #[test]
    fn temporary_scope_releases_and_failed_growth_is_atomic() {
        let account = MemoryAccount::new(100, OomStyle::InternalErrorLowercase);
        {
            let mut scope = super::MemoryScope::new(&account);
            scope.try_grow(60).unwrap();
            assert_eq!(scope.requested_bytes(), 60);
            assert!(scope.try_grow(41).is_err());
            assert_eq!(scope.requested_bytes(), 60);
            assert_eq!(account.snapshot().requested_live_bytes, 60);
        }
        assert_eq!(account.snapshot().requested_live_bytes, 0);
        assert_eq!(account.snapshot().requested_peak_bytes, 60);
    }

    #[test]
    fn persistent_groups_split_absorb_and_drop_without_recharging() {
        let account = MemoryAccount::new(1_024, OomStyle::InternalErrorLowercase);
        let context = MemoryContext::accounted(&account);
        let mut owner = context.reserve_group(768).unwrap();
        assert_eq!(account.snapshot().requested_live_bytes, 768);
        let moved = owner.split(256).unwrap();
        assert_eq!(owner.requested_bytes(), 512);
        assert_eq!(moved.requested_bytes(), 256);
        assert_eq!(account.snapshot().requested_live_bytes, 768);
        owner.absorb(moved).unwrap();
        assert_eq!(owner.requested_bytes(), 768);
        assert_eq!(account.snapshot().requested_live_bytes, 768);
        drop(owner);
        assert_eq!(account.snapshot().requested_live_bytes, 0);
        assert_eq!(account.snapshot().requested_peak_bytes, 768);
    }

    #[test]
    fn groups_from_different_accounts_cannot_merge() {
        let first = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
        let second = MemoryAccount::new(0, OomStyle::RangeErrorCapitalized);
        let mut left = MemoryContext::accounted(&first).reserve_group(64).unwrap();
        let right = MemoryContext::accounted(&second).reserve_group(32).unwrap();
        assert!(left.absorb(right).is_err());
        assert_eq!(left.requested_bytes(), 64);
        assert_eq!(first.snapshot().requested_live_bytes, 64);
        assert_eq!(second.snapshot().requested_live_bytes, 0);
    }

    #[test]
    fn temporary_scope_can_transfer_persistent_payload_without_new_peak() {
        let account = MemoryAccount::new(1_024, OomStyle::InternalErrorLowercase);
        let mut scope = super::MemoryScope::new(&account);
        scope.try_grow(800).unwrap();
        let persistent = scope.split_persistent(600).unwrap();
        assert_eq!(scope.requested_bytes(), 200);
        assert_eq!(persistent.requested_bytes(), 600);
        assert_eq!(account.snapshot().requested_live_bytes, 800);
        assert_eq!(account.snapshot().requested_peak_bytes, 800);
        drop(scope);
        assert_eq!(account.snapshot().requested_live_bytes, 600);
        std::thread::spawn(move || drop(persistent)).join().unwrap();
        assert_eq!(account.snapshot().requested_live_bytes, 0);
        assert_eq!(account.snapshot().requested_peak_bytes, 800);
    }

    #[test]
    fn fallible_filled_vector_releases_reservation_on_limit_failure() {
        let account = MemoryAccount::new(63, OomStyle::InternalErrorLowercase);
        let context = MemoryContext::accounted(&account);
        assert!(context.try_vec_filled(8, 0.0_f64).is_err());
        assert_eq!(account.snapshot().requested_live_bytes, 0);
        let (values, group) = context.try_vec_filled(7, 3.0_f64).unwrap();
        assert_eq!(values, vec![3.0; 7]);
        assert_eq!(group.requested_bytes(), 56);
        assert_eq!(account.snapshot().requested_live_bytes, 56);
        drop((values, group));
        assert_eq!(account.snapshot().requested_live_bytes, 0);
    }
}
