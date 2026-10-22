import {ChartModel} from '../../src/core/index.mjs';
import {CanvasChart} from '../../src/renderers/canvas.mjs';
// Manual synthetic producer. No timer, provider connection or automatic retry.
export const model=new ChartModel();
export const chart=new CanvasChart(document.getElementById('chart'),model);
const api=chart.api,streamId='synthetic-queue',generation=1,listeners=[];
let closed=false,running=false,producerTail=null,offered=null;
const node=id=>document.getElementById(id),current=()=>!closed&&!chart.disposed&&!model.disposed;
const on=(target,type,fn)=>{target.addEventListener(type,fn);listeners.push(()=>target.removeEventListener(type,fn));};
api.setData(Array.from({length:32},(_,i)=>({time:1700000000000+i*60000,open:100+i,high:102+i,low:99+i,close:101+i,volume:100+i})));
api.addSeries({id:'price',type:'candles',panel:'price'});api.fit();
api.configureDataIngestion({streamId,generation,firstSequence:0,maxQueuedEvents:8,maxQueuedBytes:8*49,maxBatchEvents:2,maxStoredBars:64,maxStoreBytes:96*64});
producerTail=model.store.at(model.store.length-1);
function render(message){
 if(!current())return;const s=api.dataIngestionStats();if(!current())return;
 node('status').textContent=message;if(!current())return;
 node('queue-state').textContent=`${s.state}; next event sequence ${s.nextSequence}; last error ${s.lastError?.code??s.lastError??'none'}`;if(!current())return;
 node('counters').textContent=`Events: accepted ${s.accepted}, applied ${s.applied}, cancelled ${s.cancelled}, pending ${s.pendingEvents}. Rejected attempts: ${s.rejectedPackets} packets / ${s.rejectedEvents} validated events. Conservation: ${s.accepted===s.applied+s.cancelled+s.pendingEvents}.`;if(!current())return;
 node('budget').textContent=`Queue ${s.pendingEvents}/8 events; pending ${s.pendingBytes}/392 bytes; ring owned ${s.ownedBytes} bytes. Stored ${s.storedBars}/64 bars; source typed bytes ${s.storeBytes}/6144. These are not process-memory limits.`;
}
function action(fn){return()=>{if(!current()||running)return;running=true;try{const message=fn();if(current())render(message);}catch(error){if(current())render(`${error.code??error.name}: ${error.message}. No automatic retry. Accepted pending events are retained unless explicitly cancelled.`);}finally{running=false;}};}
on(node('enqueue'),'click',action(()=>{
 if(!offered){const before=api.dataIngestionStats(),bar={...producerTail,volume:producerTail.volume+10},next={...bar,time:bar.time+60000,open:bar.close,high:bar.close+2,low:bar.close-1,close:bar.close+1,volume:0};
  offered={streamId,generation,firstSequence:before.nextSequence,events:[{kind:'update',bar},{kind:'append',bar:next}]};}
 const packet=offered;api.enqueueDataEvents(packet);if(!current())return '';
 producerTail=packet.events[1].bar;offered=null;
 return `Accepted one packet of 2 events at sequences ${packet.firstSequence}–${packet.firstSequence+1}. Source bars have not been drained. Rejected offers retain the same payload and sequence until an explicit retry or cancel.`;
}));
on(node('drain'),'click',action(()=>{const r=api.drainDataEvents(1);return `Explicit drain: ${r.events??0} event applied. One event per click; pending events remain queued.`;}));
on(node('pause'),'click',action(()=>{api.pauseDataIngestion();return 'Paused. The accepted queue is retained; enqueue/drain will reject until explicit resume.';}));
on(node('resume'),'click',action(()=>{api.resumeDataIngestion();return 'Resumed against the current source version. Pending events were not applied or discarded; next explicit drain validates them.';}));
on(node('cancel'),'click',action(()=>{const r=api.cancelDataEvents();if(!current())return '';producerTail=model.store.at(model.store.length-1);offered=null;return `Explicit cancel: ${r.cancelled??r.events??0} pending events discarded. Accepted sequence numbers are not reused. Any unaccepted offer was discarded; producer tail reset to the stored tail. Pause state is unchanged.`;}));
on(node('source-change'),'click',action(()=>{
 const bars=Array.from({length:model.store.length},(_,i)=>{const b=model.store.at(i);return {...b,time:b.time+86400000};});api.setData(bars);if(!current())return '';
 if(!api.dataIngestionStats().pendingEvents&&!offered)producerTail=model.store.at(model.store.length-1);
 return 'Replaced source with a disjoint timeline. Accepted pending events remain queued. Resume only rebinds the version; the next Drain will reject old-timeline events. Cancel explicitly discards them. No automatic recovery.';
}));
on(window,'pagehide',event=>{if(event.persisted||closed)return;closed=true;for(const remove of listeners)remove();chart.destroy({disposeModel:true});producerTail=null;offered=null;});
on(window,'pageshow',event=>{if(event.persisted&&!closed)chart.resize();});
render('Manual synthetic input: Enqueue offers 2 events; Drain applies 1. Fill 8 queued events to observe atomic packet rejection.');
