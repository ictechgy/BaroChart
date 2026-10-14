import {ChartModel,ChartAPI} from '../../src/core/index.mjs';
import {CanvasChart,TimeRangeGroup} from '../../src/renderers/canvas.mjs';
const epoch=Date.UTC(2026,0,5,9),charts=[],listeners=[];let group=null,closed=false;
const $=id=>document.getElementById(id),on=(node,type,fn)=>{node.addEventListener(type,fn);listeners.push(()=>node.removeEventListener(type,fn));};
function update(){if(closed)return;for(let i=0;i<charts.length;i++){const s=group?.status(charts[i]),node=$('range-'+['a','b'][i]);node.textContent=s?`Requested ${new Date(s.requestedTimeRange.from).toISOString()} to ${new Date(s.requestedTimeRange.to).toISOString()}; effective ${s.effectiveStoredTimes?new Date(s.effectiveStoredTimes.from).toISOString()+' to '+new Date(s.effectiveStoredTimes.to).toISOString():'none'}; ${s.status}; expanded ${s.expanded}; stale ${s.stale}.`:'No received range.';}}
function make(id,minutes){const model=new ChartModel(),api=new ChartAPI(model);api.setData(minutes.map((minute,i)=>{const close=100+Math.sin(i/5)*3;return {time:epoch+minute*60000,open:close-.5,high:close+1,low:close-1,close,volume:100+i};}));api.addSeries({id:'price',type:'candles',panel:'price'});api.fit();const chart=new CanvasChart($('chart-'+id),model);charts.push(chart);on(chart.canvas,'aster:state',update);on($('sync-'+id),'click',()=>{if(closed||!group)return;group.syncFrom(chart);update();});}
make('a',Array.from({length:120},(_,i)=>i));make('b',Array.from({length:24},(_,i)=>i*5).filter(m=>m<30||m>=45));
function connect(){group=new TimeRangeGroup({mode:'view',missing:'clip'});for(const chart of charts)group.add(chart,{publish:true,receive:true});$('link').textContent='Disconnect ranges';update();}
on($('link'),'click',()=>{if(closed)return;if(group){group.dispose();group=null;$('link').textContent='Connect ranges';update();}else connect();});connect();
// Cached history entries retain their chart instances; restoration only redraws.
on(window,'pageshow',event=>{if(!event.persisted||closed)return;for(const chart of charts){if(closed)return;chart.resize();}});
on(window,'pagehide',event=>{if(event.persisted||closed)return;closed=true;group?.dispose();group=null;for(const remove of listeners)remove();for(const chart of charts)chart.destroy({disposeModel:true});});
