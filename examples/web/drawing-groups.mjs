import {ChartModel,createChart,attachDrawingPanel} from '../../src/index.mjs';
const model=new ChartModel(),chart=createChart(document.getElementById('chart'),model),api=chart.api;
api.setData(Array.from({length:64},(_,i)=>({time:1700000000000+i*60000,open:100+i/10,high:104+i/10,low:96+i/10,close:101+i/10,volume:100})));
api.addSeries({id:'price',type:'candles',panel:'price'});
for(let i=0;i<36;i++)api.addDrawing({id:'level-'+(i+1),type:i%3?'horizontal':'text',points:[{time:1700000000000+i*60000,price:98+i/3}],...(i%3?{}:{text:'Note '+(i+1)}),style:{color:'#3366cc',width:1}});
const controls=attachDrawingPanel(document.getElementById('drawing-controls'),chart,{label:'Drawing groups'});
const undo=()=>api.undo(),redo=()=>api.redo();document.getElementById('undo').addEventListener('click',undo);document.getElementById('redo').addEventListener('click',redo);
window.addEventListener('pagehide',()=>{controls.destroy();chart.destroy({disposeModel:true});document.getElementById('undo').removeEventListener('click',undo);document.getElementById('redo').removeEventListener('click',redo);},{once:true});
