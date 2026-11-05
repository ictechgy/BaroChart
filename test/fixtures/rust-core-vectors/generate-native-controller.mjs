#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import vm from 'node:vm';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildNativeBundle} from '../../../scripts/native-core-bundle.mjs';

if(process.versions.node.split('.')[0]!=='22')throw new Error('Native controller oracle requires Node22');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=join(root,'test/fixtures/rust-core-vectors/native-controller.leaf.jsonl');
const sources=['examples/native/bridge.mjs','src/core/api.mjs','src/core/model.mjs','src/core/interaction.mjs','src/core/drawings.mjs'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const f64Buffer=new ArrayBuffer(8),f64View=new DataView(f64Buffer);
function f64(value){f64View.setFloat64(0,value,false);return f64View.getBigUint64(0,false).toString(16).padStart(16,'0');}
function encode(value,seen=new Set()){
 if(typeof value==='number')return{$f64:f64(value)};
 if(value===undefined)return{$undefined:true};
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(ArrayBuffer.isView(value)||Array.isArray(value))return Array.from(value,item=>encode(item,seen));
 if(typeof value==='object'){
  if(seen.has(value))throw new TypeError('cyclic fixture value');seen.add(value);
  const result={$object:Object.entries(value).map(([key,item])=>[key,encode(item,seen)])};seen.delete(value);return result;
 }
 throw new TypeError('unsupported fixture value');
}

const setup=`
 nativeInit(20,{series:[{id:'price',type:'candles',panel:'price'}]});nativeResize(400,300);
 const effects=[];nativeAPI.invalidate=(...args)=>effects.push(args);
 const add=()=>nativeCommand('addDrawing',[{id:'d',type:'horizontal',panel:'price',seriesId:'price',points:[{time:1700000600000,price:100}]}]);
 const drag=(id=1)=>{const d=nativeModel.drawings.items[0],p=nativeInput.layout().toScreen(d.points[0],d.panel,d.axisId);nativePointer('down',id,p.x,p.y);nativePointer('move',id,p.x,p.y+24);};
 const state=()=>({gesture:nativeInput.gesture?.kind??null,pointers:nativeInput.pointers.size,transaction:!!nativeModel.drawings.transaction,anchor:nativeModel.drawings.items[0]?.points[0]?.price??null,count:nativeModel.drawings.items.length,undo:nativeModel.drawings.undoStack.length,redo:nativeModel.drawings.redoStack.length,target:nativeInput.drawingTarget,effects:effects.length});
`;

const cases=[
 {id:'invalid-edit-preserves',source:`${setup}add();drag();const before=state();let error;try{nativeCommand('editDrawing',['missing',{locked:false}]);}catch(cause){error={name:cause.name,message:cause.message};}({before,error,after:state()})`},
 {id:'valid-edit-baseline',source:`${setup}add();drag();nativeCommand('editDrawing',['d',{style:{color:'red'}}]);({state:state(),color:nativeModel.drawings.items[0].style.color})`},
 {id:'add-during-edit-late-events',source:`${setup}add();drag();nativeCommand('addDrawing',[{id:'added',type:'horizontal',panel:'price',points:[{time:1700000600000,price:101}]}]);nativePointer('move',1,1,1);nativePointer('up',1,1,1);state()`},
 {id:'create-delete',source:`${setup}nativeCommand('setDrawingTarget',[{panel:'price',seriesId:'price'}]);nativeCommand('setTool',['horizontal']);nativePointer('down',2,100,100);const id=nativeInput.gesture.id,result=nativeCommand('deleteDrawing',[id]);({result,state:state()})`},
 {id:'active-inactive-undo-redo',source:`${setup}add();drag();nativeCommand('undo');const active=state();nativeCommand('undo');const undone=state();nativeCommand('redo');({active,undone,redone:state()})`},
 {id:'series-removal-cleanup',source:`${setup}nativeCommand('addSeries',[{id:'line',type:'line',panel:'price'}]);nativeCommand('setDrawingTarget',[{panel:'price',seriesId:'line'}]);nativeCommand('addDrawing',[{id:'d',type:'horizontal',panel:'price',seriesId:'line',points:[{time:1700000600000,price:100}]}]);drag();nativeCommand('removeSeries',['line']);({state:state(),drawingSeries:nativeModel.drawings.items[0].seriesId,series:nativeModel.series.map(row=>row.id)})`},
];

async function runCase(bundle,spec){
 const context=vm.createContext({});vm.runInContext(bundle,context);
 try{return{kind:'case',id:spec.id,result:encode(vm.runInContext(spec.source,context,{timeout:10000}))};}
 catch(cause){return{kind:'case',id:spec.id,thrown:{name:cause.name,message:cause.message,code:cause.code??null}};}
 finally{try{vm.runInContext('nativeModel?.dispose()',context);}catch{}}
}

export async function generateNativeControllerOracle(){
 const bundle=await buildNativeBundle();
 const header={kind:'header',schema:'barochart.rust-core.native-controller-leaf',version:1,
  bundleSHA256:sha(bundle),sourceSHA256:Object.fromEntries(sources.map(path=>[path,sha(readFileSync(join(root,path)))])),
  node:process.version,v8:process.versions.v8,platform:`${process.platform}-${process.arch}`,icu:process.versions.icu,tzdata:process.versions.tz,
  seed:42,dialect:'ECMA-262/V8',encoding:'f64 bits; objects ordered entries',
  callSequence:['fresh node:vm','evaluate actual native bundle','nativeInit/nativeResize','nativePointer down/move','nativeCommand','capture live controller/model/effect state']};
 const rows=[header];for(const spec of cases)rows.push(await runCase(bundle,spec));
 return rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const mode=process.argv[2];if(process.argv.length>3||mode&&!['--check','--write'].includes(mode))throw new Error('Usage: node test/fixtures/rust-core-vectors/generate-native-controller.mjs [--check|--write]');
 const output=await generateNativeControllerOracle();
 if(mode==='--check'){
  if(readFileSync(fixture,'utf8')!==output)throw new Error('native-controller.leaf.jsonl is stale');
  console.log(`native controller oracle fresh: ${cases.length} cases`);
 }else if(mode==='--write'){
  writeFileSync(fixture,output);console.log(`native controller oracle wrote: ${cases.length} cases`);
 }else process.stdout.write(output);
}
