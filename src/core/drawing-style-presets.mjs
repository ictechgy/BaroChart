import {ChartAPI} from './api.mjs';
import {DrawingStore} from './drawings.mjs';
import {identifier,RESOURCE_LIMITS} from './contracts.mjs';
import {drawingStylePatch} from './drawing-style-patch.mjs';

const presetStringify=JSON.stringify,presetApply=ChartAPI.prototype.setDrawingsStyle;
function presetOwn(value,key,required=true){const d=value&&Object.getOwnPropertyDescriptor(value,key);if(!d&&!required)return undefined;if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Drawing preset own data fields required');return d.value;}
function presetRecord(value,keys){if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError('Drawing preset plain record required');const out=Object.create(null);for(const key of Reflect.ownKeys(value)){if(!keys.includes(key))throw new TypeError('Drawing preset fields');const d=Object.getOwnPropertyDescriptor(value,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Drawing preset enumerable data fields required');out[key]=d.value;}return out;}
function presetName(value){if(typeof value!=='string'||value.length>128)throw new TypeError('Drawing preset name: string limit 128');const name=value.trim();if(!name.length||name.length>64||/[\u0000-\u001f\u007f-\u009f]/.test(value)||['__proto__','constructor','prototype'].includes(name))throw new TypeError('Drawing preset name: 1..64 trimmed characters, no controls/reserved names');return name;}
function presetOptions(value){const o=presetRecord(value,['replace']);if(Object.hasOwn(o,'replace')&&typeof o.replace!=='boolean')throw new TypeError('Drawing preset replace boolean required');return o.replace===true;}
function presetEntry(name,style){const patch=drawingStylePatch(style),ordered={};for(const key of ['color','fill','width','font'])if(Object.hasOwn(patch,key))ordered[key]=patch[key];return Object.freeze({name,style:Object.freeze(ordered)});}
function presetEqual(a,b){return !!a&&['color','fill','width','font'].every(k=>Object.hasOwn(a.style,k)===Object.hasOwn(b.style,k)&&Object.is(a.style[k],b.style[k]));}
function presetDocument(entries){return presetStringify({schema:'barochart.drawing-style-presets',version:1,presets:[...entries.values()]});}
function presetAdmission(entries){if(entries.size>64)throw new RangeError('Drawing preset count limit 64');if(presetDocument(entries).length>65536)throw new RangeError('Drawing preset document limit 65536');}
function presetReceipt(changed){return Object.freeze({changed});}

/** Host-owned, style-only patch registry. Never stores a chart, defaults or callbacks. */
export class DrawingStylePresets {
 #entries=new Map();
 get(name){return this.#entries.get(presetName(name));}
 list(){return Object.freeze([...this.#entries.values()]);}
 set(name,style,options={}){const replace=presetOptions(options),entry=presetEntry(presetName(name),style);return this.#merge([entry],replace);}
 #merge(entries,replace){const next=new Map(this.#entries);let changed=0;for(const entry of entries){const before=next.get(entry.name);if(before&&!replace)throw new Error('Drawing preset name already exists; explicit replace required');if(!presetEqual(before,entry)){next.set(entry.name,entry);changed++;}}presetAdmission(next);if(changed)this.#entries=next;return presetReceipt(changed);}
 remove(name){name=presetName(name);if(!this.#entries.has(name))return presetReceipt(0);const next=new Map(this.#entries);next.delete(name);this.#entries=next;return presetReceipt(1);}
 capture(api,id,name,options={}){
  // Validate registry inputs before reading chart state; never capture a preview.
  const replace=presetOptions(options),key=presetName(name);identifier(id,'Drawing id');
  if(!(api instanceof ChartAPI))throw new TypeError('ChartAPI required');const model=presetOwn(api,'model'),store=presetOwn(model,'drawings'),controller=presetOwn(api,'controller',false);
  if(presetOwn(model,'disposed',false))throw new Error('Chart disposed');if(!(store instanceof DrawingStore))throw new TypeError('Drawing preset managed store required');
  if(controller&&presetOwn(controller,'model')!==model)throw new Error('Drawing preset controller owner mismatch');
  if(presetOwn(store,'transaction',false)||controller&&presetOwn(controller,'gesture',false))throw new Error('Drawing preset capture requires no active gesture or transaction');
  const items=presetOwn(store,'items');if(!Array.isArray(items)||Object.getPrototypeOf(items)!==Array.prototype||items.length>RESOURCE_LIMITS.maxDrawings||Reflect.ownKeys(items).length!==items.length+1)throw new TypeError('Drawing preset managed array required');
  const seen=new Set();let source,sourceIndex;for(let i=0;i<items.length;i++){const drawing=presetOwn(items,String(i));if(!drawing||![Object.prototype,null].includes(Object.getPrototypeOf(drawing))||!Object.isFrozen(drawing))throw new TypeError('Drawing preset immutable drawing required');const current=presetOwn(drawing,'id');identifier(current,'Drawing id');if(seen.has(current))throw new TypeError('Duplicate drawing id');seen.add(current);if(current===id){source=drawing;sourceIndex=i;}}
  if(!source)throw new Error('Missing drawing');const style=presetOwn(source,'style',false);if(!style||!Object.isFrozen(style))throw new TypeError('Drawing preset capture needs a nonempty portable stored style');const entry=presetEntry(key,style);
  if(presetOwn(api,'model')!==model||presetOwn(model,'drawings')!==store||presetOwn(store,'items')!==items||presetOwn(model,'disposed',false)||presetOwn(api,'controller',false)!==controller||presetOwn(store,'transaction',false)||controller&&(presetOwn(controller,'model')!==model||presetOwn(controller,'gesture',false))||presetOwn(items,String(sourceIndex))!==source)throw new Error('Drawing preset capture owner changed');
  return this.#merge([entry],replace);
 }
 apply(api,ids,name){const entry=this.#entries.get(presetName(name));if(!entry)throw new Error('Missing drawing preset');if(!(api instanceof ChartAPI))throw new TypeError('ChartAPI required');const receipt=presetApply.call(api,ids,entry.style);return Object.freeze({changed:receipt.changed,invalidationFailed:receipt.invalidationFailed});}
 save(){return presetDocument(this.#entries);}
 load(text,options={}){
  const replace=presetOptions(options);if(typeof text!=='string'||text.length>65536)throw new TypeError('Drawing preset document: string limit 65536');
  const doc=presetRecord(JSON.parse(text),['schema','version','presets']);if(doc.schema!=='barochart.drawing-style-presets'||doc.version!==1)throw new TypeError('Drawing preset schema/version');const rows=doc.presets;
  if(!Array.isArray(rows)||rows.length>64)throw new RangeError('Drawing preset count limit 64');const entries=[],names=new Set();for(const row of rows){const r=presetRecord(row,['name','style']),entry=presetEntry(presetName(r.name),r.style);if(names.has(entry.name))throw new TypeError('Duplicate drawing preset name');names.add(entry.name);entries.push(entry);}return this.#merge(entries,replace);
 }
}
