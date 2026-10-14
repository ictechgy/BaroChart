import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import vm from 'node:vm';
export const CORE_MODULES=['contracts','labels','data','store-owners','block-index','markets','resample-plan','resample','indicator-params','indicator-modules','trusted-studies','session-studies','indicators','drawing-validation','drawings','scene-parts','model','scene','frame-cache','interaction','checkpoint-validation','native-checkpoints','ingestion-error','ingestion','study-setup','data-explorer','compaction','drawing-translation','api','workspace','native-workspace','async-state','prepare-state','native-workspace-target','native-workspace-source','native-params-target','native-params-import','native-params-source','async-ui'];
const bundleRoot=resolve(import.meta.dirname,'..');
export async function buildNativeBundle({modulePaths=[]}={}){
 const names=[],chunks=[];
 for(const file of CORE_MODULES){let source=await readFile(resolve(bundleRoot,`src/core/${file}.mjs`),'utf8');for(const match of source.matchAll(/export (?:class|function|const) (\w+)/g))if(!['store-owners','compaction','drawing-translation'].includes(file)&&!['ownedCheckpointClear','prepareNativeEntryCommit','retireNativeEntryIfReplaced','retireNativeEntriesAfterClear'].includes(match[1]))names.push(match[1]);source=source.replace(/^import .*;\n/gm,'').replace(/^export \{.*\} from .*;\n/gm,'').replace(/export (?=class|function|const)/g,'');chunks.push(source);}
 // Native renderer transport stays outside the DOM-free calculation exports.
 chunks.push((await readFile(resolve(bundleRoot,'src/renderers/native-command-packet.mjs'),'utf8')).replace(/export (?=class|function|const)/g,''));
 // Deliberately small build contract: self-contained, locally selected modules
 // may import this SDK declaration helper only. No dependency fetching or
 // source strings from chart data/settings are involved.
 const linked=[];
 for(const path of modulePaths){const file=resolve(path);let source=await readFile(file,'utf8');const lines=[...source.matchAll(/^import\s*\{\s*defineIndicatorModule\s*\}\s*from\s*(['"])([^'"\n]+)\1;?\s*$/gm)];
  if(lines.length!==1||!lines[0][2].startsWith('.')||resolve(dirname(file),lines[0][2])!==resolve(bundleRoot,'src/core/indicator-modules.mjs'))throw new TypeError('Native module requires one local defineIndicatorModule import');
  source=source.replace(lines[0][0],'');if(/\b(?:import|export)\b/.test(source))throw new TypeError('Native module has unsupported import/export syntax');
  new vm.Script('(function(){'+source+'\n})();',{filename:file});linked.push('(function(){'+source+'\n})();');
 }
 const bridge=(await readFile(resolve(bundleRoot,'examples/native/bridge.mjs'),'utf8'))+'\n'+(await readFile(resolve(bundleRoot,'examples/native/params-bridge.mjs'),'utf8'));const text=`// Generated from src/core; run npm run build:native.\n(function(){\n${chunks.join('\n')}\n${linked.length?linked.join('\n')+'\n':''}globalThis.Aster={${names.join(',')}};\n${bridge}\n})();`;
 new vm.Script(text,{filename:'aster-core.js'});return text;
}
