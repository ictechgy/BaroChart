export * from './core/index.mjs';
export * from './renderers/canvas.mjs';
export * from './renderers/webgl.mjs';
export {prepareChartModel,recomputeInWorker} from './web/worker.mjs';

export {resampleOHLCVAsync} from './web/resample-async.mjs';
export {setIndicatorParamsAsync} from './web/indicator-params-async.mjs';

export {prepareWorkspaceAsync} from './web/workspace-async.mjs';
export {createChart as createJavaScriptChart} from './renderers/webgl.mjs';
import {snapshotRustChartCreation} from './web/rust-default-options.mjs';

/** Rust-primary asynchronous factory. Importing this root module remains SSR inert. */
export function createBaroChart(container,options){
 const snapshot=snapshotRustChartCreation(container,options);
 return import('./web/rust-default.mjs').then(module=>module.createBaroChartFromSnapshot(snapshot));
}
export default createBaroChart;
