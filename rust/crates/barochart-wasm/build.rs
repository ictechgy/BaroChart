use std::env;

fn main() {
    if env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("wasm32") {
        return;
    }
    for symbol in [
        "bc_alloc",
        "bc_free",
        "bc_engine_new",
        "bc_call",
        "bc_engine_free",
        "bc_web_abi_version",
        "bc_web_capabilities",
        "bc_web_read_f64",
        "bc_web_write_f64",
        "bc_web_packet",
        "bc_web_memory_stats",
    ] {
        println!("cargo:rustc-link-arg=--export={symbol}");
    }
    println!("cargo:rustc-link-arg=--export-memory");
}
