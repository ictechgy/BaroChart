import type {ChartAPI,InteractionController,ChartModel} from '../../index.mjs';

export interface JavaScriptMigrationProgress {readonly phase?:string;readonly stage?:string;readonly [key:string]:unknown;}
export interface JavaScriptMigrationCapture {
 readonly schema:'aster.web-wasm.javascript-capture';readonly version:1;readonly metadataJSON:string;
 readonly columns:Readonly<Record<'time'|'open'|'high'|'low'|'close'|'volume',Float64Array>>;
 readonly header:string;readonly uiChunks:readonly string[];readonly description:Readonly<Record<string,unknown>>;readonly revision:number;
 check():true;finish():Readonly<Record<string,unknown>>;dispose():boolean;
}
export interface JavaScriptMigrationCandidate {
 readonly schema:'aster.web-wasm.javascript-candidate';readonly version:1;readonly model:ChartModel;readonly input:InteractionController;readonly api:ChartAPI;
 readonly size:Readonly<{width:number;height:number}>;readonly plan:unknown;readonly description:Readonly<Record<string,unknown>>;
 dispose():boolean;handoff():Readonly<{model:ChartModel;input:InteractionController;api:ChartAPI;size:Readonly<{width:number;height:number}>}>;
}
export interface JavaScriptMigrationOptions {signal?:AbortSignal;onProgress?:(progress:JavaScriptMigrationProgress)=>unknown|Promise<unknown>;chunkSize?:number;}
export class JavaScriptBackendRequiredError extends Error {readonly code:'JAVASCRIPT_BACKEND_REQUIRED';}
export function captureJavaScriptMigration(options:{api:ChartAPI;input:InteractionController;size:{width:number;height:number};document:string;binding:Record<string,unknown>;revision?:number;maxBytes?:number;signal?:AbortSignal;onProgress?:(progress:JavaScriptMigrationProgress)=>unknown|Promise<unknown>;chunkSize?:number;admissionRecords?:number}):Promise<JavaScriptMigrationCapture>;
export function importJavaScriptMigration(source:Pick<JavaScriptMigrationCapture,'metadataJSON'|'columns'|'header'|'uiChunks'|'description'>,options?:JavaScriptMigrationOptions&{stepSize?:number}):Promise<JavaScriptMigrationCandidate>;
