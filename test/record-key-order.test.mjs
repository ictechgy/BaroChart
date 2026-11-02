// 저장 레코드·반환값·검증 오류가 입력 키 순서와 무관한지 확인한다(설계 §7.4-1, M0 Task 1).
// 같은 내용을 키 순서만 바꿔 넣고 저장 문서, inspect() 결과, 오류 문구가 모두 하나로 정해지는지 본다.
// 키가 5개 이하면 모든 순열을, 그보다 많으면 시드 고정 셔플 24개를 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {BarStore,ChartModel,ChartAPI,InteractionController,DrawingStylePresets,BarReplay,saveWorkspace,portableSessionCalendar} from '../src/core/index.mjs';
import {readWorkspaceDocument,installWorkspaceConfiguration} from '../src/core/workspace.mjs';
import {nativeWorkspacePreflight} from '../src/core/native-workspace.mjs';
import {seededColumns} from '../src/core/data.mjs';
import {NativeParamsCapture} from '../src/core/native-params-source.mjs';
import {NativeParamsTarget} from '../src/core/native-params-target.mjs';
import {safeCheckpointStringify} from '../src/core/checkpoint-validation.mjs';
import {buildLegacyChart,LEGACY_BINDING} from './fixtures/legacy/build-legacy-chart.mjs';

/** 생성된 네이티브 번들 원문. 번들 수준 테스트는 커밋된 산출물을 그대로 올린다. */
const BUNDLE=await readFile(new URL('../native/Resources/aster-core.js',import.meta.url),'utf8');

/**
 * 시드 고정 난수 생성기(mulberry32)를 만든다.
 * 새 npm 의존성 없이 실행마다 같은 셔플을 재현하려고 직접 쓴다.
 * @param {number} seed 32비트 시드
 * @returns {() => number} [0, 1) 구간의 난수를 돌려주는 함수
 */
function seededRandom(seed){
 let state=seed>>>0;
 return ()=>{state=(state+0x6d2b79f5)>>>0;let value=state;value=Math.imul(value^(value>>>15),value|1);value^=value+Math.imul(value^(value>>>7),value|61);return ((value^(value>>>14))>>>0)/4294967296;};
}

/**
 * 배열을 시드 난수로 섞은 새 배열을 돌려준다(Fisher–Yates). 원본은 바꾸지 않는다.
 * @param {readonly any[]} items 섞을 항목
 * @param {() => number} random seededRandom이 만든 난수 함수
 * @returns {any[]} 섞인 새 배열
 */
function shuffle(items,random){
 const next=items.slice();
 for(let i=next.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[next[i],next[j]]=[next[j],next[i]];}
 return next;
}

/**
 * 시험할 키 순서 목록을 만든다.
 * @param {readonly string[]} keys 원래 키 목록
 * @param {number} [seed=1] 키가 6개 이상일 때 쓸 셔플 시드
 * @returns {string[][]} 키가 5개 이하면 모든 순열, 그보다 많으면 시드 고정 셔플 24개
 */
function keyOrders(keys,seed=1){
 if(keys.length>5){const random=seededRandom(seed);return Array.from({length:24},()=>shuffle(keys,random));}
 const orders=[];
 const permute=(rest,prefix)=>{if(!rest.length)orders.push(prefix);rest.forEach((key,i)=>permute([...rest.slice(0,i),...rest.slice(i+1)],[...prefix,key]));};
 permute(keys,[]);
 return orders;
}

/**
 * 같은 값을 주어진 키 순서로 담은 새 객체를 만든다.
 * @param {object} value 원본 레코드
 * @param {readonly string[]} keys 새 키 순서
 * @returns {object} 키 순서만 다른 새 객체
 */
function withOrder(value,keys){return Object.fromEntries(keys.map(key=>[key,value[key]]));}

/**
 * 중첩된 평범한 객체의 키 순서를 모두 시드 난수로 섞는다. 배열 원소 순서는 의미가 있으므로 그대로 둔다.
 * @param {any} value 섞을 값
 * @param {() => number} random 난수 함수
 * @returns {any} 키 순서만 섞인 깊은 복사본
 */
function shuffleDeep(value,random){
 if(Array.isArray(value))return value.map(item=>shuffleDeep(item,random));
 if(value&&typeof value==='object')return Object.fromEntries(shuffle(Object.keys(value),random).map(key=>[key,shuffleDeep(value[key],random)]));
 return value;
}

/**
 * 오류를 `이름: 메시지` 문자열로 바꾼다. 받아들여지면 'accepted'를 돌려준다.
 * 호스트가 받는 String(error) 형태로 비교하려고 쓴다.
 * @param {() => unknown} action 실행할 동작
 * @returns {string} 오류 문자열 또는 'accepted'
 */
function outcome(action){try{action();return 'accepted';}catch(error){return `${error.name}: ${error.message}`;}}

/** 모든 차트가 같은 원본을 쓰도록 고정한 막대 40개의 시작 시각(레거시 픽스처와 같은 시각). */
const T=1700000000000;
/** 모든 차트가 공유하는 막대 40개. */
const ROWS=Array.from({length:40},(_,i)=>({time:T+i*60000,open:100+i,high:103+i,low:99+i,close:102+i,volume:500+i}));

/**
 * 막대 40개를 가진 새 차트를 만들고 테스트가 끝나면 정리한다.
 * @param {import('node:test').TestContext} t 정리 콜백을 등록할 테스트 컨텍스트
 * @param {{panels?: object[]}} [options] 모델 생성 옵션
 * @returns {{model: ChartModel, api: ChartAPI}} 새 차트
 */
function makeChart(t,{panels}={}){
 const model=new ChartModel({store:new BarStore(ROWS),...(panels?{panels}:{})});
 const controller=new InteractionController(model,()=>({width:800,height:500})),api=new ChartAPI(model,{controller});
 t.after(()=>model.dispose());
 return {model,api};
}

test('orderedRecord and canonicalKeys put listed keys first and the rest in UTF-16 order',async()=>{
 // 계약 함수가 아직 없을 때도 다른 테스트가 돌도록 동적으로 불러온다
 const {orderedRecord,canonicalKeys}=await import('../src/core/contracts.mjs');
 const input=JSON.parse('{"zeta":1,"__proto__":4,"b":2,"Z":3}');input.a=undefined;const marker=Symbol('marker');input[marker]=5;
 const before=Reflect.ownKeys(input),record=orderedRecord(input,['b','a','missing']);
 // 목록 키(목록 순서, undefined 자리 유지) → 나머지 문자열 키(UTF-16 오름차순) → 심볼 키
 assert.deepEqual(Reflect.ownKeys(record),['b','a','Z','__proto__','zeta',marker]);
 assert.equal(Object.hasOwn(record,'a'),true);
 // `__proto__`는 프로토타입을 바꾸지 않고 평범한 자기 키로 남는다
 assert.equal(Object.getPrototypeOf(record),Object.prototype);
 assert.equal(Object.getOwnPropertyDescriptor(record,'__proto__').value,4);
 // 원본은 바꾸지 않는다
 assert.deepEqual(Reflect.ownKeys(input),before);
 assert.deepEqual(canonicalKeys(input,['b','a','missing']),['b','a','Z','__proto__','zeta']);
 assert.deepEqual(canonicalKeys(input,['zeta'],Reflect.ownKeys(input)),['zeta','Z','__proto__','a','b',marker]);
});

/** 키 순서를 바꿔 넣을 드로잉 입력(최상위 키 6개, 스타일·앵커 키는 따로 섞는다). */
const DRAWING={type:'trendline',points:[{price:100,time:1700000000000},{time:1700001200000,price:125}],text:'t',style:{width:2,color:'#ff0000'},panel:'price',visible:true};
/** DRAWING을 정규 키 순서로 저장한 문서. 레거시 픽스처 순서(id,panel,locked,style,type,points,text) 뒤에 visible이 온다. */
const CANONICAL_DRAWING_DOCUMENT='{"schema":"aster.drawings","version":4,"drawings":[{"id":"drawing-1","panel":"price","locked":false,"style":{"color":"#ff0000ff","width":2},"type":"trendline","points":[{"time":1700000000000,"price":100},{"time":1700001200000,"price":125}],"text":"t","visible":true}]}';

/**
 * DRAWING의 최상위 키는 주어진 순서로, 스타일과 앵커 키는 시드 난수로 섞은 입력을 만든다.
 * @param {readonly string[]} keys 최상위 키 순서
 * @param {() => number} random 중첩 키를 섞을 난수 함수
 * @returns {object} 새 드로잉 입력
 */
function drawingInput(keys,random){const input=withOrder(DRAWING,keys);input.style=shuffleDeep(input.style,random);input.points=shuffleDeep(input.points,random);return input;}

test('drawing records ignore input key order',t=>{
 const random=seededRandom(7);
 const saved=new Set(keyOrders(Object.keys(DRAWING)).map(keys=>{const {api}=makeChart(t);api.addDrawing(drawingInput(keys,random));return api.saveDrawings();}));
 assert.deepEqual([...saved],[CANONICAL_DRAWING_DOCUMENT]);
});

test('drawing edits keep canonical order',t=>{
 const {model,api}=makeChart(t),id=api.addDrawing({type:'trendline',points:[{time:T,price:100},{time:T+600000,price:110}]});
 api.editDrawing(id,{style:{width:3,color:'#00ff00'},text:'x'});
 assert.equal(api.saveDrawings(),'{"schema":"aster.drawings","version":1,"drawings":[{"id":"drawing-1","panel":"price","locked":false,"style":{"color":"#00ff00ff","width":3},"type":"trendline","points":[{"time":1700000000000,"price":100},{"time":1700000600000,"price":110}],"text":"x"}]}');
 // 키 순서만 다른 같은 스타일은 저장 레코드를 바꾸지 않으므로 되돌리기 항목도 만들지 않는다
 const undo=model.drawings.undoStack.length,before=model.drawings.items[0];
 api.editDrawing(id,{style:{color:'#00ff00',width:3}});
 assert.equal(model.drawings.undoStack.length,undo);
 assert.equal(model.drawings.items[0],before);
});

test('drawing group edits keep canonical order',t=>{
 const {model,api}=makeChart(t);
 api.addAxis({id:'left',panel:'price',side:'left'});api.addSeries({id:'close',type:'line',panel:'price',source:'close',axisId:'left'});
 // 시리즈에 묶인 드로잉은 axisId·seriesId가 points 뒤에 온다
 const bound=api.addDrawing({seriesId:'close',points:[{price:110,time:T}],type:'horizontal'}),record=()=>model.drawings.items.find(d=>d.id===bound);
 assert.deepEqual(Object.keys(record()),['id','panel','locked','style','type','points','axisId','seriesId']);
 // 숨김은 visible을 axisId 앞 정규 자리에 넣는다
 api.setDrawingsVisibility([bound],false);
 assert.deepEqual(Object.keys(record()),['id','panel','locked','style','type','points','visible','axisId','seriesId']);
 // 스타일 일괄 편집은 스타일 키도 정규 순서(color,width,fill)로 쓴다
 api.setDrawingsStyle([bound],{fill:'#000000',width:3,color:'#00ff00'});
 assert.deepEqual(Object.keys(record().style),['color','width','fill']);
 assert.deepEqual(Object.keys(record()),['id','panel','locked','style','type','points','visible','axisId','seriesId']);
 // locked가 없는 옛 문서 드로잉을 복제하면 locked:false가 정규 자리에 들어간다
 api.loadDrawings(JSON.stringify({schema:'aster.drawings',version:1,drawings:[{type:'horizontal',points:[{price:1,time:T}],panel:'price',id:'old'}]}));
 assert.deepEqual(Object.keys(model.drawings.items[0]),['id','panel','type','points']);
 const [copy]=api.duplicateDrawings(['old'],{deltaPrice:1,deltaTimeMs:0}).created;
 // 앞서 addDrawing이 drawing-1을 썼으므로 복제본은 drawing-2다
 assert.equal(copy.id,'drawing-2');
 assert.deepEqual(Object.keys(model.drawings.items.find(d=>d.id===copy.id)),['id','panel','locked','type','points']);
 api.translateDrawings(['old'],{deltaPrice:1,deltaTimeMs:60000});
 assert.equal(api.saveDrawings(),'{"schema":"aster.drawings","version":1,"drawings":[{"id":"old","panel":"price","type":"horizontal","points":[{"time":1700000060000,"price":2}]},{"id":"drawing-2","panel":"price","locked":false,"type":"horizontal","points":[{"time":1700000000000,"price":2}]}]}');
});

/** 작업공간 저장에 쓰는 데이터셋 바인딩(심볼 통화·조정과 맞춘다). */
const BINDING={key:'record-key-order',revision:'1',adjustmentVersion:'raw',priceUnit:'USD',adjustment:'raw'};
/** 키 순서를 바꿔 넣을 차트 레코드. 시리즈는 일반·지표·독립 축 세 종류다. */
const CHART_RECORDS={
 pricePanel:{id:'price',weight:3,padding:0.1},
 panel:{id:'lower',weight:1,label:'Lower',scale:'linear',inverted:false},
 axis:{id:'left',panel:'lower',side:'left',label:'L',width:40},
 series:{id:'close',type:'line',panel:'price',source:'close',color:'#112233',width:2},
 indicatorSeries:{id:'ema-line',type:'line',panel:'price',indicator:'ema5',output:'value',color:'#445566',width:1.5},
 axisSeries:{id:'lower-line',type:'histogram',panel:'lower',axisId:'left',source:'volume',label:'Vol',visible:true,baseline:0},
 theme:{background:'#000000',grid:'#111111',text:'#222222',up:'#333333',down:'#444444',crosshair:'#555555',font:'12px monospace'},
 symbol:{id:'AAPL',exchange:'XNAS',timezone:'America/New_York',currency:'USD',volumeUnit:'shares',priceDecimals:2,tickSize:0.01,adjustment:'raw'},
 target:{panel:'price',seriesId:'close',axisId:null},
 binding:BINDING,
};

test('series, panels, axes, theme and symbol ignore input key order',t=>{
 const orders=Object.fromEntries(Object.entries(CHART_RECORDS).map(([name,value],i)=>[name,keyOrders(Object.keys(value),i+1)]));
 const runs=Math.max(...Object.values(orders).map(list=>list.length)),outputs=new Set();
 // 레코드 종류마다 자기 순서 목록을 돌려 쓰므로 모든 순서가 한 번 이상 들어간다
 for(let run=0;run<runs;run++){
  const pick=name=>withOrder(CHART_RECORDS[name],orders[name][run%orders[name].length]);
  const {model,api}=makeChart(t,{panels:[pick('pricePanel')]});
  api.addPanel(pick('panel'));api.addAxis(pick('axis'));api.addIndicator('ema5','ema',{period:5});
  api.addSeries(pick('series'));api.addSeries(pick('indicatorSeries'));api.addSeries(pick('axisSeries'));
  api.setTheme(pick('theme'));api.setSymbol(pick('symbol'));api.setDrawingTarget(pick('target'));
  outputs.add(saveWorkspace(api,pick('binding'))+'\n'+JSON.stringify(api.inspect()));
  model.dispose();
 }
 assert.equal(outputs.size,1);
 const [workspace,inspected]=[...outputs][0].split('\n'),state=JSON.parse(inspected),saved=JSON.parse(workspace);
 // 정규 순서: 패널·축·시리즈는 허용 목록 순서(작업공간이 이미 쓰는 순서), 심볼은 검증기 허용 목록 순서
 assert.deepEqual(Object.keys(state.panels[1]),['id','weight','label','scale','inverted','padding']);
 assert.deepEqual(Object.keys(state.axes[0]),['id','panel','side','scale','inverted','padding','tickFormat','label','visible','width']);
 assert.deepEqual(Object.keys(state.series[1]),['id','type','panel','indicator','output','color','width','offset']);
 assert.deepEqual(Object.keys(state.symbol),['id','exchange','timezone','currency','volumeUnit','priceDecimals','tickSize','adjustment']);
 assert.deepEqual(Object.keys(saved.chart.symbol),Object.keys(state.symbol));
 assert.deepEqual(Object.keys(state.drawingTarget),['panel','axisId','seriesId']);
 // 기본 포매터로 저장된 심볼과 view도 동기 복원 뒤 정규 순서가 된다
 const random=seededRandom(5),doc=JSON.parse(workspace);doc.chart.formatters='default';doc.chart.symbol=shuffleDeep(doc.chart.symbol,random);doc.chart.view={to:doc.chart.view.to,from:doc.chart.view.from};
 const shuffled=JSON.stringify(doc),parsed=readWorkspaceDocument(shuffled),{model:restored,api:restoredApi}=makeChart(t,{panels:parsed.chart.panels});
 for(const axis of parsed.chart.axes)restoredApi.addAxis(axis);for(const e of parsed.indicators)restoredApi.addIndicator(e.id,e.name,e.params);
 installWorkspaceConfiguration(restored,parsed);
 assert.deepEqual(Object.keys(restored.symbol),Object.keys(state.symbol));
 assert.deepEqual(Object.keys(restored.view),['from','to']);
});

test('series, panel and axis patches keep canonical order',t=>{
 const {model,api}=makeChart(t);
 api.addPanel({weight:1,id:'lower'});api.setPanel('lower',{label:'Lower'});
 api.addAxis({panel:'lower',id:'left'});api.setAxis('left',{label:'L',side:'left'});
 api.addSeries({panel:'lower',type:'line',id:'close'});api.setSeries('close',{label:'Close',color:'#123456'});
 // 지표 배치를 옮기면 새로 생기는 axisId도 label 앞 정규 자리에 온다
 api.addIndicator('e','ema',{period:5});api.addSeries({label:'E',indicator:'e',panel:'price',type:'line',id:'e-line'});api.setIndicatorPlacement('e',{panel:'lower'});
 const state=api.inspect();
 assert.deepEqual(Object.keys(state.panels[1]),['id','weight','label','scale','inverted','padding']);
 assert.deepEqual(Object.keys(state.axes[0]),['id','panel','side','scale','inverted','padding','tickFormat','label','visible']);
 assert.deepEqual(Object.keys(state.series[0]),['id','type','panel','color','width','offset','label']);
 assert.deepEqual(Object.keys(model.series[0]).filter(key=>!['dirtyFrom','rangeIndex','revision'].includes(key)),['id','type','panel','color','width','offset','label']);
 assert.deepEqual(Object.keys(state.series[1]),['id','type','panel','indicator','color','width','offset','axisId','label']);
});

test('indicator params ignore input key order',t=>{
 const documents=[{stdDev:2,period:20},{period:20,stdDev:2}].map(params=>{const {api}=makeChart(t);api.addIndicator('b','bollinger',params);return [api.saveStudies(),saveWorkspace(api,BINDING)];});
 assert.deepEqual(documents[0],documents[1]);
 // 선언된 파라미터(period)가 먼저, 선언되지 않은 키(stdDev)는 UTF-16 순서로 뒤에 온다
 assert.match(documents[0][0],/"params":\{"period":20,"stdDev":2\}/);
});

test('indicator params follow the declared parameter order of each definition',async t=>{
 // 내장 팩토리 소스의 구조 분해 선언을 읽어, 기본값을 거꾸로 넣어도 저장 순서가 선언 순서인지 본다(선언 목록 표류 방지)
 const source=await readFile(new URL('../src/core/indicators.mjs',import.meta.url),'utf8');
 const declarations=[...source.matchAll(/add\('(\w+)',\s*\(\{([^}]*)\}\s*=\s*\{\}\)\s*=>/g)]
  .map(([,name,body])=>[name,body.split(',').map(part=>{const [left,right]=part.split('=');return [left.split(':')[0].trim(),right.trim()];})])
  .filter(([,params])=>params.length>1);
 assert.ok(declarations.length>=13,'builtin parameter declarations were not found');
 const savedParams=api=>Object.keys(JSON.parse(api.saveStudies()).indicators[0].params);
 for(const [name,params] of declarations){
  const {api}=makeChart(t),reversed=Object.fromEntries(params.slice().reverse().map(([key,value])=>[key,value.startsWith("'")?value.slice(1,-1):Number(value)]));
  api.addIndicator('x',name,reversed);
  assert.deepEqual(savedParams(api),params.map(([key])=>key),name);
 }
 // 세션 지표는 세션 설정을 읽는 순서, 링크 모듈은 모듈 팩토리가 선언한 순서다
 const calendar=portableSessionCalendar({timezone:'America/New_York',weekdays:[1,2,3,4,5],windows:[{open:'09:30',close:'16:00'}]});
 const {api:vwap}=makeChart(t);vwap.addIndicator('v','vwap',{deviation:1,source:'close',kinds:'regular',anchorTime:T,calendar});
 assert.deepEqual(savedParams(vwap),['calendar','anchorTime','kinds','source','deviation']);
 const {api:legacyVwap}=makeChart(t);legacyVwap.addIndicator('v','vwap',{deviation:2,source:'close',sessionMs:86400000});
 assert.deepEqual(savedParams(legacyVwap),['sessionMs','source','deviation']);
 const {api:pivots}=makeChart(t);pivots.addIndicator('p','pivots',{kinds:'regular',calendar});
 assert.deepEqual(savedParams(pivots),['calendar','kinds']);
 const {api:linked}=makeChart(t);linked.registerIndicatorModule('aster.volume-direction',1);linked.addIndicator('p','aster.volume-direction@1/pressure',{shift:1,factor:0.5});
 assert.deepEqual(savedParams(linked),['factor','shift']);
});

test('asynchronous indicator params publish canonical params',t=>{
 const model=new ChartModel(),api=new ChartAPI(model);api.setColumns(seededColumns(257));api.addIndicator('x','ema',{period:5});
 const source=new NativeParamsCapture(api,'x',{source:'close',period:9},{revision:3,registration:7});let target=null;
 t.after(()=>{target?.dispose();source.dispose();model.dispose();});
 let admission;do{admission=source.step(1,3);}while(!admission.complete);
 // 원본이 대상 런타임으로 넘기는 바인딩부터 선언 순서다
 assert.deepEqual(Object.keys(JSON.parse(admission.metadataJSON).params),['period','source']);
 target=new NativeParamsTarget(admission.metadataJSON);const store=model.store;
 for(let slot=0;slot<6;slot++)for(let at=0;at<store.length;at+=64){const count=Math.min(64,store.length-at);target.target(slot,at,count).set(source.buffer(slot,at,count,3));}
 target.start();while(!target.step(64).complete){}
 source.receive(safeCheckpointStringify(target.descriptor()),3);
 for(let slot=0;slot<target.layout.outputs.length;slot++)for(let at=0;at<store.capacity;at+=64){const count=Math.min(64,store.capacity-at);source.resultBuffer(slot,at,count,3).set(target.outputBuffer(slot,at,count));}
 for(let ordinal=0;ordinal<target.checkpointCount;ordinal++){const row=target.checkpoint(ordinal);source.checkpoint(row.index,row.text,3);}
 while(!source.validate(64,3).complete){}
 source.prepare(3);source.publish(3);
 assert.deepEqual(Object.keys(model.indicators.entries.get('x').params),['period','source']);
 assert.match(api.saveStudies(),/"params":\{"period":9,"source":"close"\}/);
});

test('first unsupported field is independent of input order',t=>{
 const input={zeta:1,alpha:2,type:'horizontal',points:[{time:1,price:1}]};
 const messages=new Set(keyOrders(Object.keys(input)).map(keys=>{const {api}=makeChart(t);return outcome(()=>api.addDrawing(withOrder(input,keys)));}));
 // 지원하지 않는 필드 가운데 UTF-16 순으로 가장 앞인 것을 보고한다
 assert.deepEqual([...messages],['TypeError: Drawing: unsupported field alpha']);
 // 예약 이름(JSON으로만 자기 키가 된다)도 입력 순서와 무관하게 하나로 정해진다
 const reserved=new Set(keyOrders(['prototype','constructor']).map(keys=>{const {api}=makeChart(t);return outcome(()=>api.addIndicator('x','ema',JSON.parse('{'+keys.map(key=>`"${key}":1`).join(',')+'}')));}));
 assert.deepEqual([...reserved],['TypeError: Indicator params: unsupported field constructor']);
 // 스타일 패치에서 빈 값과 모르는 필드가 섞여도 어느 오류를 낼지가 하나로 정해진다
 const style=new Set(keyOrders(['fill','zeta']).map(keys=>outcome(()=>new DrawingStylePresets().set('wide',withOrder({fill:null,zeta:1},keys)))));
 assert.deepEqual([...style],['TypeError: Drawing style nonempty defined patch required']);
});

test('dataset bindings and replay sessions are written in canonical order',t=>{
 const {api}=makeChart(t),text=saveWorkspace(api,BINDING);
 // 사전 점검 영수증은 호출자가 넘긴 바인딩 키 순서와 무관하다
 const receipts=new Set(keyOrders(Object.keys(BINDING)).map(keys=>JSON.stringify(nativeWorkspacePreflight(api,text,withOrder(BINDING,keys)))));
 assert.equal(receipts.size,1);
 assert.deepEqual(Object.keys(JSON.parse([...receipts][0]).dataset),Object.keys(BINDING));
 // 리플레이 세션 문서도 바인딩·테마·지표·북마크 키 순서가 하나로 정해진다
 const bars=ROWS.slice(0,8),sessions=new Set([0,1].map(flip=>{
  const theme=flip?{down:'#111111',background:'#abcdef'}:{background:'#abcdef',down:'#111111'},indicator=flip?{period:2,color:'#123456',kind:'ema',id:'ema'}:{id:'ema',kind:'ema',period:2,color:'#123456'};
  const replay=new BarReplay(bars,{initialCount:2,theme,indicators:[indicator]});t.after(()=>replay.dispose());
  replay.addBookmark(flip?{label:'First',id:'first'}:{id:'first',label:'First'});
  return replay.saveSession(withOrder(BINDING,flip?Object.keys(BINDING).reverse():Object.keys(BINDING)));
 }));
 assert.equal(sessions.size,1);
 const session=JSON.parse([...sessions][0]);
 assert.deepEqual(Object.keys(session.dataset),Object.keys(BINDING));
 assert.deepEqual(Object.keys(session.options.theme),['background','down']);
 assert.deepEqual(Object.keys(session.options.indicators[0]),['id','kind','period','color']);
 assert.deepEqual(Object.keys(session.bookmarks[0]),['id','label','count']);
});

/** 레거시 픽스처 원문을 읽는다. */
const fixture=name=>readFile(new URL(`./fixtures/legacy/${name}`,import.meta.url),'utf8');

test('legacy-order documents still load and restore',async t=>{
 const drawingsText=await fixture('aster-drawings.json'),workspaceText=await fixture('aster-workspace-v1.json'),random=seededRandom(11);
 const {model,api}=buildLegacyChart();t.after(()=>model.dispose());
 // 드로잉 문서: 드로잉·스타일·앵커 키를 섞은 옛 문서도 열리고, 다시 저장하면 원본 픽스처 바이트가 된다
 const legacyDrawings=JSON.parse(drawingsText);legacyDrawings.drawings=legacyDrawings.drawings.map(drawing=>shuffleDeep(drawing,random));
 const shuffledDrawings=JSON.stringify(legacyDrawings);assert.notEqual(shuffledDrawings,drawingsText);
 api.loadDrawings(shuffledDrawings);
 assert.equal(api.saveDrawings(),drawingsText);
 // 작업공간 문서: 모든 객체의 키를 섞는다(배열 순서는 유지)
 const shuffledWorkspace=JSON.stringify(shuffleDeep(JSON.parse(workspaceText),random));assert.notEqual(shuffledWorkspace,workspaceText);
 // 동기 복원(installWorkspaceConfiguration 경로) 뒤 다시 저장하면 원본 바이트다
 const doc=readWorkspaceDocument(shuffledWorkspace),rows=Array.from({length:model.store.length},(_,i)=>model.store.at(i));
 const restored=new ChartModel({store:new BarStore(rows),panels:doc.chart.panels,axes:doc.chart.axes,theme:doc.chart.theme,precision:doc.chart.precision,axisWidth:doc.chart.axisWidth});t.after(()=>restored.dispose());
 const restoredApi=new ChartAPI(restored);for(const e of doc.indicators)restoredApi.addIndicator(e.id,e.name,e.params);
 installWorkspaceConfiguration(restored,doc);
 assert.equal(saveWorkspace(restoredApi,LEGACY_BINDING),workspaceText);
 // 번들 원본 admission(nativeWorkspaceSourceBegin)을 통과하고, 대상 런타임에서 끝까지 복원한 뒤 다시 저장해도 원본 바이트다
 const source=vm.createContext({}),target=vm.createContext({});vm.runInContext(BUNDLE,source);vm.runInContext(BUNDLE,target);
 t.after(()=>{for(const context of [source,target]){context.nativeAsyncRelease(1);context.nativeWorkspaceTargetDispose();context.nativeModel?.dispose();}});
 const binding=`globalThis.binding=JSON.parse(${JSON.stringify(JSON.stringify(LEGACY_BINDING))});`;
 vm.runInContext(`nativeInit(0,{series:[]});nativeCommand('setData',[JSON.parse(${JSON.stringify(JSON.stringify(rows))})]);${binding}`,source);
 const ticket=source.nativeWorkspaceSourceBegin(shuffledWorkspace,source.binding,0).ticket;
 let description=null;for(let i=0;i<10000&&!description;i++){const row=source.nativeWorkspaceSourceStep(ticket,8,0);if(row.complete)description=row;}
 assert.ok(description,'workspace source admission did not complete');
 target.nativeWorkspaceTargetCreate(description.metadataJSON);
 for(const buffer of description.buffers)if(buffer.length)target.nativeAsyncTargetBuffer(buffer.slot,0,buffer.length).set(source.nativeAsyncBuffer(ticket,buffer.slot,0,buffer.length));
 target.nativeAsyncStart();
 let complete=false;for(let i=0;i<10000&&!complete;i++)complete=JSON.parse(target.nativeAsyncStep(4096)).complete;
 assert.ok(complete,'workspace target did not complete');
 source.nativeWorkspaceSourceFinish(ticket,0);target.nativeWorkspaceTargetFinish();
 vm.runInContext(binding,target);
 assert.equal(target.nativeSaveWorkspace(target.binding),workspaceText);
});

test('bundle-level documents ignore input key order',()=>{
 const context=vm.createContext({}),random=seededRandom(13);vm.runInContext(BUNDLE,context);
 // 입력 객체는 컨텍스트 안에서 JSON.parse로 만든다(다른 realm 객체는 plain object 검사에 걸린다)
 const saved=new Set(keyOrders(Object.keys(DRAWING)).map(keys=>{vm.runInContext(`nativeInit(0,{series:[]});nativeCommand('addDrawing',[JSON.parse(${JSON.stringify(JSON.stringify(drawingInput(keys,random)))})]);`,context);return context.nativeSave();}));
 vm.runInContext('nativeModel.dispose()',context);
 assert.deepEqual([...saved],[CANONICAL_DRAWING_DOCUMENT]);
});
