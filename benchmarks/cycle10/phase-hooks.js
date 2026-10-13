// Optional diagnostics only. Swift clock crossings affect these timings; clean
// aggregate samples never install these wrappers. Never label as pure core cost.
{
 let active=false,depth=0,metrics={};const clock=()=>globalThis.__nativeProfileNow();
 const frame=Aster.SceneCache.prototype.frame;
 Aster.SceneCache.prototype.frame=function(...args){if(!active)return frame.apply(this,args);const start=clock();depth++;try{return frame.apply(this,args);}finally{depth--;metrics.coreFrameMs+=(clock()-start)*1000;metrics.coreCalls++;}};
 const stringify=JSON.stringify;
 JSON.stringify=function(...args){if(!active||depth)return stringify.apply(this,args);const start=clock();try{return stringify.apply(this,args);}finally{metrics.jsonSerializeMs+=(clock()-start)*1000;metrics.jsonCalls++;}};
 const render=globalThis.nativeRenderFrameJSON;
 globalThis.nativeRenderFrameJSON=function(...args){metrics={coreFrameMs:0,jsonSerializeMs:0,coreCalls:0,jsonCalls:0};active=true;try{return render(...args);}finally{active=false;}};
 globalThis.__nativeProfilePhases=()=>metrics;
}
