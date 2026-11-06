import assert from 'node:assert/strict';
import {createDemoServer} from '../scripts/serve.mjs';
import {launchBrowser} from '../scripts/cdp.mjs';

function fixtureWorker() {
 const reply=new URL(self.location.href).searchParams.get('reply');
 const capabilities={schema:'barochart.web-wasm.capabilities',version:1,abi:1,transfer:'f64-le',packetVersion:1,maxTransfer:262144,implemented:['nativeInit','nativeCommand','nativeScenePacket'],unavailable:[]};
 self.onmessage=({data:request})=>{
  const response={protocol:1,generation:request.generation,id:request.id};
  if(request.type==='init')self.postMessage({...response,type:'ready',capabilities});
  else if(request.type==='close')self.postMessage({...response,type:'closed'});
  else if(request.type==='rpc'){
   const values={null:null,undefined:undefined,false:false,zero:0,invalid:'not-boolean',true:true};
   self.postMessage({...response,type:'result',value:values[reply]});
  }
 };
}

const server=createDemoServer({handleApi(request,response){
 const path=new URL(request.url,'http://127.0.0.1').pathname;
 if(request.method==='GET'&&path==='/__actor_response_fixture.html'){
  response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'"});
  response.end('<!doctype html><title>Actor response fixture</title>');
  return true;
 }else if(request.method==='GET'&&path==='/__actor_response_fixture.mjs'){
  response.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'});
  response.end(`(${fixtureWorker.toString()})();`);
  return true;
 }
 return false;
}});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
let browser;
try{
 browser=await launchBrowser({width:800,height:600,dpr:1});
 await browser.navigate(`http://127.0.0.1:${server.address().port}/__actor_response_fixture.html`);
 const result=await browser.evaluate(`(async()=>{
  const {createRustActor}=await import('/src/web/wasm/actor.mjs');
  const module=await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]));
  const NativeWorker=globalThis.Worker;let created=0,terminated=0;
  globalThis.Worker=class extends NativeWorker{constructor(...args){super(...args);created++;this.done=false;}terminate(){if(!this.done){this.done=true;terminated++;}return super.terminate();}};
  const rows=[];
  try{
   for(const [method,reply,valid] of [['packet','null',false],['packet','undefined',false],['packet','false',false],['packet','zero',false],['writeF64','invalid',false],['writeF64','true',true],['writeF64','false',true]]){
    const actor=await createRustActor({module,workerURL:new URL('/__actor_response_fixture.mjs?reply='+reply,location.href)});
    try{
     let value,error;try{value=method==='packet'?await actor.packet([]):await actor.writeF64('nativeAsyncTargetBuffer',[0,0,0],new Float64Array());}catch(caught){error=caught;}
     if(valid){if(error||value!==(reply==='true')||actor.quarantined)throw new Error('Valid boolean receipt rejected: '+reply);}
     else if(error?.code!=='BAD_RESULT'||!actor.quarantined)throw new Error('Malformed response was not quarantined: '+method+'/'+reply);
     rows.push({method,reply,valid,quarantined:actor.quarantined});
    }finally{try{await actor.close();}catch(error){if(!actor.quarantined||error.name!=='RustActorQuarantinedError')throw error;}}
   }
  }finally{globalThis.Worker=NativeWorker;}
  if(created!==7||terminated!==created)throw new Error('Worker cleanup mismatch '+created+'/'+terminated);
  return {passed:true,realWorkerStructuredClone:true,cases:rows,created,terminated};
 })()`,{timeout:30000,label:'actor response validation in dedicated Workers'});
 assert.equal(result.passed,true);console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
