// Opt-in host-declared primary price context. This is not data authentication.
import {ChartAPI} from './api.mjs';
import {ChartModel} from './model.mjs';
import {DrawingStore} from './drawings.mjs';
import {boundedText} from './contracts.mjs';

const boundDrawingIdentityKeys=['symbolId','exchange','priceUnit','timeframe','adjustment','adjustmentVersion'];
const boundDrawingEnvelopeKeys=['schema','version','identity','document'];
// Six 128-code-unit fields may each expand sixfold in JSON. The remaining
// fixed keys/schema fit within this allowance; the inner limit is unchanged.
const boundDrawingOverhead=8192;
function boundDrawingOwn(value,key,optional=false){
 const d=value&&Object.getOwnPropertyDescriptor(value,key);if(!d&&optional)return undefined;
 if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Bound drawing own data fields required');
 return d.value;
}
function boundDrawingRecord(value,keys,label){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError(label+' plain object required');
 const own=Reflect.ownKeys(value);if(own.length!==keys.length||own.some(key=>typeof key!=='string'||!keys.includes(key)))throw new TypeError(label+' fields');
 const out={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError(label+' own data fields');out[key]=d.value;}return out;
}
function boundDrawingIdentity(value){
 const identity=boundDrawingRecord(value,boundDrawingIdentityKeys,'Drawing identity');
 for(const key of boundDrawingIdentityKeys){boundedText(identity[key],128,'Drawing identity '+key);if(!identity[key].trim())throw new TypeError('Drawing identity nonblank '+key);}
 if(!['raw','split','total-return'].includes(identity.adjustment))throw new TypeError('Drawing identity adjustment');
 return identity;
}
function boundDrawingOwner(chart,identity){
 if(!(chart instanceof ChartAPI))throw new TypeError('Actual ChartAPI required');
 const model=boundDrawingOwn(chart,'model'),controller=boundDrawingOwn(chart,'controller',true);
 if(!(model instanceof ChartModel)||boundDrawingOwn(model,'disposed',true))throw new Error('Chart disposed');
 const store=boundDrawingOwn(model,'drawings'),symbol=boundDrawingOwn(model,'symbol',true);
 if(!(store instanceof DrawingStore))throw new TypeError('Bound drawing managed store required');
 if(controller&&boundDrawingOwn(controller,'model')!==model)throw new Error('Bound drawing controller owner mismatch');
 if(boundDrawingOwn(store,'transaction',true)||controller&&(boundDrawingOwn(controller,'gesture',true)||boundDrawingOwn(controller,'pointers',true)?.size))throw new Error('Commit or cancel gestures before bound drawing persistence');
 // Available symbol metadata is a consistency check only. Missing metadata
 // does not prove anything about the host's bars, venue or timeframe.
 if(symbol){for(const [field,key] of [['id','symbolId'],['exchange','exchange'],['currency','priceUnit'],['adjustment','adjustment'],['adjustmentVersion','adjustmentVersion']]){
  const d=Object.getOwnPropertyDescriptor(symbol,field);
  if(field==='adjustmentVersion'&&(!d||Object.hasOwn(d,'value')&&d.value===undefined))continue;
  if(!d||!Object.hasOwn(d,'value')||d.value!==identity[key])throw new TypeError('Drawing identity conflicts with chart symbol '+field);
 }}
 return {model,controller,store,symbol};
}
function boundDrawingOwnerSame(chart,identity,before){
 const after=boundDrawingOwner(chart,identity);
 if(Object.keys(before).some(key=>after[key]!==before[key]))throw new Error('Bound drawing owner changed');
}
function boundDrawingPrimary(items){
 if(!Array.isArray(items))throw new TypeError('Bound drawing list required');
 for(let i=0;i<items.length;i++){const drawing=boundDrawingOwn(items,String(i));if(!drawing||boundDrawingOwn(drawing,'panel')!=='price'||boundDrawingOwn(drawing,'axisId',true)!=null||boundDrawingOwn(drawing,'seriesId',true)!=null)throw new TypeError('Bound drawings require the primary price panel without axis/series bindings');}
}
export function saveBoundDrawings(chart,identity){
 const binding=boundDrawingIdentity(identity),owner=boundDrawingOwner(chart,binding),items=boundDrawingOwn(owner.store,'items');
 boundDrawingPrimary(items);boundDrawingOwnerSame(chart,binding,owner);
 const document=DrawingStore.prototype.save.call(owner.store);
 const prefix=JSON.stringify({schema:'barochart.bound-drawings',version:1,identity:binding}).slice(0,-1)+',"document":';
 const text=prefix+document+'}';
 boundedText(text,boundDrawingOwn(owner.store,'maxDocumentChars')+boundDrawingOverhead,'Bound drawing document',true);
 boundDrawingOwnerSame(chart,binding,owner);if(boundDrawingOwn(owner.store,'items')!==items)throw new Error('Bound drawing items changed during save');
 return text;
}
export function loadBoundDrawings(chart,text,expectedIdentity){
 const expected=boundDrawingIdentity(expectedIdentity),owner=boundDrawingOwner(chart,expected);
 boundedText(text,boundDrawingOwn(owner.store,'maxDocumentChars')+boundDrawingOverhead,'Bound drawing document',true);
 const envelope=boundDrawingRecord(JSON.parse(text),boundDrawingEnvelopeKeys,'Bound drawing document');
 if(envelope.schema!=='barochart.bound-drawings'||envelope.version!==1)throw new TypeError('Bound drawing schema/version');
 const actual=boundDrawingIdentity(envelope.identity);
 if(boundDrawingIdentityKeys.some(key=>actual[key]!==expected[key]))throw new TypeError('Drawing identity mismatch');
 boundDrawingPrimary(envelope.document?.drawings);
 // Existing load checks the nested schema, target panel, portable styles,
 // normalized serialized size and resources before its one history commit.
 // Its final inner limit plus the bounded identity fits the envelope limit.
 const document=JSON.stringify(envelope.document);boundDrawingOwnerSame(chart,expected,owner);
 return ChartAPI.prototype.loadDrawings.call(chart,document);
}
