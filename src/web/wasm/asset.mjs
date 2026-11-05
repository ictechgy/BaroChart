/** The packaged binary is a separate asset; importing this helper performs no fetch. */
export function defaultWasmURL(){return new URL('./barochart-core.wasm',import.meta.url);}
