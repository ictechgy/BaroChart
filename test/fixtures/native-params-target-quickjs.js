(function(){
 const scenarios=[],assert=(value,name)=>{if(!value)throw Error(name);scenarios.push(name);};
 const columns=Aster.seededColumns(257,41),store=new Aster.BarStore();store.setColumns(columns);const engine=new Aster.IndicatorEngine(store);
 for(const name of Aster.builtinIndicators.keys()){
  engine.add(name,name);const entry=engine.entries.get(name),target=new Aster.NativeParamsTarget(JSON.stringify({schema:'aster.native-params-target',version:1,registration:1,id:name,name,params:{},length:257,capacity:store.capacity,outputs:entry.def.outputs,plotOffsets:entry.def.plotOffsets||{},maxBytes:805306368}));
  for(let slot=0;slot<6;slot++)for(let start=0;start<257;start+=31)target.target(slot,start,Math.min(31,257-start)).set(columns[Aster.FIELDS[slot]].subarray(start,Math.min(start+31,257)));
  target.start();let steps=0;while(!target.step(31).complete)if(++steps>1000)throw Error('unbounded target');let same=true;
  for(let slot=0;slot<entry.arrays.length;slot++){const values=target.outputBuffer(slot,0,store.capacity);for(let i=0;i<values.length;i++)if(!Object.is(values[i],entry.arrays[slot][i]))same=false;}
  for(let row=0;row<2;row++){const record=target.checkpoint(row);if(record.index!==row*256||record.text!==Aster.safeCheckpointStringify(entry.checkpoints.get(row*256)))same=false;}
  assert(same,'oracle '+name);target.dispose();assert(target.budget.usedBytes===0,'cleanup '+name);engine.remove(name);
 }
 engine.dispose();assert(store.listeners.size===0,'source listener cleanup');
 return JSON.stringify({case:'native-params-target-quickjs',passed:true,checks:scenarios.length,scenarios});
})()
