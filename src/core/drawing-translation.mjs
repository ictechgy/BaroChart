import {drawingStylePatch} from './drawing-style-patch.mjs';
import {DrawingStore} from './drawings.mjs';
import {drawingDocumentVersion} from './position-drawing.mjs';
import {validateDrawing} from './drawing-validation.mjs';
import {identifier,RESOURCE_LIMITS} from './contracts.mjs';

const translationStringify=JSON.stringify,translationDefine=Object.defineProperty;
function translationSlot(object,key,required=false){const d=Object.getOwnPropertyDescriptor(object,key);if(!d){if(required)throw new TypeError('Drawing group edit missing '+key);return undefined;}if(!Object.hasOwn(d,'value'))throw new TypeError('Drawing group edit own data properties required');return d.value;}
function translationRecord(value,keys){if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError('Drawing group edit plain record required');const out=Object.create(null);for(const key of Reflect.ownKeys(value)){if(typeof key!=='string'||!keys.includes(key))throw new TypeError('Drawing group edit fields');const d=Object.getOwnPropertyDescriptor(value,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Drawing group edit own data fields required');out[key]=d.value;}return out;}
function translationList(value,max){if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)throw new TypeError('Drawing group edit plain array required');const n=translationSlot(value,'length',true);if(n>max||Reflect.ownKeys(value).length!==n+1)throw new RangeError('Drawing group edit array limit/shape');const result=[];for(let i=0;i<n;i++)result.push(translationSlot(value,String(i),true));return result;}
function translationStale(){throw new Error('Drawing group edit owner changed');}
function translationCapture(object,keys,guards,writes=[]){if(!object||typeof object!=='object')throw new TypeError('Drawing group edit managed owner required');const state=Object.create(null);for(const key of keys){state[key]=translationSlot(object,key);if(writes.includes(key)){const d=Object.getOwnPropertyDescriptor(object,key);if(!d?.writable)throw new TypeError('Drawing group edit writable own state required');}}guards.push(()=>{for(const key of keys)if(!Object.is(translationSlot(object,key),state[key]))translationStale();});return state;}
function translationCapturedList(value,max,guards){const copy=translationList(value,max);guards.push(()=>{if(translationSlot(value,'length')!==copy.length)translationStale();for(let i=0;i<copy.length;i++)if(translationSlot(value,String(i))!==copy[i])translationStale();});return copy;}
function translationDrawing(value){
 if(!Object.isFrozen(value))throw new TypeError('Drawing group edit requires immutable managed drawings');
 const d=translationRecord(value,['id','type','panel','points','style','text','locked','visible','axisId','seriesId']);
 if(!Object.isFrozen(d.points))throw new TypeError('Drawing group edit immutable anchors required');
 d.points=translationList(d.points,2048).map(point=>{if(!Object.isFrozen(point))throw new TypeError('Drawing group edit immutable anchor required');return translationRecord(point,['time','price']);});
 if(d.style!==undefined){if(!Object.isFrozen(d.style))throw new TypeError('Drawing group edit immutable style required');d.style=translationRecord(d.style,['color','fill','width','font']);}
 validateDrawing(d);return d;
}
// JSON character count without invoking toJSON or caller array/object methods.
function translationChars(value){if(value===null)return 4;if(typeof value!=='object')return translationStringify(value).length;if(Array.isArray(value)){let n=2;for(let i=0;i<value.length;i++)n+=(i?1:0)+translationChars(value[i]);return n;}let n=2,count=0;for(const key of Object.keys(value)){if(value[key]===undefined)continue;n+=(count++?1:0)+translationStringify(key).length+1+translationChars(value[key]);}return n;}
function translationFrozen(d){for(const p of d.points)Object.freeze(p);Object.freeze(d.points);if(d.style)Object.freeze(d.style);return Object.freeze(d);}

/** Explicit raw-coordinate group edit. No indicator/layout computation. */
export function translateDrawings(api,ids,options,ownerGuard=null){return drawingGroupEdit(api,ids,options,false,false,false,false,ownerGuard);}
/** Mixed and orphan bindings may be removed without querying live metadata. */
export function deleteDrawings(api,ids,ownerGuard=null){return drawingGroupEdit(api,ids,null,true,false,false,false,ownerGuard);}
/** Partial portable style patch; mixed/orphan bindings require no live lookup. */
export function setDrawingsStyle(api,ids,patch,ownerGuard=null){return drawingGroupEdit(api,ids,patch,false,true,false,false,ownerGuard);}
/** Presentation visibility may change locked or orphan drawings, without live metadata. */
export function setDrawingsVisibility(api,ids,visible,ownerGuard=null){return drawingGroupEdit(api,ids,visible,false,false,true,false,ownerGuard);}
/** Append unlocked copies in source z-order; zero offsets may retain orphan bindings. */
export function duplicateDrawings(api,ids,options,ownerGuard=null){return drawingGroupEdit(api,ids,options,false,false,false,true,ownerGuard);}
function drawingGroupEdit(api,ids,options,remove,styleEdit=false,visibilityEdit=false,duplicateEdit=false,ownerGuard=null){
 if(ownerGuard!==null&&typeof ownerGuard!=='function')throw new TypeError('Owner guard callback required');ownerGuard?.();
 const duplicateOptions=duplicateEdit?translationRecord(options,['deltaTimeMs','deltaPrice']):null;
 const metadata=!(remove||styleEdit||visibilityEdit||duplicateEdit&&duplicateOptions.deltaTimeMs===0&&duplicateOptions.deltaPrice===0);
 const guards=[],a=translationCapture(api,['model','controller','invalidate'],guards),model=a.model;if(ownerGuard)guards.push(ownerGuard);
 const m=translationCapture(model,!metadata?['disposed','drawings']:['disposed','drawings','panels','axes','series'],guards);
 if(m.disposed)throw new Error('Chart disposed');if(!(m.drawings instanceof DrawingStore))throw new TypeError('Drawing group edit managed store required');
 const d=m.drawings,s=translationCapture(d,['items','undoStack','redoStack','selected','serial','transaction','maxDrawings','maxPoints','maxDocumentChars','historyLimit','historyBytes','retainedHistoryBytes'],guards,['items','undoStack','redoStack']);
 const retained=Object.getOwnPropertyDescriptor(d,'retainedHistoryBytes');if(retained&&!retained.writable||!retained&&!Object.isExtensible(d))throw new TypeError('Drawing group edit writable history accounting required');
 const c=a.controller?translationCapture(a.controller,['model','gesture'],guards):null;
 if(c&&c.model!==model)throw new Error('Drawing group edit controller owner mismatch');if(s.transaction||c?.gesture)throw new Error('Drawing group edit requires no active gesture or transaction');
 const items=translationCapturedList(s.items,RESOURCE_LIMITS.maxDrawings,guards),undo=translationCapturedList(s.undoStack,10000,guards),redo=translationCapturedList(s.redoStack,10000,guards);
 const panels=!metadata?null:translationCapturedList(m.panels,RESOURCE_LIMITS.maxPanels,guards).map(p=>translationCapture(p,['id'],guards));
 const axes=!metadata?null:translationCapturedList(m.axes,RESOURCE_LIMITS.maxAxes,guards).map(p=>translationCapture(p,['id','panel'],guards));
 const series=!metadata?null:translationCapturedList(m.series,RESOURCE_LIMITS.maxSeries,guards).map(p=>translationCapture(p,['id','panel','axisId'],guards));
 const keys=translationList(ids,128),o=duplicateOptions??(remove||visibilityEdit?null:translationRecord(options,styleEdit?['color','fill','width','font']:['deltaTimeMs','deltaPrice']));
 if(!keys.length)throw new RangeError('Drawing group edit requires 1..128 ids');
 const selected=new Set();for(const id of keys){identifier(id,'Drawing id');if(selected.has(id))throw new TypeError('Duplicate drawing id');selected.add(id);}
 if(visibilityEdit&&typeof options!=='boolean')throw new TypeError('Drawing visibility boolean required');
 if(!remove&&!styleEdit&&!visibilityEdit&&(!Number.isFinite(o.deltaTimeMs)||!Number.isFinite(o.deltaPrice)))throw new TypeError('Finite deltaTimeMs and deltaPrice required');
 const patch=styleEdit?drawingStylePatch(o):null;
 for(const [key,max,min] of [['maxDrawings',10000,0],['maxPoints',2097152,0],['maxDocumentChars',RESOURCE_LIMITS.maxDocumentChars,0],['historyLimit',10000,1],['historyBytes',RESOURCE_LIMITS.maxHistoryBytes,0]])if(!Number.isSafeInteger(s[key])||s[key]<min||s[key]>max)throw new RangeError('Drawing group edit history/resource limit');
 const copies=new Map(),weights=new Map(),copy=value=>{let result=copies.get(value);if(!result){result=translationDrawing(value);copies.set(value,result);weights.set(value,2*translationChars(result));}return result;};
 let next=items.slice();const seen=new Set();let clearSelected=remove&&selected.has(s.selected);
 let binding=null,changed=0,points=0,text=0,nextSerial=s.serial;const pendingCopies=[],created=[];
 if(duplicateEdit){if(!Number.isSafeInteger(nextSerial)||nextSerial<0)throw new RangeError('Drawing duplication serial');const writable=()=>{const descriptor=Object.getOwnPropertyDescriptor(d,'serial');if(!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.writable)throw new TypeError('Drawing duplication writable serial required');};writable();guards.push(writable);}
 for(let i=0;i<items.length;i++){
  const rawPoints=translationSlot(items[i],'points',true);if(!Array.isArray(rawPoints))throw new TypeError('Drawing anchors');points+=translationSlot(rawPoints,'length',true);if(points>s.maxPoints)throw new RangeError('Drawing group edit point limit');
  const before=copy(items[i]);if(seen.has(before.id))throw new TypeError('Duplicate drawing id');seen.add(before.id);text+=before.text?.length??0;
  if(!selected.has(before.id))continue;
  if(before.locked&&!visibilityEdit&&!duplicateEdit)throw new Error('Drawing is locked');
  if(remove){next[i]=null;changed++;continue;}
  if(visibilityEdit){if((before.visible!==false)!==options){const candidate={...before,visible:options,points:translationSlot(items[i],'points')};if(before.style!==undefined)candidate.style=translationSlot(items[i],'style');validateDrawing(candidate);next[i]=translationFrozen(candidate);changed++;if(!options&&s.selected===before.id)clearSelected=true;}continue;}
  if(styleEdit){const previous=before.style??{},different=Object.keys(patch).some(key=>!Object.hasOwn(previous,key)||!Object.is(previous[key],patch[key]));if(different){const candidate={...before,points:translationSlot(items[i],'points'),style:{...previous,...patch}};validateDrawing(candidate);next[i]=translationFrozen(candidate);changed++;}continue;}
  if(metadata){const b=[before.panel,before.axisId??null,before.seriesId??null];if(binding&&b.some((v,j)=>v!==binding[j]))throw new Error('Drawing group edit requires identical panel/axis/series binding');binding=b;
  if(!panels.some(p=>p.id===b[0])||b[1]!==null&&!axes.some(p=>p.id===b[1]&&p.panel===b[0])||b[2]!==null&&!series.some(p=>p.id===b[2]&&p.panel===b[0]&&(p.axisId??null)===b[1]))throw new Error('Missing or mismatched drawing binding');}
  let moved=false;const anchors=before.points.map(p=>{const time=o.deltaTimeMs===0?p.time:p.time+o.deltaTimeMs,price=o.deltaPrice===0?p.price:p.price+o.deltaPrice;if(time!==p.time||price!==p.price)moved=true;return {time,price};});
  const candidate={...before,points:duplicateEdit&&!metadata?translationSlot(items[i],'points'):anchors,...(duplicateEdit?{locked:false}:{})};if(before.style!==undefined)candidate.style=translationSlot(items[i],'style');validateDrawing(candidate);if(duplicateEdit){pendingCopies.push(candidate);changed++;}else if(moved){next[i]=translationFrozen(candidate);changed++;}
 }
 if(keys.some(id=>!seen.has(id)))throw new Error('Missing drawing');if(items.length>s.maxDrawings||points>s.maxPoints||text>1000000)throw new RangeError('Drawing group edit resource limit');
 if(duplicateEdit){
  for(const candidate of pendingCopies){points+=candidate.points.length;text+=candidate.text?.length??0;}
  if(items.length+pendingCopies.length>s.maxDrawings||points>s.maxPoints||text>1000000)throw new RangeError('Drawing duplication resource limit');
  // At most one collision for each existing/reserved ID; never scan a numeric range.
  let attempts=0;for(const candidate of pendingCopies){let id;do{if(nextSerial===Number.MAX_SAFE_INTEGER||++attempts>items.length+pendingCopies.length)throw new RangeError('Drawing duplication ID exhaustion');id='drawing-'+(++nextSerial);}while(seen.has(id));seen.add(id);created.push(Object.freeze({sourceId:candidate.id,id}));next.push(translationFrozen({...candidate,id}));}
  // Exact document admission is O(total stored content), only on this explicit API.
  if(translationChars({schema:'aster.drawings',version:drawingDocumentVersion(next),drawings:next})>s.maxDocumentChars)throw new RangeError('Drawing duplication document limit');
 }
 if(remove)next=next.filter(value=>value!==null);
 if(clearSelected){const writable=()=>{const descriptor=Object.getOwnPropertyDescriptor(d,'selected');if(!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.writable)throw new TypeError('Drawing group edit writable selection required');};writable();guards.push(writable);}
 const receipt={changed,...(duplicateEdit?{created:Object.freeze(created)}:{}),invalidationFailed:false};
 if(!changed){for(const check of guards)check();return receipt;}
 const snapshotWeight=snapshot=>{let n=snapshot.length*8;for(const value of snapshot){copy(value);n+=weights.get(value);}return n;};
 const priorWeight=snapshotWeight(items);if(priorWeight>s.historyBytes)throw new RangeError('Drawing group edit undo snapshot exceeds historyBytes');
 const history=[],historyWeights=[];let priorHistoryBytes=0;
 for(const snapshot of undo){const rows=translationCapturedList(snapshot,s.maxDrawings,guards),weight=snapshotWeight(rows);priorHistoryBytes+=weight;if(priorHistoryBytes>RESOURCE_LIMITS.maxHistoryBytes)throw new RangeError('Drawing group edit retained history resource limit');history.push(rows);historyWeights.push(weight);}
 history.push(items);historyWeights.push(priorWeight);
 let retainedBytes=historyWeights.reduce((x,y)=>x+y,0),start=0;while(history.length-start>s.historyLimit||retainedBytes>s.historyBytes)retainedBytes-=historyWeights[start++];
 const nextUndo=history.slice(start),nextRedo=[];
 // All validation/history sizing is complete before publication. No overridable
 // begin/commit/trim/weight method or serializer is called after this guard.
 for(const check of guards)check();
 translationDefine(d,'items',{value:next});translationDefine(d,'undoStack',{value:nextUndo});translationDefine(d,'redoStack',{value:nextRedo});translationDefine(d,'retainedHistoryBytes',retained?{value:retainedBytes}:{value:retainedBytes,writable:true,enumerable:true,configurable:true});
 if(clearSelected)translationDefine(d,'selected',{value:null});
 if(duplicateEdit)translationDefine(d,'serial',{value:nextSerial});
 try{if(visibilityEdit||duplicateEdit)a.invalidate.call(api,'drawings');else a.invalidate.call(api);}catch{receipt.invalidationFailed=true;}
 return duplicateEdit?Object.freeze(receipt):receipt;
}
