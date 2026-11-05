import {CanvasChart} from './canvas.mjs';
import {renderCanvas} from './canvas-commands.mjs';
import {CacheAllocationError} from './cache-budget.mjs';
import {WebGLRenderer} from './webgl-renderer.mjs';
export {WebGLRenderer};

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
