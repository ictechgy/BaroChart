import {defineIndicatorModule} from './indicator-modules.mjs';
import {optionRecord} from './contracts.mjs';
// Static application code linked identically in the owner, worker and native
// resources. This is a close-direction volume proxy, not bid/ask volume delta.
defineIndicatorModule({id:'aster.volume-direction',version:1,stateVersion:1,indicators:{pressure:{causal:true,
 factory({factor=1,shift=0}={}) {
  if(!Number.isFinite(factor)||Math.abs(factor)>1||!Number.isInteger(shift)||Math.abs(shift)>10000)throw new RangeError('Volume-direction factor/shift');
  return {outputs:['signed','cumulative'],plotOffsets:{signed:shift,cumulative:shift},create(){let previous=NaN,cumulative=0;return {
   step(b){const signed=Number.isNaN(previous)?0:Math.sign(b.close-previous)*b.volume*factor;previous=b.close;cumulative+=signed;return [signed,cumulative];},
   snapshot(){return {previous,cumulative};},restore(s){previous=s.previous;cumulative=s.cumulative;}
  };}};
 },
 validateCheckpoint(_params,state,index){
  optionRecord(state,['previous','cumulative'],'Volume-direction checkpoint');
  if(Object.keys(state).length!==2||typeof state.previous!=='number'||!Number.isFinite(state.cumulative)||(index===0?!(Number.isNaN(state.previous)&&state.cumulative===0):!Number.isFinite(state.previous)))throw new TypeError('Volume-direction checkpoint');
  return state;
 }
}}});
