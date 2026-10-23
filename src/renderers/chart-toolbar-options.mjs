import {DRAWING_TYPES} from '../core/drawings.mjs';
const tools=['select',...DRAWING_TYPES],actions=['fit','zoomIn','zoomOut','undo','redo'];
const labelIds=new Set([...tools,...actions]);
const emptyLabels=Object.freeze({});
export const DEFAULT_TOOLBAR_OPTIONS=Object.freeze({label:'Chart tools',tools:Object.freeze(['select','trendline','horizontal','rectangle']),actions:Object.freeze([...actions]),orientation:'horizontal',density:'comfortable',labels:emptyLabels});
function toolbarLabel(value){
 if(typeof value!=='string'||!value.trim()||value.length>128)throw new TypeError('Toolbar label string limit 128');
 for(let i=0;i<value.length;i++){
  const code=value.charCodeAt(i);
  if(code>=0xd800&&code<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw new TypeError('Toolbar label Unicode scalar');}
  else if(code>=0xdc00&&code<=0xdfff)throw new TypeError('Toolbar label Unicode scalar');
 }
 return value;
}
function toolbarLabels(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError('Toolbar labels: plain object required');
 const next={};
 for(const key of Reflect.ownKeys(value)){
  if(typeof key!=='string'||!labelIds.has(key))throw new TypeError('Unknown toolbar label');
  const field=Object.getOwnPropertyDescriptor(value,key);
  if(!field||!field.enumerable||!Object.hasOwn(field,'value'))throw new TypeError('Toolbar labels require enumerable own values');
  Object.defineProperty(next,key,{value:toolbarLabel(field.value),enumerable:true,writable:true,configurable:true});
 }
 return Object.freeze(next);
}
export function chartToolbarOptions(patch,previous=DEFAULT_TOOLBAR_OPTIONS){
 if(!patch||typeof patch!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(patch)))throw new TypeError('Toolbar options: plain object required');
 const next={...previous};
 next.labels=previous.labels??emptyLabels;
 for(const key of Reflect.ownKeys(patch)){
  if(!Object.hasOwn(DEFAULT_TOOLBAR_OPTIONS,key))throw new TypeError('Unknown toolbar option');
  const field=Object.getOwnPropertyDescriptor(patch,key);if(!Object.hasOwn(field,'value'))throw new TypeError('Toolbar options require own values');const value=field.value;
  if(key==='tools'||key==='actions'){
   const allowed=key==='tools'?tools:actions;
   if(!Array.isArray(value)||value.length>allowed.length)throw new TypeError('Toolbar ID list');
   const copy=[];for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value')||!allowed.includes(d.value)||copy.includes(d.value))throw new TypeError('Toolbar IDs must be supported and unique');copy.push(d.value);}
   if(key==='tools'&&!copy.includes('select'))throw new TypeError('Toolbar must include select');next[key]=Object.freeze(copy);
  }else if(key==='labels')next.labels=toolbarLabels(value);
  else{
   if(key==='label'?(typeof value!=='string'||!value.trim()||value.length>128):key==='orientation'?!['horizontal','vertical'].includes(value):!['comfortable','compact'].includes(value))throw new TypeError('Invalid toolbar '+key);
   next[key]=value;
  }
 }
 return Object.freeze(next);
}
