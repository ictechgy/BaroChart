// Local synthetic fixture, not a market-data service or production backend.
export function createFeedFixture({snapshotDelayMs=200}={}){
 let bars=Array.from({length:64},(_,i)=>({time:1700000000000+i*60000,open:100+i*.1,high:102+i*.1,low:99+i*.1,close:101+i*.1,volume:100+i})),lastSequence=0,lastEvent=null;
 const clients=new Set();
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
 function publish(kind,bar,advance=1){lastSequence+=advance;lastEvent={sequence:lastSequence,kind,bar:{...bar}};const text='data: '+JSON.stringify(lastEvent)+'\n\n';for(const res of clients)res.write(text);}
 async function handleApi(req,res){
  const pathname=new URL(req.url,'http://localhost').pathname;if(!['/feed/snapshot','/feed/events','/feed/action'].includes(pathname))return false;
  if(pathname!=='/feed/action'&&req.method!=='GET'||pathname==='/feed/action'&&req.method!=='POST'){json(res,405,{error:'Method not allowed'});return true;}
  if(pathname==='/feed/snapshot'){
   const text=JSON.stringify({bars,lastSequence});const timer=setTimeout(()=>{if(!res.destroyed){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(text);}},snapshotDelayMs);res.once('close',()=>clearTimeout(timer));return true;
  }
  if(pathname==='/feed/events'){
   if(clients.size>=8){json(res,429,{error:'Fixture stream limit'});return true;}
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Content-Type-Options':'nosniff'});res.write(': ready\n\n');clients.add(res);res.once('close',()=>clients.delete(res));return true;
  }
  if(req.headers.origin!=='http://'+req.headers.host||req.headers['content-type']!=='application/json'){json(res,403,{error:'Same-origin JSON action required'});return true;}
  let body='';for await(const chunk of req){body+=chunk;if(body.length>1024){json(res,413,{error:'Fixture action limit'});return true;}}
  let action;try{action=JSON.parse(body).action;}catch{json(res,400,{error:'Invalid JSON action'});return true;}
  if(!['update','append','correction','duplicate','gap','disconnect'].includes(action)){json(res,400,{error:'Unknown fixture action'});return true;}
  if(action==='disconnect'){for(const client of clients)client.end();clients.clear();}
  else if(action==='duplicate'){
   if(!lastEvent){json(res,409,{error:'Apply one event before duplicating'});return true;}
   for(const client of clients)client.write('data: '+JSON.stringify(lastEvent)+'\n\n');
  }else if(action==='append'){
   if(bars.length>=256){json(res,409,{error:'Fixture bar limit'});return true;}
   const last=bars.at(-1),next={time:last.time+60000,open:last.close,high:last.close+1,low:last.close-1,close:last.close+.2,volume:0};bars.push(next);publish('append',next);
  }else{
   const index=action==='correction'?10:bars.length-1,next={...bars[index],volume:bars[index].volume+10};bars[index]=next;publish(action==='correction'?'correction':'update',next,action==='gap'?2:1);
  }
  json(res,200,{lastSequence,storedBars:bars.length,clients:clients.size});return true;
 }
 return {handleApi,close(){for(const res of clients)res.end();clients.clear();}};
}
