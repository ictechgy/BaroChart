// Web input preferences only. Core/programmatic commands remain available.
export const DEFAULT_INTERACTION_OPTIONS=Object.freeze({pointer:true,wheelZoom:true,keyboardShortcuts:true,hitTolerancePx:8});
export function interactionOptions(patch,previous=DEFAULT_INTERACTION_OPTIONS){
 if(!patch||typeof patch!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(patch)))throw new TypeError('Interaction options: plain object required');
 const next={...previous};
 for(const key of Reflect.ownKeys(patch)){
  if(!Object.hasOwn(DEFAULT_INTERACTION_OPTIONS,key))throw new TypeError('Unknown interaction option');
  const field=Object.getOwnPropertyDescriptor(patch,key);if(!Object.hasOwn(field,'value'))throw new TypeError('Interaction options require own values');
  const value=field.value;
  if(key==='hitTolerancePx'){if(!Number.isFinite(value)||value<1||value>32)throw new RangeError('Hit tolerance must be 1..32 logical pixels');}
  else if(typeof value!=='boolean')throw new TypeError('Interaction switches require booleans');
  next[key]=value;
 }
 return Object.freeze(next);
}
