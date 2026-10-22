import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartModel,InteractionController} from '../src/core/index.mjs';
function fixture(t,count){const model=new ChartModel(),controller=new InteractionController(model,()=>({width:1000,height:600}));for(let i=0;i<count;i++)model.drawings.add({id:`d${i}`,type:'horizontal',points:[{time:i,price:i+1}]});model.drawings.selected=null;t.after(()=>model.dispose());return {model,controller,d:model.drawings};}
for(const count of [0,1,3])for(const key of ['PageUp','PageDown'])test(`${key} with ${count} drawings enters from unselected boundary then wraps`,t=>{
 const {controller:c,d}=fixture(t,count),saved=d.save(),history=d.undoStack.slice();
 c.key(key);assert.equal(d.selected,count?`d${key==='PageUp'?count-1:0}`:null);
 for(let i=1;i<=count;i++){c.key(key);assert.equal(d.selected,`d${key==='PageUp'?(count-1-i%count+count)%count:i%count}`);}
 assert.equal(d.save(),saved);assert.deepEqual(d.undoStack,history);assert.equal(d.transaction,null);
});
for(const reset of ['Escape','undo','load','missing-id'])test(`PageUp after ${reset} starts at last surviving drawing`,t=>{
 const {controller:c,d}=fixture(t,3);
 if(reset==='Escape'){d.selected='d1';c.key('Escape');}
 if(reset==='undo'){d.edit('d1',{text:'edit'});c.key('z',{ctrl:true});}
 if(reset==='load')d.load(d.save());
 if(reset==='missing-id')d.selected='absent';
 const before=d.save();c.key('PageUp');assert.equal(d.selected,'d2');assert.equal(d.save(),before);
});
test('cycling preserves existing inclusion of locked and orphan drawings',t=>{
 const {controller:c,d}=fixture(t,1);d.add({id:'locked',type:'horizontal',locked:true,points:[{time:0,price:1}]});d.add({id:'orphan',panel:'missing',type:'horizontal',points:[{time:0,price:1}]});d.selected=null;
 c.key('PageUp');assert.equal(d.selected,'orphan');c.key('PageUp');assert.equal(d.selected,'locked');c.key('PageDown');assert.equal(d.selected,'orphan');
});
test('PageUp cancels a transient drawing before choosing the last committed one',t=>{
 const {controller:c,d}=fixture(t,3),saved=d.save(),history=d.undoStack.length;
 c.setTool('horizontal');c.down(1,300,200);assert.equal(d.items.length,4);
 c.key('PageUp');assert.equal(d.selected,'d2');assert.equal(d.save(),saved);assert.equal(d.undoStack.length,history);assert.equal(c.gesture,null);assert.equal(c.pointers.size,0);
});
test('generated native bundle enters last/first after explicit selection reset',async()=>{
 const {default:vm}=await import('node:vm');const {buildNativeBundle}=await import('../scripts/native-core-bundle.mjs');const context=vm.createContext({});vm.runInContext(await buildNativeBundle(),context,{timeout:5000});
 const r=JSON.parse(vm.runInContext(`JSON.stringify((()=>{nativeInit(0);const c=new Aster.InteractionController(nativeModel,()=>({width:1000,height:600}));for(let i=0;i<3;i++)nativeModel.drawings.add({id:'d'+i,type:'horizontal',points:[{time:i,price:i+1}]});c.key('Escape');c.key('PageUp');const up=nativeModel.drawings.selected;c.key('Escape');c.key('PageDown');const down=nativeModel.drawings.selected;nativeModel.dispose();return {up,down};})())`,context,{timeout:5000}));assert.deepEqual(r,{up:'d2',down:'d0'});
});
