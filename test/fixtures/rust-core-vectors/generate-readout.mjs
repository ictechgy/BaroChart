#!/usr/bin/env node
import {writeFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {buildNativeBundle} from '../../../scripts/native-core-bundle.mjs';
if(process.versions.node.split('.')[0]!=='22')throw new Error('Readout oracle requires Node22');
const path=fileURLToPath(new URL('./readout.leaf.jsonl',import.meta.url));
const bits=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex');};
function encode(v){if(typeof v==='number')return{$f64:bits(v)};if(v===undefined)return{$undefined:true};if(v===null||typeof v!=='object')return v;if(Array.isArray(v))return v.map(encode);return{$object:Object.entries(v).map(([k,v])=>[k,encode(v)])};}
const options={axes:[{id:'secondary',panel:'price',side:'left',range:[0,1000]}],series:[{id:'price',type:'candles',panel:'price'},{id:'external',type:'line',panel:'price',axisId:'secondary',values:[1,null,3,4,5,6,7,8],symbolId:'B'}]};
const context=vm.createContext({});vm.runInContext(await buildNativeBundle(),context);vm.runInContext(`nativeInit(8,${JSON.stringify(options)});nativeCommand('addIndicator',['ema','ema',{period:2}]);nativeCommand('addSeries',[{id:'ema-line',type:'line',panel:'price',indicator:'ema'}]);nativeCommand('setVisibleRange',[-.5,7.5]);nativeResize(400,300);`,context);
const rows=[];for(const mode of ['free','close','ohlc']){vm.runInContext(`nativeCommand('setCrosshairSnap',[{mode:${JSON.stringify(mode)}}]);nativePointer('move',1,100,120);`,context);rows.push({mode,options,result:encode(vm.runInContext(`({snapshot:nativeCommand('crosshairSnapshot',[400,300]),values:nativeCommand('crosshairValues',[400,300]),accessibility:nativeAccessibility(false),android:nativeAccessibilityText(false,'android'),uikit:nativeAccessibilityText(false,'uikit')})`,context))});}
if(rows.some(row=>JSON.stringify(row.result).includes('\"values\",null')))throw new Error('readout cases must exercise real data');
const output=[{kind:'header',schema:'barochart.readout',version:1,node:process.version},...rows].map(v=>JSON.stringify(v)).join('\n')+'\n';
if(process.argv[2]==='--write'){writeFileSync(path,output);console.log('readout source cases',rows.length);}else if(process.argv[2]==='--check'){if(readFileSync(path,'utf8')!==output)throw new Error('readout fixture stale');console.log('readout oracle fresh',rows.length);}else process.stdout.write(output);
