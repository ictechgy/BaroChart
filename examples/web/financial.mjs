import {drawingImportMessage} from './import-errors.mjs';
import {BarStore,ChartModel,createChart,alignSeriesByTime,SessionCalendar,zonedEpoch,zonedParts} from '../../src/index.mjs';

export function createFinancialFixture() {
  const timezone='America/New_York',dates=['2026-02-06','2026-02-09'];
  const calendarA=new SessionCalendar(timezone,date=>dates.includes(date)?[{open:'09:30',close:'12:00'},{open:'13:00',close:'16:00'}]:[]);
  const calendarB=new SessionCalendar(timezone,date=>dates.includes(date)?[{open:'09:45',close:'11:45'},{open:'13:30',close:'15:15'}]:[]);
  const clocksA=['09:30','10:00','10:30','11:00','11:30','13:00','13:30','14:00','14:30','15:00'],clocksB=['09:45','10:00','10:30','11:00','13:30','14:30','14:45','15:00'];
  const bars=[],points=[];
  for(let day=0;day<dates.length;day++){
    for(let i=0;i<clocksA.length;i++){const close=100+day*5+i*.8;bars.push({time:zonedEpoch(dates[day],clocksA[i],timezone),open:close-.3,high:close+2,low:close-2,close,volume:100+day*40+i*12});}
    for(let i=0;i<clocksB.length;i++)points.push({time:zonedEpoch(dates[day],clocksB[i],timezone),value:102+day*4+i*.6});
  }
  const times=new Float64Array(bars.map(b=>b.time)),aligned=alignSeriesByTime(times,points),volumeB=alignSeriesByTime(times,points.map((p,i)=>({time:p.time,value:50+i*8}))),matched=[...aligned].filter(Number.isFinite).length;
  return {timezone,bars,points,aligned,volumeB,calendarA,calendarB,matched,unmatched:points.length-matched,gaps:bars.length-matched};
}
export function periodExamples() {
  const regular=()=>[{open:'09:00',close:'16:00'}],fixtures=[
    {zone:'America/Santiago',time:'2026-09-06T13:00:00Z',interval:'day',expected:'2026-09-06T04:00:00.000Z'},
    {zone:'Asia/Tehran',time:'2021-03-23T05:30:00Z',interval:'week',expected:'2021-03-21T20:30:00.000Z'},
    {zone:'America/Asuncion',time:'2023-10-15T13:00:00Z',interval:'month',expected:'2023-10-01T04:00:00.000Z'},
  ];
  return fixtures.map(f=>({...f,actual:new Date(new SessionCalendar(f.zone,regular).bucket(Date.parse(f.time),f.interval).time).toISOString()}));
}
export function inspectFinancialCursor(model,layout,foreignValues,x,y) {
  if(!model.store.length)return null;
  const panel=layout.panels.find(p=>x>=p.left&&x<=p.right&&y>=p.top&&y<=p.bottom);if(!panel)return null;
  const index=Math.max(0,Math.min(model.store.length-1,Math.round(layout.index(x)))),cursorPrice=panel.price(y);
  return {index,bar:model.store.at(index),foreignValue:foreignValues[index],panel:panel.id,cursorPrice,cursorAxisValue:panel.scale==='percent'?panel.transform(cursorPrice):cursorPrice,percent:panel.scale==='percent'};
}
function mount() {
  const $=id=>document.getElementById(id),fixture=createFinancialFixture(),store=new BarStore(fixture.bars),model=new ChartModel({store,axisWidth:105,panels:[{id:'price',label:'A CANDLES · B PRICE / GAPS',weight:3,base:100},{id:'returns',label:'COMMON BASE 100 · A / B',scale:'percent',base:100,weight:1.3},{id:'volume',label:'A VOLUME · B VOLUME / GAPS',weight:1.1,precision:0}]});
  model.addSeries({id:'a',type:'candles',panel:'price'});model.addSeries({id:'b',type:'line',panel:'price',values:fixture.aligned,color:'#f0b755',width:2});
  model.addSeries({id:'returns-a',type:'line',panel:'returns',source:'close',color:'#58cadb'});model.addSeries({id:'returns-b',type:'line',panel:'returns',values:fixture.aligned,color:'#f0b755'});
  model.addSeries({id:'volume-a',type:'histogram',panel:'volume',source:'volume',color:'#2b6e78'});model.addSeries({id:'volume-b',type:'line',panel:'volume',values:fixture.volumeB,color:'#f0b755'});model.fit();
  const status=text=>$('status').textContent=text,chart=createChart($('chart'),model,{renderer:'canvas',onError:error=>status('표시 오류: '+error.message)});
  chart.canvas.setAttribute('aria-describedby','keyboard-help coordinate-summary');chart.api.setText($('annotation').value);
  $('coordinate-summary').textContent=`A ${store.length}봉 · B ${fixture.matched}점 일치 · ${fixture.gaps}개 공백 · 기준 밖 ${fixture.unmatched}점 제외`;
  const local=time=>{const p=zonedParts(time,fixture.timezone);return `${p.month}-${p.day} ${p.hour}:${p.minute}`;};model.timeFormatter=local;
  for(let i=0;i<fixture.bars.length;i++){const row=document.createElement('tr');for(const text of [local(fixture.bars[i].time),new Date(fixture.bars[i].time).toISOString(),fixture.bars[i].close.toFixed(2),Number.isNaN(fixture.aligned[i])?'공백':fixture.aligned[i].toFixed(2)]){const cell=document.createElement('td');cell.textContent=text;if(text==='공백')cell.className='gap';row.append(cell);}$('aligned-values').append(row);}
  for(const f of periodExamples()){const row=document.createElement('tr');for(const text of [f.zone+' / '+f.time,f.interval,f.actual]){const cell=document.createElement('td');cell.textContent=text;row.append(cell);}$('calendar-anchors').append(row);}
  const perform=(fn,importDocument=false)=>()=>{try{fn();chart.drawNow();}catch(error){status(importDocument?drawingImportMessage(error):'변경을 적용하지 못했습니다: '+error.message);}};
  $('fit').onclick=perform(()=>chart.api.fit());
  $('scale').onchange=perform(()=>{chart.api.setPanel('price',{scale:$('scale').value,base:100});status('가격 축: '+$('scale').value+' · 퍼센트 기준 100');});
  $('inverted').onchange=perform(()=>{for(const panel of model.panels)chart.api.setPanel(panel.id,{inverted:$('inverted').checked});status($('inverted').checked?'세 패널의 축을 반전했습니다.':'세 패널의 축 반전을 해제했습니다.');});
  for(const button of document.querySelectorAll('[data-tool]'))button.onclick=perform(()=>{chart.setTool(button.dataset.tool);for(const other of document.querySelectorAll('[data-tool]'))other.setAttribute('aria-pressed',String(other===button));chart.canvas.focus();});
  $('annotation').oninput=()=>chart.api.setText($('annotation').value);
  $('sample-drawing').onclick=perform(()=>{chart.api.addDrawing({type:'measurement',points:[{time:fixture.bars[2].time,price:fixture.bars[2].close},{time:fixture.bars[15].time,price:fixture.bars[15].close}]});status('금요일과 월요일의 실제 시간·가격을 잇는 도형을 추가했습니다.');});
  $('undo').onclick=perform(()=>chart.api.undo());$('redo').onclick=perform(()=>chart.api.redo());$('delete').onclick=perform(()=>chart.api.deleteDrawing());
  $('save').onclick=perform(()=>{$('drawing-document').value=chart.api.saveDrawings();status('도형을 아래 JSON 문서에 저장했습니다.');});
  $('reload').onclick=perform(()=>{chart.api.loadDrawings($('drawing-document').value);status('시간·가격 앵커를 유지하여 도형을 다시 읽었습니다.');},true);
  const sync=()=>{$('undo').disabled=!model.drawings.undoStack.length;$('redo').disabled=!model.drawings.redoStack.length;$('delete').disabled=!model.drawings.selected;};$('chart').addEventListener('aster:state',sync);
  const cursor=()=>{if(!model.crosshair||!chart.lastScene)return;const reading=inspectFinancialCursor(model,chart.lastScene.layout,fixture.aligned,model.crosshair.x,model.crosshair.y);if(!reading)return;
    $('crosshair-summary').textContent=`커서 축값 (${reading.panel}): ${reading.cursorAxisValue.toFixed(2)}${reading.percent?'%':''} · 원래 값 ${reading.cursorPrice.toFixed(2)} · 실제 봉 ${reading.index}의 종가는 아래에 표시합니다.`;
    const b=reading.bar,texts=[new Date(b.time).toISOString(),...['open','high','low','close'].map(k=>b[k].toFixed(2)),String(b.volume),Number.isNaN(reading.foreignValue)?'공백':reading.foreignValue.toFixed(2)];for(let i=0;i<texts.length;i++)$('cursor-bar').children[i].textContent=texts[i];
  };$('chart').addEventListener('aster:render',cursor);
  const cleanup=()=>{$('chart').removeEventListener('aster:state',sync);$('chart').removeEventListener('aster:render',cursor);chart.destroy({disposeModel:true});};
  window.addEventListener('pagehide',event=>{if(!event.persisted)cleanup();});window.addEventListener('pageshow',event=>{if(event.persisted)chart.resize();});
  window.financialExample={model,chart,fixture,cleanup};chart.drawNow();sync();status('합성 세션을 정확한 UTC 시각으로 정렬했습니다. 표와 차트의 공백을 비교하세요.');
}
if(typeof document!=='undefined'&&document.body.dataset.demo==='financial')mount();
