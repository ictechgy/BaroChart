import type {RustSession} from './session.mjs';
export interface RustChartOptions {renderer?:'canvas'|'webgl2';dpr?:()=>number;interactive?:boolean;observeResize?:boolean;onError?:((error:unknown)=>void)|null;}
export interface RustScene {width:number;height:number;background:string;stats:Record<string,number>;commands:Record<string,unknown>[];}
export class RustChartView {
 constructor(container:HTMLElement,session:RustSession,options?:RustChartOptions);
 readonly container:HTMLElement;readonly session:RustSession;readonly canvas:HTMLCanvasElement;readonly rendererKind:'canvas'|'webgl2';readonly disposed:boolean;
 readonly lastScene:RustScene|null;readonly lastError:unknown;readonly renderMetrics:Readonly<Record<string,unknown>>|null;
 invalidate():void;resize():void;drawNow():Promise<Record<string,number>|null>;flush():Promise<void>;setTool(tool:string):Promise<unknown>;replaceRenderer(kind:'canvas'|'webgl2'):Promise<void>;destroy(options?:{closeSession?:boolean}):Promise<void>;
}
export function createRustChart(container:HTMLElement,session:RustSession,options?:RustChartOptions):Promise<RustChartView>;
