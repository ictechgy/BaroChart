import {optionRecord} from './contracts.mjs';
// Parameters remain JSON primitives. The calendar field holds a separately
// validated declarative schedule, never a provider function or module source.
export function validateIndicatorParams(params) {
 if(!params||typeof params!=='object')throw new TypeError('Indicator params');
 optionRecord(params,Object.keys(params),'Indicator params');
 const descriptors=Object.getOwnPropertyDescriptors(params),keys=Reflect.ownKeys(descriptors);
 if(keys.length>32)throw new TypeError('Indicator parameter count');
 for(const key of keys){
  const d=descriptors[key];if(typeof key!=='string'||!d.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Indicator parameter data properties');
  const v=d.value;if(typeof v==='number'? !Number.isFinite(v):typeof v!=='string'||v.length>(key==='calendar'?65536:256))throw new TypeError('Indicator parameter values');
 }
 return params;
}
