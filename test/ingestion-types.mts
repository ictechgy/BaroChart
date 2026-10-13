import {BarStore,ChartModel,ChartAPI,IngestionError,applyDataEvent,type OrderedDataEvent,type DataIngestionStats,type DataIngestionPacket,type BatchReceipt} from '../src/core/index.mjs';
const store=new BarStore(),api=new ChartAPI(new ChartModel({store}));
const events:readonly OrderedDataEvent[]=[{kind:'append',bar:{time:1,open:1,high:1,low:1,close:1,volume:1}}];
const receipt:BatchReceipt=store.applyEvents(events,{maxBars:100,maxStoreBytes:96*128});
api.applyDataEvents(events);applyDataEvent(store,{kind:'batch',events});
const stats:DataIngestionStats=api.configureDataIngestion({streamId:'A',generation:1,maxQueuedEvents:128,maxStoredBars:100});
const packet:DataIngestionPacket={streamId:'A',generation:1,firstSequence:stats.nextSequence,events};
api.enqueueDataEvents(packet);api.drainDataEvents(1);api.pauseDataIngestion();api.resumeDataIngestion();api.cancelDataEvents();api.loadDataIngestion(api.saveDataIngestion());
const code:string=new IngestionError('QUEUE_BUDGET','full').code;
void receipt;void code;
// @ts-expect-error reset/prepend are explicit barriers, not queued tail events
api.enqueueDataEvents({streamId:'A',generation:1,firstSequence:0,events:[{kind:'reset',bars:[]}]});
// @ts-expect-error no executable beforeNotify hook in the public batch options
store.applyEvents(events,{beforeNotify:()=>{}});
