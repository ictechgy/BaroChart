#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {ChartAPI} from '../../../src/core/api.mjs';
import {BarStore} from '../../../src/core/data.mjs';
import {builtinIndicators} from '../../../src/core/indicators.mjs';
import {ChartModel} from '../../../src/core/model.mjs';
import {nativeWorkspacePreflight} from '../../../src/core/native-workspace.mjs';
import {NativeWorkspaceCapture} from '../../../src/core/native-workspace-source.mjs';
import {NativeWorkspacePrepared,nativeWorkspaceTargetPlan} from '../../../src/core/native-workspace-target.mjs';
import {readWorkspaceDocument,saveWorkspace,workspaceSnapshot} from '../../../src/core/workspace.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=join(root,'test/fixtures/rust-core-vectors/workspace.leaf.jsonl');
const legacy=readFileSync(join(root,'test/fixtures/legacy/aster-workspace-v1.json'),'utf8').trim();
const HEADER=Object.freeze({
 kind:'header',schema:'barochart.rust-workspace.leaf',version:1,
 workspaceBase:'8457612bda98c764bc1a9e7e794dafcf9316a47e',
 workspaceSHA256:'23014e8bc2aafa0e435d61aced3ea8149865a27d14017aeeea58ab53baaa030c',
 nativeWorkspaceSHA256:'074fc4872d50a50cb4dd1af2757540e2691d8cec167d78b6cf2ed0cd9c655780',
 sourceSHA256:'21b40e39577c5d489f072b97746d70b772de7c0191a3320582ae4b3742dfe648',
 targetSHA256:'e6430e9f20eb1f076d017edc2ee79ffe98d49f1bb3566a639c9aa0c52092d8b0',
 modelSHA256:'64bb1a0a042841a9386a6f8f500c0e5f96a952d4a09602f91e2f3ef333f356ad',
 indicatorsSHA256:'31465780b94dd84e93d5d50d913b6f006e9b329b548ddf2ca2fbe7af53553790',
 drawingsSHA256:'0cf404f1d9f9525fe3fe09a83bc4cd9a31b9a5c8668487248bcb18cd234da667',
 marketsSHA256:'605de3d5a787145980b832022fbb06318bb3db65a0ec9e89933c9365ef847cf5',
 checkpointSHA256:'6607c2b3adb1c24ad3133711b72b8e7f63bad1b195be19f3bc944ce66000b463',
 node:'v22.20.0',v8:'12.4.254.21-node.33',seed:'workspace-leaf-v1',
 encoding:'f64 big-endian bits; objects as ordered entry arrays; undefined explicitly tagged',
 caseCounts:{save:6,read:7,readError:23,preflightError:4,snapshot:4,source:1,sourceError:5,sourceIdentity:4,target:1,targetError:5,targetBig:1}
});
const sourceFiles=[
 ['src/core/workspace.mjs','workspaceSHA256'],['src/core/native-workspace.mjs','nativeWorkspaceSHA256'],
 ['src/core/native-workspace-source.mjs','sourceSHA256'],['src/core/native-workspace-target.mjs','targetSHA256'],
 ['src/core/model.mjs','modelSHA256'],['src/core/indicators.mjs','indicatorsSHA256'],
 ['src/core/drawings.mjs','drawingsSHA256'],['src/core/markets.mjs','marketsSHA256'],
 ['src/core/checkpoint-validation.mjs','checkpointSHA256']
];
const sha256=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
function verify(){if(process.version!==HEADER.node||process.versions.v8!==HEADER.v8)throw new Error(`workspace oracle requires ${HEADER.node}/${HEADER.v8}`);for(const[path,key]of sourceFiles)if(sha256(join(root,path))!==HEADER[key])throw new Error(`workspace source hash changed: ${path}`);}
const buffer=new ArrayBuffer(8),view=new DataView(buffer);
function f64(value){view.setFloat64(0,value,false);return view.getBigUint64(0,false).toString(16).padStart(16,'0');}
function encode(value){if(typeof value==='number')return{$f64:f64(value)};if(typeof value==='string'||typeof value==='boolean'||value===null)return value;if(value===undefined)return{$undefined:true};if(value instanceof Float64Array)return{$f64array:Array.from(value,f64)};if(Array.isArray(value))return value.map(encode);if(value&&typeof value==='object')return{$object:Object.entries(value).map(([key,child])=>[key,encode(child)])};throw new TypeError('Unsupported workspace oracle value');}
function errorValue(error){return{name:error.name,message:error.message,...(error.code===undefined?{}:{code:error.code})};}
function attempt(run){try{return{ok:run()};}catch(error){return{error:errorValue(error)};}}
const BINDING={key:'fixture:ASTER/1m',revision:'source-r1',adjustmentVersion:'raw-v1',priceUnit:'USD',adjustment:'raw'};
const SYMBOL={id:'ASTER',exchange:'TEST',timezone:'America/New_York',currency:'USD',volumeUnit:'shares',priceDecimals:2,tickSize:.01,adjustment:'raw'};
const START=1700000000000;
function bars(count){return Array.from({length:count},(_,index)=>{const close=100+(index%13);return{time:START+index*60000,open:close-1,high:close+2,low:close-2,close,volume:index+1};});}
function chart(kind,countOverride=null){
 const count=countOverride??(kind==='empty-raw'||kind==='empty-split'||kind==='empty-total'?0:40),store=new BarStore(bars(count));
 const model=new ChartModel({store,panels:[{id:'price',weight:3},{id:'osc',weight:1}],axes:[{id:'left',panel:'price',side:'left'}],visibleBars:30});
 const api=new ChartAPI(model);api.addSeries({id:'candles',type:'candles',panel:'price'});
 if(kind==='basic'||kind==='pressure'){
  api.addIndicator('ema','ema',{period:5});api.addSeries({id:'ema-line',type:'line',panel:'price',axisId:'left',indicator:'ema',color:'#f0b755ff'});
  api.addDrawing({id:'level',type:'horizontal',panel:'price',points:[{time:START+600000,price:110}],text:'Legacy 수평선'});
  api.addDrawing({id:'bound',type:'trendline',panel:'price',axisId:'left',points:[{time:START,price:100},{time:START+1200000,price:125}]});
  api.addDrawing({id:'position',type:'longposition',panel:'price',points:[{time:START,price:100},{time:START,price:90},{time:START,price:120},{time:START+600000,price:100}]});
  api.addDrawing({id:'visible',type:'text',panel:'price',points:[{time:START,price:105}],text:'visible',visible:false});
  api.setSymbol(SYMBOL);model.precision=4;model.setVisibleRange(5,35);
 }
 if(kind==='big'){api.addIndicator('ema','ema',{period:5});api.addSeries({id:'close-line',type:'line',panel:'price',source:'close'});api.addSeries({id:'ema-line',type:'line',panel:'price',indicator:'ema'});}
 if(kind==='pressure'){
  api.registerIndicatorModule('aster.volume-direction',1);api.addIndicator('pressure','aster.volume-direction@1/pressure',{factor:.75,shift:-3});api.addSeries({id:'pressure-line',type:'line',panel:'osc',indicator:'pressure',output:'cumulative'});
 }
 if(kind==='all-builtins')for(const [index,name]of [...builtinIndicators.keys()].entries())api.addIndicator(`i${index}`,name,{});
 const binding={...BINDING};if(kind==='empty-split')binding.adjustment='split';if(kind==='empty-total')binding.adjustment='total-return';
 return{model,api,binding};
}
function saveRow(id,kind){const value=chart(kind);try{const text=saveWorkspace(value.api,value.binding),doc=readWorkspaceDocument(text),receipt=nativeWorkspacePreflight(value.api,text,value.binding);return{kind:'save',id,chart:kind,binding:encode(value.binding),expectedText:text,expectedDoc:encode(doc),expectedPreflight:encode(receipt)};}finally{value.model.dispose();}}
function validDrawingDoc(version){const base=JSON.parse(saveRow('scratch','basic').expectedText);if(version===1)base.drawings={schema:'aster.drawings',version,drawings:[{id:'d',panel:'price',locked:false,style:{color:'#f5b85a',width:1.5},type:'horizontal',points:[{time:START,price:100}]}]};if(version===2)base.drawings={schema:'aster.drawings',version,drawings:[{id:'d',panel:'price',locked:false,style:{color:'#f5b85a',width:1.5},type:'trendline',points:[{time:START,price:100},{time:START+60000,price:101}],axisId:'left'}]};if(version===3)base.drawings={schema:'aster.drawings',version,drawings:[{id:'d',panel:'price',locked:false,style:{color:'#f5b85a',width:1.5},type:'longposition',points:[{time:START,price:100},{time:START,price:90},{time:START,price:120},{time:START+60000,price:100}]}]};if(version===4)base.drawings={schema:'aster.drawings',version,drawings:[{id:'d',panel:'price',locked:false,style:{color:'#f5b85a',width:1.5},type:'text',points:[{time:START,price:100}],text:'hidden',visible:false}]};return JSON.stringify(base);}
function readRows(saves){const rows=[{kind:'read',id:'legacy',text:legacy,expected:encode(readWorkspaceDocument(legacy))}];for(const version of[1,2,3,4]){const text=validDrawingDoc(version);rows.push({kind:'read',id:`drawing-v${version}`,text,expected:encode(readWorkspaceDocument(text))});}const canonical=saves.find(row=>row.id==='basic').expectedText,doc=JSON.parse(canonical),reordered=JSON.stringify({drawings:doc.drawings,series:doc.series,indicators:doc.indicators,chart:doc.chart,source:doc.source,dataset:doc.dataset,version:doc.version,schema:doc.schema});rows.push({kind:'read',id:'reordered',text:reordered,expected:encode(readWorkspaceDocument(reordered))});const marker=canonical.replace('"price":100','"price":{"$asterNumber":"-0"}').replace('"id":"level"','"id":"level","axisId":null');rows.push({kind:'read',id:'marker-negative-zero-null',text:marker,expected:encode(readWorkspaceDocument(marker))});return rows;}
function mutateText(base,mutate){const doc=JSON.parse(base);mutate(doc);return JSON.stringify(doc);}
function readErrorRows(base){
 const cases=[
  ['schema',text=>mutateText(text,doc=>doc.version=2)],['source-empty-endpoint',text=>mutateText(text,doc=>{doc.source.length=0;doc.source.firstTime=1;doc.source.lastTime=null;})],
  ['source-endpoint',text=>mutateText(text,doc=>doc.source.lastTime=doc.source.firstTime)],['view',text=>mutateText(text,doc=>doc.chart.view.to=doc.chart.view.from)],
  ['symbol-units',text=>mutateText(text,doc=>doc.chart.symbol.currency='EUR')],['duplicate-indicator',text=>mutateText(text,doc=>doc.indicators.push(doc.indicators[0]))],
  ['output-schema',text=>mutateText(text,doc=>doc.indicators[0].outputs=[])],['output-offset',text=>mutateText(text,doc=>doc.indicators[0].plotOffsets.value=10001)],
  ['missing-panel',text=>mutateText(text,doc=>doc.series[0].panel='missing')],['missing-axis',text=>mutateText(text,doc=>doc.series[1].axisId='missing')],
  ['missing-study',text=>mutateText(text,doc=>doc.series[1].indicator='missing')],['drawing-version',text=>mutateText(text,doc=>doc.drawings.version=1)],
  ['drawing-binding',text=>mutateText(text,doc=>doc.drawings.drawings[1].axisId='missing')],['duplicate-drawing',text=>mutateText(text,doc=>doc.drawings.drawings.push(doc.drawings.drawings[0]))],
  ['unknown-field',text=>mutateText(text,doc=>doc.restore=true)],['nonfinite-marker',text=>text.replace('"price":110','"price":{"$asterNumber":"Infinity"}')],
  ['reserved-key',text=>text.replace('"schema":','"toJSON":0,"schema":')],['lone-surrogate',text=>text.replace('"Legacy 수평선"','"\\ud800"')],
  ['linked-backend',text=>mutateText(text,doc=>doc.indicators=[{id:'custom',name:'test.native@1/pair',params:{},module:{id:'test.native',version:1,stateVersion:1,exportName:'pair',causal:true},outputs:['value'],plotOffsets:{}}])],
  ['depth-directive',()=>null,{directive:'depth',count:34}],['char-limit-directive',()=>null,{directive:'spaces',count:2097153}],['byte-limit-directive',()=>null,{directive:'wide',count:1398102}],['broken-json',()=>'{broken']
 ];
 return cases.map(([id,make,directive])=>{const text=directive??make(base),result=attempt(()=>readWorkspaceDocument(directive?directive.directive==='depth'?JSON.stringify({a:Array.from({length:directive.count}).reduce(value=>[value],0)}):directive.directive==='spaces'?' '.repeat(directive.count):'界'.repeat(directive.count):text));if(!result.error)throw new Error(`expected read error ${id}`);const expectedRust=id==='linked-backend'?{name:'UnavailableError',message:'Indicator module requires the javaScript backend: test.native@1/pair',code:'JAVASCRIPT_BACKEND_REQUIRED'}:id==='broken-json'?{name:'SyntaxError',message:'JSON: 1 unexpected \'b\'; expected \'"\' to start an object key'}:null;return{kind:'read-error',id,input:typeof text==='string'?{text}:text,expected:result.error,...(expectedRust?{expectedRust}:{})};});
}
function preflightErrorRows(base){const cases=[['binding',base,{...BINDING,revision:'other'}],['extent',mutateText(base,doc=>doc.source.lastTime--),BINDING],['output',mutateText(base,doc=>doc.indicators[0].outputs=['wrong']),BINDING],['unknown-factory',mutateText(base,doc=>{doc.indicators=[{id:'u',name:'unknown',params:{},outputs:['value'],plotOffsets:{}}];doc.series=[];}),BINDING]];return cases.map(([id,text,binding])=>{const value=chart('basic');try{const result=attempt(()=>nativeWorkspacePreflight(value.api,text,binding));if(!result.error)throw new Error(`expected preflight error ${id}`);return{kind:'preflight-error',id,chart:'basic',text,binding:encode(binding),expected:result.error};}finally{value.model.dispose();}});}
function snapshotRows(){const values=[['negative-zero',{a:-0,b:'x'}],['unicode',{a:'한국 🚀',b:['x',true,null]}],['undefined',{a:undefined}],['nonfinite',{a:Infinity}]];return values.map(([id,input])=>{const result=attempt(()=>workspaceSnapshot(input));return{kind:'snapshot',id,input:encode(input),expected:encode(result)};});}

const SIZE={width:640,height:360},REVISION=7,MAX_BYTES=805306368;
function sourceSession(){const fixture=chart('basic'),text=saveWorkspace(fixture.api,fixture.binding),capture=new NativeWorkspaceCapture(fixture.api,text,fixture.binding,{input:null,size:{...SIZE},revision:REVISION,maxBytes:MAX_BYTES}),progress=[];let complete;for(let index=0;index<100;index++){const row=capture.step(8,REVISION);progress.push(row);if(row.complete){complete=row;break;}}if(!complete)throw new Error('source did not complete admission');const metadataJSON=capture.metadataJSON,plan=capture.plan,buffers=Array.from({length:6},(_,slot)=>({slot,length:fixture.model.store.length})),columns=[];for(let slot=0;slot<6;slot++)columns.push(Array.from(capture.buffer(slot,0,fixture.model.store.length,REVISION)));const finish=capture.finish(REVISION);const result={kind:'source',id:'source-normal',chart:'basic',revision:REVISION,maxBytes:MAX_BYTES,size:SIZE,document:text,binding:encode(fixture.binding),expected:encode({progress,metadataJSON,plan,buffers,checkpoints:[],columns,finish})};fixture.model.dispose();return result;}
function sourceErrorRows(){const make=()=>{const fixture=chart('basic'),text=saveWorkspace(fixture.api,fixture.binding),capture=new NativeWorkspaceCapture(fixture.api,text,fixture.binding,{input:null,size:{...SIZE},revision:REVISION,maxBytes:MAX_BYTES});return{fixture,capture};};const rows=[];
 {const{fixture,capture}=make();const result=attempt(()=>capture.step(0,REVISION));rows.push(['step-zero',result.error]);fixture.model.dispose();}
 {const{fixture,capture}=make();const result=attempt(()=>capture.buffer(0,0,1,REVISION));rows.push(['buffer-before-copy',result.error]);fixture.model.dispose();}
 {const{fixture,capture}=make();let row;do{row=capture.step(64,REVISION);}while(!row.complete);const result=attempt(()=>capture.finish(REVISION));rows.push(['finish-incomplete',result.error]);fixture.model.dispose();}
 {const{fixture,capture}=make();fixture.model.pan(1);const result=attempt(()=>capture.check(REVISION));rows.push(['stale-view',result.error]);capture.dispose();fixture.model.dispose();}
 {const{fixture,capture}=make();capture.dispose();const result=attempt(()=>capture.check(REVISION));rows.push(['closed',result.error]);fixture.model.dispose();}
 return rows.map(([id,expected])=>({kind:'source-error',id,chart:'basic',revision:REVISION,maxBytes:MAX_BYTES,size:SIZE,expected}));}
function sourceIdentityRows(){const cases=[
 ['same-visible-range',fixture=>fixture.api.setVisibleRange(fixture.model.view.from,fixture.model.view.to)],
 ['same-panel-record',fixture=>fixture.api.setPanel('price',{})],
 ['empty-theme-replacement',fixture=>fixture.api.setTheme({})],
 ['selection-roundtrip',fixture=>{const selected=fixture.model.drawings.selected;fixture.api.selectDrawing('level');fixture.api.selectDrawing(selected);}],
];return cases.map(([id,mutate])=>{const fixture=chart('basic'),text=saveWorkspace(fixture.api,fixture.binding),capture=new NativeWorkspaceCapture(fixture.api,text,fixture.binding,{input:null,size:{...SIZE},revision:REVISION,maxBytes:MAX_BYTES});mutate(fixture);const expected=attempt(()=>capture.check(REVISION));capture.dispose();fixture.model.dispose();return{kind:'source-identity',id,expected:encode(expected)};});}
function targetFromSource(){const fixture=chart('basic'),text=saveWorkspace(fixture.api,fixture.binding),capture=new NativeWorkspaceCapture(fixture.api,text,fixture.binding,{input:null,size:{...SIZE},revision:REVISION,maxBytes:MAX_BYTES});let complete;do{complete=capture.step(64,REVISION);}while(!complete.complete);const target=new NativeWorkspacePrepared(capture.metadataJSON);for(let slot=0;slot<6;slot++){const values=capture.buffer(slot,0,fixture.model.store.length,REVISION);target.target(slot,0,values.length).set(values);}target.start();const progress=[];for(let index=0;index<1000;index++){const row=target.step(64);progress.push(row);if(row.complete)break;}const result=target.finish(),saved=saveWorkspace(new ChartAPI(result.model),fixture.binding),summary={progress,size:result.size,plan:result.plan,saved,store:{length:result.model.store.length,version:result.model.store.version,timeVersion:result.model.store.timeVersion,capacity:result.model.store.capacity},counts:{panels:result.model.panels.length,axes:result.model.axes.length,series:result.model.series.length,indicators:result.model.indicators.entries.size,drawings:result.model.drawings.items.length}};result.model.dispose();capture.dispose();fixture.model.dispose();return{kind:'target',id:'target-normal',source:'source-normal',expected:encode(summary)};}
function targetErrorRows(){const session=()=>{const fixture=chart('basic'),text=saveWorkspace(fixture.api,fixture.binding),capture=new NativeWorkspaceCapture(fixture.api,text,fixture.binding,{input:null,size:{...SIZE},revision:REVISION,maxBytes:MAX_BYTES});let complete;do{complete=capture.step(64,REVISION);}while(!complete.complete);return{fixture,capture,metadata:capture.metadataJSON};};const rows=[];
 rows.push(['bad-protocol',attempt(()=>nativeWorkspaceTargetPlan('{"schema":"bad"}')).error]);
 {const{fixture,capture,metadata}=session(),target=new NativeWorkspacePrepared(metadata);rows.push(['incomplete-start',attempt(()=>target.start()).error]);target.dispose();capture.dispose();fixture.model.dispose();}
 {const{fixture,capture,metadata}=session(),target=new NativeWorkspacePrepared(metadata);rows.push(['finish-early',attempt(()=>target.finish()).error]);target.dispose();capture.dispose();fixture.model.dispose();}
 {const{fixture,capture,metadata}=session(),target=new NativeWorkspacePrepared(metadata),values=capture.buffer(0,0,fixture.model.store.length,REVISION);rows.push(['copy-order',attempt(()=>target.target(0,1,values.length)).error]);target.dispose();capture.dispose();fixture.model.dispose();}
 {const{fixture,capture,metadata}=session(),target=new NativeWorkspacePrepared(metadata);for(let slot=0;slot<6;slot++){const values=capture.buffer(slot,0,fixture.model.store.length,REVISION);if(slot===0)values[0]+=1;target.target(slot,0,values.length).set(values);}target.start();let error;for(let index=0;index<1000;index++){const result=attempt(()=>target.step(64));if(result.error){error=result.error;break;}if(result.ok.complete)break;}rows.push(['source-extent',error]);target.dispose();capture.dispose();fixture.model.dispose();}
 return rows.map(([id,expected])=>({kind:'target-error',id,expected}));}

function targetBigSession(){const fixture=chart('big',8193),text=saveWorkspace(fixture.api,fixture.binding),capture=new NativeWorkspaceCapture(fixture.api,text,fixture.binding,{input:null,size:{...SIZE},revision:REVISION,maxBytes:MAX_BYTES});let admitted;do{admitted=capture.step(64,REVISION);}while(!admitted.complete);const target=new NativeWorkspacePrepared(capture.metadataJSON);for(let slot=0;slot<6;slot++){const values=capture.buffer(slot,0,fixture.model.store.length,REVISION);target.target(slot,0,values.length).set(values);}target.start();const progress=[];for(let index=0;index<1000;index++){const row=target.step(4096);progress.push(row);if(row.complete)break;}const result=target.finish(),summary={progress,store:{length:result.model.store.length,capacity:result.model.store.capacity,version:result.model.store.version,timeVersion:result.model.store.timeVersion},counts:{series:result.model.series.length,indicators:result.model.indicators.entries.size}};result.model.dispose();capture.dispose();fixture.model.dispose();return{kind:'target-big',id:'target-big-8193',chart:'big',count:8193,quantum:4096,expected:encode(summary)};}

export function generateWorkspaceOracle(){verify();const saves=[saveRow('basic','basic'),saveRow('pressure','pressure'),saveRow('all-builtins','all-builtins'),saveRow('empty-raw','empty-raw'),saveRow('empty-split','empty-split'),saveRow('empty-total','empty-total')],reads=readRows(saves),readErrors=readErrorRows(saves[0].expectedText),preflightErrors=preflightErrorRows(saves[0].expectedText),snapshots=snapshotRows(),source=[sourceSession()],sourceErrors=sourceErrorRows(),sourceIdentity=sourceIdentityRows(),target=[targetFromSource()],targetErrors=targetErrorRows(),targetBig=[targetBigSession()];for(const[name,rows]of Object.entries({save:saves,read:reads,readError:readErrors,preflightError:preflightErrors,snapshot:snapshots,source,sourceError:sourceErrors,sourceIdentity,target,targetError:targetErrors,targetBig}))if(rows.length!==HEADER.caseCounts[name])throw new Error(`${name} count ${rows.length}`);return[HEADER,...saves,...reads,...readErrors,...preflightErrors,...snapshots,...source,...sourceErrors,...sourceIdentity,...target,...targetErrors,...targetBig].map(row=>JSON.stringify(row)).join('\n')+'\n';}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const mode=process.argv[2];if(process.argv.length>3||mode&&!['--check','--write'].includes(mode))throw new Error('Usage: node test/fixtures/rust-core-vectors/generate-workspace.mjs [--check|--write]');const output=generateWorkspaceOracle();if(mode==='--check'){if(readFileSync(fixture,'utf8')!==output)throw new Error('workspace.leaf.jsonl is stale');console.log(`workspace oracle fresh: ${Object.entries(HEADER.caseCounts).map(([key,value])=>key+'='+value).join(', ')}`);}else if(mode==='--write'){writeFileSync(fixture,output);console.log(`wrote ${fixture}`);}else process.stdout.write(output);}
