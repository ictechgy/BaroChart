import type {ForwardRefExoticComponent,HTMLAttributes,RefAttributes} from 'react';
import type {Bar,ChartModel,ChartAPI,ColumnInput,DrawingTarget,DrawingType,Theme} from '../core/index.mjs';
import type {CanvasChart,ChartOptions} from '../renderers/canvas.mjs';

export interface AsterChartHandle {
 readonly chart:CanvasChart|null;
 readonly model:ChartModel|null;
 readonly api:ChartAPI|null;
}
export interface AsterChartContext {readonly chart:CanvasChart;readonly model:ChartModel}
export type AsterChartData=readonly Bar[]|{columns:ColumnInput;length?:number};
type Ownership={model:ChartModel;createModel?:never}|{model?:undefined;createModel?:()=>ChartModel};
export type AsterChartProps=Omit<HTMLAttributes<HTMLDivElement>,'children'|'onError'> & Ownership & {
 children?:never;
 data?:AsterChartData;
 /** Reapply an unchanged input object after caller-side mutation; inputs are copied. */
 dataRevision?:number|string;
 theme?:Partial<Theme>;
 renderer?:'canvas'|'webgl2'|'auto';
 options?:ChartOptions;
 /** Recreate the renderer; an owned factory creates a new model for each lifecycle. */
 resetKey?:number|string;
 tool?:'select'|DrawingType;
 text?:string;
 drawingTarget?:DrawingTarget|null;
 /** undefined leaves imperative range alone; null fits all bars. */
 visibleRange?:readonly [number,number]|null;
 onReady?:(context:AsterChartContext)=>void|(()=>void);
 onDispose?:(context:AsterChartContext)=>void;
 onRender?:(context:AsterChartContext,event:Event)=>void;
 onState?:(context:AsterChartContext,event:Event)=>void;
 onError?:(error:Error)=>void;
 onFallback?:(reason:string)=>void;
};
export const AsterChart:ForwardRefExoticComponent<AsterChartProps & RefAttributes<AsterChartHandle>>;
