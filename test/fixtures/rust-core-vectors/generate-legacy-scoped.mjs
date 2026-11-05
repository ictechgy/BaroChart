import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createJavaScriptOracle} from '../../../scripts/rust/core-conformance.mjs';
import {stringifyLossless} from '../../../scripts/trace/bcjson.mjs';

assert.ok(process.version.startsWith('v22.'));
const manifest=JSON.parse(await readFile(new URL('manifest.json',import.meta.url),'utf8'));
const metadata={schema:'aster.rust-core-vectors',version:1,oracleCommit:manifest.oracleCommit,bundleSha256:manifest.bundleSha256,seed:42,dialect:'Ecma',runtime:{node:process.version,v8:process.versions.v8,icu:process.versions.icu,tz:process.versions.tz,platform:process.platform,arch:process.arch},scope:'legacy receiver/error order, borrowed arguments and direct model versus API semantics'};
const oracle=await createJavaScriptOracle(),calls=[];
function call(name,args){const result=oracle.call(name,args);calls.push({name,arguments:stringifyLossless(args),expected:stringifyLossless(result)});return result.value;}
for(const [name,args]of [
 ['nativeView',[0,8]],['nativeAddPanel',[{id:'other'}]],['nativeSetPanel',['other',{}]],['nativeRemoveSeries',['missing']],
 ['nativeLoad',['{}']],['nativeFit',[]],['nativeSave',[]],['nativeTheme',[{}]],['nativeThemeFont',[]],
])call(name,args);
call('nativeInit',[16,{}]);
call('nativeAddPanel',[{id:'other',weight:1},'ignored']);
call('nativeSetPanel',['other',{weight:2},'ignored']);
call('nativeSetPanel',['other',{range:null}]);
call('nativeView',[0,8,'ignored']);
call('nativeRemoveSeries',['missing','ignored']);
call('nativeAddSeries',[{id:'price-copy',type:'candles',panel:'price'}]);
const document=call('nativeSave',[]);
call('nativeLoad',[document,'ignored']);
call('nativeTheme',[{font:'13px monospace'}]);
call('nativeThemeFont',[]);
call('nativeFit',[]);
call('nativeInspect',[]);
const output=JSON.stringify({metadata,suite:'legacy-scoped',name:'legacy-receivers-raw-model-patches-and-roundtrip',calls})+'\n';
const path=new URL('legacy-scoped.jsonl',import.meta.url);
if(process.argv.includes('--check'))assert.equal(await readFile(path,'utf8'),output);else await writeFile(path,output);
console.log(`Legacy native oracle: ${calls.length} calls`);
