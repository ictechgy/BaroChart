import {identifier,optionRecord} from './contracts.mjs';
import {validateIndicatorParams} from './indicator-params.mjs';
import {safeCheckpointStringify,safeCheckpointParse} from './checkpoint-validation.mjs';

const linkedIndicatorModules=new Map(),linkedIndicatorFactories=new Map(),linkedFactoryNames=new WeakMap();
export class UnsupportedIndicatorError extends Error {
 constructor(name){super('Unsupported indicator module: '+String(name).slice(0,128)+'; requires a canonical builtin or linked factory');this.name='UnsupportedIndicatorError';this.code='UNSUPPORTED_INDICATOR_MODULE';}
}
function moduleInteger(value,label){if(!Number.isSafeInteger(value)||value<1)throw new TypeError('Indicator module '+label);}
function moduleToken(value,label){identifier(value,label);if(value.includes('@')||value.includes('/'))throw new TypeError('Indicator module '+label);return value;}
function moduleRecord(value,keys,label){optionRecord(value,keys,label);for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!d.enumerable||!Object.hasOwn(d,'value'))throw new TypeError(label+' data properties');}return value;}
export function defineIndicatorModule(spec){
 moduleRecord(spec,['id','version','stateVersion','indicators'],'Indicator module');moduleToken(spec.id,'id');moduleInteger(spec.version,'version');moduleInteger(spec.stateVersion,'state version');
 const key=spec.id+'@'+spec.version;if(linkedIndicatorModules.has(key))throw new TypeError('Duplicate indicator module');
 const entries=moduleRecord(spec.indicators,Object.keys(spec.indicators??{}),'Indicator module exports'),names=Object.keys(entries);
 if(!names.length||names.length>128||linkedIndicatorFactories.size+names.length>128)throw new RangeError('Indicator module export count');
 const definitions=names.map(exportName=>{
  moduleToken(exportName,'export name');const name=key+'/'+exportName;identifier(name,'Canonical indicator name');
  const entry=moduleRecord(entries[exportName],['factory','validateCheckpoint','causal'],'Indicator module export');
  if(typeof entry.factory!=='function'||typeof entry.validateCheckpoint!=='function'||entry.causal!==true)throw new TypeError('Causal indicator factory and checkpoint validator required');
  const module=Object.freeze({id:spec.id,version:spec.version,stateVersion:spec.stateVersion,exportName,causal:true});
  return Object.freeze({name,factory:entry.factory,module,validateCheckpoint:entry.validateCheckpoint});
 });
 for(const entry of definitions){linkedIndicatorFactories.set(entry.name,entry);let names=linkedFactoryNames.get(entry.factory);if(!names){names=new Set();linkedFactoryNames.set(entry.factory,names);}names.add(entry.name);}
 const publicEntries=Object.freeze(definitions.map(({name,factory,module})=>Object.freeze({name,factory,module})));
 linkedIndicatorModules.set(key,publicEntries);return publicEntries;
}
export function portableIndicatorFactory(name){return linkedIndicatorFactories.get(name)?.factory;}
export function portableIndicatorFactories(){return new Map([...linkedIndicatorFactories].map(([name,entry])=>[name,entry.factory]));}
export function indicatorModule(name){return linkedIndicatorFactories.get(name)?.module;}
export function requirePortableIndicator(name,factory){const entry=linkedIndicatorFactories.get(name);if(!entry||entry.factory!==factory||!linkedFactoryNames.get(factory)?.has(name))throw new UnsupportedIndicatorError(name);return entry.module;}
export function indicatorModuleDefinitions(id,version){moduleToken(id,'id');moduleInteger(version,'version');const definitions=linkedIndicatorModules.get(id+'@'+version);if(!definitions)throw new UnsupportedIndicatorError(id+'@'+version);return definitions;}
export function validateIndicatorModuleBinding(name,descriptor){
 const expected=indicatorModule(name);if(!expected){if(descriptor!==undefined)throw new TypeError('Indicator module descriptor binding');return undefined;}
 moduleRecord(descriptor,['id','version','stateVersion','exportName','causal'],'Indicator module descriptor');
 if(Object.keys(descriptor).length!==5||Object.keys(expected).some(key=>descriptor[key]!==expected[key]))throw new TypeError('Indicator module descriptor binding');return expected;
}
export function validateModuleCheckpoint(name,params,state,index){
 const entry=linkedIndicatorFactories.get(name);if(!entry)throw new UnsupportedIndicatorError(name);
 validateIndicatorParams(params);if(!Number.isSafeInteger(index)||index<0||index>4194304)throw new RangeError('Module checkpoint index');
 // The codec receives a detached state. It validates; it never repairs or
 // replaces the state that will be installed into the calculation instance.
 const text=safeCheckpointStringify(state),copy=safeCheckpointParse(text),before=safeCheckpointStringify(copy);
 const result=entry.validateCheckpoint(Object.freeze({...params}),copy,index);
 if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw new TypeError('Module checkpoint validator must be synchronous');}
 if(result===false||result!==undefined&&result!==true&&!Object.is(result,copy)||safeCheckpointStringify(copy)!==before)throw new TypeError('Module checkpoint validation failed or mutated state');return state;
}
