import test from 'node:test';
import assert from 'node:assert/strict';
import {createHttpFeedTransport} from '../examples/web/feed-transport.mjs';
import {createFeedDemoServer} from '../scripts/serve-feed.mjs';

class Source extends EventTarget{
 static instances=[];
 constructor(url){super();this.url=url;this.closed=0;Source.instances.push(this);}
 close(){this.closed++;}
 emit(type,data){const e=new Event(type);if(data!==undefined)Object.defineProperty(e,'data',{value:data});this.dispatchEvent(e);}
}
test('HTTP transport forwards cancellation and waits for a successful snapshot',async()=>{
 const controller=new AbortController();let request;
 const transport=createHttpFeedTransport({EventSourceType:Source,fetcher:async(url,options)=>{request={url,options};return new Response('{"bars":[],"lastSequence":0}');}});
 assert.deepEqual(await transport.loadSnapshot({signal:controller.signal}),{bars:[],lastSequence:0});
 assert.equal(request.url,'/feed/snapshot');assert.equal(request.options.signal,controller.signal);assert.equal(request.options.cache,'no-store');
 const failed=createHttpFeedTransport({EventSourceType:Source,fetcher:async()=>new Response('',{status:503})});
 await assert.rejects(()=>failed.loadSnapshot({signal:controller.signal}),/503/);
});
test('snapshot body is cancelled at the byte limit instead of being fully buffered',async()=>{
 let reads=0,cancelled=false;
 const body=new ReadableStream({pull(controller){if(++reads===1)controller.enqueue(new Uint8Array(16*1024*1024+1));else controller.close();},cancel(){cancelled=true;}},{highWaterMark:0});
 const transport=createHttpFeedTransport({EventSourceType:Source,fetcher:async()=>new Response(body)});
 await assert.rejects(()=>transport.loadSnapshot({signal:new AbortController().signal}),/limit/i);
 assert.equal(cancelled,true);assert.equal(reads,1);
});
test('SSE transport has explicit ready, closes on error, and ignores late messages',async()=>{
 const controller=new AbortController(),received=[],errors=[];
 const transport=createHttpFeedTransport({EventSourceType:Source});
 const sub=transport.subscribe({signal:controller.signal,onEvent:e=>received.push(e),onClose:e=>errors.push(e)}),source=Source.instances.at(-1);
 source.emit('open');await sub.ready;source.emit('message','{"sequence":1}');assert.equal(received.length,1);
 source.emit('error');source.emit('message','{"sequence":2}');sub.close();controller.abort();
 assert.equal(received.length,1);assert.equal(source.closed,1);assert.equal(errors.length,1);
});
test('abort before open settles readiness and closes the source exactly once',async()=>{
 const controller=new AbortController(),transport=createHttpFeedTransport({EventSourceType:Source});
 const sub=transport.subscribe({signal:controller.signal,onEvent(){},onClose(){assert.fail('explicit abort is not a transport failure');}}),source=Source.instances.at(-1);
 controller.abort();sub.close();await assert.rejects(sub.ready,{name:'AbortError'});assert.equal(source.closed,1);
});
test('malformed SSE data disconnects without delivering an event',async()=>{
 const controller=new AbortController(),errors=[],transport=createHttpFeedTransport({EventSourceType:Source});
 const sub=transport.subscribe({signal:controller.signal,onEvent(){assert.fail('malformed frame delivered');},onClose:e=>errors.push(e)}),source=Source.instances.at(-1);
 source.emit('open');await sub.ready;source.emit('message','not json');assert.equal(source.closed,1);assert.equal(errors.length,1);
});
test('actual loopback HTTP/SSE delivers snapshot, update, duplicate and gap; static server retains boundaries',async t=>{
 const server=createFeedDemoServer({snapshotDelayMs:0});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin='http://127.0.0.1:'+server.address().port;
 const action=async name=>{const response=await fetch(origin+'/feed/action',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({action:name})});assert.equal(response.status,200);return response.json();};
 const response=await fetch(origin+'/feed/events'),reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
 t.after(()=>reader.cancel());
 const readEvent=async()=>{while(true){const index=buffer.indexOf('\n\n');if(index>=0){const text=buffer.slice(0,index);buffer=buffer.slice(index+2);if(text.startsWith('data: '))return JSON.parse(text.slice(6));continue;}const {done,value}=await reader.read();assert.equal(done,false);buffer+=decoder.decode(value,{stream:true});}};
 const initial=await (await fetch(origin+'/feed/snapshot')).json();assert.equal(initial.bars.length,64);assert.equal(initial.lastSequence,0);
 await action('update');const update=await readEvent();assert.equal(update.kind,'update');assert.equal(update.sequence,1);assert.equal(update.bar.volume,initial.bars.at(-1).volume+10);
 await action('duplicate');assert.deepEqual(await readEvent(),update);
 await action('gap');assert.equal((await readEvent()).sequence,3);
 const current=await(await fetch(origin+'/feed/snapshot')).json();assert.equal(current.lastSequence,3);
 assert.equal((await fetch(origin+'/.env')).status,403);
 assert.equal((await fetch(origin+'/HANDOFF.md')).status,403);
 assert.equal((await fetch(origin+'/examples/web/feed.html')).status,200);
 assert.equal((await fetch(origin+'/feed/action',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"append"}'})).status,403);
 await reader.cancel();
});
