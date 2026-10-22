// Additive opt-in endpoint. Existing generic command/default ingestion stays intact.
const nativeBatchApply=ChartAPI.prototype.applyDataEvents;
function nativeBatchData(owner,key){const d=Object.getOwnPropertyDescriptor(owner,key);if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Native batch own data required');return d.value;}
function nativeBatchDisposed(model){const d=Object.getOwnPropertyDescriptor(model,'disposed');if(d&&!Object.hasOwn(d,'value'))throw new TypeError('Native batch disposed data required');return d?.value===true;}
function nativeBatchOwnerError(){const error=new Error('Native batch owner/source changed');error.name='StaleSourceError';return error;}
globalThis.nativeApplyUnchangedDataEvents=function(events){
 const api=nativeBatchData(globalThis,'nativeAPI'),model=nativeBatchData(globalThis,'nativeModel'),input=nativeBatchData(globalThis,'nativeInput');
 const store=nativeBatchData(model,'store'),beforeVersion=nativeBatchData(store,'version'),columns=nativeBatchData(store,'columns'),index=nativeBatchData(store,'index'),length=nativeBatchData(store,'length'),capacity=nativeBatchData(store,'capacity');
 const vectors=FIELDS.map(key=>nativeBatchData(columns,key)),count=Array.isArray(events)?Object.getOwnPropertyDescriptor(events,'length')?.value:null;
 const owner=()=>{if(nativeBatchData(globalThis,'nativeAPI')!==api||nativeBatchData(globalThis,'nativeModel')!==model||nativeBatchData(globalThis,'nativeInput')!==input||nativeBatchData(api,'model')!==model||nativeBatchData(api,'controller')!==input||nativeBatchData(input,'model')!==model||nativeBatchData(model,'store')!==store||nativeBatchDisposed(model))throw nativeBatchOwnerError();};
 owner();
 const receipt=nativeBatchApply.call(api,events,{skipUnchanged:true});
 owner();
 const copy={};for(const key of ['events','appended','from','to','version','length','capacity','bytes','unchanged'])copy[key]=nativeBatchData(receipt,key);
 const afterVersion=nativeBatchData(store,'version');
 const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
 if(typeof copy.unchanged!=='boolean'||(!integer(copy.events,1,4096)||copy.events!==count)||!integer(copy.appended,0,copy.events)||!integer(copy.length,0,4194304)||!integer(copy.capacity,1,4194304)||copy.capacity<copy.length||(copy.capacity&(copy.capacity-1))!==0||copy.bytes!==96*copy.capacity||!integer(copy.from,0,copy.length)||!integer(copy.to,copy.from+1,copy.length)||!integer(beforeVersion,0,Number.MAX_SAFE_INTEGER)||!integer(afterVersion,beforeVersion,Number.MAX_SAFE_INTEGER)||!integer(copy.version,beforeVersion,afterVersion))throw new TypeError('Native batch receipt invalid');
 if(copy.unchanged){
  if(copy.appended!==0||FIELDS.some((key,i)=>nativeBatchData(columns,key)!==vectors[i])||copy.version!==beforeVersion||afterVersion!==beforeVersion||copy.length!==length||copy.capacity!==capacity||nativeBatchData(store,'columns')!==columns||nativeBatchData(store,'index')!==index||nativeBatchData(store,'length')!==length||nativeBatchData(store,'capacity')!==capacity)throw nativeBatchOwnerError();
 }else if(copy.version!==beforeVersion+1)throw new TypeError('Native batch publication version');
 owner();return Object.freeze({schema:'aster.native-data-batch',version:1,beforeVersion,afterVersion,unchanged:copy.unchanged,receipt:Object.freeze(copy)});
};
