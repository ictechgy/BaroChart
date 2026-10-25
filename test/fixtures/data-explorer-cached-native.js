(function(){
 const names=[],check=(ok,name)=>{if(!ok)throw new Error(name);names.push(name);},same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const command=(operation,args=[])=>nativeCommand(operation,args),read=options=>command('dataAt',[{index:8},options]);
 const bars=Array.from({length:20},(_,i)=>({time:1700000000000+i*60000,open:10+i,high:12+i,low:9+i,close:11+i,volume:100+i}));
 nativeInit(0,{series:[]});command('setData',[bars]);command('addIndicator',['mean','ema',{period:3}]);
 command('addSeries',[{id:'price',type:'candles',panel:'price'}]);command('addSeries',[{id:'mean',type:'line',panel:'price',indicator:'mean'}]);command('addSeries',[{id:'lag',type:'line',panel:'price',indicator:'mean',offset:2}]);
 const exact=read({}),cached=read({indicatorMode:'cached'}),entry=nativeModel.indicators.entries.get('mean'),array=entry.arrays[0];
 check(same(exact,cached),'warm native cached snapshot equals calculating snapshot');
 check(cached.series[2].sourceIndex===6&&cached.series[2].sourceTime===bars[6].time,'native cached offsets preserve stored source position');
 const originalGet=Aster.IndicatorEngine.prototype.get,originalCalculate=Aster.IndicatorEngine.prototype.calculate;let getCalls=0,calculateCalls=0;
 const unchanged=()=>JSON.stringify({dirty:entry.dirty,dirtyTo:entry.dirtyTo,invalidated:entry.invalidated,length:entry.length,revision:entry.revision,values:Array.from(array)});
 try{
  Aster.IndicatorEngine.prototype.get=function(){getCalls++;throw new Error('lazy get from cached query');};
  Aster.IndicatorEngine.prototype.calculate=function*(){calculateCalls++;throw new Error('lazy calculate from cached query');};
  check(same(read({indicatorMode:'cached'}),exact),'native warm cached query invokes no lazy execution');
  command('applyDataEvent',[{kind:'correction',bar:{...bars[0],close:12}}]);
  const before=unchanged(),version=nativeModel.store.version,columns=nativeModel.store.columns,view=nativeModel.view;
  const pending=read({indicatorMode:'cached'});
  check(pending.series[0].status==='value'&&pending.series.slice(1).every(row=>row.status==='pending'&&row.value===null),'native dirty cached query never returns old study values');
  check(pending.series[1].sourceIndex===8&&pending.series[2].sourceIndex===6,'native pending study values retain mapped positions');
  check(before===unchanged()&&entry.arrays[0]===array&&nativeModel.store.version===version&&nativeModel.store.columns===columns&&nativeModel.view===view,'native cached query preserves cache and source ownership');
  check(getCalls===0&&calculateCalls===0,'native cached queries perform zero lazy calculations');
 }finally{Aster.IndicatorEngine.prototype.get=originalGet;Aster.IndicatorEngine.prototype.calculate=originalCalculate;}
 const refreshed=read({});check(refreshed.series[1].status==='value'&&same(read({indicatorMode:'cached'}),refreshed),'native cached query reflects later completed calculation');
 nativeModel.dispose();check(nativeModel.disposed&&nativeModel.store.listeners.size===0,'native cached query fixture releases its model');
 return JSON.stringify({status:'passed',checks:names.length,names,runtime:'generic native command facade'});
})()
