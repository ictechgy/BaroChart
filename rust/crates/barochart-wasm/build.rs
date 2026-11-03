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
    ] {
        println!("cargo:rustc-link-arg=--export={symbol}");
    }
    println!("cargo:rustc-link-arg=--export-memory");
}
