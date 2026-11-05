#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {validateIndicatorParams} from '../../../src/core/indicator-params.mjs';
import {builtinIndicators} from '../../../src/core/indicators.mjs';
import {portableSessionCalendar} from '../../../src/core/session-studies.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=join(root,'test/fixtures/rust-indicators/session-oracle.jsonl');
const ORACLE=Object.freeze({kind:'header',schema:'barochart.rust-indicators.session-oracle',version:1,
 oracleCommit:'bf851d9fda8547180207de165c46ff8dc7c09b1b',localRustWorkspace:'f6831d5c56c2b0b1427d46c27227099ed0b09248',
 bundleSHA256:'007ac99f8553b5912ef0c32ec392b5d30d196daf97bb17181c183004258ef512',
 sessionStudiesSHA256:'caacda71303a687535b6ecfa9b06c6742adbf8543c7c09a400cc6f59cd4ce7c4',
 marketsSHA256:'605de3d5a787145980b832022fbb06318bb3db65a0ec9e89933c9365ef847cf5',
 indicatorParamsSHA256:'fb323f348b5204e39c85e31f5a88fd1b0ab08af71d2ae81fa04f820a0bd96519',
 seed:'session-v1-fixed',dialect:'ECMA-262/V8+Intl',node:'v22.20.0',v8:'12.4.254.21-node.33',
 platform:'darwin-arm64',icu:'77.1',tzdata:'2025b',
 callSequence:['validateIndicatorParams','builtinFactory','create','restore?','snapshot','step+snapshot*'],
 encoding:'f64 big-endian bits; objects as ordered entry arrays'});
const bytes=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
function verifySources(){for(const [path,key] of [['native/Resources/aster-core.js','bundleSHA256'],['src/core/session-studies.mjs','sessionStudiesSHA256'],['src/core/markets.mjs','marketsSHA256'],['src/core/indicator-params.mjs','indicatorParamsSHA256']])if(bytes(join(root,path))!==ORACLE[key])throw new Error(`session oracle source hash changed: ${path}`);}
const buffer=new ArrayBuffer(8),view=new DataView(buffer);
function f64(value){view.setFloat64(0,value,false);return view.getBigUint64(0,false).toString(16).padStart(16,'0');}
function encode(value){if(typeof value==='number')return{$f64:f64(value)};if(typeof value==='string'||typeof value==='boolean'||value===null)return value;if(Array.isArray(value))return value.map(encode);if(value&&typeof value==='object')return{$object:Object.entries(value).map(([key,child])=>[key,encode(child)])};if(value===undefined)return{$undefined:true};throw new TypeError('Unsupported session oracle value');}
const calendarText=options=>JSON.stringify(options);
const calendar=options=>portableSessionCalendar(options);
const fixed=calendar({timezone:'+09:00',weekdays:[1,2,3,4,5],windows:[{open:'09:00',close:'15:00',kind:'regular'},{open:'16:00',close:'18:00',kind:'after'}],exceptions:{'2024-01-01':[{open:'10:00',close:'12:00',kind:'regular'}]},ambiguity:'earlier'});
const nyEarlier=calendar({timezone:'America/New_York',weekdays:[0],windows:[{open:'01:30',close:'02:30',kind:'regular'}],ambiguity:'earlier'});
const nyLater=calendar({timezone:'America/New_York',weekdays:[0],windows:[{open:'01:30',close:'02:30',kind:'regular'}],ambiguity:'later'});
const nyReject=calendar({timezone:'America/New_York',weekdays:[0],windows:[{open:'01:30',close:'02:30',kind:'regular'}],ambiguity:'reject'});
const nyGap=calendar({timezone:'America/New_York',weekdays:[0],windows:[{open:'02:30',close:'03:30',kind:'regular'}],ambiguity:'earlier'});
const santiagoGap=calendar({timezone:'America/Santiago',weekdays:[0],windows:[{open:'00:00',close:'02:00',kind:'regular'}],ambiguity:'earlier'});
const santiagoValid=calendar({timezone:'America/Santiago',weekdays:[0],windows:[{open:'01:00',close:'03:00',kind:'regular'}],ambiguity:'earlier'});
function bar(iso,open,high,low,close,volume){return{time:Date.parse(iso),open,high,low,close,volume};}
const cases=[
 {id:'vwap-legacy',program:'vwap',params:{},bars:[bar('2024-01-01T00:00:00Z',10,12,8,11,2),bar('2024-01-01T01:00:00Z',11,13,9,12,0),bar('2024-01-02T00:00:00Z',20,22,18,21,3)]},
 {id:'vwap-legacy-restored-negzero',program:'vwap',params:{sessionMs:3600000},restore:Object.fromEntries([['v',2],['session',-0],['pv',20]]),bars:[bar('1970-01-01T00:30:00Z',10,10,10,10,1)]},
 {id:'pivots-legacy',program:'pivots',params:{sessionMs:3600000},bars:[bar('2024-01-01T00:10:00Z',10,12,8,11,1),bar('2024-01-01T00:20:00Z',11,14,7,12,1),bar('2024-01-01T01:10:00Z',13,15,10,14,1)]},
 {id:'vwap-explicit-source',program:'vwap',params:{source:'close'},bars:[bar('2024-01-01T00:00:00Z',10,12,8,11,2),bar('2024-01-01T01:00:00Z',11,13,9,12,3)]},
 {id:'vwap-bands-hour',program:'vwap',params:{sessionMs:3600000,source:'hl2',deviation:2},bars:[bar('2024-01-01T00:10:00Z',10,12,8,11,2),bar('2024-01-01T00:20:00Z',12,14,10,13,3),bar('2024-01-01T01:10:00Z',20,22,18,21,1)]},
 {id:'vwap-anchor',program:'vwap',params:{anchorTime:Date.parse('2024-01-01T00:30:00Z'),source:'ohlc4'},bars:[bar('2024-01-01T00:00:00Z',10,12,8,11,1),bar('2024-01-01T00:30:00Z',12,14,10,13,2)]},
 {id:'vwap-fixed-calendar-exception-kinds',program:'vwap',params:{calendar:fixed,kinds:'regular',source:'ohlc4',deviation:1},bars:[bar('2024-01-01T00:30:00Z',10,12,8,11,1),bar('2024-01-01T01:30:00Z',12,14,10,13,2),bar('2024-01-01T04:00:00Z',20,22,18,21,1)]},
 {id:'pivots-fixed-calendar',program:'pivots',params:{calendar:fixed,kinds:'regular'},bars:[bar('2024-01-01T01:10:00Z',10,12,8,11,1),bar('2024-01-01T02:10:00Z',11,14,7,12,1),bar('2024-01-02T00:10:00Z',13,15,10,14,1)]},
 {id:'vwap-ny-fold-earlier',program:'vwap',params:{calendar:nyEarlier,source:'close'},bars:[bar('2024-11-03T05:45:00Z',10,10,10,10,1),bar('2024-11-03T06:45:00Z',20,20,20,20,1)]},
 {id:'vwap-ny-fold-later',program:'vwap',params:{calendar:nyLater,source:'close'},bars:[bar('2024-11-03T05:45:00Z',10,10,10,10,1),bar('2024-11-03T06:45:00Z',20,20,20,20,1)]},
 {id:'vwap-santiago-valid-boundary',program:'vwap',params:{calendar:santiagoValid,source:'close'},bars:[bar('2024-09-08T03:30:00Z',10,10,10,10,1),bar('2024-09-08T04:30:00Z',20,20,20,20,1)]},
 {id:'vwap-ny-gap-error',program:'vwap',params:{calendar:nyGap,source:'close'},bars:[bar('2024-03-10T07:30:00Z',10,10,10,10,1)]},
 {id:'vwap-ny-fold-reject-error',program:'vwap',params:{calendar:nyReject,source:'close'},bars:[bar('2024-11-03T06:45:00Z',10,10,10,10,1)]},
 {id:'vwap-santiago-gap-error',program:'vwap',params:{calendar:santiagoGap,source:'close'},bars:[bar('2024-09-08T04:30:00Z',10,10,10,10,1)]},
 {id:'vwap-overflow-error',program:'vwap',params:{source:'close',deviation:1},bars:[bar('2024-01-01T00:00:00Z',Number.MAX_VALUE,Number.MAX_VALUE,Number.MAX_VALUE,Number.MAX_VALUE,2)]},
 {id:'pivots-invalid-ohlc-error',program:'pivots',params:{calendar:fixed},bars:[bar('2024-01-01T01:00:00Z',10,8,9,10,1)]},
];
const errors=[
 {id:'calendar-json',program:'vwap',params:{calendar:'{' }},
 {id:'calendar-missing-timezone',program:'vwap',params:{calendar:calendarText({weekdays:[1],windows:[]})}},
 {id:'calendar-bad-zone',program:'vwap',params:{calendar:calendarText({timezone:'Nope',weekdays:[1],windows:[]})}},
 {id:'calendar-duplicate-weekday',program:'vwap',params:{calendar:calendarText({timezone:'+00:00',weekdays:[1,1],windows:[]})}},
 {id:'calendar-overlap-window',program:'vwap',params:{calendar:calendarText({timezone:'+00:00',weekdays:[1],windows:[{open:'09:00',close:'12:00'},{open:'11:00',close:'13:00'}]})}},
 {id:'calendar-kind-space',program:'vwap',params:{calendar:calendarText({timezone:'+00:00',weekdays:[1],windows:[{open:'09:00',close:'12:00',kind:' regular'}]})}},
 {id:'calendar-clock-type',program:'vwap',params:{calendar:calendarText({timezone:'+00:00',weekdays:[1],windows:[{open:900,close:'12:00'}]})}},
 {id:'calendar-exceptions-null',program:'vwap',params:{calendar:calendarText({timezone:'+00:00',weekdays:[1],windows:[],exceptions:null})}},
 {id:'calendar-bad-exception-date',program:'vwap',params:{calendar:calendarText({timezone:'+00:00',weekdays:[1],windows:[],exceptions:{'2024-02-30':[]}})}},
 {id:'calendar-bad-ambiguity',program:'vwap',params:{calendar:calendarText({timezone:'+00:00',weekdays:[1],windows:[],ambiguity:'middle'})}},
 {id:'calendar-session-conflict',program:'vwap',params:{calendar:fixed,sessionMs:1000}},
 {id:'pivots-anchor',program:'pivots',params:{anchorTime:0}},
 {id:'kinds-without-calendar',program:'vwap',params:{kinds:'regular'}},
 {id:'vwap-source',program:'vwap',params:{source:'median'}},
 {id:'vwap-deviation',program:'vwap',params:{deviation:-1}},
 {id:'session-duration',program:'pivots',params:{sessionMs:0}},
];
function generate(spec){validateIndicatorParams(spec.params);const def=builtinIndicators.get(spec.program)(spec.params),instance=def.create();if(spec.restore!==undefined)instance.restore(spec.restore);const frames=[{index:null,output:null,snapshot:encode(instance.snapshot())}];for(let index=0;index<spec.bars.length;index++){try{const output=instance.step(spec.bars[index],index);frames.push({index,output:output.map(f64),snapshot:encode(instance.snapshot())});}catch(error){frames.push({index,error:{name:error.name,message:error.message},snapshot:encode(instance.snapshot())});break;}}return{kind:'case',id:spec.id,program:spec.program,params:encode(spec.params),outputs:def.outputs,plotOffsets:encode(def.plotOffsets),bars:spec.bars.map(row=>[row.time,row.open,row.high,row.low,row.close,row.volume].map(f64)),restore:spec.restore===undefined?null:encode(spec.restore),frames};}
function generateError(spec){try{validateIndicatorParams(spec.params);builtinIndicators.get(spec.program)(spec.params);throw new Error(`Expected create error: ${spec.id}`);}catch(error){if(error.message===`Expected create error: ${spec.id}`)throw error;return{kind:'create-error',id:spec.id,program:spec.program,params:encode(spec.params),error:{name:error.name,message:error.message}};}}
export function generateSessionOracle(){verifySources();return[JSON.stringify(ORACLE),...cases.map(row=>JSON.stringify(generate(row))),...errors.map(row=>JSON.stringify(generateError(row)))].join('\n')+'\n';}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const mode=process.argv[2];if(process.argv.length>3||mode&&mode!=='--check')throw new Error('Usage: node test/fixtures/rust-indicators/generate-session.mjs [--check]');const output=generateSessionOracle();if(mode==='--check'){if(readFileSync(fixture,'utf8')!==output)throw new Error('session-oracle.jsonl is stale');console.log(`session oracle fresh: ${cases.length} cases, ${errors.length} create errors`);}else process.stdout.write(output);}
