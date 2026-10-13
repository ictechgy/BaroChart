// Native read-only metadata preflight. This is not calculation or restoration.
import {ChartAPI} from './api.mjs';
import {ChartModel} from './model.mjs';
import {BarStore,FIELDS} from './data.mjs';
import {IndicatorEngine,requirePortableFactory} from './indicators.mjs';
import {workspaceSlot,workspaceSnapshot,workspaceBinding,workspaceBindingSame,readWorkspaceDocument} from './workspace.mjs';
const nativeWorkspaceTypedProto=Object.getPrototypeOf(Float64Array.prototype),nativeWorkspaceLengthGet=Object.getOwnPropertyDescriptor(nativeWorkspaceTypedProto,'length').get,nativeWorkspaceBufferGet=Object.getOwnPropertyDescriptor(nativeWorkspaceTypedProto,'buffer').get,nativeWorkspaceTagGet=Object.getOwnPropertyDescriptor(nativeWorkspaceTypedProto,Symbol.toStringTag).get;
function nativeWorkspaceSame(a,b){return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&Object.is(a[k],b[k]));}
function nativeWorkspaceStale(){const error=new Error('Workspace preflight owner/source changed');error.name='StaleSourceError';throw error;}
export function nativeWorkspacePreflight(api,text,datasetBinding){
 if(!(api instanceof ChartAPI))throw new TypeError('Actual ChartAPI required');const model=workspaceSlot(api,'model');if(!(model instanceof ChartModel)||model.disposed)throw new Error('Chart disposed');const store=workspaceSlot(model,'store');if(!(store instanceof BarStore))throw new TypeError('Actual BarStore required');
 const columns=workspaceSlot(store,'columns'),length=workspaceSlot(store,'length'),capacity=workspaceSlot(store,'capacity'),version=workspaceSlot(store,'version');if(!Number.isSafeInteger(length)||length<0||length>4194304||!Number.isSafeInteger(capacity)||capacity<16||capacity<length||capacity>4194304||(capacity&(capacity-1))||!Number.isSafeInteger(version))throw new RangeError('Workspace source dimensions/version');
 const source=FIELDS.map(k=>workspaceSlot(columns,k));for(const a of source){if(nativeWorkspaceTagGet.call(a)!=='Float64Array'||nativeWorkspaceLengthGet.call(a)<length)throw new TypeError('Workspace source columns');if(typeof SharedArrayBuffer!=='undefined'&&nativeWorkspaceBufferGet.call(a) instanceof SharedArrayBuffer)throw new TypeError('Shared workspace source');}
 const guard=()=>{if(workspaceSlot(api,'model')!==model||model.disposed||workspaceSlot(model,'store')!==store||workspaceSlot(store,'columns')!==columns||workspaceSlot(store,'version')!==version||workspaceSlot(store,'length')!==length||workspaceSlot(store,'capacity')!==capacity||FIELDS.some((k,i)=>workspaceSlot(columns,k)!==source[i]))nativeWorkspaceStale();};
 const binding=workspaceBinding(datasetBinding),doc=readWorkspaceDocument(text);guard();if(!workspaceBindingSame(doc.dataset,binding))throw new TypeError('Workspace dataset binding mismatch');if(doc.source.length!==length||doc.source.firstTime!==(length?source[0][0]:null)||doc.source.lastTime!==(length?source[0][length-1]:null))throw new TypeError('Workspace source extent mismatch');
 // Empty metadata-only engine: canonical factories run, but create/step and
 // checkpoint generation never do. It never subscribes to the live BarStore.
 const staging=new IndicatorEngine({length:0,capacity:0,columns:{},_subscribeInternal:()=>()=>{}}),modules=[],seenModules=new Set();let outputs=0,receipt;
 try{
  for(const study of doc.indicators){requirePortableFactory(study.name,staging.registry.get(study.name));staging.add(study.id,study.name,{...study.params});const entry=staging.entries.get(study.id);if(!nativeWorkspaceSame(entry.params,study.params))throw new TypeError('Workspace factory changed requested params');const layout=workspaceSnapshot({outputs:entry.def.outputs,plotOffsets:entry.def.plotOffsets??{}});if(layout.outputs.length!==study.outputs.length||layout.outputs.some((key,i)=>key!==study.outputs[i])||!nativeWorkspaceSame(layout.plotOffsets,study.plotOffsets))throw new TypeError('Workspace output schema/offset binding');outputs+=layout.outputs.length;if(outputs*capacity*8>staging.maxOutputBytes)throw new RangeError('Workspace projected output byte limit');if(study.module){const key=study.name;if(!seenModules.has(key)){seenModules.add(key);modules.push(workspaceSnapshot(study.module));}}guard();}
  receipt=workspaceSnapshot({schema:'aster.workspace-preflight',version:1,status:'validated-only',restored:false,dataset:binding,source:{length,firstTime:doc.source.firstTime,lastTime:doc.source.lastTime,version},counts:{panels:doc.chart.panels.length,axes:doc.chart.axes.length,series:doc.series.length,indicators:doc.indicators.length,outputs,drawings:doc.drawings.drawings.length},projectedOutputBytes:outputs*capacity*8,outputByteLimit:staging.maxOutputBytes,modules});
  // All module/metadata callbacks finish before this final callback-free guard.
  // No source vectors, indicator caches, history or native UI state are changed.
 }finally{staging.dispose();}
 guard();return receipt;
}
