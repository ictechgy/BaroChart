import {optionRecord,identifier} from './contracts.mjs';
import {nearestVisibleOHLC} from './ohlc-snap.mjs';

// Metadata belongs to a particular raw pointer object, never the model's JSON
// cursor shape. Weak keys and opaque owner tokens do not retain controllers.
const pointerSnapRequests=new WeakMap();
export function crosshairSnapOptions(model,options){
 optionRecord(options,['mode','target'],'Crosshair snap');const mode=options.mode;
 if(!['free','close','ohlc'].includes(mode))throw new TypeError('Crosshair snap mode: free, close or ohlc required');
 let target=null;
 if(options.target!=null){optionRecord(options.target,['panel','axisId','seriesId'],'Crosshair snap target');const next={...options.target};identifier(next.panel,'Crosshair snap panel');if(next.seriesId!=null&&next.axisId===undefined){const series=model.series.find(s=>s.id===next.seriesId);if(series)next.axisId=series.axisId??null;}model.validateDrawingBinding(next);target=Object.freeze({panel:next.panel,axisId:next.axisId??null,seriesId:next.seriesId??null});}
 return Object.freeze({mode,target});
}
export function capturePointerCrosshair(controller,x,y){
 const cursor={x,y};controller.model.crosshair=cursor;controller._crosshairPointer=cursor;
 pointerSnapRequests.set(cursor,{model:controller.model,owner:controller._crosshairOwner,options:controller.crosshairSnap,x,y});
}
export function updatePointerCrosshair(controller){
 const cursor=controller._crosshairPointer,request=cursor&&pointerSnapRequests.get(cursor);
 if(cursor===controller.model.crosshair&&request?.owner===controller._crosshairOwner&&Object.is(cursor.x,request.x)&&Object.is(cursor.y,request.y))request.options=controller.crosshairSnap;
}
export function releasePointerCrosshair(controller){
 const cursor=controller._crosshairPointer;if(cursor&&pointerSnapRequests.get(cursor)?.owner===controller._crosshairOwner)pointerSnapRequests.delete(cursor);controller._crosshairPointer=null;
}
// A prepared layout is required: selection itself performs no study calculation.
// Fresh-layout public API queries retain the existing layout computation cost.
export function resolveCrosshairSnapshot(model,layout){
 const cursor=model.crosshair;if(!cursor)return null;const {x,y}=cursor,panel=layout.panels.find(p=>x>=p.left&&x<=p.right&&y>=p.top&&y<=p.bottom);if(!panel)return null;
 const stored=pointerSnapRequests.get(cursor),request=stored?.model===model&&Object.is(stored.x,x)&&Object.is(stored.y,y)?stored:null,mode=request?.options.mode??'free';
 const result={mode,raw:{x,y},resolved:{x,y},panel:panel.id,snapped:false,reason:mode==='free'?'free':'no-eligible',index:null,time:null,field:null,price:null,axisId:null,seriesId:null,storeVersion:null};
 if(mode==='free')return result;
 const target=request.options.target??{panel:panel.id};if(target.panel!==panel.id)return result;
 const snap=nearestVisibleOHLC(model,layout,x,y,target,mode==='close'?['close']:undefined);if(!snap)return result;
 return {...result,resolved:{x:snap.x,y:snap.y},snapped:true,reason:'snapped',index:snap.index,time:snap.time,field:snap.field,price:snap.price,axisId:snap.axisId,seriesId:snap.seriesId,storeVersion:model.store.version};
}
export function crosshairAxisPrice(snapshot,axis){return snapshot.snapped&&snapshot.axisId===(axis.axisId??null)?snapshot.price:axis.price(snapshot.resolved.y);}
