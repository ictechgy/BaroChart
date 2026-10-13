import {resampleOHLCVAsync} from '../src/index.mjs';

// The caller owns this job. Call cancel() on teardown or when a newer request
// replaces it. No chart is mutated; install a result only for the current job.
export function startFiveMinuteResample(store,calendar,asOf,{onProgress,workerFactory}={}) {
 const controller=new AbortController();
 const promise=resampleOHLCVAsync({kind:'store',store},{sourceIntervalMs:60000,targetIntervalMs:300000,calendar,kinds:['regular'],asOf,partialTarget:'include-unconfirmed',signal:controller.signal,onProgress,workerFactory});
 return {promise,cancel:()=>controller.abort()};
}
