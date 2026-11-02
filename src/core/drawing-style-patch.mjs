import {portableStyle,canonicalKeys} from './contracts.mjs';
// Shared by explicit group styling and portable presets. No renderer defaults.
export function drawingStylePatch(value){
 if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError('Drawing style plain record required');
 const patch=Object.create(null),keys=Reflect.ownKeys(value);
 if(!keys.length)throw new TypeError('Drawing style nonempty defined patch required');
 // 허용 키를 먼저, 모르는 키는 UTF-16 순으로 본다. 빈 값과 모르는 필드가 섞여도 보고할 오류가 입력 순서와 상관없이 하나로 정해진다
 for(const key of canonicalKeys(value,['color','fill','width','font'],keys)){if(!['color','fill','width','font'].includes(key))throw new TypeError('Drawing style fields');const d=Object.getOwnPropertyDescriptor(value,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Drawing style own data fields required');if(d.value===undefined||d.value===null)throw new TypeError('Drawing style nonempty defined patch required');patch[key]=d.value;}
 const normalized=portableStyle(patch,['color','fill']);if(Object.hasOwn(normalized,'width')&&(!Number.isFinite(normalized.width)||normalized.width<.1||normalized.width>50))throw new RangeError('Stroke width');
 return normalized;
}
