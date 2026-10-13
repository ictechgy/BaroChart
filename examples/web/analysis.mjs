import {BarStore,ChartModel,ChartAPI,createChart,portableSessionCalendar,zonedEpoch,recomputeInWorker} from '../../src/index.mjs';
import '../indicators/local-volume-balance.mjs';
export function createAnalysisModel({studies=true,anchor=false}={}){
 const bars=[];for(const date of ['2026-03-06','2026-03-09']){const first=zonedEpoch(date,'07:00','America/New_York');for(let i=0;i<600;i++){const close=100+Math.sin(i/31)*2+i*.003;bars.push({time:first+i*60000,open:close-.1,high:close+.4,low:close-.4,close,volume:100+i%73});}}
 const model=new ChartModel({store:new BarStore(bars),panels:[{id:'price',weight:3,label:'SESSION VWAP · NEW YORK / DST'},{id:'volume',weight:1,label:'CLOSE-DIRECTION VOLUME PROXY'}]}),api=new ChartAPI(model);
 api.addSeries({id:'price',type:'candles',panel:'price'});
 if(studies){installVWAP(api,anchor);const name=api.registerIndicatorModule('aster.volume-direction',1)[0];api.addIndicator('pressure',name,{shift:-2});api.addSeries({id:'pressure-signed',type:'histogram',panel:'volume',indicator:'pressure',output:'signed',color:'#7898ff',label:'Volume direction proxy (−2 plot shift)'});api.registerIndicatorModule('local.volume-balance',1);api.addIndicator('balance','local.volume-balance@1/smooth',{period:10});api.addSeries({id:'balance-value',type:'line',panel:'volume',indicator:'balance',color:'#f0b755',label:'Static custom module · smoothed volume balance'});}
 model.fit();return model;
}
function vwapParams(anchor){
 const calendar=portableSessionCalendar({timezone:'America/New_York',weekdays:[1,2,3,4,5],windows:[{open:'09:30',close:'16:00'}]}),params={calendar,deviation:2,...(anchor?{anchorTime:zonedEpoch('2026-03-06','11:00','America/New_York')}:{})};
 return params;
}
export function setAnalysisAnchor(api,anchor){return api.setIndicatorParams('vwap',vwapParams(anchor));}
function installVWAP(api,anchor){
 api.addIndicator('vwap','vwap',vwapParams(anchor));for(const [output,color] of [['value','#f0b755'],['upper','#58cadb'],['lower','#58cadb']])api.addSeries({id:'vwap-'+output,type:'line',panel:'price',indicator:'vwap',output,color,label:'VWAP '+output});
}
function mount(){
 const $=id=>document.getElementById(id),status=text=>$('status').textContent=text;let model=createAnalysisModel(),chart=createChart($('chart'),model,{renderer:'canvas',onError:e=>status(e.message)}),busy=false;
 const perform=fn=>async()=>{if(busy)return;try{await fn();chart.drawNow();}catch(e){status('변경을 적용하지 못했습니다: '+e.message);}};
 $('fit').onclick=perform(()=>chart.api.fit());$('anchor').onchange=perform(()=>{setAnalysisAnchor(chart.api,$('anchor').value==='anchor');status('기존 선 스타일과 도형을 유지하고 VWAP 기준을 변경했습니다.');});
 $('query').onclick=perform(()=>{const asOfIndex=Number($('asof').value),point=chart.api.indicatorValueAt('pressure','signed',asOfIndex,{mode:'plot',asOfIndex});$('reading').textContent=point.sourceIndex===null?'음수 이동된 값은 이 시점에 아직 관측되지 않았습니다.':JSON.stringify(point);});
 $('save').onclick=perform(()=>{$('setup').value=chart.api.saveStudies();status('지표 설정을 JSON에 저장했습니다.');});
 $('load').onclick=perform(()=>{const next=createAnalysisModel({studies:false}),api=new ChartAPI(next);try{api.loadStudies($('setup').value);}catch(e){next.dispose();throw e;}chart.destroy({disposeModel:true});model=next;chart=createChart($('chart'),model,{renderer:'canvas',onError:e=>status(e.message)});window.analysisExample.model=model;window.analysisExample.chart=chart;status('새 지표 컨테이너에 설정을 불러왔습니다.');});
 $('correct').onclick=perform(async()=>{busy=true;$('correct').disabled=true;try{const bar=model.store.at(160);await recomputeInWorker(model,{kind:'correction',bar:{...bar,volume:bar.volume+4321}},{workerURL:new URL('./analysis-worker.mjs',import.meta.url)});status('과거 거래량 수정과 지표 재계산을 Worker에서 적용했습니다.');}finally{busy=false;$('correct').disabled=false;}});
 const cleanup=()=>chart.destroy({disposeModel:true});window.addEventListener('pagehide',e=>{if(!e.persisted)cleanup();});window.analysisExample={model,chart,cleanup};chart.drawNow();status('뉴욕 현지 09:30–16:00. 금요일과 월요일의 UTC 개장 시각은 DST 때문에 한 시간 다릅니다.');
}
if(typeof document!=='undefined'&&document.body.dataset.demo==='analysis')mount();
