import {runChartWorker} from 'barochart/worker';
import {smoke as defaultSmoke} from './worker-client.mjs';
const workerURL=new URL('./worker-emitted.mjs',import.meta.url);
export const calculate=columns=>runChartWorker({columns},{workerURL});
export const smoke=()=>defaultSmoke({workerURL});
