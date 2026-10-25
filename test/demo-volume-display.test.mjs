import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ChartModel,ChartAPI,DEMO_SYMBOLS,formatPrice} from '../src/core/index.mjs';
const source=await readFile(new URL('../examples/web/demo.mjs',import.meta.url),'utf8');
const start=source.indexOf('function sync(){'),end=source.indexOf('\nfunction busy(',start);
assert.ok(start>=0&&end>start);
// Execute the shipped sync handler with only host nodes substituted. This is
// stored binary64 display validation, not a browser or decimal-accounting test.
const sync=new Function('context','with(context){return ('+source.slice(start,end)+')();}');
function fixture(t){
 const model=new ChartModel(),api=new ChartAPI(model),nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{setAttribute(){}});return nodes.get(id);};
 const chart={controller:{tool:'select'},canvas:{style:{}}};
 t.after(()=>model.dispose());return {model,api,$,run:()=>sync({model,chart,$,indicatorEditor:{sync(){}},setText:(id,value)=>$(id).textContent=value,formatPrice})};
}
for(const market of ['kr','us','crypto'])test(`actual ${market} summary keeps stored volume distinguishable from zero and round-trippable`,t=>{
 const f=fixture(t);f.api.setSymbol(DEMO_SYMBOLS[market]);
 for(const volume of [0,-0,Number.MIN_VALUE,1e-18,1e-8,.0001,1.23456789,1234,123456789.12345679,Number.MAX_SAFE_INTEGER,1e21,Number.MAX_VALUE]){
  f.api.setData([{time:1700000000000,open:1,high:2,low:0,close:1,volume}]);const version=f.model.store.version,columns=f.model.store.columns;f.run();const text=f.$('last-volume').textContent;
  assert.equal(text,Object.is(volume,-0)?'-0':String(volume));assert.ok(Object.is(Number(text),volume),`${volume} must round-trip`);if(volume!==0)assert.notEqual(text,'0');
  assert.equal(f.model.store.version,version);assert.equal(f.model.store.columns,columns);assert.ok(Object.is(f.model.store.at(0).volume,volume));
  for(const key of ['open','high','low','close'])assert.equal(f.$('last-'+key).textContent,formatPrice(f.model.store.at(0)[key],f.model.symbol));
 }
});
test('market changes preserve volume text while price precision changes; empty source clears stale values',t=>{
 const f=fixture(t);f.api.setData([{time:1700000000000,open:1,high:2,low:0,close:1,volume:1e-8}]);
 for(const market of ['crypto','kr','us','crypto']){f.api.setSymbol(DEMO_SYMBOLS[market]);f.run();assert.equal(f.$('last-volume').textContent,'1e-8');assert.equal(f.$('last-close').textContent,formatPrice(1,DEMO_SYMBOLS[market]));}
 f.api.setData([]);f.run();for(const key of ['open','high','low','close','volume'])assert.equal(f.$('last-'+key).textContent,'—');assert.equal(f.$('last-time').textContent,'데이터 없음');
});
test('summary explains exponent display and stored Number scope',async()=>{
 const html=await readFile(new URL('../examples/web/index.html',import.meta.url),'utf8');assert.match(html,/거래량은 저장된 Number/);assert.match(html,/작은 값은 지수 표기/);assert.match(html,/원래 decimal 정밀도를 보장하지 않습니다/);
});
