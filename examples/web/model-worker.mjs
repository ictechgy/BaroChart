import {makeDemoData} from './demo-data.mjs';
import {computeRequest} from '../../src/web/compute-worker.mjs';import {transferBuffers} from '../../src/web/worker-state.mjs';
self.onmessage=async({data})=>{try{const columns=makeDemoData({market:data.market,count:data.count,onProgress:progress=>self.postMessage({progress})}),packet=await computeRequest({columns,options:data.options},progress=>self.postMessage({progress}));self.postMessage({packet},transferBuffers(packet));}catch(error){self.postMessage({error:String(error.message).slice(0,256)});}};
