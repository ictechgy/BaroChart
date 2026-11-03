import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartModel,ChartAPI} from '../src/core/index.mjs';
import {createFeedSession} from '../examples/web/feed-session.mjs';

const bar = (i, volume=10) => ({time:1700000000000+i*60000,open:100,high:102,low:99,close:101,volume});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture(t, options={}){
 const model=new ChartModel(),api=new ChartAPI(model),connections=[],snapshots=[],states=[];
 api.setData([bar(0)]);
 const session=createFeedSession(api,{
  loadSnapshot:({signal})=>{const request=deferred();snapshots.push({...request,signal});return request.promise;},
  subscribe:callbacks=>{const ready=deferred(),connection={...callbacks,ready,closed:0};connections.push(connection);return {ready:ready.promise,close(){connection.closed++;}};},
  onState:value=>states.push(value),...options,
 });
 t.after(()=>{session.dispose();model.dispose();});
 return {model,api,session,connections,snapshots,states};
}
const tick=async()=>{await Promise.resolve();await Promise.resolve();};
async function connect(f, snapshot={bars:[bar(0)],lastSequence:0}){
 const promise=f.session.connect();f.connections.at(-1).ready.resolve();await tick();f.snapshots.at(-1).resolve(snapshot);assert.equal(await promise,true);return f.connections.at(-1);
}
test('subscribe becomes ready before snapshot request; buffered deltas publish a coherent source',async t=>{
 const f=fixture(t),work=f.session.connect(),c=f.connections[0],old=f.model.store.columns;
 assert.equal(f.snapshots.length,0);
 const queued={sequence:2,kind:'append',bar:bar(1)};c.onEvent(queued);queued.bar.volume=999;
 c.onEvent({sequence:3,kind:'update',bar:bar(1,20)});
 c.ready.resolve();await tick();assert.equal(f.snapshots.length,1);
 assert.equal(f.model.store.columns,old);
 f.snapshots[0].resolve({bars:[bar(0,15)],lastSequence:1});assert.equal(await work,true);
 assert.equal(f.model.store.length,2);assert.equal(f.model.store.at(0).volume,15);assert.equal(f.model.store.at(1).volume,20);
 assert.equal(f.session.snapshot().lastSequence,3);assert.equal(f.session.snapshot().status,'live');
});
test('live update/append/correction apply once and duplicate sequence never overwrites new data',async t=>{
 const f=fixture(t),c=await connect(f);
 c.onEvent({sequence:1,kind:'update',bar:bar(0,11)});
 c.onEvent({sequence:2,kind:'append',bar:bar(1,12)});
 c.onEvent({sequence:3,kind:'correction',bar:bar(0,13)});
 c.onEvent({sequence:2,kind:'append',bar:bar(1,999)});
 assert.equal(f.model.store.length,2);assert.equal(f.model.store.at(0).volume,13);assert.equal(f.model.store.at(1).volume,12);
 assert.equal(f.session.snapshot().duplicates,1);assert.equal(f.session.snapshot().applied,3);
});
test('a buffered frame is copied before the producer reuses its mutable bar object',async t=>{
 const f=fixture(t),work=f.session.connect(),c=f.connections[0],event={sequence:1,kind:'append',bar:bar(1,22)};
 c.onEvent(event);event.bar.volume=999;c.ready.resolve();await tick();f.snapshots[0].resolve({bars:[bar(0)],lastSequence:0});
 assert.equal(await work,true);assert.equal(f.model.store.at(1).volume,22);
});
test('a sequence gap disconnects, preserves data, and requires explicit reconnect',async t=>{
 const f=fixture(t),c=await connect(f),columns=f.model.store.columns,version=f.model.store.version;
 c.onEvent({sequence:2,kind:'update',bar:bar(0,99)});
 assert.equal(f.session.snapshot().status,'error');assert.match(f.session.snapshot().error,/sequence/i);
 assert.equal(f.model.store.columns,columns);assert.equal(f.model.store.version,version);assert.equal(c.closed,1);
 c.onEvent({sequence:1,kind:'update',bar:bar(0,999)});assert.equal(f.model.store.version,version);
});
test('buffer overflow cancels snapshot before replacing the accepted source',async t=>{
 const f=fixture(t,{maxBufferedEvents:2}),work=f.session.connect(),c=f.connections[0],columns=f.model.store.columns;
 for(let i=1;i<=3;i++)c.onEvent({sequence:i,kind:'update',bar:bar(0,i)});
 c.ready.resolve();assert.equal(await work,false);assert.equal(f.model.store.columns,columns);
 assert.equal(c.closed,1);assert.match(f.session.snapshot().error,/buffer/i);assert.equal(f.snapshots.length,0);
});
for(const malformed of [
 {bars:[bar(0)],lastSequence:-1},
 {bars:[{...bar(0),volume:NaN}],lastSequence:0},
 {bars:[bar(0),bar(0)],lastSequence:0},
])test('malformed snapshot retains the current chart',async t=>{
 const f=fixture(t),columns=f.model.store.columns,work=f.session.connect();f.connections[0].ready.resolve();await tick();f.snapshots[0].resolve(malformed);
 assert.equal(await work,false);assert.equal(f.model.store.columns,columns);assert.equal(f.session.snapshot().status,'error');
});
test('invalid buffered correction rejects the complete candidate snapshot',async t=>{
 const f=fixture(t),columns=f.model.store.columns,work=f.session.connect(),c=f.connections[0];
 c.onEvent({sequence:1,kind:'correction',bar:bar(9)});c.ready.resolve();await tick();f.snapshots[0].resolve({bars:[bar(0,42)],lastSequence:0});
 assert.equal(await work,false);assert.equal(f.model.store.columns,columns);assert.equal(f.model.store.at(0).volume,10);
});
test('reconnect ignores old events, disconnect callbacks and late snapshot completion',async t=>{
 const f=fixture(t),first=f.session.connect(),old=f.connections[0];old.ready.resolve();await tick();const oldRequest=f.snapshots[0];
 const second=f.session.connect(),current=f.connections[1];current.ready.resolve();await tick();
 old.onEvent({sequence:1,kind:'update',bar:bar(0,999)});old.onClose(new Error('old network error'));
 oldRequest.resolve({bars:[bar(0,999)],lastSequence:0});assert.equal(await first,false);
 f.snapshots[1].resolve({bars:[bar(0,42)],lastSequence:10});assert.equal(await second,true);
 assert.equal(old.closed,1);assert.equal(oldRequest.signal.aborted,true);assert.equal(f.model.store.at(0).volume,42);assert.equal(f.session.snapshot().lastSequence,10);
});
test('external source edits during snapshot or live delivery are retained and stop the session',async t=>{
 for(const phase of ['snapshot','live']){
  const f=fixture(t),work=f.session.connect(),c=f.connections[0];c.ready.resolve();await tick();
  if(phase==='live'){f.snapshots[0].resolve({bars:[bar(0)],lastSequence:0});await work;}
  f.api.setData([bar(0,66)]);
  if(phase==='snapshot'){f.snapshots[0].resolve({bars:[bar(0,99)],lastSequence:0});assert.equal(await work,false);}
  else c.onEvent({sequence:1,kind:'update',bar:bar(0,99)});
  assert.equal(f.model.store.at(0).volume,66);assert.equal(f.session.snapshot().status,'error');
 }
});
test('disconnect/dispose close owned subscriptions once and reject late publication',async t=>{
 const f=fixture(t),work=f.session.connect(),c=f.connections[0];c.ready.resolve();await tick();const request=f.snapshots[0],columns=f.model.store.columns;
 f.session.disconnect();f.session.dispose();f.session.dispose();request.resolve({bars:[bar(0,999)],lastSequence:0});
 assert.equal(await work,false);assert.equal(c.closed,1);assert.equal(request.signal.aborted,true);assert.equal(f.model.store.columns,columns);assert.equal(f.session.snapshot().status,'closed');
 await assert.rejects(()=>f.session.connect(),/closed/i);
});
test('a transport that closes synchronously during subscribe is retired without an unhandled ready rejection',async t=>{
 let closed=0;
 const f=fixture(t,{subscribe:({onClose})=>{const error=new Error('subscription refused');onClose(error);return {ready:Promise.reject(error),close(){closed++;}};}});
 assert.equal(await f.session.connect(),false);assert.equal(closed,1);assert.equal(f.session.snapshot().status,'error');
 await new Promise(resolve=>setImmediate(resolve));
});
