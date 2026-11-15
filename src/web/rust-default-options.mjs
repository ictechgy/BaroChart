function abortError(){const error=new Error('Rust chart creation aborted');error.name='AbortError';return error;}
function checkSignal(signal){
 if(signal!==undefined&&(!signal||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'||typeof signal.aborted!=='boolean'))throw new TypeError('AbortSignal required');
}
function copyRecord(value,label){if(value===undefined)return{};if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError(`${label} options required`);return{...value};}
function copyURL(value){return typeof URL==='function'&&value instanceof URL?new URL(value.href):value;}
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
 for(const name of ['source','wasmURL','workerURL'])if(Object.hasOwn(load,name))load[name]=copyURL(load[name]);
 if(Object.hasOwn(session,'options'))session.options=copyOwned(session.options,'Rust session options');
 // Select the prepare payload now, but leave its potentially large column copy to
 // RustSession.prepareData, which owns the established normalization boundary.
 const prepare=options.prepare;
 if(prepare!==undefined&&(session.count??0)!==0)throw new TypeError('Choose initial session count or prepared data');
 return Object.freeze({container,backend:options.backend,load:Object.freeze(load),session:Object.freeze(session),prepare,prepareOptions:Object.freeze(prepareOptions),view:Object.freeze(view),signal});
}
