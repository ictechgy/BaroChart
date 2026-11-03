//! Rust 코어 뼈대(M1b Task 5). 실제 모델·저장소는 M2 이후에 이식한다.
#![forbid(unsafe_code)]

use barochart_js::string::JsString;

/// Opaque host callback failure; the core supplies the stable JavaScript error text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostError;

/// Host services owned by an engine and callable on its current owning thread.
/// Implementations must remain valid when the engine moves to another thread.
pub trait Host: Send {
    /// Resolves an accepted zone name to its canonical name.
    fn zone_resolve(&self, name: &JsString) -> Result<JsString, HostError>;
    /// Returns the zone offset at a finite epoch timestamp in seconds.
    fn zone_offset_seconds(&self, zone: &JsString, epoch_ms: f64) -> Result<i32, HostError>;
    /// Emits a developer diagnostic without exposing user payloads.
    fn log(&self, level: i32, message: &str);
}

/// Internal empty engine scaffold. Chart state is added in subsequent porting stages.
/// An engine is Send, but is intentionally not Sync: its host need not be Sync.
pub struct Engine {
    _host: Box<dyn Host>,
}

impl Engine {
    /// Takes ownership of host services for the engine's lifetime.
    pub fn new(host: Box<dyn Host>) -> Self {
        Self { _host: host }
    }
}
