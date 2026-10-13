import {seededColumns} from '../../src/core/data.mjs';import {demoCalendar} from '../../src/core/markets.mjs';
import {computeRequest} from '../../src/web/compute-worker.mjs';import {transferBuffers} from '../../src/web/worker-state.mjs';
async function makeData(market,n){if(!['us','kr','crypto'].includes(market))throw new TypeError('Demo market');const c=seededColumns(n,42),calendar=demoCalendar(market);let written=0,date='2026-01-01',nextProgress=0;
 while(written<n){for(const session of calendar.sessions(date).filter(s=>s.kind==='regular'))for(let time=session.open;time<session.close&&written<n;time+=60000)c.time[written++]=time;
  if(written>=nextProgress){self.postMessage({progress:{phase:'data',done:written,total:n}});nextProgress=written+Math.max(10000,n/20);}date=new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10);
 }
 const factor=market==='kr'?700:market==='crypto'?1e-10:1;for(let i=0;i<n;i++)for(const key of ['open','high','low','close'])c[key][i]*=factor;return c;
}
self.onmessage=async({data})=>{try{const columns=await makeData(data.market,data.count),packet=await computeRequest({columns,options:data.options},progress=>self.postMessage({progress}));self.postMessage({packet},transferBuffers(packet));}catch(error){self.postMessage({error:String(error.message).slice(0,256)});}};
