#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {packNativeCommands} from '../../../src/renderers/native-command-packet.mjs';
if(process.versions.node.split('.')[0]!=='22')throw new Error('Native packet oracle requires Node22');
const fixture=fileURLToPath(new URL('./native-packet.leaf.jsonl',import.meta.url));
const source=fileURLToPath(new URL('../../../src/renderers/native-command-packet.mjs',import.meta.url));
const bits=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex');};
function encode(v){if(typeof v==='number')return{$f64:bits(v)};if(v===undefined)return{$undefined:true};if(v===null||typeof v!=='object')return v;if(Array.isArray(v))return v.map(encode);return{$object:Object.entries(v).map(([k,v])=>[k,encode(v)])};}
const layer=commands=>({commands});
const box={op:'box',x:1,y:-0,w:4,h:5,color:'red'};
const options={mode:'scene',width:400,height:300,background:'#000',stats:{storedBars:5,commandCount:6}};
const cases=[];
function add(id,layers,patch={}){const opts={...options,...patch};try{const out=packNativeCommands(layers,opts);cases.push({id,layers:encode(layers),options:encode(opts),metadata:out.metadata,numbers:Array.from(out.numbers,bits)});}catch(e){cases.push({id,layers:encode(layers),options:encode(opts),error:{name:e.name,message:e.message}});}}
add('all-six-ops',[layer([
 {op:'lines',coords:[-0,1,2,3],color:'red',width:-0,clip:[-0,2,4,6],dash:[1,2]},
 {op:'rects',coords:[1,2,3,4],color:'red'},
 {op:'path',points:[1,2,3,4],color:'blue',fill:'red',baseline:-0},
 box,{...box,op:'ellipse',fill:'blue'},
 {op:'text',x:1,y:2,text:'한글🙂\ud800',font:'13px serif',color:'red'},
])]);
add('empty-scene',[layer([])],{stats:undefined,width:-0,height:0});
add('frame-null-base',[null,layer([]),layer([{op:'text',x:1,y:2,text:'a',font:null,color:'red'}])],{mode:'frame'});
add('frame-all-layers',[layer([box]),layer([box]),layer([])],{mode:'frame'});
add('bad-mode-before-size',[layer([])],{mode:'other',width:NaN});
add('null-last-before-size',[null],{width:NaN});
add('finite-width',[layer([])],{width:'400'});
add('finite-height',[layer([])],{height:Infinity});
add('background-string',[layer([])],{background:0});
add('commands-array',[{}]);
add('unsupported-op',[layer([{...box,op:'__proto__'}])]);
add('color-before-stroke',[layer([{...box,color:0,width:-1}])]);
add('stroke-type',[layer([{...box,width:false}])]);
add('stroke-negative',[layer([{...box,width:-1}])]);
add('clip-type',[layer([{...box,clip:false}])]);
add('clip-arity',[layer([{...box,clip:[]}])]);
add('clip-finite-before-dash',[layer([{...box,clip:[NaN,0,1,1],dash:[]}])]);
add('dash-empty',[layer([{...box,dash:[]}])]);
add('fill-before-geometry',[layer([{...box,fill:0,x:NaN}])]);
add('area-baseline',[layer([{op:'path',points:[],color:'red',fill:'red'}])]);
add('text-before-font',[layer([{op:'text',x:1,y:2,color:'red',text:0,font:0}])]);
add('font-string',[layer([{op:'text',x:1,y:2,color:'red',text:'a',font:0}])]);
add('geometry-arity',[layer([{op:'lines',coords:[1],color:'red'}])]);
add('headers-before-earlier-geometry',[layer([{...box,x:NaN},{...box,color:0}])]);
add('dash-positive',[layer([{...box,dash:[0,1]}])]);
add('geometry-finite',[layer([{...box,x:NaN}])]);
const header={kind:'header',schema:'barochart.rust.native-packet',version:1,oracleCommit:'80b404d92edeadf6e39c8eb243327eaf4dd25f3a',sourceSHA256:createHash('sha256').update(readFileSync(source)).digest('hex'),node:process.version,v8:process.versions.v8};
const output=[header,...cases].map(x=>JSON.stringify(x)).join('\n')+'\n';
if(process.argv[2]==='--write'){writeFileSync(fixture,output);console.log('native packet source cases',cases.length);}
else if(process.argv[2]==='--check'){if(readFileSync(fixture,'utf8')!==output)throw new Error('native packet fixture stale');console.log('native packet source fresh',cases.length);}
else process.stdout.write(output);
