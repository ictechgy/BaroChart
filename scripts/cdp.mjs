import {spawn} from 'node:child_process';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
// Isolated headless browser owned by this harness, not a user's existing tab.
export async function launchBrowser({dpr=1,width=1280,height=900}={}){
  const profile=await mkdtemp(join(tmpdir(),'aster-chrome-'));
  const executable=process.env.CHROME_BIN??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'chromium');
  const child=spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  const endpoint=await new Promise((resolve,reject)=>{let text='';const timeout=setTimeout(()=>reject(new Error('Chrome launch timed out')),15000);child.stderr.on('data',data=>{text+=data;const match=text.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});child.on('error',reject);child.on('exit',code=>reject(new Error(`Chrome exited ${code}: ${text.slice(-2000)}`)));});
  const socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let id=0,sessionId;const pending=new Map(),events=new Map();
  socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}}else for(const f of events.get(m.method)??[]) f(m.params,{sessionId:m.sessionId,method:m.method});});
  socket.addEventListener('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('CDP connection closed'));}pending.clear();});
  const send=(method,params={},session=sessionId,timeoutMs=180000)=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(new Error(`CDP timeout: ${method}`));},timeoutMs);pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method,params,...(session?{sessionId:session}:{})}));});
  const target=await send('Target.createTarget',{url:'about:blank'},null),attached=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true},null);sessionId=attached.sessionId;
  await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:dpr,mobile:false});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
  const navigate=async url=>{const loaded=new Promise(resolve=>{const fn=()=>{events.get('Page.loadEventFired').delete(fn);resolve();};if(!events.has('Page.loadEventFired'))events.set('Page.loadEventFired',new Set());events.get('Page.loadEventFired').add(fn);});await send('Page.navigate',{url});await loaded;};
  const on=(method,listener)=>{if(!events.has(method))events.set(method,new Set());events.get(method).add(listener);return ()=>events.get(method)?.delete(listener);};
  return {send,evaluate,navigate,on,targetId:target.targetId,sessionId,close:async()=>{await send('Browser.close',{},null).catch(()=>{});socket.close();child.kill();await rm(profile,{recursive:true,force:true}).catch(()=>{});}};
}
