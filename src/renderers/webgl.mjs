import {CanvasChart} from './canvas.mjs';
import {renderCanvas} from './canvas.mjs';
import {CacheAllocationError} from './cache-budget.mjs';

const WEBGL_FRAME_INSTANCE_LIMIT=200000,WEBGL_PACKED_BYTE_LIMIT=16777216,COLOR_CACHE_LIMIT=256;
// CPU packing and the matching GPU allocation both retain the grown capacity.
// The 200k instance budget and fixed 16 MiB power-of-two ceiling bound
// tessellation independently of document limits, preventing hundreds of MiB
// of retained screen buffers per renderer.
class WebGLCapacityError extends RangeError {constructor(kind,limit){super(`WebGL frame ${kind} limit ${limit}`);this.name='WebGLCapacityError';}}

const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec4 top;
layout(location=1) in vec4 bottom;
layout(location=2) in vec4 tint;
layout(location=3) in vec4 uvRect;
uniform vec2 viewport;
out vec4 color; out vec2 uv; flat out float textured;
void main(){
 bool right=(gl_VertexID&1)==1; bool down=gl_VertexID>=2;
 vec2 p=down?(right?bottom.zw:bottom.xy):(right?top.zw:top.xy);
 gl_Position=vec4(p.x/viewport.x*2.0-1.0,1.0-p.y/viewport.y*2.0,0.0,1.0);
 color=tint;uv=uvRect.xy+vec2(right?1.0:0.0,down?1.0:0.0)*uvRect.zw;
 textured=uvRect.z>0.0?1.0:0.0;
}`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec4 color; in vec2 uv; flat in float textured;
uniform sampler2D atlas;
out vec4 pixel;
void main(){pixel=vec4(color.rgb,color.a*(textured>0.5?texture(atlas,uv).a:1.0));}`;
const COPY_VERTEX = `#version 300 es
precision highp float;
out vec2 uv;
void main(){uv=vec2(float(gl_VertexID&1),float((gl_VertexID>>1)&1));gl_Position=vec4(uv*2.0-1.0,0.0,1.0);}`;
const COPY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;uniform sampler2D image;out vec4 pixel;
void main(){pixel=texture(image,uv);}`;

function shader(gl, type, source) {
 const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);
 if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const error=gl.getShaderInfoLog(s);gl.deleteShader(s);throw new Error(error);}return s;
}
// Only display coordinates are packed as Float32. This renderer never reads or
// uploads timestamp/price columns, indicator outputs or persisted anchors.
export class WebGLRenderer {
 constructor(canvas, onLost = null) {
  const gl=this.gl=canvas.getContext('webgl2',{alpha:false,antialias:true,premultipliedAlpha:false,preserveDrawingBuffer:false});
  if(!gl)throw new Error('WebGL2 unavailable');this.kind='webgl2';this.canvas=canvas;this.disposed=false;this.layers=null;
  const supported=gl.getInternalformatParameter(gl.RENDERBUFFER,gl.RGBA8,gl.SAMPLES);this.layerSamples=Math.max(0,...Array.from(supported).filter(n=>n<=gl.getParameter(gl.SAMPLES)));
  this.lost=e=>{e.preventDefault();onLost?.('WebGL2 context lost');};canvas.addEventListener('webglcontextlost',this.lost);
  this.program=gl.createProgram();let v,f;
  try{v=shader(gl,gl.VERTEX_SHADER,VERTEX);f=shader(gl,gl.FRAGMENT_SHADER,FRAGMENT);gl.attachShader(this.program,v);gl.attachShader(this.program,f);gl.linkProgram(this.program);if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(this.program));}
  catch(e){this.dispose();throw e;}finally{if(v)gl.deleteShader(v);if(f)gl.deleteShader(f);}
  this.vao=gl.createVertexArray();this.buffer=gl.createBuffer();gl.bindVertexArray(this.vao);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
  for(let i=0;i<4;i++){gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,4,gl.FLOAT,false,64,i*16);gl.vertexAttribDivisor(i,1);}
  this.viewportUniform=gl.getUniformLocation(this.program,'viewport');this.texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,this.texture);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  this.atlas=document.createElement('canvas');this.atlas.width=this.atlas.height=2048;this.atlasContext=this.atlas.getContext('2d');this.glyphs=new Map();this.colors=new Map();this.colorCanvas=document.createElement('canvas');this.colorCanvas.width=this.colorCanvas.height=1;this.colorContext=this.colorCanvas.getContext('2d',{willReadFrequently:true});
  this.packed=new Float32Array(4096*16);this.capacityBytes=0;this.resetAtlas(1);
 }
 resetAtlas(dpr){this.glyphs.clear();this.atlasContext.clearRect(0,0,2048,2048);this.atlasX=1;this.atlasY=1;this.rowHeight=0;this.atlasDpr=dpr;this.atlasDirty=true;}
 color(css){
  let result=this.colors.get(css);if(result){this.colors.delete(css);this.colors.set(css,result);return result;}
  if(typeof css==='string'&&/^#[\da-f]{8}$/i.test(css)){const value=Number.parseInt(css.slice(1),16);result=[(value>>>24)/255,(value>>>16&255)/255,(value>>>8&255)/255,(value&255)/255];}
  else{const c=this.colorContext;c.clearRect(0,0,1,1);c.fillStyle='#ffffff';c.fillStyle=css;c.fillRect(0,0,1,1);const p=c.getImageData(0,0,1,1).data;result=[p[0]/255,p[1]/255,p[2]/255,p[3]/255];}
  this.colors.set(css,result);if(this.colors.size>COLOR_CACHE_LIMIT)this.colors.delete(this.colors.keys().next().value);return result;
 }
 glyph(character,font){
  const key=font+'\0'+character;if(this.glyphs.has(key))return this.glyphs.get(key);const c=this.atlasContext,ratio=this.atlasDpr;c.font=font;const m=c.measureText(character),size=parseFloat(font.match(/([\d.]+)px/)?.[1]??'12');
  const left=Math.ceil(Math.max(0,m.actualBoundingBoxLeft??0))+2,right=Math.ceil(Math.max(m.width,m.actualBoundingBoxRight??m.width))+2,ascent=Math.ceil(m.actualBoundingBoxAscent??size)+2,descent=Math.ceil(m.actualBoundingBoxDescent??size*.3)+2;
  const w=Math.ceil((left+right)*ratio),h=Math.ceil((ascent+descent)*ratio);if(this.atlasX+w>=2048){this.atlasX=1;this.atlasY+=this.rowHeight+1;this.rowHeight=0;}
  if(w>=2047||this.atlasY+h>=2048)throw new Error('Glyph atlas capacity exceeded; use Canvas for large text sets');const x=this.atlasX,y=this.atlasY;
  c.save();c.setTransform(ratio,0,0,ratio,x,y);c.font=font;c.fillStyle='#ffffff';c.fillText(character,left,ascent);c.restore();
  const result={advance:m.width,left,ascent,w:w/ratio,h:h/ratio,uv:[x/2048,y/2048,w/2048,h/2048]};this.glyphs.set(key,result);this.atlasX+=w+1;this.rowHeight=Math.max(this.rowHeight,h);this.atlasDirty=true;return result;
 }
 quad(x0,y0,x1,y1,x2,y2,x3,y3,color,uv=null){
  if(!Number.isFinite(x0)||!Number.isFinite(y0)||!Number.isFinite(x1)||!Number.isFinite(y1)||!Number.isFinite(x2)||!Number.isFinite(y2)||!Number.isFinite(x3)||!Number.isFinite(y3))return;
  const next=this.count+1,bytes=next*64;if(next>WEBGL_FRAME_INSTANCE_LIMIT)throw new WebGLCapacityError('instance',WEBGL_FRAME_INSTANCE_LIMIT);if(bytes>WEBGL_PACKED_BYTE_LIMIT)throw new WebGLCapacityError('packed byte',WEBGL_PACKED_BYTE_LIMIT);
  const i=this.count*16;if(i+16>this.packed.length){let length=this.packed.length;while(length<i+16){if(length*8>WEBGL_PACKED_BYTE_LIMIT){length=WEBGL_PACKED_BYTE_LIMIT/4;break;}length*=2;}if(length<i+16||length*4>WEBGL_PACKED_BYTE_LIMIT)throw new WebGLCapacityError('packed byte',WEBGL_PACKED_BYTE_LIMIT);const a=new Float32Array(length);a.set(this.packed);this.packed=a;}
  const a=this.packed;a[i]=x0;a[i+1]=y0;a[i+2]=x1;a[i+3]=y1;a[i+4]=x2;a[i+5]=y2;a[i+6]=x3;a[i+7]=y3;
  a[i+8]=color[0];a[i+9]=color[1];a[i+10]=color[2];a[i+11]=color[3];a[i+12]=uv?.[0]??0;a[i+13]=uv?.[1]??0;a[i+14]=uv?.[2]??0;a[i+15]=uv?.[3]??0;this.count++;
 }
 rect(x,y,w,h,color,uv){this.quad(x,y,x+w,y,x,y+h,x+w,y+h,color,uv);}
 segment(x,y,a,b,width,color,dash=null,phase=0){
  const dx=a-x,dy=b-y,length=Math.hypot(dx,dy);if(!length)return phase;
  if(dash?.length){const pattern=dash.length%2?[...dash,...dash]:dash;
   if(pattern.some(v=>!Number.isFinite(v)||v<0))throw new RangeError('Dash lengths must be finite and nonnegative');
   const sum=pattern.reduce((n,v)=>n+v,0);if(sum<=0)return this.segment(x,y,a,b,width,color);let pos=0;
   while(pos<length){let at=((phase+pos)%sum+sum)%sum,k=0;while(k<pattern.length-1&&at>=pattern[k])at-=pattern[k++];const step=Math.min(length-pos,pattern[k]-at);if(step<=1e-9){pos+=1e-8;continue;}if(k%2===0)this.segment(x+dx*pos/length,y+dy*pos/length,x+dx*(pos+step)/length,y+dy*(pos+step)/length,width,color);pos+=step;}return (phase+length)%sum;
  }
  const nx=-dy/length*width/2,ny=dx/length*width/2;this.quad(x+nx,y+ny,a+nx,b+ny,x-nx,y-ny,a-nx,b-ny,color);return phase+length;
 }
 render(scene,dpr=1,{target=null,clear=true}={}){
  if(this.disposed||this.gl.isContextLost())return;
  const gl=this.gl;this.count=0;this.runs=[];this.metrics={instances:0,drawCalls:0,screenBufferBytes:0,glyphs:0};if(dpr!==this.atlasDpr)this.resetAtlas(dpr);
  // Preload before drawing; no atlas coordinates change during a frame.
  for(const c of scene.commands)if(c.op==='text')for(const char of c.text)this.glyph(char,c.font??'12px monospace');
  let clipKey='',run=null;
  for(const c of scene.commands){
   const key=JSON.stringify(c.clip??null);if(key!==clipKey){run={clip:c.clip,start:this.count,end:this.count};this.runs.push(run);clipKey=key;}
   const color=this.color(c.color),fill=c.fill?this.color(c.fill):color,w=c.width??1;
   if(c.op==='rects'){for(let i=0;i<c.coords.length;i+=4)this.rect(...c.coords.slice(i,i+4),color);}
   else if(c.op==='lines'){for(let i=0;i<c.coords.length;i+=4)this.segment(...c.coords.slice(i,i+4),w,color,c.dash);}
   else if(c.op==='path'){
    let phase=0;for(let i=2;i<c.points.length;i+=2)phase=this.segment(c.points[i-2],c.points[i-1],c.points[i],c.points[i+1],w,color,c.dash,phase);
    if(c.fill)for(let i=2;i<c.points.length;i+=2){const x=c.points[i-2],y=c.points[i-1],a=c.points[i],b=c.points[i+1],z=c.baseline;if((y-z)*(b-z)<0){const mid=x+(a-x)*(z-y)/(b-y);this.quad(x,y,mid,z,x,z,mid,z,fill);this.quad(mid,z,a,b,mid,z,a,z,fill);}else this.quad(x,y,a,b,x,z,a,z,fill);}
   }else if(c.op==='box'){
    if(c.fill)this.rect(c.x,c.y,c.w,c.h,fill);const x=c.x,y=c.y,a=x+c.w,b=y+c.h;this.segment(x,y,a,y,w,color);this.segment(a,y,a,b,w,color);this.segment(a,b,x,b,w,color);this.segment(x,b,x,y,w,color);
   }else if(c.op==='ellipse'){
    const cx=c.x+c.w/2,cy=c.y+c.h/2,rx=c.w/2,ry=c.h/2,n=Math.min(256,Math.max(32,Math.ceil(Math.PI*Math.sqrt(Math.max(rx,ry))*2)));let x=cx+rx,y=cy;
    for(let i=1;i<=n;i++){const a=cx+rx*Math.cos(i/n*Math.PI*2),b=cy+ry*Math.sin(i/n*Math.PI*2);if(c.fill)this.quad(cx,cy,x,y,cx,cy,a,b,fill);this.segment(x,y,a,b,w,color);x=a;y=b;}
   }else if(c.op==='text'){
    let x=c.x;for(const char of c.text){const q=this.glyph(char,c.font??'12px monospace');this.rect(x-q.left,c.y-q.ascent,q.w,q.h,color,q.uv);x+=q.advance;}
   }run.end=this.count;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER,target);gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.disable(gl.SCISSOR_TEST);if(clear){const bg=this.color(scene.background);gl.clearColor(bg[0]*bg[3],bg[1]*bg[3],bg[2]*bg[3],1);gl.clear(gl.COLOR_BUFFER_BIT);}gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.useProgram(this.program);gl.bindVertexArray(this.vao);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.uniform2f(this.viewportUniform,scene.width,scene.height);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.texture);
  if(this.atlasDirty){gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,this.atlas);this.atlasDirty=false;}
  if(this.capacityBytes<this.packed.byteLength){gl.bufferData(gl.ARRAY_BUFFER,this.packed.byteLength,gl.DYNAMIC_DRAW);this.capacityBytes=this.packed.byteLength;}gl.bufferSubData(gl.ARRAY_BUFFER,0,this.packed.subarray(0,this.count*16));
  for(const r of this.runs){if(r.end===r.start)continue;if(r.clip){gl.enable(gl.SCISSOR_TEST);const [x,y,w,h]=r.clip,l=Math.floor(x*dpr),b=Math.floor((scene.height-y-h)*dpr);gl.scissor(l,b,Math.ceil((x+w)*dpr)-l,Math.ceil((scene.height-y)*dpr)-b);}else gl.disable(gl.SCISSOR_TEST);
   for(let i=0;i<4;i++)gl.vertexAttribPointer(i,4,gl.FLOAT,false,64,r.start*64+i*16);gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,r.end-r.start);this.metrics.drawCalls++;
  }gl.disable(gl.SCISSOR_TEST);this.metrics.instances=this.count;this.metrics.screenBufferBytes=this.count*64;this.metrics.glyphs=this.glyphs.size;
 }
 releaseLayers(){if(!this.layers)return;const gl=this.gl;for(const target of [this.layers.base,this.layers.stable]){gl.deleteFramebuffer(target.framebuffer);gl.deleteTexture(target.texture);}if(this.layers.scratch){gl.deleteFramebuffer(this.layers.scratch.framebuffer);gl.deleteRenderbuffer(this.layers.scratch.renderbuffer);}this.layers=null;}
 layerTarget(width,height){
  const gl=this.gl,texture=gl.createTexture(),framebuffer=gl.createFramebuffer();
  if(!texture||!framebuffer){if(texture)gl.deleteTexture(texture);if(framebuffer)gl.deleteFramebuffer(framebuffer);throw new CacheAllocationError('Layer framebuffer allocation');}
  try{gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new CacheAllocationError('Layer framebuffer unavailable');return {texture,framebuffer};}
  catch(error){gl.deleteTexture(texture);gl.deleteFramebuffer(framebuffer);throw error;}
 }
 blitLayer(source,target,width,height){const gl=this.gl;gl.disable(gl.SCISSOR_TEST);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,source);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,target);gl.blitFramebuffer(0,0,width,height,0,0,width,height,gl.COLOR_BUFFER_BIT,gl.NEAREST);}
 multisampleTarget(width,height){
  const gl=this.gl,renderbuffer=gl.createRenderbuffer(),framebuffer=gl.createFramebuffer();if(!renderbuffer||!framebuffer){if(renderbuffer)gl.deleteRenderbuffer(renderbuffer);if(framebuffer)gl.deleteFramebuffer(framebuffer);throw new CacheAllocationError('Multisample layer allocation');}
  try{gl.bindRenderbuffer(gl.RENDERBUFFER,renderbuffer);gl.renderbufferStorageMultisample(gl.RENDERBUFFER,this.layerSamples,gl.RGBA8,width,height);const samples=gl.getRenderbufferParameter(gl.RENDERBUFFER,gl.RENDERBUFFER_SAMPLES);gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.RENDERBUFFER,renderbuffer);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new CacheAllocationError('Multisample layer unavailable');return {renderbuffer,framebuffer,samples};}
  catch(error){gl.deleteRenderbuffer(renderbuffer);gl.deleteFramebuffer(framebuffer);throw error;}
 }
 presentTexture(texture,target,width,height){
  const gl=this.gl;
  if(!this.copyProgram){const program=gl.createProgram();let v,f;try{v=shader(gl,gl.VERTEX_SHADER,COPY_VERTEX);f=shader(gl,gl.FRAGMENT_SHADER,COPY_FRAGMENT);gl.attachShader(program,v);gl.attachShader(program,f);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));this.copyProgram=program;}catch(error){gl.deleteProgram(program);throw error;}finally{if(v)gl.deleteShader(v);if(f)gl.deleteShader(f);}}
  gl.bindFramebuffer(gl.FRAMEBUFFER,target);gl.viewport(0,0,width,height);gl.disable(gl.SCISSOR_TEST);gl.disable(gl.BLEND);gl.useProgram(this.copyProgram);gl.bindVertexArray(null);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
 }
 renderLayers(frame,dpr){
  if(this.disposed||this.gl.isContextLost())throw new Error('Layer WebGL context unavailable');
  const w=this.canvas.width,h=this.canvas.height;let allocated=false;
  if(!this.layers||this.layers.width!==w||this.layers.height!==h){
   this.releaseLayers();const base=this.layerTarget(w,h);let stable,scratch;
   try{stable=this.layerTarget(w,h);if(this.layerSamples)scratch=this.multisampleTarget(w,h);}catch(error){for(const target of [base,stable])if(target){this.gl.deleteFramebuffer(target.framebuffer);this.gl.deleteTexture(target.texture);}throw error;}
   this.layers={width:w,height:h,base,stable,scratch};allocated=true;
  }
  const baseChanged=allocated||frame.baseChanged,drawingsChanged=baseChanged||frame.drawingsChanged,metrics={instances:0,drawCalls:0,screenBufferBytes:0,glyphs:0},submit=(scene,target,clear)=>{this.render(scene,dpr,{target,clear});for(const key of ['instances','drawCalls','screenBufferBytes'])metrics[key]+=this.metrics[key];metrics.glyphs=this.metrics.glyphs;};
  let framebufferBlits=0,texturePresents=0;
  if(baseChanged){submit(frame.base,this.layers.scratch?.framebuffer??this.layers.base.framebuffer,true);if(this.layers.scratch){this.blitLayer(this.layers.scratch.framebuffer,this.layers.base.framebuffer,w,h);framebufferBlits++;}}
  if(drawingsChanged){
   if(this.layers.scratch&&frame.drawings.commands.length){this.presentTexture(this.layers.base.texture,this.layers.scratch.framebuffer,w,h);texturePresents++;submit(frame.drawings,this.layers.scratch.framebuffer,false);this.blitLayer(this.layers.scratch.framebuffer,this.layers.stable.framebuffer,w,h);framebufferBlits++;}
   else{this.blitLayer(this.layers.base.framebuffer,this.layers.stable.framebuffer,w,h);framebufferBlits++;if(frame.drawings.commands.length)submit(frame.drawings,this.layers.stable.framebuffer,false);}
  }
  this.presentTexture(this.layers.stable.texture,null,w,h);texturePresents++;submit(frame.hover,null,false);this.metrics=metrics;
  return {baseRedrawn:baseChanged,drawingsRedrawn:drawingsChanged,cachedPixelBytes:w*h*4*(2+(this.layers.scratch?.samples??0)),hoverCommands:frame.hover.commands.length,framebufferBlits,texturePresents,msaaSamples:this.layers.scratch?.samples??0};
 }
 dispose(){if(this.disposed)return;this.disposed=true;this.canvas?.removeEventListener('webglcontextlost',this.lost);const gl=this.gl;if(gl){this.releaseLayers();if(this.buffer)gl.deleteBuffer(this.buffer);if(this.vao)gl.deleteVertexArray(this.vao);if(this.texture)gl.deleteTexture(this.texture);if(this.program)gl.deleteProgram(this.program);if(this.copyProgram)gl.deleteProgram(this.copyProgram);gl.getExtension('WEBGL_lose_context')?.loseContext();}this.packed=null;this.glyphs?.clear();this.colors?.clear();if(this.atlas)this.atlas.width=this.atlas.height=0;if(this.colorCanvas)this.colorCanvas.width=this.colorCanvas.height=0;this.atlasContext=null;this.colorContext=null;}
}

export class GPUChart extends CanvasChart {
 constructor(container,model,options={}) {super(container,model,{...options,rendererFactory:(canvas,onLost)=>new WebGLRenderer(canvas,onLost)});}
 canCacheLayers(pixels){return pixels*4*(2+(this.renderer?.layerSamples??0))<=100663296;}
 cachedLayerBytes(pixels){return this.renderer?pixels*4*(2+this.renderer.layerSamples):super.cachedLayerBytes(pixels);}
 // Fallback schedules a fresh owned frame. Do not continue obsolete GPU work
 // through replacement callbacks, which may draw again or destroy the chart.
 renderScene(scene,ratio){if(!this.renderer)return renderCanvas(this.ctx,scene,ratio);try{this.renderer.render(scene,ratio);}catch(error){this.fallback(error.message);}}
 renderLayers(frame,ratio){if(!this.renderer)return super.renderLayers(frame,ratio);try{return this.renderer.renderLayers(frame,ratio);}catch(error){if(error instanceof CacheAllocationError)throw error;this.fallback(error.message);}}
}
// Auto is opt-in: simple scenes often cost less through Canvas. Actual crossover
// depends on hardware, DPR, series density, text and synchronization behavior.
export function createChart(container,model,{renderer='canvas',...options}={}){
 if(!['canvas','webgl2','auto'].includes(renderer))throw new RangeError('Unknown renderer');return renderer==='canvas'?new CanvasChart(container,model,options):new GPUChart(container,model,options);
}
