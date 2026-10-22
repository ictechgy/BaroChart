import {DRAWING_TYPES} from '../core/drawings.mjs';
const tools=['select',...DRAWING_TYPES],actions=['fit','zoomIn','zoomOut','undo','redo'];
export const DEFAULT_TOOLBAR_OPTIONS=Object.freeze({label:'Chart tools',tools:Object.freeze(['select','trendline','horizontal','rectangle']),actions:Object.freeze([...actions]),orientation:'horizontal',density:'comfortable'});
export function chartToolbarOptions(patch,previous=DEFAULT_TOOLBAR_OPTIONS){
 if(!patch||typeof patch!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(patch)))throw new TypeError('Toolbar options: plain object required');
 const next={...previous};
 for(const key of Reflect.ownKeys(patch)){
  if(!Object.hasOwn(DEFAULT_TOOLBAR_OPTIONS,key))throw new TypeError('Unknown toolbar option');
  const field=Object.getOwnPropertyDescriptor(patch,key);if(!Object.hasOwn(field,'value'))throw new TypeError('Toolbar options require own values');const value=field.value;
  if(key==='tools'||key==='actions'){
   const allowed=key==='tools'?tools:actions;
   if(!Array.isArray(value)||value.length>allowed.length)throw new TypeError('Toolbar ID list');
   const copy=[];for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value')||!allowed.includes(d.value)||copy.includes(d.value))throw new TypeError('Toolbar IDs must be supported and unique');copy.push(d.value);}
   if(key==='tools'&&!copy.includes('select'))throw new TypeError('Toolbar must include select');next[key]=Object.freeze(copy);
  }else{
   if(key==='label'?(typeof value!=='string'||!value.trim()||value.length>128):key==='orientation'?!['horizontal','vertical'].includes(value):!['comfortable','compact'].includes(value))throw new TypeError('Invalid toolbar '+key);
   next[key]=value;
  }
 }
 return Object.freeze(next);
}
