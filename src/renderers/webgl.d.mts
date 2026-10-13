import type {ChartModel,Scene} from '../core/index.mjs';
import {CanvasChart,type ChartOptions} from './canvas.mjs';
export class WebGLRenderer {constructor(canvas:HTMLCanvasElement,onLost?:(reason:string)=>void);readonly gl:WebGL2RenderingContext;readonly kind:'webgl2';readonly metrics?:{instances:number;drawCalls:number;screenBufferBytes:number;glyphs:number};render(scene:Scene,dpr?:number):void;dispose():void}
export class GPUChart extends CanvasChart {constructor(container:HTMLElement,model:ChartModel,options?:ChartOptions);}
export function createChart(container:HTMLElement,model:ChartModel,options?:ChartOptions & {renderer?:'canvas'|'webgl2'|'auto'}):CanvasChart | GPUChart;
