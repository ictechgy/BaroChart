// Node 22 oracle for study documents and synchronous indicator params replacement.
// Usage: ~/.nvm/versions/node/v22.20.0/bin/node test/fixtures/rust-indicators/generate-study-setup.mjs [--check]
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {BarStore,ChartModel,ChartAPI} from '../../../src/core/index.mjs';
import {safeCheckpointStringify} from '../../../src/core/checkpoint-validation.mjs';

const directory=fileURLToPath(new URL('.',import.meta.url)),root=new URL('../../../',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('../rust-core-vectors/manifest.json',import.meta.url),'utf8'));
const hash=async path=>createHash('sha256').update(await readFile(new URL(path,root))).digest('hex');
const bars=(closes=[10,11,11,9,12,8,13,10])=>closes.map((close,index)=>({time:1700000000000+index*60000,open:close,high:close+1,low:close-1,close,volume:index+5}));
const model=(rows=bars())=>{const value=new ChartModel({store:new BarStore(rows)});return {model:value,api:new ChartAPI(value)};};
const values=(engine,id)=>Object.fromEntries(Object.entries(engine.get(id).outputs).map(([name,array])=>[name,safeCheckpointStringify([...array])]));
const outcome=run=>{try{return {value:run()};}catch(error){return {error:{name:error.name,message:error.message,code:error.code??null}};}};
const addCore=(target)=>{
 target.api.addIndicator('average','sma',{unknown:-0,period:3});
 target.api.addIndicator('pressure','aster.volume-direction@1/pressure',{factor:.5,shift:-0});
 target.api.addSeries({id:'mean-line',type:'line',panel:'price',indicator:'average',output:'value',color:'#345678',width:3,visible:false,label:'평균 🚀'});
 target.api.addSeries({id:'pressure-bars',type:'histogram',panel:'price',indicator:'pressure',output:'cumulative',color:'#abcdef',fill:'#123456',baseline:0,offset:-0});
};

const rows=[];
const source=model();addCore(source);const saved=source.api.saveStudies();
rows.push({suite:'save',name:'portable-ordered-module',text:saved,entryOrder:[...source.model.indicators.entries.keys()],seriesOrder:source.model.series.map(series=>series.id),values:{average:values(source.model.indicators,'average'),pressure:values(source.model.indicators,'pressure')}});

const target=model(bars([30,29,33,32,35,36,31,34]));target.api.addIndicator('existing','ema',{period:2});target.api.addSeries({id:'existing-line',type:'line',panel:'price',indicator:'existing'});const loadReceipt=target.api.loadStudies(saved);
rows.push({suite:'load',name:'additive-target-data',receipt:loadReceipt,text:target.api.saveStudies(),entryOrder:[...target.model.indicators.entries.keys()],seriesOrder:target.model.series.map(series=>series.id),values:{average:values(target.model.indicators,'average'),pressure:values(target.model.indicators,'pressure')}});

const paramsModel=model();paramsModel.api.addIndicator('ema','ema',{period:5});paramsModel.api.addSeries({id:'ema-line',type:'line',panel:'price',indicator:'ema',color:'#123456'});const held=[...paramsModel.model.indicators.get('ema').outputs.value],paramsReceipt=paramsModel.api.setIndicatorParams('ema',{unknown:-0,period:2});
rows.push({suite:'params',name:'success',receiptLossless:safeCheckpointStringify(paramsReceipt),paramsLossless:safeCheckpointStringify(paramsModel.model.indicators.entries.get('ema').params),heldLossless:safeCheckpointStringify(held),values:values(paramsModel.model.indicators,'ema'),text:paramsModel.api.saveStudies()});
const noOpEntry=paramsModel.model.indicators.entries.get('ema'),noOpReceipt=paramsModel.api.setIndicatorParams('ema',{period:2,unknown:-0});
rows.push({suite:'params',name:'no-op',receiptLossless:safeCheckpointStringify(noOpReceipt),sameEntry:paramsModel.model.indicators.entries.get('ema')===noOpEntry});
const last=paramsModel.model.store.at(paramsModel.model.store.length-1);paramsModel.model.store.append({...last,time:last.time+60000,close:last.close+1,high:last.high+1});const fresh=model([...bars(),{...last,time:last.time+60000,close:last.close+1,high:last.high+1}]);fresh.api.addIndicator('ema','ema',{unknown:-0,period:2});
rows.push({suite:'params',name:'next-append-equivalence',actual:values(paramsModel.model.indicators,'ema'),expected:values(fresh.model.indicators,'ema')});

const failureCases=[
 ['vwap-schema','vwap',{}, {source:'hlc3',deviation:2}],
 ['ichimoku-offset','ichimoku',{displacement:26},{displacement:27}],
 ['keltner-output','keltner',{period:1,atrPeriod:1,multiplier:1},{period:1,atrPeriod:1,multiplier:Number.MAX_VALUE}],
];
for(const [name,indicator,beforeParams,next] of failureCases){const value=model();value.api.addIndicator('target',indicator,beforeParams);const entry=value.model.indicators.entries.get('target'),before=values(value.model.indicators,'target'),result=outcome(()=>value.api.setIndicatorParams('target',next));rows.push({suite:'params-failure',name,result,sameEntry:value.model.indicators.entries.get('target')===entry,before,after:values(value.model.indicators,'target')});value.model.dispose();}

const base=()=>({schema:'aster.studies',version:1,indicators:[{id:'incoming',name:'sma',params:{period:3}}],series:[{id:'incoming-line',type:'line',panel:'price',indicator:'incoming',output:'value'}]});
const invalid=[
 ['wrong-schema',doc=>doc.schema='wrong'],['duplicate-id',doc=>doc.indicators.push({...doc.indicators[0]})],
 ['missing-output',doc=>doc.series[0].output='missing'],['builtin-module',doc=>doc.indicators[0].module={id:'x',version:1,stateVersion:1,exportName:'x',causal:true}],
 ['unknown-factory',doc=>doc.indicators[0].name='custom.missing@1/x'],
];
for(const [name,mutate] of invalid){const value=model();const doc=base();mutate(doc);rows.push({suite:'load-failure',name,result:outcome(()=>value.api.loadStudies(JSON.stringify(doc))),entryCount:value.model.indicators.entries.size,seriesCount:value.model.series.length});value.model.dispose();}

for(const value of [source,target,paramsModel,fresh])value.model.dispose();
const metadata={schema:'aster.rust-study-setup-oracle',version:1,oracleCommit:manifest.oracleCommit,bundleSha256:await hash('native/Resources/aster-core.js'),studySourceSha256:await hash('src/core/study-setup.mjs'),paramsSourceSha256:await hash('src/core/indicator-params.mjs'),seed:20261104,dialect:'Ecma',runtime:{node:process.version,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,tz:process.versions.tz,platform:process.platform,arch:process.arch}};
const text=[{metadata},...rows].map(row=>JSON.stringify(row)).join('\n')+'\n',path=directory+'study-setup-oracle.jsonl';
if(process.argv.includes('--check')){const stored=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse),current=text.trim().split('\n').map(JSON.parse);current[0].metadata.runtime=stored[0].metadata.runtime;if(JSON.stringify(current)!==JSON.stringify(stored))throw new Error('Study setup vectors are stale');}else await writeFile(path,text);
process.stdout.write(`Study setup oracle: ${rows.length} sequences\n`);
