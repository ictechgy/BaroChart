import assert from 'node:assert/strict';
import test from 'node:test';
import {ChartModel} from '../src/core/model.mjs';
import {createLayoutHistory,readLayoutHistoryState} from '../examples/web/layout-history.mjs';

const frame=(...panelOrder)=>({panelOrder,placements:[],generatedPanels:[],generatedAxes:[]});
function fixture(t,initial=frame('price','volume')){
 const model=new ChartModel({panels:initial.panelOrder.map(id=>({id}))});let current=structuredClone(initial);
 const history=createLayoutHistory({getModel:()=>model,capture:()=>structuredClone(current),apply:value=>{current=structuredClone(value);return true;}});
 t.after(()=>model.dispose());return{model,history,get current(){return current;},set current(value){current=structuredClone(value);}};
}
function commit(f,label,next){const token=f.history.begin(label);f.current=next;assert.equal(f.history.commit(token),true);}

test('portable layout history preserves cursor, labels, undo and redo across owners',t=>{
 const first=fixture(t),b=frame('volume','price'),c=frame('volume','price','rsi');commit(first,'패널 순서',b);commit(first,'RSI 패널',c);
 assert.equal(first.history.undo(),true);assert.deepEqual(first.current,b);
 const state=first.history.exportState();assert.deepEqual(state.commands.map(row=>row.label),['패널 순서','RSI 패널']);assert.equal(state.cursor,1);
 state.commands[0].label='caller mutation';assert.equal(first.history.exportState().commands[0].label,'패널 순서');
 const second=fixture(t,b),accepted=second.history.importState(first.history.exportState(),second.model);assert.deepEqual(accepted,{canUndo:true,canRedo:true,undoLabel:'패널 순서',redoLabel:'RSI 패널',depth:2,cursor:1});
 assert.equal(second.history.redo(),true);assert.deepEqual(second.current,c);assert.equal(second.history.undo(),true);assert.deepEqual(second.current,b);
 const branched=frame('price','volume');commit(second,'새 분기',branched);assert.equal(second.history.status().canRedo,false);assert.equal(second.history.exportState().cursor,2);
});

test('portable history rejects active, malformed, discontinuous and mismatched state',t=>{
 const f=fixture(t),token=f.history.begin('active');assert.throws(()=>f.history.exportState(),/active/i);assert.throws(()=>f.history.importState({}),/active/i);f.history.cancel(token);
 assert.throws(()=>readLayoutHistoryState({schema:'barochart.layout-history',version:1,commands:[],cursor:1}),/cursor/i);
 const bad={schema:'barochart.layout-history',version:1,cursor:1,commands:[{label:'a',before:frame('a'),after:frame('b')},{label:'b',before:frame('other'),after:frame('c')}]};assert.throws(()=>readLayoutHistoryState(bad),/discontinuous/i);
 const foreign={schema:'barochart.layout-history',version:1,cursor:0,commands:[{label:'x',before:frame('missing'),after:frame('other')}]};assert.throws(()=>f.history.importState(foreign,f.model),/does not match/i);
});

test('portable history stays bounded to thirty commands',t=>{
 const f=fixture(t);for(let index=0;index<35;index++)commit(f,'step '+index,frame(index%2?'price':'volume',index%2?'volume':'price'));
 const state=f.history.exportState();assert.equal(state.commands.length,30);assert.equal(state.cursor,30);assert.equal(state.commands.at(-1).label,'step 34');
});
