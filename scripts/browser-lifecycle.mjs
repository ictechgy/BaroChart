// Owned-process/bootstrap helpers. No process is launched on import.
export function browserLaunchBudget(timeoutMs,clock=()=>performance.now()){
 if(timeoutMs!==undefined&&(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>180000))throw new RangeError('Browser startup timeout: 0..180000ms');
 const deadline=timeoutMs===undefined?Infinity:clock()+timeoutMs;
 return (limit=180000,stage='bootstrap')=>{const left=Math.min(limit,Math.floor(deadline-clock()));if(left<=0)throw new Error('Chrome startup deadline: '+stage);return left;};
}
export async function configureBrowserTarget(transport,{width,height,dpr,remaining}){
 const send=(method,params={},session)=>transport.send(method,params,session,remaining(180000,method),'launch:'+method);
 const target=await send('Target.createTarget',{url:'about:blank'},null),attached=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true},null);transport.setSession(attached.sessionId);
 await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:dpr,mobile:false});remaining(180000,'ready');return {targetId:target.targetId,sessionId:attached.sessionId};
}
export async function terminateOwnedBrowser(child,{graceMs=1000,killMs=1000}={}){
 for(const v of [graceMs,killMs])if(!Number.isFinite(v)||v<0||v>5000)throw new RangeError('Owned browser cleanup timeout');
 if(!child)return {status:'not-started',terminationConfirmed:true};
 if(!child.pid){if(child.exitCode===null&&child.signalCode===null)await new Promise((resolve,reject)=>{let settled=false,timer;const done=error=>{if(settled)return;settled=true;clearTimeout(timer);child.off('error',failed);child.off('close',closed);error?reject(error):resolve();},failed=()=>done(),closed=()=>done();child.on('error',failed);child.on('close',closed);timer=setTimeout(()=>done(new Error('Owned browser spawn outcome unconfirmed; profile retained')),graceMs);});return {status:'not-started',terminationConfirmed:true};}
 const exited=()=>child.exitCode!==null||child.signalCode!==null;
 const signalAndWait=(signal,ms)=>new Promise((resolve,reject)=>{if(exited()){resolve(true);return;}let settled=false,timer;const done=error=>{if(settled)return;settled=true;clearTimeout(timer);child.off('exit',onExit);child.off('error',onError);error?reject(error):resolve(exited());},onExit=()=>done(),onError=error=>done(error);child.on('exit',onExit);child.on('error',onError);timer=setTimeout(()=>done(),ms);try{if(exited())done();else child.kill(signal);}catch(error){done(error);}});
 if(!exited()&&!await signalAndWait('SIGTERM',graceMs)&&!await signalAndWait('SIGKILL',killMs))throw new Error('Owned browser termination unconfirmed; profile retained');
 return {status:'exited',terminationConfirmed:true,exitCode:child.exitCode,signalCode:child.signalCode};
}
