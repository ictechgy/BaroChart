package kr.coden.barochart;

/** Core implementation used by a chart engine. */
public enum EngineBackend {
    /** JavaScript/QuickJS core. */
    JAVASCRIPT,
    /** Native Rust core. */
    RUST
}
