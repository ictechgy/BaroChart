import {defineIndicatorModule} from '../../src/core/indicator-modules.mjs';
// Author-owned static module; the engine does not fetch or evaluate this file.
defineIndicatorModule({id:'local.volume-balance',version:1,stateVersion:1,indicators:{smooth:{causal:true,
 factory({period=10,shift=0}={}){
  if(!Number.isInteger(period)||period<1||period>10000||!Number.isInteger(shift)||Math.abs(shift)>10000)throw new RangeError('Local volume balance parameters');
  const alpha=2/(period+1);
  return {outputs:['value'],plotOffsets:{value:shift},create(){let previous=NaN,value=0,count=0;return {
   step(bar){const signed=Number.isNaN(previous)?0:Math.sign(bar.close-previous)*bar.volume;value+=(signed-value)*alpha;previous=bar.close;count++;return [value];},
   snapshot(){return {previous,value,count};},restore(s){previous=s.previous;value=s.value;count=s.count;}
  };}};
 },
 validateCheckpoint(_params,state,index){
  if(!state||Object.keys(state).length!==3||!Object.hasOwn(state,'previous')||!Object.hasOwn(state,'value')||!Object.hasOwn(state,'count')||state.count!==index||!Number.isFinite(state.value)||(index===0?!(Number.isNaN(state.previous)&&state.value===0):!Number.isFinite(state.previous)))throw new TypeError('Local volume balance checkpoint');
  return state;
 }
}}});
