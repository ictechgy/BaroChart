import {isPositionDrawing,positionPointsValid,positionHandlePoints,initialPositionPoints} from './position-drawing.mjs';
import {nearestVisibleOHLC} from './ohlc-snap.mjs';
import {crosshairSnapOptions,capturePointerCrosshair,updatePointerCrosshair,releasePointerCrosshair} from './crosshair-snap.mjs';
import {createLayout} from './model.mjs';
import {optionRecord,identifier} from './contracts.mjs';
import {drawingHitTest, DRAWING_TYPES, drawingPointCount} from './drawings.mjs';

// Pan/pinch snapshots own only one short-lived source reference and scalar view
// state. Detect topology/external-view changes on input, without subscriptions.
function viewportState(controller){const m=controller.model;return {store:m.store,identity:m.store.geometryIdentity,timeVersion:m.store.timeVersion,from:m.view.from,to:m.view.to,follow:m.follow};}
function viewportCurrent(controller,g){const s=g?.viewport,m=controller.model;return !s||(s.store===m.store&&s.identity===m.store.geometryIdentity&&s.timeVersion===m.store.timeVersion&&Object.is(s.from,m.view.from)&&Object.is(s.to,m.view.to)&&s.follow===m.follow);}
function stopStaleViewport(controller){const g=controller.gesture;if(g?.viewport&&!viewportCurrent(controller,g)){controller.gesture=controller.pointers.size?{kind:'wait',staleViewport:true}:null;return true;}return false;}

// A shared-model command can retire this controller's drawing transaction.
// Late pointer events must not cancel or commit a replacement owner's work.
function stopStaleDrawing(controller){const g=controller.gesture;if(g?.transaction&&g.transaction!==controller.model.drawings.transaction){controller.gesture=null;controller.pointers.clear();return true;}return false;}

// Own the begin-to-gesture setup window without claiming a foreign transaction.
function beginDrawing(controller,setup){
 const drawings=controller.model.drawings;drawings.begin();const transaction=drawings.transaction;
 try{return setup(transaction);}catch(error){if(drawings.transaction===transaction)drawings.cancel();throw error;}
}

// Magnet is a pointer aid, not a data transform: persist exact source time and
// raw OHLC prices. Only a visible raw-price binding on this precise axis is safe.
function magnetDrawingPoint(controller,layout,x,y,target,type,free=layout.fromScreen(x,y,target.panel,target.axisId)){
 const config=controller.drawingMagnet;
 if(config.mode==='off'||type==='freehand')return free;
 const snap=nearestVisibleOHLC(controller.model,layout,x,y,target);
 if(!snap||config.mode==='weak'&&Math.hypot(snap.x-x,snap.y-y)>config.radiusPx)return free;
 return {time:snap.time,price:snap.price};
}

// DOM-free pointer state machine shared by browser, native host, and tests.
export class InteractionController {
  constructor(model, size, invalidate = () => {}) {this.model = model; this.size = size; this.invalidate = invalidate; this.pointers = new Map(); this.tool = 'select'; this.gesture = null; this.text = 'Note';this.drawingTarget=null;this._drawingMagnet=Object.freeze({mode:'off',radiusPx:8});this._crosshairSnap=Object.freeze({mode:'free',target:null});this._crosshairOwner={};this._crosshairPointer=null;}
  get drawingMagnet(){return this._drawingMagnet;}
  setDrawingMagnet(options,{notify=true}={}){optionRecord(options,['mode','radiusPx'],'Drawing magnet');const mode=options.mode,radiusPx=options.radiusPx===undefined?8:options.radiusPx;if(!['off','weak','strong'].includes(mode))throw new TypeError('Drawing magnet mode: off, weak or strong required');if(!Number.isFinite(radiusPx)||radiusPx<1||radiusPx>32)throw new RangeError('Drawing magnet radius must be 1..32 logical pixels');if(mode===this.drawingMagnet.mode&&radiusPx===this.drawingMagnet.radiusPx)return;this.cancel({notify:false,ownedDrawingsOnly:true});this._drawingMagnet=Object.freeze({mode,radiusPx});if(notify)this.invalidate();}
  get crosshairSnap(){return this._crosshairSnap;}
  setCrosshairSnap(options,{notify=true}={}){const next=crosshairSnapOptions(this.model,options),old=this.crosshairSnap;if(next.mode===old.mode&&next.target?.panel===old.target?.panel&&next.target?.axisId===old.target?.axisId&&next.target?.seriesId===old.target?.seriesId)return;this._crosshairSnap=next;updatePointerCrosshair(this);if(notify)this.invalidate('hover');}
  releaseCrosshair(){releasePointerCrosshair(this);}
  layout() {const {width, height} = this.size(); return createLayout(this.model, width, height);}
  drawingProjection(layout,panel,axisId){const axis=layout.axis(panel,axisId);return axis?[axis.left,axis.right,axis.top,axis.bottom,axis.min,axis.max,axis.scale,axis.inverted,axis.base,this.model.view.from,this.model.view.to,this.model.store.geometryIdentity,this.model.store.timeVersion]:null;}
  setTool(tool,{notify=true}={}) {if (tool !== 'select' && !DRAWING_TYPES.includes(tool)) throw new Error('Unknown drawing tool'); this.cancel({notify:false}); this.tool = tool; if(notify)this.invalidate();}
  setDrawingTarget(target,{notify=true}={}){if(target!==null){optionRecord(target,['panel','axisId','seriesId'],'Drawing target');const next={panel:'price',...target};identifier(next.panel,'Drawing target panel');if(next.seriesId!=null&&next.axisId===undefined){const s=this.model.series.find(s=>s.id===next.seriesId);if(s)next.axisId=s.axisId??null;}this.model.validateDrawingBinding(next);this.cancel({notify:false});this.drawingTarget=next;}else{this.cancel({notify:false});this.drawingTarget=null;}if(notify)this.invalidate();}
  down(id, x, y, hitTolerance = 8) {
    if(!Number.isFinite(hitTolerance)||hitTolerance<1||hitTolerance>32)throw new RangeError('Pointer hit tolerance must be 1..32 logical pixels');
    if (![x, y].every(Number.isFinite)) return;
    stopStaleViewport(this);
    if (this.pointers.size >= 2 && !this.pointers.has(id)) return;
    this.pointers.set(id, {x, y});
    if(this.gesture?.staleViewport){this.invalidate();return;}
    if (this.pointers.size === 2) {
      // Pinch restores only this controller's current drawing/edit transaction.
      if(this.gesture?.transaction&&this.gesture.transaction===this.model.drawings.transaction)this.model.drawings.cancel(); if(stopStaleViewport(this)){this.invalidate();return;} const [a, b] = [...this.pointers.values()];
      this.gesture = {kind: 'pinch', distance: Math.hypot(b.x - a.x, b.y - a.y) || 1, view: {...this.model.view}, follow: this.model.follow, midpoint: (a.x + b.x) / 2,viewport:viewportState(this)}; this.invalidate(); return;
    }
    if (this.pointers.size > 2) return;
    const layout = this.layout(), p = layout.panels.find(p => y >= p.top && y <= p.bottom && x >= p.left && x <= p.right); if (!p) {this.gesture = null; return;}
    if (this.tool !== 'select') {
      const target=this.drawingTarget??{panel:p.id};if(target.panel!==p.id)return;this.model.validateDrawingBinding(target);const point=magnetDrawingPoint(this,layout,x,y,target,this.tool),positionPoints=isPositionDrawing(this.tool)?initialPositionPoints(this.tool,point,layout,target):null;if(isPositionDrawing(this.tool)&&!positionPoints)return;beginDrawing(this,transaction=>{
      const points=positionPoints??Array.from({length:drawingPointCount(this.tool)},()=>({...point}));
      const drawingId = this.model.drawings.add({type: this.tool, ...target,panel: p.id, points, ...(this.tool === 'text' ? {text: this.text} : {})});
      this.gesture = {kind: 'create', transaction, id: drawingId,panel:p.id,axisId:target.axisId,seriesId:target.seriesId,type:this.tool,projection:this.drawingProjection(layout,p.id,target.axisId),lastX:x,lastY:y, moved:false};});
    } else {
      const hit = drawingHitTest(this.model.drawings, layout, x, y, hitTolerance); this.model.drawings.selected = hit?.id ?? null;
      if (hit && !hit.locked) {const d = this.model.drawings.items.find(d => d.id === hit.id); beginDrawing(this,transaction=>{this.gesture = {kind: 'edit', transaction, id: hit.id, handle: hit.handle, startX: x, startY: y, screenPoints: d.points.map(q => layout.toScreen(q,p.id,d.axisId)), points:d.points.map(p=>({...p})),panel:p.id,axisId:d.axisId,seriesId:d.seriesId,type:d.type,projection:this.drawingProjection(layout,p.id,d.axisId)};});}
      else this.gesture = {kind: 'pan', startX: x, view: {...this.model.view}, follow: this.model.follow, pixelWidth: p.right - p.left,viewport:viewportState(this)};
    }
    this.invalidate('drawings');
  }
  move(id, x, y) {
    if(![x,y].every(Number.isFinite))return;
    if(stopStaleDrawing(this)){this.invalidate('drawings');return;}
    stopStaleViewport(this);
    capturePointerCrosshair(this,x,y); const g = this.gesture;
    if (!this.pointers.has(id)) {this.invalidate('hover'); return;}
    this.pointers.set(id, {x, y});
    if (!g) return;
    if (g.kind === 'pinch') {
      if (this.pointers.size !== 2) return; const [a, b] = [...this.pointers.values()], layout = this.layout();if(this.gesture!==g)return;if(stopStaleViewport(this)){this.invalidate();return;}const p = layout.panels[0], span = g.view.to - g.view.from, factor = g.distance / (Math.hypot(b.x - a.x, b.y - a.y) || 1), anchor = Math.max(0, Math.min(1, (g.midpoint - p.left) / (p.right - p.left))), at = g.view.from + span * anchor, delta = ((a.x + b.x) / 2 - g.midpoint) / (p.right - p.left) * span * factor;
      this.model.setVisibleRange(at - span * factor * anchor - delta, at + span * factor * (1 - anchor) - delta);
    } else if (g.kind === 'pan') {const delta = (g.startX - x) / g.pixelWidth * (g.view.to - g.view.from); this.model.setVisibleRange(g.view.from + delta, g.view.to + delta);}
    else if (g.kind !== 'wait') {
      const layout = this.layout();if(this.gesture!==g)return;if(stopStaleDrawing(this)){this.invalidate('drawings');return;}const d = this.model.drawings.items.find(d => d.id === g.id);
      if (!d || d.locked || d.visible===false || !this.model.drawings.transaction || d.panel!==g.panel || (d.axisId??null)!==(g.axisId??null) || (d.seriesId??null)!==(g.seriesId??null) || d.type!==g.type || !layout.drawingAxis(d)) {this.cancel(); return;}
      const projection=this.drawingProjection(layout,g.panel,g.axisId);
      if(!projection||!g.projection||g.projection.some((value,index)=>!Object.is(value,projection[index]))){this.cancel();return;}
      const freePoint=layout.fromScreen(x,y,g.panel,g.axisId),point=g.kind==='create'||g.handle>=0?magnetDrawingPoint(this,layout,x,y,g,d.type,freePoint):freePoint;
      if (g.kind === 'create') {
        let points=d.points.length===1?[point]:[d.points[0],point];
        if(isPositionDrawing(d.type)){points=d.points.map(p=>({...p}));points[2].price=point.price;points[3].time=point.time;if(!positionPointsValid(d.type,points)||points.some(p=>{const q=layout.toScreen(p,g.panel,g.axisId);return !Number.isFinite(q.x)||!Number.isFinite(q.y);})){this.invalidate('hover');return;}}
        else if(d.type==='freehand'){if(Math.hypot(x-g.lastX,y-g.lastY)<1||d.points.length>=2048)return;points=g.moved?[...d.points,point]:points;g.moved=true;g.lastX=x;g.lastY=y;}
        else if(drawingPointCount(d.type)===3){const anchor=point===freePoint?{x,y}:layout.toScreen(point,g.panel,g.axisId);points.push(layout.fromScreen(anchor.x,anchor.y+40,g.panel,g.axisId));}
        this.model.drawings.edit(g.id,{points});
      }
      else {const points = isPositionDrawing(d.type)&&g.handle>=0?positionHandlePoints(g.points,g.handle,point):g.points.map((p, i) => g.handle < 0 ? layout.fromScreen(g.screenPoints[i].x + x - g.startX, g.screenPoints[i].y + y - g.startY,g.panel,g.axisId) : i === g.handle ? point : {...p}); if(isPositionDrawing(d.type)&&(!positionPointsValid(d.type,points)||points.some(p=>{const q=layout.toScreen(p,g.panel,g.axisId);return !Number.isFinite(q.x)||!Number.isFinite(q.y);}))) {this.invalidate('hover');return;}this.model.drawings.edit(g.id, {points});}
    }
    if(this.gesture===g&&g.viewport)g.viewport=viewportState(this);
    this.invalidate(g.kind==='pan'||g.kind==='pinch'?'all':'drawings');
  }
  up(id) {
    if(stopStaleDrawing(this)){this.invalidate('drawings');return;}
    stopStaleViewport(this);
    if (!this.pointers.has(id)) return; this.pointers.delete(id);
    if(this.gesture?.staleViewport){if(!this.pointers.size)this.gesture=null;}
    else if (this.gesture?.kind === 'pinch') {this.gesture = this.pointers.size ? {kind: 'wait'} : null;}
    else {if (['create', 'edit'].includes(this.gesture?.kind)) this.model.drawings.commit(); this.gesture = null;}
    this.invalidate();
  }
  // Renderer teardown may only roll back its captured drawing transaction.
  // Explicit/native cancel keeps its existing global cancellation contract.
  cancel({notify=true,ownedDrawingsOnly=false}={}) {if(!ownedDrawingsOnly||this.gesture?.transaction&&this.gesture.transaction===this.model.drawings.transaction)this.model.drawings.cancel(); if (this.gesture?.view&&viewportCurrent(this,this.gesture)) {this.model.view = {...this.gesture.view}; this.model.follow = this.gesture.follow;} this.gesture = null; this.pointers.clear(); if(notify)this.invalidate();}
  wheel(delta, x) {if (this.gesture) return; const p = this.layout().panels[0]; this.model.zoom(Math.exp(Math.max(-1, Math.min(1, delta * .001))), (x - p.left) / (p.right - p.left)); this.invalidate();}
  key(key, {ctrl = false, shift = false} = {}) {
    if(this.model.drawings.items.some(d=>d.id===this.model.drawings.selected&&d.visible===false))this.model.drawings.selected=null;
    const undo = ctrl && key.toLowerCase() === 'z' && !shift, redo = ctrl && (key.toLowerCase() === 'y' || key.toLowerCase() === 'z' && shift), deleting = ['Delete', 'Backspace'].includes(key);
    if(key==='Escape'){this.cancel();this.model.drawings.selected=null;this.model.crosshair=null;}
    else if(['PageUp','PageDown'].includes(key)){this.cancel();const items=this.model.drawings.items.filter(d=>d.visible!==false);if(items.length){const at=items.findIndex(d=>d.id===this.model.drawings.selected),next=at<0?(key==='PageUp'?items.length-1:0):(at+(key==='PageUp'?-1:1)+items.length)%items.length;this.model.drawings.selected=items[next].id;}}
    else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key)){if(this.gesture)this.cancel();const d=this.model.drawings.items.find(d=>d.id===this.model.drawings.selected);
      if(d&&!ctrl&&!d.locked&&this.layout().drawingAxis(d)){const layout=this.layout(),step=shift?10:1,dx=key==='ArrowLeft'?-step:key==='ArrowRight'?step:0,dy=key==='ArrowUp'?-step:key==='ArrowDown'?step:0;const points=d.points.map(p=>{const q=layout.toScreen(p,d.panel,d.axisId);return layout.fromScreen(q.x+dx,q.y+dy,d.panel,d.axisId);});if(!isPositionDrawing(d.type)||positionPointsValid(d.type,points)&&points.every(p=>{const q=layout.toScreen(p,d.panel,d.axisId);return Number.isFinite(q.x)&&Number.isFinite(q.y);}))this.model.drawings.edit(d.id,{points});}
      else if(!d||ctrl){if(key==='ArrowLeft'||key==='ArrowRight')this.model.pan((key==='ArrowLeft'?-1:1)*(this.model.view.to-this.model.view.from)*.1);else this.model.zoom(key==='ArrowUp'?.9:1.1);}
    }
    else if(['+','=','-','_'].includes(key))this.model.zoom(key==='+'||key==='='?.8:1.25);
    else if(key==='Home')this.model.fit();else if(key==='End')this.model.setVisibleRange(this.model.store.length-200.5,this.model.store.length-.5);
    else if (undo || redo || deleting) {
      const active = !!this.gesture, selected = this.model.drawings.selected; if (active) this.cancel();
      if (undo && !active) this.model.drawings.undo(); else if (redo) this.model.drawings.redo(); else if (deleting && selected) this.model.drawings.remove(selected);
    }
    this.invalidate();
  }
}
