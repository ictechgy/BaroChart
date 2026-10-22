import test from 'node:test';
import assert from 'node:assert/strict';
import {saveChartUI,readChartUI,attachChartToolbar,createChartUIPreset} from '../src/index.mjs';
import * as canvas from '../src/renderers/canvas.mjs';
import {fixture} from './helpers/customization-dom.mjs';

test('web UI codec exports and defaults preserve opt-in mounting',()=>{
 assert.equal(canvas.saveChartUI,saveChartUI);assert.equal(canvas.readChartUI,readChartUI);
 const text=saveChartUI(),ui=readChartUI(text);
 assert.deepEqual(ui,{interaction:{pointer:true,wheelZoom:true,keyboardShortcuts:true,hitTolerancePx:8},toolbar:null});
 assert.equal(saveChartUI(ui),text);assert(Object.isFrozen(ui));assert(Object.isFrozen(ui.interaction));
});
test('web UI codec owns complete frozen options and excludes transient state',t=>{
 const f=fixture(t),{chart}=f.create(),toolbar=attachChartToolbar(f.node(),chart,{tools:['rectangle','select'],actions:[],label:'내 도구',density:'compact'});
 chart.setTool('rectangle');chart.setInteractionOptions({wheelZoom:false,hitTolerancePx:13.5});
 const text=saveChartUI({interaction:chart.interactionOptions,toolbar:toolbar.options}),ui=readChartUI(text);
 assert(!text.includes('activeTool'));assert(!text.includes('canUndo'));assert(Object.isFrozen(ui.toolbar));assert(Object.isFrozen(ui.toolbar.tools));
 assert.deepEqual(ui.toolbar.tools,['rectangle','select']);assert.deepEqual(ui.toolbar.actions,[]);assert.equal(ui.interaction.hitTolerancePx,13.5);
 assert.throws(()=>saveChartUI({toolbar:toolbar.snapshot()}));assert.equal(saveChartUI(ui),text);
 const held=toolbar.options;toolbar.setOptions({density:'comfortable'});assert.equal(held.density,'compact');toolbar.destroy();assert.throws(()=>toolbar.options);
});
test('saved configuration detaches caller lists',()=>{const tools=['select','text'],input={toolbar:{tools}};const text=saveChartUI(input);tools[1]='ray';assert.deepEqual(readChartUI(text).toolbar.tools,['select','text']);});
for(const [name,value] of Object.entries({unknown:{extra:true},null:null,array:[],interactionNull:{interaction:null},switch:{interaction:{pointer:1}},radius:{interaction:{hitTolerancePx:33}},tool:{toolbar:{tools:['select','bad']}},transient:{toolbar:{activeTool:'select'}},sparse:{toolbar:{tools:new Array(2)}},infinite:{interaction:{hitTolerancePx:Infinity}},unicode:{toolbar:{label:'\ud800'}},function:{toolbar:{label:()=>{}}}}))test('UI writer rejects '+name,()=>assert.throws(()=>saveChartUI(value)));
test('UI writer never evaluates accessors or toJSON',()=>{
 let calls=0;for(const value of [{get interaction(){calls++;return{};}},{toolbar:{get label(){calls++;return'Bad';}}},{toJSON(){calls++;return{};}},Object.defineProperty({},'toolbar',{value:{},enumerable:false})])assert.throws(()=>saveChartUI(value));
 assert.equal(calls,0);
});
test('UI writer rejects extra list properties and inherited configuration',()=>{const tools=['select'];tools.extra=true;assert.throws(()=>saveChartUI({toolbar:{tools}}));assert.throws(()=>saveChartUI(Object.create({interaction:{pointer:false}})));const v={};v[Symbol('extra')]=true;assert.throws(()=>saveChartUI(v));});
for(const [name,mutate] of Object.entries({schema:d=>d.schema='other',version:d=>d.version=2,missing:d=>delete d.toolbar,partial:d=>delete d.interaction.pointer,toolbarPartial:d=>d.toolbar={tools:['select']},extra:d=>d.workspace='no',nullInteraction:d=>d.interaction=null}))test('UI reader rejects '+name,()=>{const doc=JSON.parse(saveChartUI());mutate(doc);assert.throws(()=>readChartUI(JSON.stringify(doc)));});
test('UI reader rejects duplicate/escaped/reserved keys, oversized/deep/nonfinite input',()=>{
 for(const text of ['{"schema":"x","schema":"barochart.web-ui"}','{"x":1,"\\u0078":2}','{"__proto__":{}}',' '.repeat(8193),'['.repeat(33)+'0'+']'.repeat(33),'{"x":1e999}','{"x":{"$asterNumber":"NaN"}}'])assert.throws(()=>readChartUI(text));
 assert.throws(()=>readChartUI(null));
 const text=saveChartUI();assert.deepEqual(readChartUI(text+' '.repeat(8192-text.length)),readChartUI(text));
});
test('invalid UI leaves existing chart, history, input and toolbar untouched',t=>{const f=fixture(t),{chart,model}=f.create(),toolbar=attachChartToolbar(f.node(),chart),policy=chart.interactionOptions,config=toolbar.options,history=model.drawings.undoStack;assert.throws(()=>readChartUI('{"version":99}'));assert.equal(chart.interactionOptions,policy);assert.equal(toolbar.options,config);assert.equal(model.drawings.undoStack,history);});

test('mobile and desktop presets are explicit immutable values with stable serialization',()=>{const mobile=createChartUIPreset('mobile'),desktop=createChartUIPreset('desktop');assert.equal(canvas.createChartUIPreset,createChartUIPreset);assert.deepEqual(mobile.interaction,{pointer:true,wheelZoom:false,keyboardShortcuts:true,hitTolerancePx:24});assert.equal(mobile.toolbar.density,'comfortable');assert.equal(mobile.toolbar.orientation,'horizontal');assert.deepEqual(mobile.toolbar.actions,['fit','undo','redo']);assert.equal(desktop.interaction.hitTolerancePx,8);assert.equal(desktop.interaction.wheelZoom,true);assert.equal(desktop.toolbar.actions.length,5);assert(Object.isFrozen(mobile));assert(Object.isFrozen(mobile.toolbar.actions));assert.notEqual(mobile,createChartUIPreset('mobile'));assert.deepEqual(readChartUI(saveChartUI(mobile)),mobile);assert(!saveChartUI(mobile).includes('mobile'));});
test('presets never coerce names or change existing renderer defaults',t=>{let calls=0;for(const value of[undefined,null,'tablet','MOBILE',{}, {toString(){calls++;return'mobile';}}])assert.throws(()=>createChartUIPreset(value));assert.equal(calls,0);createChartUIPreset('mobile');const f=fixture(t),{chart}=f.create();assert.equal(chart.interactionOptions.hitTolerancePx,8);assert.equal(chart.interactionOptions.wheelZoom,true);});
