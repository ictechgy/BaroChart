// Measurement contracts only; importing this module never launches a browser.
export function interactionOptions(input={}) {
  const c={bars:10000,large:false,seed:42,width:1200,height:700,dpr:1,samples:20,warmup:5,parameterSamples:4,parameterWarmup:1,inputIntervalMs:16,streamIntervalMs:50,requestTimeoutMs:5000,caseTimeoutMs:30000,runTimeoutMs:180000,renderers:['canvas','webgl2'],operations:['pan','zoom','stream','params-sync','params-async'],...input};
  if(typeof c.large!=='boolean'||![10000,100000].includes(c.bars)||c.bars===100000&&!c.large)throw new RangeError('100k requires explicit large opt-in');
  for(const [key,lo,hi]of [['seed',0,4294967295],['width',300,2000],['height',200,1200],['dpr',1,2],['samples',1,200],['warmup',0,50],['parameterSamples',1,20],['parameterWarmup',0,5],['inputIntervalMs',16,1000],['streamIntervalMs',16,1000],['requestTimeoutMs',100,10000],['caseTimeoutMs',1000,60000],['runTimeoutMs',1000,600000]])if(!Number.isInteger(c[key])||c[key]<lo||c[key]>hi)throw new RangeError('Interaction '+key);
  for(const [key,allowed]of [['renderers',['canvas','webgl2']],['operations',['pan','zoom','stream','params-sync','params-async']]])if(!Array.isArray(c[key])||!c[key].length||new Set(c[key]).size!==c[key].length||c[key].some(v=>!allowed.includes(v)))throw new TypeError('Interaction '+key);
  return c;
}
export function interactionCases(c){return c.renderers.flatMap(renderer=>c.operations.map(operation=>({...c,renderer,operation})));}
export function interactionDistribution(values){
  if(values.some(v=>!Number.isFinite(v)||v<0))throw new TypeError('Invalid latency sample; do not silently omit');
  const sorted=[...values].sort((a,b)=>a-b),at=p=>sorted.length?sorted[Math.ceil(p*sorted.length)-1]:null;
  return {count:sorted.length,p50:at(.5),p95:at(.95),p99:at(.99),max:sorted.at(-1)??null,quantile:'nearest-rank; small pilot tails are descriptive only'};
}
// Self-contained so the exact same implementation can be serialized into the
// existing loopback fixture server. State is primitives only, never DOM/models.
export function createInteractionLedger({limit=256,timeoutMs=5000}={}){
  if(!Number.isInteger(limit)||limit<1||limit>256||!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>10000)throw new RangeError('Interaction ledger budget');
  const rows=[],pending=new Map();let serial=0,frameId=0;
  const finite=v=>typeof v==='number'&&Number.isFinite(v),state=s=>{if(!s||!Number.isSafeInteger(s.version)||s.version<0||!Number.isSafeInteger(s.entry)||s.entry<0||!finite(s.from)||!finite(s.to)||s.to<=s.from)throw new TypeError('Interaction state');return {version:s.version,entry:s.entry,from:s.from,to:s.to};};
  const same=(a,b)=>a.version===b.version&&a.entry===b.entry&&a.from===b.from&&a.to===b.to;
  const finish=(row,status,at,extra={})=>{row.status=status;row.endedAt=at;Object.assign(row,extra);pending.delete(row.token);};
  const requireTime=t=>{if(!finite(t)||t<0)throw new TypeError('Interaction timestamp');};
  return {
    arm(kind,requestedAt,{warmup=false}={}){requireTime(requestedAt);if(rows.length>=limit)throw new RangeError('Interaction raw sample limit');if(!['pan','zoom','stream','params-sync','params-async'].includes(kind)||typeof warmup!=='boolean')throw new TypeError('Interaction request');const row={token:++serial,kind,warmup,requestedAt,status:'pending',inputAt:null,handlerAt:null,trusted:null,expected:null,apiCompletedAt:null};rows.push(row);pending.set(row.token,row);return row.token;},
    input(token,{timeStamp,handlerAt,trusted}){const row=pending.get(token);if(!row||row.inputAt!==null)throw new Error('Unknown or repeated interaction input');requireTime(timeStamp);requireTime(handlerAt);if(handlerAt<timeStamp||timeStamp<row.requestedAt||typeof trusted!=='boolean')throw new TypeError('Interaction input timing');row.inputAt=timeStamp;row.handlerAt=handlerAt;row.trusted=trusted;},
    expect(token,expected,apiCompletedAt){const row=pending.get(token);if(!row||row.expected)throw new Error('Interaction no longer pending or already bound');requireTime(apiCompletedAt);if(apiCompletedAt<(row.handlerAt??row.requestedAt))throw new TypeError('Interaction completion timing');row.expected=state(expected);row.apiCompletedAt=apiCompletedAt;},
    frame(value,at){requireTime(at);const current=state(value),id=++frameId;for(const row of [...pending.values()])if(at-row.requestedAt>=timeoutMs)finish(row,'timeout',at);const eligible=[...pending.values()].filter(r=>r.expected&&same(r.expected,current)&&r.apiCompletedAt<=at);if(!eligible.length)return [];const newest=eligible.at(-1),done=[];
      for(const row of [...pending.values()]){
        if(row.token>newest.token||!row.expected||row.kind!==newest.kind||row.apiCompletedAt>at)continue;
        // Earlier view requests can be superseded; stream versions are retained
        // prefixes. Both are explicit coalesced rows, never invented own paints.
        const exact=same(row.expected,current),coalescible=((row.kind==='pan'||row.kind==='zoom')&&row.expected.version===current.version||row.kind==='stream'&&row.expected.version<=current.version)&&row.expected.entry===current.entry;
        if(!exact&&!coalescible)continue;
        const from=row.inputAt??row.requestedAt;if(at<from)throw new TypeError('Render before request');
        finish(row,row.token===newest.token?'rendered':'coalesced',at,{frameId:id,renderedToken:newest.token,renderState:{...current},requestToSubmitMs:at-row.requestedAt,inputToSubmitMs:row.inputAt===null?null:at-row.inputAt,handlerToSubmitMs:row.handlerAt===null?null:at-row.handlerAt});done.push(row.token);
      }return done;
    },
    expire(at){requireTime(at);for(const row of [...pending.values()])if(at-row.requestedAt>=timeoutMs)finish(row,'timeout',at);},
    reject(token,at,error){requireTime(at);const row=pending.get(token);if(row)finish(row,'rejected',at,{error:String(error?.name??'Error').slice(0,64),message:String(error?.message??error).slice(0,256)});},
    stop(at){requireTime(at);for(const row of [...pending.values()])finish(row,'unrendered',at);},
    get pending(){return pending.size;},
    snapshot(){return rows.map(r=>({...r,expected:r.expected?{...r.expected}:null,...(r.renderState?{renderState:{...r.renderState}}:{})}));}
  };
}
export function summarizeInteractions(rows){
  const counts=Object.fromEntries(['rendered','coalesced','timeout','unrendered','rejected','pending'].map(k=>[k,rows.filter(r=>!r.warmup&&r.status===k).length]));
  const measured=rows.filter(r=>!r.warmup),group=status=>{const selected=measured.filter(r=>r.status===status);return Object.fromEntries(['requestToSubmitMs','inputToSubmitMs','handlerToSubmitMs'].map(key=>[key,interactionDistribution(selected.filter(r=>r[key]!==null).map(r=>r[key]))]));};
  return {counts,total:measured.length,warmup:rows.length-measured.length,rendered:group('rendered'),coalesced:group('coalesced'),endpoint:'CPU submission of the verified state; not compositor presentation or physical display paint'};
}
