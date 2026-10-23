import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartAPI,ChartModel,readChartUI,saveChartUI} from '../src/index.mjs';
import {readCustomizationProfile,saveCustomizationProfile} from '../examples/web/customization-profile.mjs';

const theme={background:'#0c1320',grid:'#1d2a3a',text:'#8093ad',up:'#35d2ab',down:'#fa6c7c',crosshair:'#b9c9de',font:'12px monospace'};
const interaction={pointer:true,wheelZoom:false,keyboardShortcuts:true,hitTolerancePx:12};
const toolbar={label:'Price tools',tools:['select','trendline','rectangle'],actions:['fit','undo'],orientation:'vertical',density:'compact'};
function config(overrides={}){
 return {theme:{...theme,...overrides.theme},layout:{priceWeight:3.5,volumeWeight:1.25,axisSide:'left',placement:'right',...overrides.layout},ui:{interaction:{...interaction,...overrides.ui?.interaction},toolbar:{...toolbar,...overrides.ui?.toolbar}},extras:{navigator:true,overlays:false,tradeMarkers:true,...overrides.extras}};
}
function envelope(input=config(),uiText=saveChartUI(input.ui)){
 const normalized={theme:input.theme,layout:input.layout,extras:input.extras,uiText};
 return JSON.stringify({schema:'barochart.customization-profile',version:1,...normalized});
}

test('customization profile round-trips normalized appearance, layout, UI and extras',()=>{
 const input=config({theme:{background:'red',grid:'#abc',text:'rgba(1, 2, 3, .5)',up:'lime',down:'#12345678',crosshair:'transparent',font:'bold 18px monospace'},ui:{toolbar:{labels:{select:'Pan',undo:'Undo last'}}}});
 const text=saveCustomizationProfile(input),document=JSON.parse(text),read=readCustomizationProfile(text);
 assert.deepEqual(document,{schema:'barochart.customization-profile',version:1,theme:{background:'#ff0000ff',grid:'#aabbccff',text:'#01020380',up:'#00ff00ff',down:'#12345678',crosshair:'#00000000',font:'bold 18px monospace'},layout:input.layout,extras:input.extras,uiText:saveChartUI(input.ui)});
 assert.deepEqual(read,{theme:document.theme,layout:document.layout,extras:document.extras,ui:readChartUI(document.uiText)});
 assert.equal(saveCustomizationProfile(read),text);
 assert.deepEqual(read.ui.toolbar.labels,{select:'Pan',undo:'Undo last'});
});

test('profile reads legacy version 1 UI nesting and preserves its text',()=>{
 const input=config();
 const uiText=saveChartUI(input.ui);
 assert.equal(JSON.parse(uiText).version,1);
 const read=readCustomizationProfile(envelope(input,uiText));
 assert.deepEqual(read.ui,readChartUI(uiText));
 assert.equal(JSON.parse(saveCustomizationProfile(read)).uiText,uiText);
});

test('profile requires a toolbar and matching placement orientation on save and read',()=>{
 const input=config();
 assert.throws(()=>saveCustomizationProfile({...input,ui:{...input.ui,toolbar:null}}));
 const nullToolbar=JSON.parse(saveCustomizationProfile(input));
 nullToolbar.uiText=saveChartUI({interaction:input.ui.interaction,toolbar:null});
 assert.throws(()=>readCustomizationProfile(JSON.stringify(nullToolbar)));
 for(const [placement,orientation] of [['top','vertical'],['left','horizontal'],['right','horizontal']]){
  const candidate=config({layout:{placement},ui:{toolbar:{orientation}}});
  assert.throws(()=>saveCustomizationProfile(candidate));
  const expected=placement==='top'?'horizontal':'vertical';
  const valid=JSON.parse(saveCustomizationProfile(config({layout:{placement},ui:{toolbar:{orientation:expected}}})));
  valid.uiText=saveChartUI(candidate.ui);
  assert.throws(()=>readCustomizationProfile(JSON.stringify(valid)));
 }
});

test('profile preserves literal markup labels as text',()=>{
 const label='<b>Pan</b>',input=config({ui:{toolbar:{labels:{select:label}}}});
 const read=readCustomizationProfile(saveCustomizationProfile(input));
 assert.equal(read.ui.toolbar.labels.select,label);
});

test('profile rejects unknown, reserved, hidden, symbol and accessor input without evaluation',()=>{
 let calls=0;
 for(const value of [
  {...config(),unknown:true},
  {...config(),__proto__:{polluted:true}},
  Object.defineProperty(config(),'theme',{value:config().theme,enumerable:false}),
  Object.defineProperty(config(),'theme',{get(){calls++;return theme;},enumerable:true}),
  {...config(),toJSON(){calls++;return{};}},
 ])assert.throws(()=>saveCustomizationProfile(value));
 const symbol=Symbol('extra'),withSymbol=config();withSymbol[symbol]=true;
 assert.throws(()=>saveCustomizationProfile(withSymbol));
 assert.equal(calls,0);
});

test('profile rejects invalid schema, text size, colors, font, weights, enums and flags',()=>{
 const cases=[
  ['schema',JSON.stringify({schema:'other',version:1,theme:theme,layout:config().layout,extras:config().extras,uiText:saveChartUI(config().ui)})],
  ['oversize',' '.repeat(16385)],
 ];
 for(const [,text] of cases)assert.throws(()=>readCustomizationProfile(text));
 for(const themePatch of [{background:'hsl(0 0% 0%)'},{font:'9px monospace'},{font:'12px sans-serif'},{font:'12px monospace, sans-serif'}])assert.throws(()=>saveCustomizationProfile(config({theme:themePatch})));
 for(const layoutPatch of [{priceWeight:.49},{volumeWeight:8.01},{priceWeight:Infinity},{axisSide:'center'},{placement:'bottom'}])assert.throws(()=>saveCustomizationProfile(config({layout:layoutPatch})));
 for(const extrasPatch of [{navigator:1},{overlays:'yes'},{tradeMarkers:null}])assert.throws(()=>saveCustomizationProfile(config({extras:extrasPatch})));
 const doc=JSON.parse(saveCustomizationProfile(config()));for(const patch of [{schema:'other'},{version:2},{theme:{...doc.theme,unknown:'#fff'}},{layout:{...doc.layout,extra:1}},{extras:{...doc.extras,extra:false}},{uiText:saveChartUI(config().ui),extra:true}]){const next={...doc,...patch};assert.throws(()=>readCustomizationProfile(JSON.stringify(next)));}
});

test('profile output is deeply frozen and detached from caller data',()=>{
 const input=config({ui:{toolbar:{tools:['select','rectangle'],labels:{select:'Pan'}}}}),text=saveCustomizationProfile(input);
 input.theme.background='#fff';input.layout.priceWeight=8;input.ui.interaction.pointer=false;input.ui.toolbar.tools[1]='trendline';input.extras.navigator=false;
 const read=readCustomizationProfile(text);
 assert.equal(read.theme.background,'#0c1320ff');assert.equal(read.layout.priceWeight,3.5);assert.equal(read.ui.interaction.pointer,true);assert.deepEqual(read.ui.toolbar.tools,['select','rectangle']);assert.equal(read.extras.navigator,true);
 assert(Object.isFrozen(read));assert(Object.isFrozen(read.theme));assert(Object.isFrozen(read.layout));assert(Object.isFrozen(read.ui));assert(Object.isFrozen(read.ui.interaction));assert(Object.isFrozen(read.ui.toolbar));assert(Object.isFrozen(read.ui.toolbar.tools));assert(Object.isFrozen(read.extras));
 assert.throws(()=>{read.theme.background='#fff';});assert.throws(()=>{read.ui.toolbar.tools.push('text');});
});

test('profile color validation uses an isolated model and leaves live models unchanged',t=>{
 const model=new ChartModel({theme:{background:'#abcdef'}}),api=new ChartAPI(model);t.after(()=>model.dispose());
 const before={...model.theme},input=config({theme:{background:'white'}});
 saveCustomizationProfile(input);readCustomizationProfile(saveCustomizationProfile(input));
 assert.deepEqual(model.theme,before);assert.equal(model.disposed,undefined);api.setTheme({grid:'#123456'});assert.equal(model.theme.background,'#abcdef');
});
