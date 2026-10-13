import {ChartModel,ChartAPI} from '../../src/core/index.mjs';
import {CanvasChart,TimeCursorGroup} from '../../src/renderers/canvas.mjs';
const epoch=Date.UTC(2026,0,5,9),charts=[],listeners=[];let group=null,closed=false;
const on=(node,type,fn)=>{node.addEventListener(type,fn);listeners.push(()=>node.removeEventListener(type,fn));};
function make(id,minutes){const model=new ChartModel(),api=new ChartAPI(model),bars=minutes.map((minute,i)=>{const close=100+Math.sin(i/5)*3;return {time:epoch+minute*60000,open:close-.5,high:close+1,low:close-1,close,volume:100+i};});api.setData(bars);api.addSeries({id:'price',type:'candlestick',panel:'price'});api.fit();
 const explore=document.getElementById(`explore-${id}`),read=document.getElementById(`read-${id}`),status=document.getElementById(`cursor-${id}`),chart=new CanvasChart(document.getElementById(`chart-${id}`),model,{dataExplorer:{readout:document.getElementById(`values-${id}`),live:document.getElementById(`live-${id}`),controls:[explore,read]}});charts.push(chart);
 const update=()=>{if(closed)return;const state=chart.timeCursor;status.textContent=state?`Requested ${new Date(state.requestedTime).toISOString()}; matched ${state.matchedTime===null?'none':new Date(state.matchedTime).toISOString()}; ${state.status}.`:'No linked cursor.';};
 on(chart.canvas,'aster:render',update);on(chart.canvas,'aster:state',update);
 on(explore,'click',()=>{if(closed)return;chart.setDataExploration(!chart.dataExploration.active);chart.canvas.focus();});
 on(read,'click',()=>{if(closed)return;try{chart.readExploration();}catch(error){status.textContent=error.message;}});update();}
make('a',Array.from({length:90},(_,i)=>i));make('b',Array.from({length:18},(_,i)=>i*5).filter(m=>m<30||m>=45));
const policy=document.getElementById('policy'),toggle=document.getElementById('link');
function connect(){group?.dispose();group=new TimeCursorGroup({match:policy.value});for(const chart of charts)group.add(chart);toggle.textContent='Disconnect cursors';}
on(policy,'change',()=>{if(!closed&&group)connect();});on(toggle,'click',()=>{if(closed)return;if(group){group.dispose();group=null;toggle.textContent='Connect cursors';}else connect();});connect();
on(window,'pagehide',()=>{if(closed)return;closed=true;group?.dispose();group=null;for(const remove of listeners)remove();for(const chart of charts)chart.destroy({disposeModel:true});});
