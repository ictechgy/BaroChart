// Generates the checked-in checkpoint oracle from the current public JS factory table.
// Usage: node test/fixtures/rust-indicators/generate-checkpoints.mjs
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {builtinIndicators} from '../../../src/core/indicators.mjs';
import {FIELDS,seededColumns} from '../../../src/core/data.mjs';
import {safeCheckpointStringify} from '../../../src/core/checkpoint-validation.mjs';

const root=new URL('../../../',import.meta.url);
const hash=async path=>createHash('sha256').update(await readFile(new URL(path,root))).digest('hex');
console.log(JSON.stringify({
 schema:'barochart.rust-checkpoint-oracle',version:1,
 oracleCommit:'bf851d9fda8547180207de165c46ff8dc7c09b1b',
 rustBaseCommit:'f6831d5c56c2b0b1427d46c27227099ed0b09248',
 bundleSha256:await hash('native/Resources/aster-core.js'),
 sourceSha256:await hash('src/core/checkpoint-validation.mjs'),
 indicatorSourceSha256:await hash('src/core/indicators.mjs'),
 seed:77,index:3,numberDialect:'Ecma',platform:'darwin-arm64',
 runtime:{node:process.version,v8:process.versions.v8,unicode:process.versions.unicode},
 icu:process.versions.icu??null,tzdata:process.versions.tz??null,
}));
const columns=seededColumns(3,77),bar={};
for(const [name,factory] of builtinIndicators){
 const instance=factory({}).create();
 for(let index=0;index<3;index++){for(const key of FIELDS)bar[key]=columns[key][index];instance.step(bar,index);}
 console.log(JSON.stringify({name,index:3,stateLossless:safeCheckpointStringify(instance.snapshot())}));
}
