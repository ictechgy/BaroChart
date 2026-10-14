import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Harness transport. Diagnostics deliberately exclude expressions, URLs and payloads.
export function createCDPTransport(socket,{timeoutMs=180000,logLimit=128}={}){
  if(!Number.isInteger(logLimit)||logLimit<0||logLimit>128)throw new RangeError('CDP logLimit must be an integer from 0 to 128');
  let id=0,sessionId,closed=false;
  const pending=new Map(),events=new Map(),waiters=new Set(),log=[];
  const record=(key,method,label,start,state)=>{log.push({id:key,method,label:String(label??method).slice(0,80),elapsed:performance.now()-start,state});if(log.length>logLimit)log.shift();};
  const finish=(key,error,result)=>{const p=pending.get(key);if(!p)return;pending.delete(key);clearTimeout(p.timer);record(key,p.method,p.label,p.start,error?'rejected':'resolved');error?p.reject(error):p.resolve(result);};
  const end=error=>{if(closed)return;closed=true;for(const key of pending.keys())finish(key,error);for(const stop of [...waiters])stop(error);events.clear();};
  const message=e=>{let m;try{m=JSON.parse(e.data);}catch(error){end(error);return;}if(m.id){finish(m.id,m.error?new Error(m.error.message):null,m.result);}else for(const fn of [...(events.get(m.method)??[])])fn(m.params,{sessionId:m.sessionId,method:m.method});};
  const disconnected=()=>end(new Error('CDP connection closed'));
  const failed=event=>end(event.error instanceof Error?event.error:new Error('CDP WebSocket connection failed'));
  socket.addEventListener('message',message);socket.addEventListener('close',disconnected);socket.addEventListener('error',failed);
  const request=(method,params={},session=sessionId,limit=timeoutMs,label=method)=>{let cancel=()=>{};const promise=new Promise((resolve,reject)=>{
    if(closed){reject(new Error('CDP connection closed'));return;}
    const key=++id,start=performance.now();record(key,method,label,start,'started');
    const timer=setTimeout(()=>finish(key,new Error(`CDP timeout: ${method} [${label}]`)),limit);
    pending.set(key,{resolve,reject,timer,method,label,start});cancel=error=>finish(key,error);
    try{socket.send(JSON.stringify({id:key,method,params,...(session?{sessionId:session}:{})}));}catch(error){finish(key,error);}
  });return {promise,cancel:error=>cancel(error)};};
  const send=(...args)=>request(...args).promise;
  const on=(method,listener)=>{if(closed)throw new Error('CDP connection closed');if(!events.has(method))events.set(method,new Set());events.get(method).add(listener);return ()=>{const set=events.get(method);set?.delete(listener);if(!set?.size)events.delete(method);};};
  const evaluate=async(expression,{timeout=timeoutMs,label='evaluate'}={})=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId,timeout,label);if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
  const navigate=(url,{timeout=timeoutMs,label='navigate'}={})=>new Promise((resolve,reject)=>{
    if(closed){reject(new Error('CDP connection closed'));return;}
    let settled=false,loaded=false,ack=false,command;const start=performance.now();
    const done=error=>{if(settled)return;settled=true;clearTimeout(timer);off();if(error)command?.cancel(error);waiters.delete(done);record(null,'Page.loadEventFired',label,start,error?'rejected':'resolved');error?reject(error):resolve();};
    const off=on('Page.loadEventFired',(_params,meta)=>{if(meta.sessionId&&meta.sessionId!==sessionId)return;loaded=true;if(ack)done();});
    const timer=setTimeout(()=>done(new Error(`CDP timeout: Page.loadEventFired [${label}]`)),timeout);waiters.add(done);
    command=request('Page.navigate',{url},sessionId,timeout,label);command.promise.then(result=>{if(result.errorText){done(new Error(result.errorText));return;}ack=true;if(loaded)done();},done);
  });
  return {send,evaluate,navigate,on,setSession:value=>{sessionId=value;},get diagnostics(){return log.map(x=>({...x}));},get resources(){return {pending:pending.size,waiters:waiters.size,listeners:[...events.values()].reduce((n,x)=>n+x.size,0)};},dispose(){end(new Error('CDP connection closed'));socket.removeEventListener('message',message);socket.removeEventListener('close',disconnected);socket.removeEventListener('error',failed);}};
}

// Isolated headless browser owned by this harness, not a user's existing tab.
export async function launchBrowser({dpr=1,width=1280,height=900}={}){
  const profile=await mkdtemp(join(tmpdir(),'aster-chrome-'));
  const executable=process.env.CHROME_BIN??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'chromium');
  let child,socket,transport,closing;
  const cleanup=async()=>{transport?.dispose();try{socket?.close();}catch{}if(child&&child.exitCode===null&&child.signalCode===null)child.kill();await rm(profile,{recursive:true,force:true}).catch(()=>{});};
  try{
    child=spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
    const endpoint=await new Promise((resolve,reject)=>{
      let text='';const finish=(error,value)=>{clearTimeout(timer);child.stderr.off('data',data);child.off('error',failed);child.off('exit',exited);error?reject(error):resolve(value);};
      const data=chunk=>{text=(text+chunk).slice(-8192);const match=text.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match)finish(null,match[1]);};
      const failed=error=>finish(error),exited=code=>finish(new Error(`Chrome exited ${code}: ${text.slice(-2000)}`));
      const timer=setTimeout(()=>finish(new Error('Chrome launch timed out')),15000);
      child.stderr.on('data',data);child.on('error',failed);child.on('exit',exited);
    });
    socket=new WebSocket(endpoint);
    await new Promise((resolve,reject)=>{const finish=error=>{clearTimeout(timer);socket.removeEventListener('open',opened);socket.removeEventListener('error',failed);socket.removeEventListener('close',closed);error?reject(error):resolve();};const opened=()=>finish(),failed=()=>finish(new Error('CDP WebSocket connection failed')),closed=()=>finish(new Error('CDP connection closed during open'));const timer=setTimeout(()=>finish(new Error('CDP WebSocket open timed out')),15000);socket.addEventListener('open',opened);socket.addEventListener('error',failed);socket.addEventListener('close',closed);});
    transport=createCDPTransport(socket);
    const target=await transport.send('Target.createTarget',{url:'about:blank'},null),attached=await transport.send('Target.attachToTarget',{targetId:target.targetId,flatten:true},null);transport.setSession(attached.sessionId);
    await transport.send('Page.enable');await transport.send('Runtime.enable');await transport.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:dpr,mobile:false});
    return {send:transport.send,evaluate:transport.evaluate,navigate:transport.navigate,on:transport.on,targetId:target.targetId,sessionId:attached.sessionId,get diagnostics(){return transport.diagnostics;},close:()=>closing??=(async()=>{try{if(socket.readyState===WebSocket.OPEN)await transport.send('Browser.close',{},null,3000,'close').catch(()=>{});}finally{await cleanup();}})()};
  }catch(error){await cleanup();throw error;}
}
