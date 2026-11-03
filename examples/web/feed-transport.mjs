// Replace these same-origin fixture endpoints with the host's authenticated
// snapshot/stream adapter. Neither credentials nor feed acquisition enter SDK APIs.
export function createHttpFeedTransport({fetcher=fetch,EventSourceType=EventSource,snapshotURL='/feed/snapshot',eventsURL='/feed/events'}={}){
 return {
  async loadSnapshot({signal}){
   const response=await fetcher(snapshotURL,{signal,cache:'no-store'});
   if(!response.ok)throw new Error('Snapshot request failed: '+response.status);
   const reader=response.body?.getReader();if(!reader)throw new Error('Snapshot response body required');
   const parts=[],decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0;
   try{
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>16*1024*1024){await reader.cancel();throw new RangeError('Snapshot response limit');}parts.push(decoder.decode(value,{stream:true}));}
    parts.push(decoder.decode());return JSON.parse(parts.join(''));
   }finally{reader.releaseLock();}
  },
  subscribe({signal,onEvent,onClose}){
   const source=new EventSourceType(eventsURL);let settled=false,closed=false,resolveReady,rejectReady;
   const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
   const cleanup=()=>{if(closed)return;closed=true;source.removeEventListener('open',opened);source.removeEventListener('message',message);source.removeEventListener('error',failed);signal.removeEventListener('abort',cleanup);source.close();if(!settled){settled=true;rejectReady(new DOMException('Cancelled','AbortError'));}};
   const opened=()=>{if(closed)return;settled=true;resolveReady();};
   const failed=()=>{if(closed)return;const error=new Error('Stream disconnected; reconnect explicitly');cleanup();onClose(error);};
   const message=event=>{if(closed)return;try{if(typeof event.data!=='string'||event.data.length>16384)throw new RangeError('Feed event text limit');const parsed=JSON.parse(event.data);onEvent(parsed);}catch(error){cleanup();onClose(error);}};
   source.addEventListener('open',opened);source.addEventListener('message',message);source.addEventListener('error',failed);signal.addEventListener('abort',cleanup,{once:true});if(signal.aborted)cleanup();
   return {ready,close:cleanup};
  },
 };
}
