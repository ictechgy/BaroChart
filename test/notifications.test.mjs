import test from 'node:test';import assert from 'node:assert/strict';
import {BarStore,ChartModel,seededColumns} from '../src/index.mjs';
test('first/middle/reporting callback failures do not interrupt committed data or indicator notification',()=>{
 const s=new BarStore(),reported=[];s.setColumns(seededColumns(40));s.onListenerError=(error,change)=>{reported.push(change.version);throw Error('report failed');};
 s.subscribe(()=>{throw Error('first')});const m=new ChartModel({store:s});m.indicators.add('e','ema');s.subscribe(()=>{throw Error('middle')});let notified=0;s.subscribe(()=>notified++);
 assert.doesNotThrow(()=>s.update(39,{...s.at(39),close:1000,high:1000}));const fresh=new ChartModel({store:s});
 assert.equal(m.indicators.get('e').outputs.value[39],fresh.indicators.add('f','ema').outputs.value[39]);assert.equal(notified,1);assert.equal(reported.length,2);assert.equal(s.listenerErrors.length,4);assert.throws(()=>s.subscribe(null));m.dispose();fresh.dispose();
});
test('notification snapshots and reentrant commits drain in version order',()=>{
 const s=new BarStore([ {time:1,open:1,high:2,low:0,close:1,volume:1} ]),events=[];let stop;
 s.subscribe(change=>{events.push('a'+change.version);if(change.version===2){stop();s.subscribe(c=>events.push('new'+c.version));s.append({time:3,open:1,high:2,low:0,close:1,volume:1});}});
 stop=s.subscribe(change=>events.push('b'+change.version));s.append({time:2,open:1,high:2,low:0,close:1,volume:1});
 assert.deepEqual(events,['a2','b2','a3','new3']);assert.equal(s.pendingChanges.length,0);
});
test('constructor validation failures do not retain shared-store subscriptions',()=>{
 const s=new BarStore(),before=s.listeners.size;
 for(const panels of [[{id:'x'},{id:'x'}],[{id:'x'},{id:'bad',weight:-1}],[{id:'x',formatter:'invalid'}]])for(let i=0;i<3;i++)assert.throws(()=>new ChartModel({store:s,panels}));
 assert.equal(s.listeners.size,before);const m=new ChartModel({store:s});m.dispose();assert.equal(s.listeners.size,before);
});
