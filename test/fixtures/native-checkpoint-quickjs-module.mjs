import {defineIndicatorModule} from '../../src/core/indicator-modules.mjs';
globalThis.nativeCheckpointQuickjsProbe={onValidate:null};
defineIndicatorModule({id:'test.native-checkpoint-quickjs',version:1,stateVersion:1,indicators:{value:{causal:true,
 factory(){return {outputs:['value'],create(){return {step(bar){return [bar.close];},snapshot(){return null;},restore(){}};}};},
 validateCheckpoint(params,state,index){globalThis.nativeCheckpointQuickjsProbe.onValidate?.(state,index);return state;}
}}});
