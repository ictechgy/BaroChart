import {BarStore,ChartModel,ChartAPI,seededColumns} from '../src/core/index.mjs';
const owners=['A','B'].map((streamId,index)=>{
 const store=new BarStore();store.setColumns(seededColumns(1000,42+index));
 const model=new ChartModel({store}),api=new ChartAPI(model);
 api.addIndicator('ema','ema',{period:20});
 api.configureDataIngestion({streamId,generation:1,maxQueuedEvents:16,maxQueuedBytes:16*49,maxBatchEvents:8,maxStoredBars:1016,maxStoreBytes:96*2048});
 return {model,api,streamId};
});
try{
 for(const {model,api,streamId} of owners){
  const tail=model.store.at(999),events=[{kind:'update',bar:{...tail,volume:tail.volume+1}},{kind:'append',bar:{...tail,time:tail.time+60000}}];
  api.enqueueDataEvents({streamId,generation:1,firstSequence:0,events});
  const receipt=api.drainDataEvents();
  const backup=api.saveDataIngestion();api.loadDataIngestion(backup);
  console.log(JSON.stringify({symbol:streamId,receipt,ema:api.indicatorValueAt('ema','value',1000),ingestion:api.dataIngestionStats()}));
 }
}finally{for(const {model} of owners)model.dispose();}
