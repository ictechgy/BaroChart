import {renderCanvas} from '../../renderers/canvas-commands.mjs';
import {WebGLRenderer} from '../../renderers/webgl-renderer.mjs';
import {decodeRustPacket} from './packet.mjs';
import {RustSession} from './session.mjs';

const MAX_PIXELS=16777216;
const KEYBOARD=new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','PageUp','PageDown','Escape','Delete','Backspace','+','=','-','_']);

/** Browser presentation host. Business interaction and scene calculation run in its Rust actor. */
export class RustChartView {
 #surface;#listeners=[];#observer;#unsubscribe;#raf=null;#drawing=null;#dirty=true;#epoch=0;#inputTail=Promise.resolve();#rendererTail=Promise.resolve();#pointers=new Set();#destroyPromise=null;#dpr;#onError;#interactive;#paused=0;
 constructor(container,session,{renderer='canvas',dpr=()=>globalThis.devicePixelRatio||1,interactive=true,observeResize=true,onError=null}={}){
  if(!(session instanceof RustSession))throw new TypeError('Rust session required');
  if(!container||typeof container.append!=='function'||typeof container.getBoundingClientRect!=='function')throw new TypeError('Chart container required');
  if(!['canvas','webgl2'].includes(renderer)||typeof dpr!=='function'||typeof interactive!=='boolean'||typeof observeResize!=='boolean'||onError!==null&&typeof onError!=='function')throw new TypeError('Rust chart options');
  this.container=container;this.session=session;this.disposed=false;this.lastScene=null;this.lastError=null;this.renderMetrics=null;
  this.#dpr=dpr;this.#onError=onError;this.#interactive=interactive;
  session.claimView(this);
  try{
   this.#surface=this.#makeSurface(renderer);this.canvas=this.#surface.canvas;this.rendererKind=renderer;
   container.append(this.canvas);this.#surface.active=true;
   this.#listeners=this.#bind(this.canvas);
   this.#unsubscribe=session.subscribe(snapshot=>{if(this.disposed)return;this.#cursor(snapshot);this.canvas.dispatchEvent(new CustomEvent('aster:state',{bubbles:true,detail:{snapshot}}));this.invalidate();});
   if(observeResize&&typeof ResizeObserver==='function'){this.#observer=new ResizeObserver(()=>this.resize());this.#observer.observe(container);}
   this.#cursor(session.snapshot());
  }catch(error){this.#retire();throw error;}
 }
 #makeSurface(kind){
  const canvas=document.createElement('canvas');canvas.tabIndex=0;canvas.setAttribute('role','group');canvas.setAttribute('aria-roledescription','Financial chart');canvas.setAttribute('aria-label','Financial chart. Arrows pan or edit; +/- zoom; Page Up/Down select drawings; Escape cancels; Delete deletes.');canvas.style.cssText='width:100%;height:100%;display:block;touch-action:none;outline-offset:-2px;';
  const surface={canvas,renderer:null,context:null,active:false,lost:null};
  if(kind==='canvas'){surface.context=canvas.getContext('2d',{alpha:false});if(!surface.context)throw new Error('Canvas 2D unavailable');}
  else{surface.renderer=new WebGLRenderer(canvas,reason=>{surface.lost=reason;if(surface.active&&!this.disposed)void this.replaceRenderer('canvas').catch(error=>this.#report(error));});if(surface.lost){surface.renderer.dispose();throw new Error(surface.lost);}}
  return surface;
 }
 #report(error){if(this.disposed)return;this.lastError=error;try{this.#onError?.(error);}catch{}this.canvas?.dispatchEvent(new CustomEvent('aster:error',{bubbles:true,detail:{error}}));}
 #cursor(snapshot){if(!this.canvas)return;const tool=snapshot?.interaction?.tool??'select',gesture=snapshot?.interaction?.gestureKind;this.canvas.style.cursor=tool==='select'?(gesture==='pan'?'grabbing':'grab'):tool==='text'?'text':'crosshair';}
 #unbind(listeners=this.#listeners){for(const [canvas,type,callback,options]of listeners)canvas.removeEventListener(type,callback,options);if(listeners===this.#listeners)this.#listeners=[];}
 #send(name,args){const task=this.#inputTail.then(()=>{if(this.disposed)return;return this.session.invoke(name,args);});this.#inputTail=task.catch(error=>this.#report(error));return task;}
 #bind(canvas){
  const listeners=[];
  if(!this.#interactive)return listeners;
  const listen=(type,callback,options)=>{listeners.push([canvas,type,callback,options]);canvas.addEventListener(type,callback,options);};
  const point=event=>{const rect=canvas.getBoundingClientRect();return[event.clientX-rect.left,event.clientY-rect.top];};
  try{
  listen('pointerdown',event=>{if(event.pointerType!=='touch'&&event.button!==0)return;event.preventDefault();canvas.focus({preventScroll:true});this.#pointers.add(event.pointerId);try{canvas.setPointerCapture(event.pointerId);}catch{}const[x,y]=point(event);void this.#send('nativePointer',['down',event.pointerId,x,y,event.pointerType==='touch'?16:8]);});
  listen('pointermove',event=>{const[x,y]=point(event);void this.#send('nativePointer',['move',event.pointerId,x,y]);});
  listen('pointerup',event=>{if(!this.#pointers.delete(event.pointerId))return;try{canvas.releasePointerCapture(event.pointerId);}catch{}void this.#send('nativePointer',['up',event.pointerId]);});
  const cancel=()=>{this.#pointers.clear();void this.#send('nativePointer',['cancel']);};
  listen('pointercancel',cancel);
  listen('lostpointercapture',event=>{if(this.#pointers.has(event.pointerId))cancel();});
  listen('pointerleave',()=>{if(!this.#pointers.size)void this.#send('nativeHoverExit',[]);});
  listen('wheel',event=>{event.preventDefault();void this.#send('nativeWheel',[event.deltaY*(event.deltaMode===1?16:1),point(event)[0]]);},{passive:false});
  listen('keydown',event=>{const control=event.ctrlKey||event.metaKey;if(KEYBOARD.has(event.key)||control&&['z','y','Z','Y'].includes(event.key))event.preventDefault();void this.#send('nativeKey',[event.key,control,event.shiftKey]);});
  return listeners;
  }catch(error){this.#unbind(listeners);throw error;}
 }
 #size(){const rect=this.container.getBoundingClientRect(),width=Math.floor(rect.width),height=Math.floor(rect.height),ratio=this.#dpr();if(!Number.isFinite(width)||!Number.isFinite(height)||width<1||height<1||typeof ratio!=='number'||!Number.isFinite(ratio)||ratio<=0||Math.ceil(width*ratio)*Math.ceil(height*ratio)>MAX_PIXELS)throw new RangeError('Rust chart surface size');return{width,height,ratio};}
 #paint(surface,scene,ratio){const width=Math.ceil(scene.width*ratio),height=Math.ceil(scene.height*ratio);if(surface.canvas.width!==width)surface.canvas.width=width;if(surface.canvas.height!==height)surface.canvas.height=height;if(surface.renderer)surface.renderer.render(scene,ratio);else renderCanvas(surface.context,scene,ratio);}
 invalidate(){if(this.disposed)return;this.#dirty=true;if(!this.#paused&&this.#raf===null)this.#raf=requestAnimationFrame(()=>{this.#raf=null;void this.drawNow().catch(error=>this.#report(error));});}
 resize(){if(this.disposed)return;this.#epoch++;this.invalidate();}
 drawNow(){
  if(this.disposed)return Promise.reject(new Error('Rust chart view is closed'));
  if(this.#paused)return Promise.reject(new Error('Rust presentation is paused for candidate preparation'));
  if(this.#raf!==null){cancelAnimationFrame(this.#raf);this.#raf=null;}
  if(this.#drawing)return this.#drawing;
  this.#dirty=false;const epoch=this.#epoch,surface=this.#surface;
  this.#drawing=(async()=>{
   const {width,height,ratio}=this.#size(),start=performance.now();
   const packet=await this.session.packet(['scene',null,width,height]);
   if(this.disposed||epoch!==this.#epoch||surface!==this.#surface)return null;
   const decoded=decodeRustPacket(packet),scene=decoded.layers[0];
   if(decoded.mode!=='scene'||!scene)throw new TypeError('Rust chart requires a complete scene packet');
   this.#paint(surface,scene,ratio);this.lastScene=scene;this.lastError=null;
   this.renderMetrics={backend:'rust-wasm',renderer:this.rendererKind,revision:packet.revision,elapsedMs:performance.now()-start,numbers:packet.numbers.length};
   this.canvas.dispatchEvent(new CustomEvent('aster:render',{bubbles:true,detail:{generation:packet.generation,revision:packet.revision,stats:scene.stats}}));
   return scene.stats;
  })().finally(()=>{this.#drawing=null;if(this.#dirty&&!this.disposed)this.invalidate();});
  return this.#drawing;
 }
 async flush(){let inputs;do{inputs=this.#inputTail;await inputs;if(this.disposed)return;await this.drawNow();}while(!this.disposed&&(this.#dirty||inputs!==this.#inputTail));}
 async setTool(tool){return this.#send('nativeTool',[tool]);}
 pausePresentation(){if(this.disposed)throw new Error('Rust chart view is closed');this.#paused++;if(this.#raf!==null)cancelAnimationFrame(this.#raf);this.#raf=null;}
 resumePresentation(){if(this.#paused)this.#paused--;if(!this.#paused&&this.#dirty)this.invalidate();}
 promotionSize(){if(this.disposed)throw new Error('Rust chart view is closed');return this.#size();}
 stagePresentation(packet,snapshot){
  if(this.disposed||this.#pointers.size)throw new Error('Rust view has active input or is closed');
  const decoded=decodeRustPacket(packet),scene=decoded.layers[0],size=this.#size();
  if(decoded.mode!=='scene'||!scene||scene.width!==size.width||scene.height!==size.height)throw new TypeError('Rust candidate scene size changed');
  const previous=this.#surface,epoch=this.#epoch,next=this.#makeSurface(this.rendererKind);let listeners=[],done=false;
  const discard=()=>{if(done)return;done=true;this.#unbind(listeners);next.active=false;next.renderer?.dispose();next.canvas.remove();next.canvas.width=next.canvas.height=0;};
  try{
   this.#paint(next,scene,size.ratio);listeners=this.#bind(next.canvas);
   const tool=snapshot?.interaction?.tool??'select',gesture=snapshot?.interaction?.gestureKind;
   next.canvas.style.cursor=tool==='select'?(gesture==='pan'?'grabbing':'grab'):tool==='text'?'text':'crosshair';
  }catch(error){discard();throw error;}
  return {
   discard,
   commit:()=>{
    if(done||this.disposed||this.#surface!==previous||this.#epoch!==epoch||this.#pointers.size)throw new Error('Rust presentation owner changed before activation');
    previous.canvas.replaceWith(next.canvas);
    done=true;this.#unbind();previous.active=false;this.#listeners=listeners;this.#surface=next;this.canvas=next.canvas;next.active=true;this.#epoch++;this.lastScene=scene;this.lastError=null;
    this.renderMetrics={backend:'rust-wasm',renderer:this.rendererKind,revision:packet.revision,numbers:packet.numbers.length};
    try{previous.renderer?.dispose();}catch(error){this.#report(error);}finally{previous.canvas.width=previous.canvas.height=0;}
   },
  };
 }
 replaceRenderer(kind){
  const task=this.#rendererTail.then(()=>this.#replaceRenderer(kind));this.#rendererTail=task.catch(()=>{});return task;
 }
 async #replaceRenderer(kind){
  if(!['canvas','webgl2'].includes(kind))throw new RangeError('Unknown Rust chart renderer');
  if(this.disposed)throw new Error('Rust chart view is closed');if(kind===this.rendererKind)return;
  await this.#inputTail;
  if(this.#pointers.size){this.#pointers.clear();await this.session.invoke('nativePointer',['cancel']);}
  if(this.disposed)throw new Error('Rust chart view is closed');
  const previous=this.#surface,next=this.#makeSurface(kind);let listeners=[];
  try{
   if(this.lastScene)this.#paint(next,this.lastScene,this.#size().ratio);
   listeners=this.#bind(next.canvas);
   const snapshot=this.session.snapshot(),tool=snapshot?.interaction?.tool??'select',gesture=snapshot?.interaction?.gestureKind;
   next.canvas.style.cursor=tool==='select'?(gesture==='pan'?'grabbing':'grab'):tool==='text'?'text':'crosshair';
   if(this.disposed)throw new Error('Rust chart view is closed');
   previous.canvas.replaceWith(next.canvas);
  }catch(error){this.#unbind(listeners);next.active=false;next.renderer?.dispose();next.canvas.remove();throw error;}
  this.#unbind();previous.active=false;this.#listeners=listeners;this.#surface=next;this.canvas=next.canvas;this.rendererKind=kind;next.active=true;this.#epoch++;
  try{previous.renderer?.dispose();}catch(error){this.#report(error);}finally{previous.canvas.width=previous.canvas.height=0;}
  this.invalidate();
 }
 #retire(){
  if(this.disposed)return;this.disposed=true;this.#epoch++;if(this.#raf!==null)cancelAnimationFrame(this.#raf);this.#raf=null;this.#observer?.disconnect();this.#unsubscribe?.();this.#unbind();this.#pointers.clear();if(this.#surface){this.#surface.active=false;this.#surface.renderer?.dispose();this.#surface.canvas.remove();this.#surface.canvas.width=this.#surface.canvas.height=0;}this.session.releaseView(this);
 }
 onSessionClose(){this.#retire();}
 destroy({closeSession=false}={}){
  if(this.#destroyPromise)return this.#destroyPromise;
  const needsCancel=this.#pointers.size>0;this.#retire();
  this.#destroyPromise=(async()=>{if(needsCancel&&!this.session.closed)try{await this.session.invoke('nativePointer',['cancel']);}catch(error){if(!this.session.closed)throw error;}if(closeSession)await this.session.close();})();
  return this.#destroyPromise;
 }
}

export async function createRustChart(container,session,options={}){
 const chart=new RustChartView(container,session,options);
 try{await chart.drawNow();return chart;}catch(error){await chart.destroy();throw error;}
}
