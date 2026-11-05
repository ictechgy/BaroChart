import type {RustActor} from './actor.mjs';
import type {RustParamsJobOptions,RustParamsReceipt} from './params-job.mjs';
import type {RustPrepareInput,RustPrepareJobOptions} from './prepare-job.mjs';
import type {RustMigrationJobOptions} from './migration-job.mjs';
import type {RustCaptureJobOptions,RustCaptureResult} from './capture-job.mjs';

export interface RustPresentationState {
 readonly schema:'aster.web-wasm.presentation';readonly version:1;readonly generation:string;readonly revision:number;
 readonly data:Readonly<{length:number;capacity:number;version:number;timeVersion:number}>;
 readonly view:Readonly<{from:number;to:number;follow:boolean}>;
 readonly configuration:Readonly<{panels:number;axes:number;series:number;indicators:number}>;
 readonly drawings:Readonly<{count:number;selected:string|null;canUndo:boolean;canRedo:boolean;transaction:boolean;serial:number}>;
 readonly interaction:Readonly<{tool:string;text:string;gestureKind:string|null;pointerCount:number;crosshair:unknown;crosshairSnap:unknown;drawingTarget:unknown;drawingMagnet:unknown}>;
}
export interface RustViewOwner {onSessionClose?():void;}
export class RustSessionError extends Error {constructor(message:string,options?:{code?:string;cause?:unknown});readonly code:string;}
export class RustSession {
 constructor(actor:RustActor,options?:{createActor?:(options?:{signal?:AbortSignal})=>Promise<RustActor>;maxTransfer?:number});
 readonly backend:'rust-wasm';readonly generation:string;readonly closed:boolean;readonly quarantined:boolean;readonly requiresResync:boolean;readonly notificationErrors:number;
 readonly lastOutcome:Readonly<{id:number;operation:string;phase:string;status:number|null}>|null;
 readonly activeJob:'params'|'prepare'|'migration'|null;
 snapshot():RustPresentationState;
 subscribe(listener:(state:RustPresentationState)=>unknown,options?:{emitCurrent?:boolean}):()=>boolean;
 resync():Promise<RustPresentationState>;
 invoke(name:string,args?:unknown[]):Promise<unknown>;
 command(operation:string,args?:unknown[]):Promise<unknown>;
 query(name:string,args?:unknown[]):Promise<unknown>;
 packet(args:unknown[]):Promise<{metadata:unknown;numbers:Float64Array;generation:string;revision:number}>;
 readDataColumn(field:'time'|'open'|'high'|'low'|'close'|'volume',start:number,count:number,expectedVersion?:number):Promise<Float64Array>;
 exportColumns(options?:{maxBars?:number}):Promise<{columns:Record<'time'|'open'|'high'|'low'|'close'|'volume',Float64Array>;length:number;version:number;generation:string}>;
 memoryStats():Promise<Record<string,unknown>>;
 setIndicatorParams(id:string,params:Record<string,unknown>,options?:RustParamsJobOptions):Promise<RustParamsReceipt>;
 applyLayoutFrame(frame:unknown):Promise<void>;
 registerIndicatorSource(name:string,source:unknown):Promise<never>;
 saveWorkspace(binding:Record<string,unknown>):Promise<string>;
 prepareData(input:RustPrepareInput,options?:Omit<RustPrepareJobOptions,'activate'>):Promise<{status:'committed';generation:string;snapshot:RustPresentationState}>;
 recreate(options?:Omit<RustMigrationJobOptions,'activate'>&{binding?:Record<string,unknown>}):Promise<{status:'committed';generation:string;snapshot:RustPresentationState}>;
 withMigrationCapture<T,A>(binding:Record<string,unknown>,options:RustCaptureJobOptions<T,A>&{activate:NonNullable<RustCaptureJobOptions<T,A>['activate']>}):Promise<RustCaptureResult<T,A>>;
 claimView(view:RustViewOwner):void;releaseView(view:RustViewOwner):void;close():Promise<void>;
}
export function openRustSession(actor:RustActor,options?:{count?:number;options?:unknown;createActor?:(options?:{signal?:AbortSignal})=>Promise<RustActor>}):Promise<RustSession>;
