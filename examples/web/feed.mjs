import {ChartModel,createChart} from '../../src/index.mjs';
import {createFeedSession} from './feed-session.mjs';
import {createHttpFeedTransport} from './feed-transport.mjs';

const node=id=>document.getElementById(id),model=new ChartModel();model.addSeries({id:'price',type:'candles',panel:'price'});
const chart=createChart(node('chart'),model,{onError:error=>{node('status').textContent=error.message;}}),transport=createHttpFeedTransport();
let closed=false,intent=false;
const labels={idle:'연결 전',loading:'구독과 초기 시세 확인 중',live:'연결됨',error:'연결 중단',disconnected:'일시 정지',closed:'종료'};
const session=createFeedSession(chart.api,{...transport,maxBars:256,onState:state=>{
 if(closed)return;node('status').textContent=labels[state.status]+(state.error?' · '+state.error:'');
 node('cursor').textContent='마지막 순번 '+(state.lastSequence??'—')+' · 적용 '+state.applied+' · 중복 무시 '+state.duplicates+' · 저장 봉 '+model.store.length;
 node('connect').disabled=state.status==='loading';
}});
node('connect').onclick=()=>{intent=true;void session.connect();};
node('pause').onclick=()=>{intent=false;session.disconnect();};
for(const action of ['update','append','correction','duplicate','gap','disconnect'])node(action).onclick=async()=>{
 try{const response=await fetch('/feed/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});if(!response.ok)throw new Error((await response.json()).error);}
 catch(error){if(!closed)node('status').textContent=error.message;}
};
window.addEventListener('pagehide',event=>{session.disconnect();if(!event.persisted){closed=true;session.dispose();chart.destroy({disposeModel:true});}});
window.addEventListener('pageshow',event=>{if(event.persisted&&!closed){chart.resize();if(intent)void session.connect();}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)session.disconnect();else if(intent&&!closed)void session.connect();});
window.baroFeed={model,chart,session};
