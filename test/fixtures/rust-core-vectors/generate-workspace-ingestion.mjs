#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {DataIngestion,restoreDataIngestion} from '../../../src/core/ingestion.mjs';
if(process.versions.node.split('.')[0]!=='22')throw new Error('Workspace ingestion oracle requires Node22');
const fixture=fileURLToPath(new URL('./workspace-ingestion.leaf.jsonl',import.meta.url));
const shape={length:2,capacity:16,maxBars:100,version:2};
const facade=s=>({disposed:false,dataIngestion:null,series:[],store:{...s,bytes:s.capacity*96}});
const model=facade(shape);model.dataIngestion=new DataIngestion(model,{streamId:'s',generation:7,maxQueuedEvents:8,maxQueuedBytes:392,maxStoreBytes:1536});
const valid=model.dataIngestion.save();
model.dataIngestion.enqueue({streamId:'s',generation:7,firstSequence:0,events:[{kind:'append',bar:{time:3000,open:3,high:4,low:2,close:3,volume:1}}]});
const pending=model.dataIngestion.save();
const inputs=[['valid',shape,valid],['budget',{...shape,capacity:32},valid],['pending',shape,pending],['shape',shape,'{}'],['text-type',shape,0]];
const rows=inputs.map(([id,shape,text])=>{const m=facade(shape);let candidate;try{if(typeof text!=='string'||text.length>32768)throw new RangeError('Native workspace ingestion document limit');candidate=restoreDataIngestion(m,text);m.dataIngestion=candidate;if(candidate.count)throw new TypeError('Native workspace pending ingestion');return{id,shape,text,canonical:candidate.save(),capacity:candidate.capacity};}catch(e){return{id,shape,text,error:{name:e.name,message:e.message,code:e.code??null}};}finally{candidate?.dispose();}});
const header={kind:'header',schema:'barochart.workspace-ingestion-shape',version:1,node:process.version,sourceSHA256:createHash('sha256').update(readFileSync(fileURLToPath(new URL('../../../src/core/ingestion.mjs',import.meta.url)))).digest('hex')};
const output=[header,...rows].map(row=>JSON.stringify(row)).join('\n')+'\n';
if(process.argv[2]==='--write'){writeFileSync(fixture,output);console.log('workspace ingestion shape cases',rows.length);}
else if(process.argv[2]==='--check'){if(readFileSync(fixture,'utf8')!==output)throw new Error('workspace ingestion fixture stale');console.log('workspace ingestion shape oracle fresh',rows.length);}
else process.stdout.write(output);
