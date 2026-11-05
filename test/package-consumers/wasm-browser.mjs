const {loadRustBackend,createRustChart}=await import('barochart/wasm');
const backend=await loadRustBackend(),session=await backend.createSession({count:10_000}),state=session.snapshot();
const host=document.createElement('div');host.style.cssText='width:640px;height:360px';document.body.append(host);
const view=await createRustChart(host,session,{renderer:'canvas',dpr:()=>1});await view.flush();
if(state.data.length!==10_000||view.lastScene.stats.storedBars!==10_000)throw new Error('Rust package chart bar count mismatch');
await view.destroy({closeSession:true});
globalThis.__wasmConsumerResult={bars:state.data.length,renderer:view.rendererKind,worker:true};
