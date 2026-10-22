// Package-internal snapshot; deliberately not exported through the core barrel.
export function snapshotDataBatchOptions(options,storeLimits=true) {
 if(!options||typeof options!=='object'||Array.isArray(options)||![Object.prototype,null].includes(Object.getPrototypeOf(options)))throw new TypeError('Data batch options plain data record required');
 const keys=storeLimits?['maxBars','maxStoreBytes','skipUnchanged']:['skipUnchanged'],copy={};
 for(const key of Reflect.ownKeys(options)){
  const descriptor=Object.getOwnPropertyDescriptor(options,key);
  if(typeof key!=='string'||!keys.includes(key)||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))throw new TypeError('Data batch options unsupported field or accessor data property');
  copy[key]=descriptor.value;
 }
 if(copy.skipUnchanged!==undefined&&typeof copy.skipUnchanged!=='boolean')throw new TypeError('Data batch skipUnchanged must be boolean');
 return copy;
}
