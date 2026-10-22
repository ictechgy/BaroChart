import {portableStyle} from './contracts.mjs';
// Shared by explicit group styling and portable presets. No renderer defaults.
export function drawingStylePatch(value){
 if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError('Drawing style plain record required');
 const patch=Object.create(null),keys=Reflect.ownKeys(value);
 if(!keys.length)throw new TypeError('Drawing style nonempty defined patch required');
 for(const key of keys){if(!['color','fill','width','font'].includes(key))throw new TypeError('Drawing style fields');const d=Object.getOwnPropertyDescriptor(value,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Drawing style own data fields required');if(d.value===undefined||d.value===null)throw new TypeError('Drawing style nonempty defined patch required');patch[key]=d.value;}
 const normalized=portableStyle(patch,['color','fill']);if(Object.hasOwn(normalized,'width')&&(!Number.isFinite(normalized.width)||normalized.width<.1||normalized.width>50))throw new RangeError('Stroke width');
 return normalized;
}
