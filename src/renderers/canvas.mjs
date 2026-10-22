import {captureTradeMarkerFrame,commitTradeMarkerFrame,invalidateTradeMarkerFrame,disposeTradeMarkers} from './trade-markers.mjs';
export {attachTradeMarkers} from './trade-markers.mjs';
import {notifyChartState} from './state-notification.mjs';
import {interactionOptions} from './interaction-options.mjs';
export {saveChartUI,readChartUI,createChartUIPreset} from './chart-ui.mjs';
import {disposeChartToolbars} from './chart-toolbar.mjs';
import {disposeChartOverlays} from './chart-overlays.mjs';
export {attachChartOverlays} from './chart-overlays.mjs';
import {disposeChartNavigators} from './chart-navigator.mjs';
export {attachChartNavigator} from './chart-navigator.mjs';
export {attachChartToolbar} from './chart-toolbar.mjs';
import {resolveCrosshairSnapshot} from '../core/crosshair-snap.mjs';
import {registerTimeRangeHost,disposeTimeRangeHost,refreshTimeRange} from './time-range.mjs';
export {TimeRangeGroup} from './time-range.mjs';
import {disposeDrawingPanels} from './drawing-panel.mjs';
export {attachDrawingPanel} from './drawing-panel.mjs';
export {DrawingSelectionController} from './drawing-selection.mjs';
import {registerTimeCursorHost,disposeTimeCursorHost,timeCursorState,refreshTimeCursor,publishTimeCursor,clearTimeCursorOrigin,timeCursorCommands} from './time-cursor.mjs';
export {TimeCursorGroup} from './time-cursor.mjs';
import {KeyboardDataExplorer,explorerInputAllowed} from './keyboard-explorer.mjs';
import {buildScene} from '../core/scene.mjs';
import {InteractionController} from '../core/interaction.mjs';
import {ChartAPI} from '../core/api.mjs';
import {RESOURCE_LIMITS} from '../core/contracts.mjs';
import {SceneCache} from './scene-cache.mjs';
import {LayerCacheBudget,defaultLayerCacheBudget,CacheAllocationError} from './cache-budget.mjs';
export {LayerCacheBudget} from './cache-budget.mjs';
const explorerNodeOwners=new WeakMap();
const FRAME_RENDER = Symbol('scheduled layered frame');

export function renderCanvas(ctx, scene, dpr = 1) {
  drawCanvasCommands(ctx, scene, dpr, true);
}
function drawCanvasCommands(ctx, scene, dpr, clear) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); if (clear) {ctx.clearRect(0,0,scene.width,scene.height);ctx.fillStyle = scene.background; ctx.fillRect(0, 0, scene.width, scene.height);}
  for (const c of scene.commands) {
    ctx.save(); if (c.clip) {ctx.beginPath(); ctx.rect(...c.clip); ctx.clip();}
    ctx.strokeStyle = c.color; ctx.fillStyle = c.fill ?? c.color; ctx.lineWidth = c.width ?? 1; if (c.dash) ctx.setLineDash(c.dash);
    if (c.op === 'lines') {ctx.beginPath(); for (let i = 0; i < c.coords.length; i += 4) {ctx.moveTo(c.coords[i], c.coords[i + 1]); ctx.lineTo(c.coords[i + 2], c.coords[i + 3]);} ctx.stroke();}
    else if (c.op === 'rects') {ctx.beginPath(); for (let i = 0; i < c.coords.length; i += 4) ctx.rect(...c.coords.slice(i, i + 4)); ctx.fill();}
    else if (c.op === 'path') {ctx.beginPath(); c.points.forEach((v, i) => {if (!(i % 2)) (i ? ctx.lineTo : ctx.moveTo).call(ctx, v, c.points[i + 1]);}); ctx.stroke(); if (c.fill && c.points.length) {ctx.lineTo(c.points[c.points.length - 2], c.baseline); ctx.lineTo(c.points[0], c.baseline); ctx.closePath(); ctx.fill();}}
    else if (c.op === 'box') {if (c.fill) ctx.fillRect(c.x, c.y, c.w, c.h); ctx.strokeRect(c.x, c.y, c.w, c.h);}
    else if (c.op === 'ellipse') {ctx.beginPath(); ctx.ellipse(c.x + c.w / 2, c.y + c.h / 2, c.w / 2, c.h / 2, 0, 0, Math.PI * 2); if (c.fill) ctx.fill(); ctx.stroke();}
    else if (c.op === 'text') {ctx.font = c.font ?? '12px monospace'; ctx.fillStyle = c.color; ctx.fillText(c.text, c.x, c.y);}
    ctx.restore();
  }
}

export class CanvasChart {
  constructor(container, model, {dpr = () => window.devicePixelRatio || 1, interactive = true, observeResize = true, rendererFactory = null, onFallback = null,onError=null,layerCaching=true,maxCachedPixels=8388608,rasterCaching='auto',cacheBudget=defaultLayerCacheBudget,dataExplorer=null,interaction={}} = {}) {
    this._interaction=interactionOptions(interaction);
    if(typeof dpr!=='function'||onError!==null&&typeof onError!=='function')throw new TypeError('DPR/error callback');this.onError=onError;this.lastError=null;
    if(typeof layerCaching!=='boolean'||!Number.isSafeInteger(maxCachedPixels)||maxCachedPixels<0||maxCachedPixels>RESOURCE_LIMITS.maxCanvasPixels)throw new RangeError('Layer cache options');
    if(!['auto','always','never'].includes(rasterCaching)||!(cacheBudget instanceof LayerCacheBudget))throw new TypeError('Raster cache policy/budget');this.rasterCaching=rasterCaching;this.cacheBudget=cacheBudget;this.rasterPolicy=null;this.failedRasterKey=null;
    if (!container || !model) throw new TypeError('Container and model required'); this.container = container; this.model = model; this.dpr = dpr; this.disposed = false; this.drawGeneration=0;this.invalidationGeneration=0; this.listeners = []; this.frame = null; this.timings = [];
    this.interactive = interactive; this.onFallback = onFallback;this.layerCaching=layerCaching;this.maxCachedPixels=maxCachedPixels;this.sceneCache=new SceneCache();this.fullDirty=true;this.layerSurfaces=null;this.lastRatio=null;this.renderMetrics=null;
    this.canvas = document.createElement('canvas'); this.canvas.tabIndex = 0; this.canvas.setAttribute('role', 'group');this.canvas.setAttribute('aria-roledescription','Financial chart'); this.canvas.setAttribute('aria-label', 'Financial chart. Arrows pan or move the selected drawing; +/- zoom; Page Up/Down select drawings; Escape cancels; Delete deletes.'); this.canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;outline-offset:-2px;'; this.applyInteractionPresentation(); container.append(this.canvas);
    if (rendererFactory) {try {this.renderer = rendererFactory(this.canvas, reason => this.fallback(reason));} catch (e) {this.fallback(e.message);}}
    if (!this.renderer) {this.ctx = this.canvas.getContext('2d', {alpha: false}); if (!this.ctx) {this.canvas.remove(); throw new Error('Canvas 2D unavailable');}}
    this.rendererKind = this.renderer?.kind ?? 'canvas';
    try {
    this.controller = new InteractionController(model, () => this.size(), kind => this.invalidate(kind));
    this.api = new ChartAPI(model,{controller:this.controller,invalidate:kind=>this.invalidate(kind)});
    this.setupDataExplorer(dataExplorer);
    if (interactive) this.bind();
    if (observeResize) {this.observer = new ResizeObserver(() => this.invalidate()); this.observer.observe(container);}
    registerTimeRangeHost(this,model,()=>this.invalidate());this.unsubscribe = model.store.subscribe(() => this.invalidate()); registerTimeCursorHost(this,model,()=>{try{this.invalidate('hover');}catch(error){if(!this.disposed)this.reportError(error);}});this.invalidate();
    }catch(error){disposeTimeRangeHost(this);disposeTimeCursorHost(this);this.disposeDataExplorer();this.observer?.disconnect();this.unsubscribe?.();this.renderer?.dispose();this.releaseLayers();this.sceneCache.clear();for(const [type,fn,options] of this.listeners)this.canvas.removeEventListener(type,fn,options);this.listeners=[];this.canvas.remove();this.disposed=true;throw error;}
  }
  fallback(reason = 'GPU context lost') {
    const sourceCanvas=this.canvas,sourceController=this.controller,sourcePointerToken=this.timePointerToken;
    const current=()=>!this.disposed&&this.canvas===sourceCanvas&&this.controller===sourceController;
    if(this.explorer?.active)this.setDataExploration(false);
    if(!current())return;clearTimeCursorOrigin(this,'pointer',sourcePointerToken);if(!current())return;this.timeLayout=null;
    if(!current())return;
    this.controller?.cancel({ownedDrawingsOnly:true});if(!current())return;
    this.renderer?.dispose();if(!current())return;this.renderer = null;
    this.releaseLayers();this.sceneCache?.clear();this.fullDirty=true;
    for (const [type, fn, options] of this.listeners) this.canvas.removeEventListener(type, fn, options); this.listeners = [];
    const old = this.canvas; this.canvas = old.cloneNode(false); old.replaceWith(this.canvas); this.ctx = this.canvas.getContext('2d', {alpha:false}); this.rendererKind = 'canvas'; this.fallbackReason = reason;
    if (!this.ctx) throw new Error('Canvas fallback unavailable');
    if(this.controller&&this.interactive)this.bind();try{this.onFallback?.(reason);}catch(error){this.reportError(error);}if(this.controller)this.invalidate();
  }
  get interactionOptions(){return this._interaction;}
  applyInteractionPresentation(){
    const policy=this._interaction;
    this.canvas.style.touchAction=this.interactive&&policy.pointer?'none':'auto';
    this.canvas.setAttribute('aria-label',this.interactive&&policy.keyboardShortcuts?'Financial chart. Arrows pan or move the selected drawing; +/- zoom; Page Up/Down select drawings; Escape cancels; Delete deletes.':'Financial chart. Ordinary keyboard shortcuts disabled.');
  }
  setInteractionOptions(patch){
    if(this.disposed)throw new Error('Chart disposed');
    const next=interactionOptions(patch,this._interaction),previous=this._interaction;
    if(Object.keys(next).every(key=>next[key]===previous[key]))return previous;
    const canvas=this.canvas,controller=this.controller,token=this.timePointerToken,ids=[...controller.pointers.keys()];
    this._interaction=next;
    const current=()=>!this.disposed&&this.canvas===canvas&&this.controller===controller&&this._interaction===next;
    if(previous.pointer&&!next.pointer){
      controller.cancel({notify:false,ownedDrawingsOnly:true});
      if(controller._crosshairPointer===this.model.crosshair)this.model.crosshair=null;
      controller.releaseCrosshair();
      // Retire old captures before notifications; never release an ID acquired
      // by a newer reentrant gesture on this same controller.
      for(const id of ids)if(!controller.pointers.has(id)){try{canvas.releasePointerCapture?.(id);}catch{}}
      clearTimeCursorOrigin(this,'pointer',token);if(!current())return this._interaction;
    }
    this.applyInteractionPresentation();if(current())this.invalidate();return this._interaction;
  }
  size() {return {width: Math.max(100, this.container.clientWidth), height: Math.max(80, this.container.clientHeight)};}
  bind() {
    const boundCanvas=this.canvas,input=fn=>e=>{if(this.disposed||this.canvas!==boundCanvas)return;try{fn(e);}catch(error){if(this.disposed)return;const canvas=this.canvas,controller=this.controller;if(!this.explorer?.active)controller.cancel({ownedDrawingsOnly:true});if(this.disposed||this.canvas!==canvas||this.controller!==controller)return;this.reportError(error);}};
    const on = (type, fn, options) => {this.canvas.addEventListener(type, fn, options); this.listeners.push([type, fn, options]);}, point = e => {const b = this.canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top];};
    on('pointerdown',input(e=>{if(e.button!==0||!this._interaction.pointer)return;const policy=this._interaction,canvas=this.canvas,controller=this.controller;if(this.explorer?.active)this.setDataExploration(false);if(this.disposed||this.canvas!==canvas||this.controller!==controller||this._interaction!==policy)return;this.canvas.focus();if(this.disposed||this.canvas!==canvas||this.controller!==controller||this._interaction!==policy)return;this.canvas.setPointerCapture(e.pointerId);if(this.disposed||this.canvas!==canvas||this.controller!==controller||this._interaction!==policy){if(!controller.pointers.has(e.pointerId))try{canvas.releasePointerCapture?.(e.pointerId);}catch{}return;}this.controller.down(e.pointerId,...point(e),policy.hitTolerancePx);}));
    on('pointermove',input(e=>{if(this._interaction.pointer&&!this.explorer?.active){const policy=this._interaction,canvas=this.canvas,controller=this.controller,[x,y]=point(e);controller.move(e.pointerId,x,y);if(!this.disposed&&this.canvas===canvas&&this.controller===controller&&this._interaction===policy&&!controller.pointers.size)this.publishPointerTime(x,y);}}));
    on('pointerup',input(e=>{if(this._interaction.pointer)this.controller.up(e.pointerId);}));on('pointercancel',input(e=>{if(this.controller.pointers.has(e.pointerId))this.controller.cancel({ownedDrawingsOnly:true});}));
    on('lostpointercapture', input(e => {if (this.controller.pointers.has(e.pointerId)) this.controller.cancel({ownedDrawingsOnly:true});}));
    on('pointerleave', input(() => {if (this._interaction.pointer&&!this.controller.pointers.size) {this.model.crosshair = null;clearTimeCursorOrigin(this,'pointer',this.timePointerToken);if(!this.disposed)this.invalidate('hover');}}));
    on('wheel',input(e=>{if(!this._interaction.wheelZoom)return;const policy=this._interaction,canvas=this.canvas,controller=this.controller;if(this.explorer?.active)this.setDataExploration(false);if(this.disposed||this.canvas!==canvas||this.controller!==controller||this._interaction!==policy)return;e.preventDefault();this.controller.wheel(e.deltaY*(e.deltaMode===1?16:1),point(e)[0]);}),{passive:false});
    on('focusout',e=>this.explorerFocusOut(e));
    on('keydown',input(e=>{if(e.defaultPrevented||e.isComposing||e.target!==this.canvas)return;if(this.explorer?.active){if(document.activeElement!==undefined&&document.activeElement!==this.canvas)return;if(!explorerInputAllowed(e,this.canvas))return;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Enter','Escape'].includes(e.key)){e.preventDefault();const explorer=this.explorer,generation=explorer.generation,canvas=this.canvas;try{explorer.key(e.key);if(!this.disposed&&this.explorer===explorer&&this.canvas===canvas)this.publishExploration(true);}catch(error){if(!this.disposed&&this.explorer===explorer&&this.canvas===canvas&&explorer.generation===generation)this.publishExploration(true);throw error;}}return;}if(!this._interaction.keyboardShortcuts)return;if(e.altKey||(e.ctrlKey||e.metaKey)&&!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','z','y'].includes(e.key.length===1?e.key.toLowerCase():e.key))return;if(['Escape','Delete','Backspace','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','PageUp','PageDown','Home','End','+','=','-','_'].includes(e.key)||(e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();this.controller.key(e.key,{ctrl:e.ctrlKey||e.metaKey,shift:e.shiftKey});}}));
  }
  setupDataExplorer(options){
    if(options===null)return;
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['readout','live','controls'].includes(k)))throw new TypeError('Data explorer options');
    const {readout,live,controls=[]}=options;
    const element=node=>node&&node.nodeType===1&&typeof node.addEventListener==='function'&&typeof node.removeEventListener==='function';
    if(!element(readout)||!element(live)||readout===live||!Array.isArray(controls)||controls.length>4||new Set(controls).size!==controls.length||controls.some(node=>!element(node)||node===readout||node===live))throw new TypeError('Data explorer output/control elements');
    this.explorer=new KeyboardDataExplorer(this.api);this.explorerNodes={readout,live,controls:[...controls],token:{},listeners:[]};
    explorerNodeOwners.set(readout,this.explorerNodes.token);explorerNodeOwners.set(live,this.explorerNodes.token);
    readout.textContent='Data exploration off.';live.textContent='';
    for(const node of controls){const fn=e=>this.explorerFocusOut(e);node.addEventListener('focusout',fn);this.explorerNodes.listeners.push([node,fn]);}
  }
  get timeCursor(){return timeCursorState(this);}
  timeProjectionMatches(prior){const model=this.model;return prior.axisWidth===model.axisWidth&&prior.font===model.theme.font&&prior.panels.length===model.panels.length&&prior.axes.length===model.axes.length&&prior.panels.every((p,i)=>p===model.panels[i])&&prior.axes.every((a,i)=>a===model.axes[i]);}
  publishPointerTime(x,y){const prior=this.timeLayout,size=this.size(),model=this.model;if(!prior||this.disposed||prior.canvas!==this.canvas||prior.version!==model.store.version||prior.store!==model.store||prior.from!==model.view.from||prior.to!==model.view.to||prior.width!==size.width||prior.height!==size.height||!this.timeProjectionMatches(prior)||this.fullDirty)return;const layout=prior.layout;if(!layout.panels.some(p=>x>=p.left&&x<=p.right&&y>=p.top&&y<=p.bottom))return;const snapshot=resolveCrosshairSnapshot(model,layout),index=snapshot?.snapped&&snapshot.raw.x===x&&snapshot.raw.y===y?snapshot.index:Math.round(layout.index(x));if(index<0||index>=model.store.length)return;const token=publishTimeCursor(this,model.store.columns.time[index],'pointer');if(timeCursorState(this)?.generation===token)this.timePointerToken=token;}
  get dataExploration(){return this.explorer?.snapshot()??{active:false,time:null,index:null,seriesId:null,phase:'off',text:''};}
  setDataExploration(active){
    if(this.disposed)throw new Error('Chart disposed');if(!this.explorer)throw new Error('Configure dataExplorer output elements first');
    if(typeof active!=='boolean')throw new TypeError('Exploration mode boolean');
    if(active){this.controller.cancel({notify:false});if(this.disposed)throw new Error('Chart disposed');}
    const result=this.explorer.setActive(active);this.publishExploration(true);return result;
  }
  readExploration(){
    if(this.disposed)throw new Error('Chart disposed');if(!this.explorer)throw new Error('Configure dataExplorer output elements first');
    const explorer=this.explorer,generation=explorer.generation,canvas=this.canvas;
    try{return explorer.read();}finally{if(!this.disposed&&this.explorer===explorer&&this.canvas===canvas&&explorer.generation===generation)this.publishExploration(true);}
  }
  publishExploration(announce){
    const nodes=this.explorerNodes,explorer=this.explorer,canvas=this.canvas;if(this.disposed||!nodes||!explorer)return;
    if(explorerNodeOwners.get(nodes.readout)!==nodes.token||explorerNodeOwners.get(nodes.live)!==nodes.token)return;
    const generation=explorer.generation,state=explorer.snapshot();if(announce&&state.active&&state.index>=0){const token=publishTimeCursor(this,state.time,'keyboard');if(timeCursorState(this)?.generation===token)this.timeKeyboardToken=token;}else if(!state.active||state.index<0)clearTimeCursorOrigin(this,'keyboard',this.timeKeyboardToken);if(this.disposed||this.explorer!==explorer||this.canvas!==canvas||explorer.generation!==generation||this.explorerNodes!==nodes||explorerNodeOwners.get(nodes.readout)!==nodes.token||explorerNodeOwners.get(nodes.live)!==nodes.token)return;const text=state.active?state.text:'Data exploration off.';
    nodes.readout.textContent=text;
    if(this.disposed||this.canvas!==canvas||this.explorer!==explorer||explorer.generation!==generation||explorerNodeOwners.get(nodes.readout)!==nodes.token||explorerNodeOwners.get(nodes.live)!==nodes.token)return;
    if(announce)nodes.live.textContent=text;
    if(!this.disposed&&this.canvas===canvas&&this.explorer===explorer&&explorer.generation===generation)this.canvas.dispatchEvent(new Event('aster:exploration',{bubbles:true}));
  }
  explorerFocusOut(event){
    if(!this.explorer?.active||this.disposed)return;const next=event.relatedTarget,nodes=this.explorerNodes;
    if(next&&next.isConnected!==false&&(next===this.canvas||nodes?.controls.includes(next)))return;
    this.setDataExploration(false);
  }
  disposeDataExplorer(){
    const nodes=this.explorerNodes;this.explorerNodes=null;this.explorer?.dispose();this.explorer=null;
    if(!nodes)return;for(const [node,fn] of nodes.listeners)node.removeEventListener('focusout',fn);
    for(const node of [nodes.readout,nodes.live])if(explorerNodeOwners.get(node)===nodes.token){explorerNodeOwners.delete(node);node.textContent='';}
  }
  reportError(error){const next=error instanceof Error?error:new Error('Chart error'),changed=this.lastError?.message!==next.message;this.lastError=next;if(changed)try{this.onError?.(next);}catch{} }
  invalidate(kind='all') {if(this.disposed)return;++this.invalidationGeneration;refreshTimeRange(this);if(this.disposed)return;if(kind!=='hover')refreshTimeCursor(this);if(kind!=='hover'&&this.explorer?.active){this.explorer.changed();this.publishExploration(false);if(this.disposed)return;}if(kind!=='hover'&&kind!=='drawings')this.fullDirty=true;notifyChartState(this.canvas,kind);if(this.disposed||this.frame!==null)return; this.frame = requestAnimationFrame(() => {this.frame = null;try{this.drawNow(FRAME_RENDER);}catch{}});}
  renderScene(scene,ratio){if(this.renderer)this.renderer.render(scene,ratio);else renderCanvas(this.ctx,scene,ratio);}
  canCacheLayers(pixels){return pixels*8<=100663296;}
  cachedLayerBytes(pixels){return pixels*8;}
  wantsRaster(frame){if(this.rasterCaching==='never'||this.renderer&&(this.renderer.color(frame.scene.background)[3]!==1||frame.drawings.commands.length>0))return false;if(this.rasterCaching==='always'||this.renderer)return true;if(frame.baseChanged||this.rasterPolicy===null){let cost=0;for(const c of frame.base.commands)cost+=(c.coords?.length??c.points?.length??(c.op==='text'?c.text.length*8:8));if(this.rasterPolicy===null)this.rasterPolicy=cost>=3584;else if(cost>=4096)this.rasterPolicy=true;else if(cost<=3072)this.rasterPolicy=false;}return this.rasterPolicy;}
  releaseLayers(){if(this.layerSurfaces){for(const canvas of [this.layerSurfaces.base,this.layerSurfaces.stable])canvas.width=canvas.height=0;this.layerSurfaces=null;}this.renderer?.releaseLayers?.();this.cacheBudget?.release(this);}
  renderLayers(frame,ratio){
    const w=this.canvas.width,h=this.canvas.height;
    let surfaces=this.layerSurfaces,allocated=false;
    if(!surfaces){const base=document.createElement('canvas'),stable=document.createElement('canvas'),baseContext=base.getContext('2d',{alpha:false}),stableContext=stable.getContext('2d',{alpha:false});if(!baseContext||!stableContext){base.width=base.height=stable.width=stable.height=0;throw new CacheAllocationError('Layer Canvas unavailable');}surfaces=this.layerSurfaces={base,stable,baseContext,stableContext};allocated=true;}
    if(surfaces.base.width!==w||surfaces.base.height!==h){for(const c of [surfaces.base,surfaces.stable]){c.width=w;c.height=h;}allocated=true;}
    const baseChanged=allocated||frame.baseChanged,drawingsChanged=baseChanged||frame.drawingsChanged;
    if(baseChanged)renderCanvas(surfaces.baseContext,frame.base,ratio);
    if(drawingsChanged){surfaces.stableContext.setTransform(1,0,0,1,0,0);surfaces.stableContext.drawImage(surfaces.base,0,0);drawCanvasCommands(surfaces.stableContext,frame.drawings,ratio,false);}
    this.ctx.setTransform(1,0,0,1,0,0);this.ctx.drawImage(surfaces.stable,0,0);drawCanvasCommands(this.ctx,frame.hover,ratio,false);
    return {baseRedrawn:baseChanged,drawingsRedrawn:drawingsChanged,cachedPixelBytes:w*h*8,hoverCommands:frame.hover.commands.length};
  }
  drawNow(frameToken) {
    if(this.disposed)return;
    const generation=++this.drawGeneration,invalidation=this.invalidationGeneration,canvas=this.canvas,model=this.model,controller=this.controller,renderer=this.renderer;
    const current=()=>!this.disposed&&generation===this.drawGeneration&&invalidation===this.invalidationGeneration&&canvas===this.canvas&&model===this.model&&controller===this.controller&&renderer===this.renderer;
    try{
    const start=performance.now(),size=this.size(),ratio=this.dpr();
    if(!current())return;const w=Math.round(size.width*ratio),h=Math.round(size.height*ratio);
    if(!Number.isFinite(ratio)||ratio<=0||ratio>8||w>RESOURCE_LIMITS.maxCanvasDimension||h>RESOURCE_LIMITS.maxCanvasDimension||w*h>RESOURCE_LIMITS.maxCanvasPixels)throw new RangeError('Canvas size/DPR limit');
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    const markerFrame=captureTradeMarkerFrame(this,size.width,size.height);
    const binding={canvas,store:model.store,version:model.store.version,from:model.view.from,to:model.view.to,width:size.width,height:size.height,axisWidth:model.axisWidth,font:model.theme.font,panels:model.panels.slice(),axes:model.axes.slice()};let scene,metrics,prepared;
    if(this.layerCaching){
      // Formatter/renderer callbacks can invalidate, replace, nest or destroy a
      // draw. Never publish their obsolete outer cache or output over its owner.
      prepared=Object.assign(new SceneCache(),this.sceneCache);
      const frame=prepared.frame(model,size.width,size.height,{forceBase:frameToken!==FRAME_RENDER||this.fullDirty||ratio!==this.lastRatio});
      if(!current())return;
      const synced=timeCursorCommands(this,frame.scene.layout);if(!current())return;
      if(synced.length){frame.hover={...frame.hover,commands:frame.hover.commands.concat(synced)};frame.scene={...frame.scene,commands:frame.scene.commands.concat(synced),stats:{...frame.scene.stats,commandCount:frame.scene.commands.length+synced.length}};}
      const key=[w,h,this.rendererKind,this.cacheBudget.generation].join('/'),bytes=this.cachedLayerBytes(w*h);
      const raster=this.wantsRaster(frame)&&w*h<=this.maxCachedPixels&&this.canCacheLayers(w*h)&&this.failedRasterKey!==key&&this.cacheBudget.reserve(this,bytes,()=>{this.releaseLayers();this.invalidate('hover');});
      if(!current())return;let rendered=false;
      if(raster)try{metrics={...this.renderLayers(frame,ratio),cacheMode:'raster'};if(!current())return;rendered=this.cacheBudget.reserve(this,metrics.cachedPixelBytes,()=>{this.releaseLayers();this.invalidate('hover');});if(!current())return;if(!rendered)this.failedRasterKey=key;}catch(error){if(!current())throw error;if(!(error instanceof CacheAllocationError))throw error;this.failedRasterKey=key;this.releaseLayers();}
      if(!current())return;
      if(!rendered){this.releaseLayers();if(!current())return;this.renderScene(frame.scene,ratio);if(!current())return;metrics={baseRedrawn:frame.baseChanged,drawingsRedrawn:frame.drawingsChanged,cachedPixelBytes:0,hoverCommands:frame.hover.commands.length,cacheMode:'scene'};}
      scene=frame.scene;
    }else{
      this.releaseLayers();if(!current())return;
      scene=buildScene(model,size.width,size.height);if(!current())return;
      const synced=timeCursorCommands(this,scene.layout);if(!current())return;
      if(synced.length)scene={...scene,commands:scene.commands.concat(synced),stats:{...scene.stats,commandCount:scene.commands.length+synced.length}};
      this.renderScene(scene,ratio);if(!current())return;metrics={baseRedrawn:true,drawingsRedrawn:true,cachedPixelBytes:0,hoverCommands:0};
    }
    if(!current())return;
    if(prepared)Object.assign(this.sceneCache,prepared);else this.sceneCache.clear();
    this.renderMetrics=metrics;this.fullDirty=false;this.lastRatio=ratio;this.lastScene=scene;this.timeLayout=binding.store===model.store&&binding.version===model.store.version&&binding.from===model.view.from&&binding.to===model.view.to&&this.timeProjectionMatches(binding)?{...binding,layout:scene.layout}:null;this.lastError=null;
    commitTradeMarkerFrame(this,markerFrame,scene.layout);
    this.timings.push(performance.now()-start);if(this.timings.length>300)this.timings.shift();canvas.dispatchEvent(new Event('aster:render',{bubbles:true}));return scene.stats;
    }catch(error){if(current()){this.fullDirty=true;this.sceneCache.clear();invalidateTradeMarkerFrame(this);if(current())this.reportError(error);}throw error;}
  }
  setTool(tool) {this.controller.setTool(tool);}
  resize() {this.invalidate();}
  destroy({disposeModel = false} = {}) {if (this.disposed) return; this.disposed = true;disposeTimeRangeHost(this);disposeDrawingPanels(this);disposeChartToolbars(this);disposeChartOverlays(this);disposeChartNavigators(this);disposeTradeMarkers(this);disposeTimeCursorHost(this);this.timeLayout=null; this.disposeDataExplorer();this.controller.releaseCrosshair();this.controller.cancel({ownedDrawingsOnly:true}); if (this.frame !== null) cancelAnimationFrame(this.frame); this.frame = null; this.observer?.disconnect(); this.unsubscribe(); for (const [type, fn, options] of this.listeners) this.canvas.removeEventListener(type, fn, options); this.listeners = [];this.releaseLayers();this.sceneCache.clear(); this.renderer?.dispose(); this.canvas.remove();this.canvas.width=this.canvas.height=0; this.lastScene = null;this.renderMetrics=null; this.timings = []; if (disposeModel) this.model.dispose();}
}
