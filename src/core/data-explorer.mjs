import {BarStore,FIELDS,validateBar} from './data.mjs';
import {IndicatorEngine,requirePortableFactory,isCanonicalBuiltinDefinition} from './indicators.mjs';
import {RESOURCE_LIMITS,SERIES_KEYS,PANEL_KEYS,AXIS_KEYS,boundedText,identifier} from './contracts.mjs';

const explorerTyped=Object.getPrototypeOf(Float64Array.prototype),explorerTypedLength=Object.getOwnPropertyDescriptor(explorerTyped,'length').get,explorerTypedBuffer=Object.getOwnPropertyDescriptor(explorerTyped,'buffer').get,explorerTypedTag=Object.getOwnPropertyDescriptor(explorerTyped,Symbol.toStringTag).get;
const explorerArrayBufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
const explorerMapEntries=Map.prototype.entries,explorerMapGet=Map.prototype.get,explorerMapSize=Object.getOwnPropertyDescriptor(Map.prototype,'size').get;
function explorerSlot(object,key,required=false){const d=Object.getOwnPropertyDescriptor(object,key);if(!d){if(required)throw new TypeError('Data query missing '+key);return undefined;}if(!Object.hasOwn(d,'value'))throw new TypeError('Data query own data properties required');return d.value;}
function explorerRecord(value,keys,label){if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError(label+' plain record');const out=Object.create(null);for(const key of Reflect.ownKeys(value)){if(typeof key!=='string'||!keys.includes(key))throw new TypeError(label+' fields');const d=Object.getOwnPropertyDescriptor(value,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError(label+' own data fields');Object.defineProperty(out,key,{value:d.value,enumerable:true});}return out;}
function explorerList(value,max,label){if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)throw new TypeError(label+' array');const n=explorerSlot(value,'length',true);if(n>max||Reflect.ownKeys(value).length!==n+1)throw new RangeError(label+' limit/shape');return Array.from({length:n},(_,i)=>explorerSlot(value,String(i),true));}
function explorerVector(value,length){if(explorerTypedTag.call(value)!=='Float64Array'||explorerTypedLength.call(value)<length)throw new TypeError('Data query Float64 column length');const buffer=explorerTypedBuffer.call(value);try{explorerArrayBufferLength.call(buffer);}catch{throw new TypeError('Shared data query buffer');}return value;}
function explorerCachedVector(value,capacity,state){if(value==null)return null;if(explorerTypedTag.call(value)!=='Float64Array')throw new TypeError('Data query cached Float64 output');const buffer=explorerTypedBuffer.call(value);try{explorerArrayBufferLength.call(buffer);}catch{throw new TypeError('Shared data query buffer');}const length=explorerTypedLength.call(value);state.push({value,buffer,length});return length===capacity?value:null;}
function explorerCapture(object,keys){if(!object||typeof object!=='object')throw new TypeError('Data query owner object');return {object,values:keys.map(key=>[key,explorerSlot(object,key)])};}
function explorerSame(snapshot){return snapshot.values.every(([key,value])=>{const d=Object.getOwnPropertyDescriptor(snapshot.object,key);return d?Object.hasOwn(d,'value')&&Object.is(d.value,value):value===undefined;});}
function explorerText(value,max,label,nullable=false){if(nullable&&value==null)return null;boundedText(value,max,label);return value;}
function explorerStale(){const error=new Error('Data query source or display configuration changed');error.name='StaleSourceError';throw error;}
function explorerMapSnapshot(value,max){const n=explorerMapSize.call(value);if(n>max)throw new RangeError('Data query indicator limit');return [...explorerMapEntries.call(value)];}
function explorerMapSame(value,rows){return explorerMapSize.call(value)===rows.length&&rows.every(([key,entry])=>explorerMapGet.call(value,key)===entry);}

// A reentrant source update can invalidate an in-flight engine calculation,
// whose normal completion would otherwise overwrite that dirty marker. Only
// the still-owned entry is reset; replaced/disposed owners are never revived.
function explorerInvalidateCalculation(model,engine,entries,id,entry,source,columnOwner){
 if(explorerSame(source)&&explorerSame(columnOwner))return;
 if(explorerSlot(model,'disposed')||explorerSlot(model,'indicators')!==engine||explorerSlot(engine,'entries')!==entries||explorerMapGet.call(entries,id)!==entry)return;
 const dirty=Object.getOwnPropertyDescriptor(entry,'dirty'),invalidated=Object.getOwnPropertyDescriptor(entry,'invalidated');
 if(!dirty||!Object.hasOwn(dirty,'value')||!dirty.writable||!invalidated||!Object.hasOwn(invalidated,'value')||!invalidated.writable)return;
 Object.defineProperty(entry,'dirty',{value:0});Object.defineProperty(entry,'invalidated',{value:true});
}

// A bounded semantic readout, independent of layout, viewport and pixels. The
// default may evaluate indicators; cached mode only accepts a whole clean cache.
export function dataAt(model,query,options={}){
 const q=explorerRecord(query,['index','time','match'],'Data selection'),o=explorerRecord(options,['asOfIndex','includeHidden','indicatorMode'],'Data query options'),cached=o.indicatorMode==='cached';
 const byIndex=Object.hasOwn(q,'index');
 if(byIndex){if(Object.keys(q).length!==1||!Number.isSafeInteger(q.index)||q.index<0)throw new RangeError('Data query index');}
 else if(Object.keys(q).length!==2||!Object.hasOwn(q,'time')||!Object.hasOwn(q,'match')||!Number.isSafeInteger(q.time)||Math.abs(q.time)>8640000000000000||!['exact','at-or-before'].includes(q.match))throw new RangeError('Data query time and explicit match');
 if(o.includeHidden!==undefined&&typeof o.includeHidden!=='boolean')throw new TypeError('Data query hidden flag');
 if(o.indicatorMode!==undefined&&!['calculate','cached'].includes(o.indicatorMode))throw new TypeError('Data query indicator mode');
 const owner=explorerCapture(model,['disposed','store','indicators','series','panels','axes','symbol','seriesValuesRevision','seriesValueRevisions']),store=explorerSlot(model,'store',true),engine=explorerSlot(model,'indicators',true);
 if(explorerSlot(model,'disposed'))throw new Error('Chart disposed');if(!(store instanceof BarStore)||!(engine instanceof IndicatorEngine))throw new TypeError('Data query managed store/indicators');
 const source=explorerCapture(store,['length','capacity','version','timeVersion','columns']),length=explorerSlot(store,'length',true),columns=explorerSlot(store,'columns',true),version=explorerSlot(store,'version',true);
 if(!Number.isSafeInteger(length)||length<0||length>RESOURCE_LIMITS.maxBars)throw new RangeError('Data query source length');
 const cutoff=o.asOfIndex===undefined?length-1:o.asOfIndex;if(!Number.isSafeInteger(cutoff)||cutoff< -1||cutoff>=length)throw new RangeError('Data query cutoff');
 const columnOwner=explorerCapture(columns,FIELDS),vectors=FIELDS.map(key=>explorerVector(explorerSlot(columns,key,true),length));
 const seriesList=explorerSlot(model,'series',true),series=explorerList(seriesList,RESOURCE_LIMITS.maxSeries,'Data query series'),seriesState=series.map(s=>explorerCapture(s,SERIES_KEYS));
 const panelsList=explorerSlot(model,'panels',true),panels=explorerList(panelsList,RESOURCE_LIMITS.maxPanels,'Data query panels'),panelState=panels.map(p=>explorerCapture(p,PANEL_KEYS));
 const axesList=explorerSlot(model,'axes',true),axes=explorerList(axesList,RESOURCE_LIMITS.maxAxes,'Data query axes'),axisState=axes.map(a=>explorerCapture(a,AXIS_KEYS));
 const engineOwner=explorerCapture(engine,['entries','registry']),entries=explorerSlot(engine,'entries',true),registry=explorerSlot(engine,'registry',true),entryRows=explorerMapSnapshot(entries,RESOURCE_LIMITS.maxIndicators),factoryRows=entryRows.map(([,entry])=>{const name=explorerSlot(entry,'name',true);return [name,explorerMapGet.call(registry,name)];});
 const entryState=entryRows.map(([,e])=>explorerCapture(e,['def','name','params'])),cachedEntryState=cached?new Map():null,cachedEntryRows=cached?[]:null,cachedArrayState=cached?[]:null,cachedVectorState=cached?[]:null;
 const definitionState=entryRows.map(([,entry])=>{const def=explorerSlot(entry,'def',true),schema=explorerSlot(def,'outputs',true),keys=explorerList(schema,32,'Data query outputs'),offsets=explorerSlot(def,'plotOffsets'),params=explorerSlot(entry,'params',true);const offsetKeys=offsets==null?[]:Reflect.ownKeys(offsets),paramKeys=Reflect.ownKeys(params);if(offsetKeys.length>32||paramKeys.length>32||offsetKeys.some(k=>typeof k!=='string')||paramKeys.some(k=>typeof k!=='string'))throw new RangeError('Data query definition metadata');return {def:explorerCapture(def,['create','outputs','plotOffsets']),schema:explorerCapture(schema,['length',...keys.map((_,i)=>String(i))]),offsets:offsets==null?null:explorerCapture(offsets,offsetKeys),params:explorerCapture(params,paramKeys),offsetKeys:offsetKeys.length,paramKeys:paramKeys.length};});
 const symbol=explorerSlot(model,'symbol'),symbolState=symbol?explorerCapture(symbol,['id','currency','volumeUnit']):null;
 const primarySymbol=symbol?{id:explorerText(explorerSlot(symbol,'id',true),128,'Symbol id'),currency:explorerText(explorerSlot(symbol,'currency',true),64,'Currency'),volumeUnit:explorerText(explorerSlot(symbol,'volumeUnit',true),64,'Volume unit')}:null;
 const guard=()=>{if(!explorerSame(owner)||explorerSlot(model,'disposed')||!explorerSame(source)||!explorerSame(columnOwner)||!explorerSame(engineOwner)||!explorerMapSame(entries,entryRows)||!factoryRows.every(([name,factory])=>explorerMapGet.call(registry,name)===factory)||!entryState.every(explorerSame)||!definitionState.every(s=>explorerSame(s.def)&&explorerSame(s.schema)&&(!s.offsets||explorerSame(s.offsets)&&Reflect.ownKeys(s.offsets.object).length===s.offsetKeys)&&explorerSame(s.params)&&Reflect.ownKeys(s.params.object).length===s.paramKeys)||cached&&(!cachedEntryRows.every(s=>explorerSame(s.snapshot))||!cachedArrayState.every(s=>explorerSame(s.snapshot)&&Reflect.ownKeys(s.snapshot.object).length===s.keys)||!cachedVectorState.every(s=>explorerTypedTag.call(s.value)==='Float64Array'&&explorerTypedLength.call(s.value)===s.length&&explorerTypedBuffer.call(s.value)===s.buffer))||symbolState&&!explorerSame(symbolState)||explorerSlot(seriesList,'length')!==series.length||series.some((s,i)=>explorerSlot(seriesList,String(i))!==s)||!seriesState.every(explorerSame)||explorerSlot(panelsList,'length')!==panels.length||panels.some((p,i)=>explorerSlot(panelsList,String(i))!==p)||!panelState.every(explorerSame)||explorerSlot(axesList,'length')!==axes.length||axes.some((a,i)=>explorerSlot(axesList,String(i))!==a)||!axisState.every(explorerSame))explorerStale();};
 let index=q.index;
 if(!byIndex){let lo=0,hi=length;const time=vectors[0];while(lo<hi){const mid=(lo+hi)>>>1;if(time[mid]<q.time)lo=mid+1;else hi=mid;}index=lo<length&&time[lo]===q.time?lo:q.match==='at-or-before'?lo-1:-1;}
 if(index<0||index>=length||index>cutoff){guard();return null;}
 const bar=Object.fromEntries(FIELDS.map((key,i)=>[key,vectors[i][index]]));validateBar(bar);
 const pending=[];
 for(let i=0;i<series.length;i++){
  const s=series[i],v=Object.fromEntries(seriesState[i].values);if(v.visible===false&&!o.includeHidden)continue;
  identifier(v.id,'Series id');identifier(v.panel,'Series panel');if(v.axisId!=null)identifier(v.axisId,'Series axis');
  if(!panels.some(p=>explorerSlot(p,'id')===v.panel)||v.axisId!=null&&!axes.some(a=>explorerSlot(a,'id')===v.axisId&&explorerSlot(a,'panel')===v.panel))throw new TypeError('Data query series binding');
  const offset=v.offset??0;if(!Number.isSafeInteger(offset)||Math.abs(offset)>10000)throw new RangeError('Data query series offset');
  const sourceIndex=index-offset,kind=v.values?'external':v.indicator?'indicator':'source';
  const row={id:v.id,label:explorerText(v.label??v.id,256,'Series label'),panel:v.panel,axisId:v.axisId??null,symbolId:v.values?explorerText(v.symbolId,128,'External symbol',true):primarySymbol?.id??null,visible:v.visible!==false,type:explorerText(v.type,16,'Series type'),kind,causality:kind==='source'?'stored-source':kind==='external'?'host-aligned':'unverified-study',offset,source:kind==='source'?(v.source??'close'):null,indicator:kind==='indicator'?explorerText(v.indicator,128,'Indicator id'):null,output:kind==='indicator'?(v.output??null):null,value:null,sourceIndex:null,sourceTime:null,status:'outside-source'};
  if(row.source!==null&&!FIELDS.includes(row.source))throw new TypeError('Data query source field');
  let entry=null,key=null,itemOutputs=null,outputIndex=-1;
  if(kind==='indicator'){
   entry=explorerMapGet.call(entries,v.indicator);if(!entry)throw new Error('Missing indicator');const def=explorerSlot(entry,'def',true),outputs=explorerList(explorerSlot(def,'outputs',true),128,'Data query outputs');key=v.output??outputs[0];explorerText(key,128,'Indicator output');for(let j=0;j<outputs.length;j++)if(outputs[j]===key){outputIndex=j;break;}if(outputIndex<0)throw new Error('Missing indicator output');row.output=key;try{if(requirePortableFactory(explorerSlot(entry,'name',true),explorerMapGet.call(registry,explorerSlot(entry,'name',true)))===null&&isCanonicalBuiltinDefinition(explorerSlot(entry,'name',true),def))row.causality='canonical-builtin';}catch{}itemOutputs=outputs;
  }
  if(sourceIndex<0||sourceIndex>=length){pending.push({row});continue;}
  if(sourceIndex>cutoff){row.status='after-cutoff';pending.push({row});continue;}
  if(entry&&cutoff<length-1&&row.causality!=='canonical-builtin'){row.status='unsupported-causality';pending.push({row});continue;}
  if(entry&&cached&&row.causality!=='canonical-builtin'){row.status='unsupported-cache';row.sourceIndex=sourceIndex;row.sourceTime=vectors[0][sourceIndex];pending.push({row});continue;}
  let array=kind==='external'?explorerVector(v.values,length):kind==='source'?vectors[FIELDS.indexOf(row.source)]:null,cachePending=false;
  if(entry&&cached){let cachedState=explorerMapGet.call(cachedEntryState,entry);if(!cachedState){const snapshot=explorerCapture(entry,['dirty','dirtyTo','invalidated','length','arrays']);cachedState={snapshot,values:Object.fromEntries(snapshot.values)};Map.prototype.set.call(cachedEntryState,entry,cachedState);cachedEntryRows.push(cachedState);}const state=cachedState.values,ready=state.dirty===length&&state.dirtyTo===0&&state.invalidated===false&&state.length===length;if(!ready)cachePending=true;else if(state.arrays==null)cachePending=true;else{const values=explorerList(state.arrays,128,'Data query cached outputs');cachedArrayState.push({snapshot:explorerCapture(state.arrays,['length',...values.map((_,j)=>String(j))]),keys:Reflect.ownKeys(state.arrays).length});if(values.length===0)cachePending=true;else if(values.length!==itemOutputs.length)throw new TypeError('Data query cached output shape');else{array=explorerCachedVector(values[outputIndex],explorerSlot(store,'capacity',true),cachedVectorState);cachePending=array===null;}}}
  pending.push({row,sourceIndex,array,entry,key,cachePending});
 }
 // Validate every selected binding before the first lazy callback. A getter is
 // never treated as market data. Arbitrary Proxy/internal mutation is unsupported.
 guard();const calculated=new Map();
 for(const item of pending){if(item.sourceIndex===undefined)continue;let array=item.array;
  if(item.cachePending){item.row.sourceIndex=item.sourceIndex;item.row.sourceTime=vectors[0][item.sourceIndex];item.row.status='pending';continue;}
  if(item.entry&&!cached){const id=item.row.indicator;let outputs=calculated.get(id);if(!outputs){let data;try{data=IndicatorEngine.prototype.get.call(engine,id);guard();}catch(error){explorerInvalidateCalculation(model,engine,entries,id,item.entry,source,columnOwner);throw error;}outputs=explorerSlot(data,'outputs',true);calculated.set(id,outputs);}array=explorerVector(explorerSlot(outputs,item.key,true),length);}
  const value=array[item.sourceIndex];item.row.value=Number.isFinite(value)?value:null;item.row.sourceIndex=item.sourceIndex;item.row.sourceTime=vectors[0][item.sourceIndex];item.row.status=Number.isFinite(value)?'value':'non-finite';
 }
 const result={index,time:bar.time,asOfIndex:cutoff,storeVersion:version,primary:{symbol:primarySymbol,bar},series:pending.map(item=>item.row)};
 guard();return result;
}
