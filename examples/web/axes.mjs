import {BarStore,ChartModel,createChart,alignSeriesByTime} from '../../src/index.mjs';
import {createFinancialFixture} from './financial.mjs';
const compact=matchMedia('(max-width:600px)').matches;
const $=id=>document.getElementById(id),fixture=createFinancialFixture(),pointsB=fixture.points.map(p=>({...p,value:p.value*20})),times=new Float64Array(fixture.bars.map(b=>b.time)),bValues=alignSeriesByTime(times,pointsB),cValues=alignSeriesByTime(times,fixture.points.map(p=>({...p,value:p.value*1e-14}))),model=new ChartModel({store:new BarStore(fixture.bars),panels:[{id:'price',weight:1,padding:0,label:'A OHLCV / B & C EXACT ALIGNED PRICE'}],axes:[{id:'b-axis',panel:'price',side:'left',padding:0,precision:3,prefix:'B ',label:'SYNTH:B'},{id:'c-axis',panel:'price',side:'right',visible:!compact,width:100,padding:0,precision:3,tickFormat:'scientific',prefix:'C ',label:'SYNTH:C'}]});
if(compact)model.timeFormatter=time=>new Date(time).toISOString().slice(11,16);
$('show-c').checked=!compact;
model.addSeries({id:'a',type:'candles',panel:'price'});
const bOptions={id:'b',type:'line',panel:'price',axisId:'b-axis',symbolId:'SYNTH:B',values:bValues,color:'#f0b755',width:2};model.addSeries(bOptions);model.addSeries({id:'c',type:'line',panel:'price',axisId:'c-axis',symbolId:'SYNTH:C',values:cValues,color:'#a998ff',width:2});model.fit();
let chart,cleanupChart;
const status=text=>$('status').textContent=text;
function syncControls(){const target=chart.controller.drawingTarget;$('target').value=target?.seriesId==='b'?'b':target?.seriesId==='c'?'c':'a';$('target').querySelector('[value="b"]').disabled=!model.series.some(s=>s.id==='b');for(const button of document.querySelectorAll('[data-tool]'))button.setAttribute('aria-pressed',String(button.dataset.tool===chart.controller.tool));}
function mount(renderer,{target={panel:'price',seriesId:'b'},tool='select',text='Note'}={}){cleanupChart?.();chart=createChart($('chart'),model,{renderer,onError:error=>status('표시 오류: '+error.message)});chart.api.setDrawingTarget(target);chart.api.setTool(tool);chart.api.setText(text);chart.canvas.setAttribute('aria-describedby','readout');
 const read=()=>{if(!model.crosshair)return;const r=chart.api.crosshairValues(chart.lastScene.width,chart.lastScene.height);if(!r)return;const b=r.primary.bar;const series=r.series.filter(s=>s.symbolId).map(s=>`${s.symbolId}: ${s.value===null?'공백':s.value.toPrecision(9)} · 원본 UTC ${s.sourceTime??'없음'}`).join('\n');$('readout').textContent=`A 기본 OHLCV · ${new Date(r.time).toISOString()}\nO ${b.open.toFixed(2)} H ${b.high.toFixed(2)} L ${b.low.toFixed(2)} C ${b.close.toFixed(2)} V ${b.volume}\n${series}\n커서 축 값: ${r.axes.map(a=>(a.id??'A')+' '+a.formatted).join(' / ')}`;};
 $('chart').addEventListener('aster:state',syncControls);$('chart').addEventListener('aster:render',read);cleanupChart=()=>{$('chart').removeEventListener('aster:state',syncControls);$('chart').removeEventListener('aster:render',read);chart.destroy();};syncControls();chart.drawNow();window.axesExample.chart=chart;
}
window.axesExample={model,fixture,bValues,cValues,chart:null,cleanup:()=>{cleanupChart?.();model.dispose();}};
mount('canvas');$('coordinates').textContent=`A 20봉 · B / C 각 12점 · 각 8공백 · 독립 3축${compact?' · 시간 눈금 UTC(HH:mm)':''}`;
const perform=fn=>()=>{try{fn();chart.drawNow();}catch(error){status('변경을 적용하지 못했습니다: '+error.message);}};
$('renderer').onchange=perform(()=>{const {drawingTarget:target,tool,text}=chart.controller;mount($('renderer').value,{target,tool,text});status('렌더러 '+chart.rendererKind);});
$('fit').onclick=perform(()=>chart.api.fit());$('scale').onchange=perform(()=>{chart.api.setAxis('b-axis',{scale:$('scale').value,base:2040});status('B 축 '+$('scale').value+' · 퍼센트 기준 2040');});
$('range').onchange=perform(()=>chart.api.setAxis('b-axis',{range:$('range').value==='manual'?[1900,2400]:null}));$('precision').onchange=perform(()=>chart.api.setAxis('b-axis',{precision:Number($('precision').value)}));$('hide').onchange=perform(()=>chart.api.setAxis('b-axis',{visible:!$('hide').checked}));
$('show-c').onchange=perform(()=>chart.api.setAxis('c-axis',{visible:$('show-c').checked}));
$('target').onchange=perform(()=>chart.api.setDrawingTarget($('target').value==='a'?null:{panel:'price',seriesId:$('target').value}));
$('series').onclick=perform(()=>{if(model.series.some(s=>s.id==='b')){chart.api.removeSeries('b');status('B 제거: 바인딩 도형은 숨겨지고 저장 앵커는 유지됩니다.');}else{chart.api.addSeries(bOptions);status('같은 B ID와 축을 복원하여 도형을 다시 표시했습니다.');}});
$('sample').onclick=perform(()=>{chart.api.addDrawing({type:'trendline',panel:'price',seriesId:'b',points:[{time:fixture.bars[1].time,price:2052},{time:fixture.bars[15].time,price:2168}]});status('B의 원래 가격 앵커 2052 / 2168로 도형을 추가했습니다.');});
for(const button of document.querySelectorAll('[data-tool]'))button.onclick=perform(()=>{chart.setTool(button.dataset.tool);for(const b of document.querySelectorAll('[data-tool]'))b.setAttribute('aria-pressed',String(b===button));chart.canvas.focus();});
$('undo').onclick=perform(()=>chart.api.undo());$('redo').onclick=perform(()=>chart.api.redo());$('delete').onclick=perform(()=>chart.api.deleteDrawing());$('save').onclick=perform(()=>{$('drawing-document').value=chart.api.saveDrawings();status('도형 문서를 저장했습니다.');});$('load').onclick=perform(()=>{chart.api.loadDrawings($('drawing-document').value);status('바인딩과 원래 가격 앵커를 복원했습니다.');});
window.addEventListener('pagehide',e=>{if(!e.persisted)window.axesExample.cleanup();});window.addEventListener('pageshow',e=>{if(e.persisted)chart.resize();});status('세 종목을 각자의 가격축에 표시합니다.');
