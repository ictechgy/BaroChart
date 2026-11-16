const arrayBufferByteLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
const sharedArrayBufferByteLength=typeof SharedArrayBuffer==='function'?Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype,'byteLength').get:null;
const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype),typedArrayBuffer=Object.getOwnPropertyDescriptor(typedArrayPrototype,'buffer').get,typedArrayByteOffset=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteOffset').get,typedArrayByteLength=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteLength').get;
const dataViewBuffer=Object.getOwnPropertyDescriptor(DataView.prototype,'buffer').get,dataViewByteOffset=Object.getOwnPropertyDescriptor(DataView.prototype,'byteOffset').get,dataViewByteLength=Object.getOwnPropertyDescriptor(DataView.prototype,'byteLength').get;
function abortError(){const error=new Error('Rust chart creation aborted');error.name='AbortError';return error;}
function checkSignal(signal){
 if(signal!==undefined&&(!signal||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'||typeof signal.aborted!=='boolean'))throw new TypeError('AbortSignal required');
}
function copyRecord(value,label){if(value===undefined)return{};if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError(`${label} options required`);return{...value};}
function copyURL(value){return typeof URL==='function'&&value instanceof URL?new URL(value.href):value;}
function hasBufferBrand(getter,value){if(!getter)return false;try{getter.call(value);return true;}catch{return false;}}
function copyWasmSource(value){
 if(typeof value==='string'||typeof URL==='function'&&value instanceof URL||value instanceof WebAssembly.Module)return copyURL(value);
 if(typeof Response==='function'&&value instanceof Response){
  try{return Response.prototype.clone.call(value);}catch(error){throw new TypeError('Rust WASM Response must be unused',{cause:error});}
 }
 if(hasBufferBrand(arrayBufferByteLength,value)){try{return Uint8Array.prototype.slice.call(new Uint8Array(value)).buffer;}catch(error){throw new TypeError('Rust WASM ArrayBuffer must not be detached',{cause:error});}}
 if(hasBufferBrand(sharedArrayBufferByteLength,value))throw new TypeError('Rust WASM source must use an ArrayBuffer');
 if(ArrayBuffer.isView(value)){
  let buffer,byteOffset,byteLength;
  try{try{buffer=typedArrayBuffer.call(value);byteOffset=typedArrayByteOffset.call(value);byteLength=typedArrayByteLength.call(value);}catch{buffer=dataViewBuffer.call(value);byteOffset=dataViewByteOffset.call(value);byteLength=dataViewByteLength.call(value);}}
  catch(error){throw new TypeError('Rust WASM byte view must not be detached',{cause:error});}
  try{arrayBufferByteLength.call(buffer);}catch{throw new TypeError('Rust WASM source must use an ArrayBuffer');}
  try{return Uint8Array.prototype.slice.call(new Uint8Array(buffer,byteOffset,byteLength)).buffer;}
  catch(error){throw new TypeError('Rust WASM byte view must not be detached',{cause:error});}
 }
 return value;
}
function copyOwned(value,label){try{return structuredClone(value);}catch(error){throw new TypeError(`${label} must be cloneable`,{cause:error});}}
function checkView(view){
 if(view.renderer!==undefined&&!['canvas','webgl2'].includes(view.renderer))throw new TypeError('Rust chart renderer');
 if(view.dpr!==undefined&&typeof view.dpr!=='function')throw new TypeError('Rust chart DPR');
 if(view.interactive!==undefined&&typeof view.interactive!=='boolean')throw new TypeError('Rust chart interactive option');
 if(view.observeResize!==undefined&&typeof view.observeResize!=='boolean')throw new TypeError('Rust chart resize option');
 if(view.onError!==undefined&&view.onError!==null&&typeof view.onError!=='function')throw new TypeError('Rust chart error callback');
}

/** Pure, synchronous ownership snapshot used before the root entry dynamically imports Rust code. */
export function snapshotRustChartCreation(container,options={}){
 if(!container||typeof container.append!=='function'||typeof container.getBoundingClientRect!=='function')throw new TypeError('Chart container required');
 if(!options||typeof options!=='object'||Array.isArray(options))throw new TypeError('Rust chart options required');
 const signal=options.signal;checkSignal(signal);if(signal?.aborted)throw abortError();
 const load=copyRecord(options.load,'Rust load'),session=copyRecord(options.session,'Rust session'),prepareOptions=copyRecord(options.prepareOptions,'Rust prepare'),view=copyRecord(options.view,'Rust view');
 checkView(view);
 if(Object.hasOwn(load,'source'))load.source=copyWasmSource(load.source);
 for(const name of ['wasmURL','workerURL'])if(Object.hasOwn(load,name))load[name]=copyURL(load[name]);
 if(Object.hasOwn(session,'options'))session.options=copyOwned(session.options,'Rust session options');
 // Select the prepare payload now, but leave its potentially large column copy to
 // RustSession.prepareData, which owns the established normalization boundary.
 const prepare=options.prepare;
 if(prepare!==undefined&&(session.count??0)!==0)throw new TypeError('Choose initial session count or prepared data');
 return Object.freeze({container,backend:options.backend,load:Object.freeze(load),session:Object.freeze(session),prepare,prepareOptions:Object.freeze(prepareOptions),view:Object.freeze(view),signal});
}
