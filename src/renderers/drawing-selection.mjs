import {ChartAPI} from '../core/api.mjs';
import {DrawingStore,DRAWING_TYPES} from '../core/drawings.mjs';
import {identifier,RESOURCE_LIMITS} from '../core/contracts.mjs';
const results=new WeakMap(),controllers=new WeakMap();
export function selectionVersion(controller){const c=controllers.get(controller);return !c||c.disposed?NaN:c.generation;}
export function selectionResultCurrent(controller,receipt){const r=results.get(receipt),c=controllers.get(controller);return !!r&&!!c&&r.token===c.token&&r.generation===c.generation&&r.current&&!c.disposed;}
const style=ChartAPI.prototype.setDrawingsStyle,remove=ChartAPI.prototype.deleteDrawings;
function own(object,key,required=true){const d=Object.getOwnPropertyDescriptor(object,key);if(!d&&!required)return undefined;if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Drawing selection requires own data properties');return d.value;}
function dataIs(object,key,value){const d=Object.getOwnPropertyDescriptor(object,key);return !!d&&Object.hasOwn(d,'value')&&Object.is(d.value,value);}
// Validate every source row, but retain metadata only for the bounded page and
// the at-most-128 selected IDs. The duplicate-ID Set intentionally remains O(n).
function scanRows(store,selected,offset=0,limit=32,targetId=null){
 const items=own(store,'items');if(!Array.isArray(items)||Object.getPrototypeOf(items)!==Array.prototype)throw new TypeError('Drawing selection array');const total=own(items,'length');if(total>RESOURCE_LIMITS.maxDrawings||Reflect.ownKeys(items).length!==total+1)throw new RangeError('Drawing selection source limit');
 const page=[],ids=new Set(),live=new Map();let target=null;
 for(let i=0;i<total;i++){const drawing=own(items,String(i));if(!drawing||![Object.prototype,null].includes(Object.getPrototypeOf(drawing))||!Object.isFrozen(drawing))throw new TypeError('Drawing selection immutable drawings required');const id=own(drawing,'id');identifier(id,'Drawing id');if(ids.has(id))throw new TypeError('Duplicate drawing id');ids.add(id);const type=own(drawing,'type'),panel=own(drawing,'panel'),locked=own(drawing,'locked',false);if(!DRAWING_TYPES.includes(type)||locked!==undefined&&typeof locked!=='boolean')throw new TypeError('Drawing selection metadata');identifier(panel,'Drawing panel');
  if(selected.has(id))live.set(id,drawing);if(id===targetId)target={id,drawing};if(i>=offset&&i<offset+limit)page.push({drawing,id,type,panel,locked:locked===true});
 }return{page,live,target,total,offset,limit};
}
function pageOptions(options){if(!options||Object.getPrototypeOf(options)!==Object.prototype)throw new TypeError('Drawing selection page');for(const k of Reflect.ownKeys(options))if(!['offset','limit'].includes(k))throw new TypeError('Drawing selection page fields');const offset=Object.hasOwn(options,'offset')?own(options,'offset'):0,limit=Object.hasOwn(options,'limit')?own(options,'limit'):32;if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>32)throw new RangeError('Drawing selection page bounds');return{offset,limit};}
/** Session-local explicit selection. Does not replace the canvas's single selected handle. */
export class DrawingSelectionController {
 #api;#model;#store;#selected=new Map();#generation=0;#disposed=false;
 constructor(api){if(!(api instanceof ChartAPI))throw new TypeError('ChartAPI required');this.#api=api;this.#model=own(api,'model');this.#store=own(this.#model,'drawings');if(!(this.#store instanceof DrawingStore))throw new TypeError('DrawingStore required');this.#source();controllers.set(this,{token:{},generation:0,disposed:false});}
 #advance(){this.#generation++;const c=controllers.get(this);if(c)c.generation=this.#generation;}
 #source(offset=0,limit=32,targetId=null){if(this.#disposed)throw new Error('Drawing selection disposed');if(own(this.#api,'model')!==this.#model||own(this.#model,'drawings')!==this.#store)throw new Error('Drawing selection owner changed');if(own(this.#model,'disposed',false))throw new Error('Chart disposed');return scanRows(this.#store,this.#selected,offset,limit,targetId);}
 #snapshot(source){return{rows:source.page.map(({drawing,...r})=>({...r,selected:this.#selected.get(r.id)===drawing})),total:source.total,selectedIds:[...this.#selected.keys()],selectedCount:this.#selected.size,staleCount:[...this.#selected].filter(([id,d])=>(source.target?.id===id?source.target.drawing:source.live.get(id))!==d).length,offset:source.offset,limit:source.limit};}
 #prune(source){let changed=false;for(const[id,drawing]of this.#selected)if(source.live.get(id)!==drawing){this.#selected.delete(id);changed=true;}if(changed)this.#advance();}
 select(id,selected=true){identifier(id,'Drawing id');if(typeof selected!=='boolean')throw new TypeError('Boolean selection required');const source=this.#source(0,32,id),entry=source.target;if(!entry)throw new Error('Missing drawing');if(selected){if(!this.#selected.has(id)&&this.#selected.size===128)throw new RangeError('Drawing selection limit 128');if(this.#selected.get(id)!==entry.drawing){this.#selected.set(id,entry.drawing);this.#advance();}}else if(this.#selected.delete(id))this.#advance();return this.#snapshot(source);}
 clear(){const source=this.#source();this.#selected.clear();this.#advance();return this.#snapshot(source);}
 refresh(){const source=this.#source();this.#prune(source);return this.#snapshot(source);}
 snapshot(options={}){const{offset,limit}=pageOptions(options);return this.#snapshot(this.#source(offset,limit));}
 #apply(operation,patch){const source=this.#source(0,0);if([...this.#selected].some(([id,d])=>source.live.get(id)!==d)){this.#prune(source);const error=new Error('Drawing selection changed; refresh and select again');error.code='STALE_SELECTION';throw error;}if(!this.#selected.size)throw new Error('Select at least one drawing');const generation=this.#generation,api=this.#api,model=this.#model,store=this.#store,ids=[...this.#selected.keys()];const receipt=operation===style?operation.call(api,ids,patch):operation.call(api,ids);const disposed=Object.getOwnPropertyDescriptor(model,'disposed'),current=!this.#disposed&&this.#generation===generation&&this.#api===api&&dataIs(api,'model',model)&&dataIs(model,'drawings',store)&&(!disposed||Object.hasOwn(disposed,'value')&&!disposed.value);if(receipt.changed>0&&current){this.#selected.clear();this.#advance();}const state=controllers.get(this);results.set(receipt,{token:state.token,generation:this.#generation,current});return receipt;}
 applyStyle(patch){return this.#apply(style,patch);}
 deleteSelected(){return this.#apply(remove);}
 dispose(){if(this.#disposed)return;this.#disposed=true;controllers.get(this).disposed=true;this.#advance();this.#selected.clear();this.#api=null;this.#model=null;this.#store=null;}
}
