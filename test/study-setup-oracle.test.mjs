import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/core/index.mjs';

const moduleName='aster.volume-direction@1/pressure';
const bars=(closes=[10,11,11,9,12,8,13,10])=>closes.map((close,i)=>({time:1700000000000+i*60000,open:close,high:close+1,low:close-1,close,volume:i+5}));
function fixture(t,input=bars()) {
 const model=new A.ChartModel();let invalidations=0;
 const api=new A.ChartAPI(model,{invalidate:()=>invalidations++});
 t.after(()=>model.dispose());api.setData(input);
 return {model,api,invalidations:()=>invalidations};
}
function requireStudies(api) {
 assert.equal(typeof api.saveStudies,'function','public study-save contract is required');
 assert.equal(typeof api.loadStudies,'function','public atomic study-load contract is required');
}
function baseDocument() {
 return {schema:'aster.studies',version:1,
  indicators:[{id:'incoming',name:'sma',params:{period:3}}],
  series:[{id:'incoming-line',type:'line',panel:'price',indicator:'incoming',output:'value',color:'#123456ff',width:2,offset:0}],
 };
}
function currentState(f) {
 const {model,api}=f;
 const values=[...model.indicators.entries].map(([id])=>[id,Object.fromEntries(Object.keys(model.indicators.get(id).outputs).map(output=>[output,api.indicatorValues(id,output)]))]);
 return {store:model.store,version:model.store.version,entries:model.indicators.entries,entryRefs:[...model.indicators.entries],series:model.series,seriesRefs:[...model.series],listeners:[...model.store.listeners],inspect:api.inspect(),values,invalidations:f.invalidations()};
}
function unchanged(f,before,label) {
 const {model,api}=f;
 assert.equal(model.store,before.store,label+' store identity');assert.equal(model.store.version,before.version,label+' store version');
 assert.equal(model.indicators.entries,before.entries,label+' entries map identity');
 assert.deepEqual([...model.indicators.entries.keys()],before.entryRefs.map(([id])=>id),label+' indicator IDs');
 for(const [id,entry] of before.entryRefs)assert.equal(model.indicators.entries.get(id),entry,label+' prior entry '+id);
 assert.equal(model.series,before.series,label+' series array identity');
 assert.equal(model.series.length,before.seriesRefs.length,label+' series length');
 before.seriesRefs.forEach((series,i)=>assert.equal(model.series[i],series,label+' prior series '+series.id));
 assert.deepEqual([...model.store.listeners],before.listeners,label+' temporary subscriptions released');
 assert.deepEqual(api.inspect(),before.inspect,label+' public state');
 for(const [id,outputs] of before.values)for(const [output,values] of Object.entries(outputs))assert.deepEqual(api.indicatorValues(id,output),values,label+' retained output');
 assert.equal(f.invalidations(),before.invalidations,label+' rejection does not publish');
}
function occupied(t) {
 const f=fixture(t);requireStudies(f.api);
 f.api.addIndicator('existing','ema',{period:2});
 f.api.addSeries({id:'existing-line',type:'line',panel:'price',indicator:'existing',color:'#abcdef'});
 f.api.addSeries({id:'external',type:'line',panel:'price',values:Array(8).fill(23)});
 return f;
}
function rejectAtomically(f,document,label) {
 const before=currentState(f);
 assert.throws(()=>f.api.loadStudies(typeof document==='string'?document:JSON.stringify(document)),undefined,label);
 unchanged(f,before,label);
}
const pressure=(input,factor)=>{let cumulative=0;return input.map((bar,i)=>cumulative+=(i?Math.sign(bar.close-input[i-1].close)*bar.volume:0)*factor);};
const sma=(input,period)=>input.map((_,i)=>i<period-1?null:input.slice(i-period+1,i+1).reduce((sum,b)=>sum+b.close,0)/period);

test('saveStudies is a study-only public-style snapshot with exact module metadata',t=>{
 const f=fixture(t),{api,model}=f;requireStudies(api);
 assert.equal(typeof api.registerIndicatorModule,'function');assert.deepEqual(api.registerIndicatorModule('aster.volume-direction',1),[moduleName]);
 api.addPanel({id:'osc',weight:1});api.addAxis({id:'volume-axis',panel:'osc',side:'left'});
 api.addIndicator('average','sma',{period:3});api.addIndicator('pressure',moduleName,{factor:.5,shift:2});
 api.addSeries({id:'price-candles',type:'candles',panel:'price'});
 api.addSeries({id:'external',type:'line',panel:'price',values:Array(8).fill(999)});
 api.addSeries({id:'mean-line',type:'line',panel:'price',indicator:'average',output:'value',color:'#345678',width:3,visible:false,label:'average'});
 api.addSeries({id:'pressure-bars',type:'histogram',panel:'osc',axisId:'volume-axis',indicator:'pressure',output:'cumulative',color:'#abcdef',fill:'#123456',baseline:0,offset:-2});
 api.addDrawing({type:'text',panel:'price',points:[{time:model.store.at(0).time,price:10}],text:'not a study'});
 const text=api.saveStudies();assert.equal(typeof text,'string');const doc=JSON.parse(text);
 assert.deepEqual(Object.keys(doc).sort(),['indicators','schema','series','version']);assert.equal(doc.schema,'aster.studies');assert.equal(doc.version,1);
 assert.deepEqual(doc.indicators,[{id:'average',name:'sma',params:{period:3}},{id:'pressure',name:moduleName,params:{factor:.5,shift:2},module:{id:'aster.volume-direction',version:1,stateVersion:1,exportName:'pressure',causal:true}}]);
 assert.deepEqual(doc.series.map(s=>s.id),['mean-line','pressure-bars']);
 const publicSeries=api.inspect().series.filter(s=>s.indicator);
 assert.deepEqual(doc.series,publicSeries);
 for(const series of doc.series)for(const [key,value] of Object.entries(series)) {
  assert.ok(['id','type','panel','indicator','output','color','fill','width','baseline','offset','upColor','downColor','visible','axisId','label'].includes(key),'portable series key '+key);
  assert.equal(Array.isArray(value),false,'no output/data arrays in study series');
 }
});

test('loadStudies atomically merges new studies and recomputes against target data while preserving existing owners',t=>{
 const source=fixture(t),target=occupied(t),{api}=source;requireStudies(api);
 api.registerIndicatorModule('aster.volume-direction',1);api.addIndicator('average','sma',{period:3});api.addIndicator('pressure',moduleName,{factor:.5,shift:-2});
 api.addSeries({id:'mean-line',type:'line',panel:'price',indicator:'average',output:'value',color:'#123456',width:4});
 api.addSeries({id:'pressure-line',type:'line',panel:'price',indicator:'pressure',output:'cumulative'});
 const targetBars=bars([30,29,33,32,35,36,31,34]);target.api.setData(targetBars);
 const before=currentState(target),data=targetBars.map(b=>({...b})),drawing=target.api.addDrawing({type:'text',points:[{time:targetBars[0].time,price:30}],text:'keep'});
 const drawingText=target.api.saveDrawings(),layout=target.api.inspect();
 const result=target.api.loadStudies(api.saveStudies());assert.deepEqual(result,{indicators:2,series:2});
 assert.equal(target.model.store,before.store);assert.equal(target.model.store.version,before.version);
 assert.deepEqual(Array.from({length:target.model.store.length},(_,i)=>target.model.store.at(i)),data);
 assert.equal(target.model.indicators.entries.get('existing'),before.entryRefs[0][1]);
 for(const old of before.seriesRefs)assert.equal(target.model.series.find(s=>s.id===old.id),old);
 assert.deepEqual([...target.model.store.listeners],before.listeners,'temporary engine subscription released after success');
 assert.deepEqual(target.api.indicatorValues('average','value'),sma(targetBars,3));
 assert.deepEqual(target.api.indicatorValues('pressure','cumulative'),pressure(targetBars,.5));
 assert.equal(target.api.saveDrawings(),drawingText);assert.equal(target.api.inspect().selected,drawing);
 for(const key of ['view','theme','panels','axes'])assert.deepEqual(target.api.inspect()[key],layout[key],'study load preserves '+key);
});

const invalidDocuments=[
 ['wrong schema',d=>{d.schema='aster.drawings';}],['unsupported version',d=>{d.version=2;}],
 ['unknown document key',d=>{d.data=[];}],['unknown indicator key',d=>{d.indicators[0].source='(()=>{globalThis.studyOracleExecuted=true})()';}],
 ['invalid params',d=>{d.indicators[0].params.period=0;}],['nested params',d=>{d.indicators[0].params={period:{value:3}};}],
 ['unknown factory',d=>{d.indicators[0].name='https://invalid.example/indicator.js';}],
 ['duplicate incoming indicator IDs',d=>{d.indicators.push({...d.indicators[0]});}],
 ['existing indicator collision',d=>{d.indicators[0].id='existing';d.series[0].indicator='existing';}],
 ['existing series collision',d=>{d.series[0].id='existing-line';}],
 ['duplicate incoming series IDs',d=>{d.series.push({...d.series[0]});}],
 ['missing panel',d=>{d.series[0].panel='missing';}],['missing axis',d=>{d.series[0].axisId='missing';}],
 ['missing indicator binding',d=>{d.series[0].indicator='missing';}],['missing output',d=>{d.series[0].output='missing';}],
 ['fractional offset',d=>{d.series[0].offset=.25;}],['out-of-range offset',d=>{d.series[0].offset=10001;}],
 ['unknown series key',d=>{d.series[0].url='https://invalid.example/study';}],['borrowed output array',d=>{d.series[0].values=[1,2,3];}],
 ['invalid style',d=>{d.series[0].width=-1;}],['data-source series',d=>{delete d.series[0].indicator;d.series[0].source='close';}],
];
for(const [label,mutate] of invalidDocuments)test(`study load rejects ${label} before publishing or retaining subscriptions`,t=>{
 const f=occupied(t),doc=baseDocument();mutate(doc);globalThis.studyOracleExecuted=false;
 try {rejectAtomically(f,doc,label);assert.equal(globalThis.studyOracleExecuted,false);}finally {delete globalThis.studyOracleExecuted;}
});

test('module version, state version and causal metadata mismatches fail atomically',t=>{
 const source=fixture(t),target=occupied(t);requireStudies(source.api);
 source.api.registerIndicatorModule('aster.volume-direction',1);source.api.addIndicator('incoming',moduleName,{factor:1,shift:0});
 source.api.addSeries({id:'incoming-line',type:'line',panel:'price',indicator:'incoming',output:'signed'});
 const saved=JSON.parse(source.api.saveStudies());
 for(const key of ['version','stateVersion','exportName','id','causal']) {
  const doc=structuredClone(saved);doc.indicators[0].module[key]=key==='causal'?false:typeof doc.indicators[0].module[key]==='number'?2:'missing';
  rejectAtomically(target,doc,'module '+key);
 }
});

test('study document and count limits reject before altering the target model',t=>{
 const f=occupied(t),tooManyIndicators=baseDocument(),tooManySeries=baseDocument();
 tooManyIndicators.indicators=Array.from({length:129},(_,i)=>({id:'i'+i,name:'sma',params:{period:3}}));tooManyIndicators.series=[];
 tooManySeries.series=Array.from({length:257},(_,i)=>({...baseDocument().series[0],id:'s'+i}));
 rejectAtomically(f,tooManyIndicators,'129 indicators');rejectAtomically(f,tooManySeries,'257 series');
 // Whitespace is legal JSON; a parser without the size guard would accept it.
 rejectAtomically(f,JSON.stringify(baseDocument())+' '.repeat(8388609),'8MiB document budget');
});

test('study merge limits include indicators and series already owned by the target',t=>{
 const f=occupied(t),indicatorLimit=baseDocument(),seriesLimit=baseDocument();
 indicatorLimit.indicators=Array.from({length:128},(_,i)=>({id:'incoming-'+i,name:'sma',params:{period:3}}));indicatorLimit.series=[];
 seriesLimit.series=Array.from({length:255},(_,i)=>({...baseDocument().series[0],id:'incoming-series-'+i}));
 rejectAtomically(f,indicatorLimit,'existing1 + incoming128 indicators');
 rejectAtomically(f,seriesLimit,'existing2 + incoming255 series');
});

test('naked and source-string custom studies reject save without removing existing custom output',t=>{
 for(const source of [false,true]) {
  const f=fixture(t);requireStudies(f.api);
  if(source)f.api.registerIndicatorSource('naked-study','()=>({outputs:["value"],create(){return {step:b=>[b.close],snapshot:()=>0,restore(){}}}})');
  else f.api.registerIndicator('naked-study',()=>({outputs:['value'],create(){return {step:b=>[b.close],snapshot:()=>0,restore(){}};}}));
  f.api.addIndicator('naked','naked-study');const before=currentState(f);
  assert.throws(()=>f.api.saveStudies(),/unsupported|portable|factory/i);unchanged(f,before,'unsupported custom save');
 }
});

for(const mutation of ['data','source-store','configuration','entries','entry-replacement','series-binding'])test(`trusted staging callback ${mutation} mutation makes study load stale without overwriting callback-owned changes`,t=>{
 assert.equal(typeof A.defineIndicatorModule,'function','trusted module catalog API required');
 let armed=false,fired=false,target,replacement;
 const moduleId='oracle.study-reentry-'+mutation;
 A.defineIndicatorModule({id:moduleId,version:1,stateVersion:1,indicators:{close:{causal:true,validateCheckpoint(_params,state){if(state!==0)throw new TypeError('state');},factory(){
  if(armed&&!fired) {
   fired=true;
   if(mutation==='data')target.model.store.append({...target.model.store.at(7),time:target.model.store.at(7).time+60000});
   if(mutation==='source-store'){replacement=new A.BarStore(bars([40,41,42,43,44,45,46,47]));target.model.store=replacement;}
   if(mutation==='configuration')target.model.setPanel('price',{padding:.2});
   if(mutation==='entries')target.model.indicators.add('callback-owned','sma',{period:2});
   if(mutation==='entry-replacement')target.model.indicators.entries.set('existing',{...target.model.indicators.entries.get('existing')});
   if(mutation==='series-binding')target.api.setSeries('existing-line',{indicator:'other',output:'value'});
  }
  return {outputs:['value'],create(){return {step:b=>[b.close],snapshot:()=>0,restore(){}};}};
 }}}});
 const source=fixture(t);requireStudies(source.api);source.api.registerIndicatorModule(moduleId,1);
 source.api.addIndicator('incoming',moduleId+'@1/close');source.api.addSeries({id:'incoming-line',type:'line',panel:'price',indicator:'incoming'});
 const document=source.api.saveStudies();target=occupied(t);target.model.indicators.add('other','sma',{period:3});
 const store=target.model.store,entries=target.model.indicators.entries,existing=entries.get('existing'),listeners=[...store.listeners],version=store.version;
 armed=true;
 try {
  assert.throws(()=>target.api.loadStudies(document),/stale|changed|mutat|config/i);assert.equal(fired,true,'callback executed during staging');
  assert.equal(target.model.indicators.entries,entries);assert.equal(entries.has('incoming'),false);
  assert.equal(target.model.series.some(s=>s.id==='incoming-line'),false);assert.deepEqual([...store.listeners],listeners,'staging listener released on stale rejection');
  if(mutation==='data'){assert.equal(store.version,version+1);assert.equal(store.length,9);}
  if(mutation==='source-store')assert.equal(target.model.store,replacement);
  if(mutation==='configuration')assert.equal(target.model.panels[0].padding,.2);
  if(mutation==='entries')assert.equal(entries.has('callback-owned'),true);
  if(mutation==='entry-replacement')assert.notEqual(entries.get('existing'),existing,'same-config replacement entry remains callback owned');
  if(mutation==='series-binding')assert.equal(target.model.series.find(s=>s.id==='existing-line').indicator,'other');
 } finally {target.model.store=store;}
});
