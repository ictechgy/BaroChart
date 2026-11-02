// 시간대 계약 v1(설계 §7.4-2, M0 Task 2)을 확인한다.
// 이름 문법, 지원 연도(1000~9999), 오류 문구를 코어가 정하므로 V8(웹)·JSC(iOS)·QuickJS+java.time(Android)이
// 같은 입력에 같은 답을 내야 한다. src/core/markets.mjs를 직접 부르고, 커밋된 번들은 node:vm에 올려 같은 기대값을 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {zonedParts,zonedEpoch,shiftDate,marketDate} from '../src/core/markets.mjs';

/** 캐시가 빈 새 모듈 인스턴스를 import할 때 쓰는 원본 주소 */
const MARKETS_URL=new URL('../src/core/markets.mjs',import.meta.url).href;
/** 생성된 네이티브 번들 원문. 번들 수준 테스트는 커밋된 산출물을 그대로 올린다. */
const BUNDLE=await readFile(new URL('../native/Resources/aster-core.js',import.meta.url),'utf8');
/** Android JNI 원본. QuickJS에 까는 Intl shim 문자열을 여기서 그대로 꺼내 쓴다(표류 방지). */
const JNI_SOURCE=await readFile(new URL('../native/android/aster_jni.c',import.meta.url),'utf8');

/** 2026-03-09T13:30:00Z. 뉴욕은 전날 일광 절약 시간(UTC−4)이 시작됐다. */
const NY_OPEN=1773063000000;
/** 1000-01-01T00:00:00.000Z: 지원 연도 첫날의 UTC 자정 */
const YEAR_1000=-30610224000000;
/** 9999-12-31T23:59:59.999Z: 지원 연도의 마지막 UTC 밀리초 */
const YEAR_9999_END=253402300799999;
/** 코어가 받는 시각의 하한·상한. 지원 연도 범위를 하루씩 넓힌 값이다(1000-01-01Z−1일, 9999-12-31T23:59:59.999Z+1일). */
const TIME_MIN=-30610310400000,TIME_MAX=253402387199999;
/** 지원 연도 밖 오류의 기대값 */
const YEAR_OUT_OF_RANGE={name:'RangeError',message:'Time zone conversion year out of range'};
/** 날짜·시각 입력 오류의 기대값 */
const BAD_DATE_CLOCK={name:'TypeError',message:'ISO date and HH:mm[:ss] required'};

/**
 * zonedParts 결과의 기대값을 만든다. 키 순서도 계약이라 비교는 JSON 문자열로 한다.
 * @param {string} year 4자리 연도
 * @param {string} month 2자리 월
 * @param {string} day 2자리 일
 * @param {string} hour 2자리 시(00~23)
 * @param {string} minute 2자리 분
 * @param {string} second 2자리 초
 * @returns {string} 정규 순서 {year, month, day, hour, minute, second}의 JSON 문자열
 */
function partsJSON(year,month,day,hour,minute,second){return JSON.stringify({year,month,day,hour,minute,second});}

/**
 * 지원하지 않는 이름 오류의 기대값을 만든다. 문구에는 이름의 앞 64 UTF-16 단위만 들어간다.
 * @param {string} timezone 넘긴 이름
 * @returns {{name: string, message: string}} assert.throws 비교 객체
 */
function unsupported(timezone){return {name:'RangeError',message:`Unsupported time zone: ${timezone.slice(0,64)}`};}

/**
 * 본문이 던진 오류를 돌려준다. 던지지 않으면 테스트를 실패시킨다.
 * @param {() => unknown} body 실행할 본문
 * @returns {any} 던져진 오류
 */
function thrown(body){
 try{body();}catch(error){return error;}
 assert.fail('expected an error');
}

/** withTrackedIntl이 매번 다른 모듈 인스턴스를 받도록 붙이는 일련번호 */
let moduleCase=0;
/**
 * Intl.DateTimeFormat 생성 때 넘긴 시간대를 기록하면서, 포매터 캐시가 빈 markets.mjs 새 인스턴스로 본문을 실행한다.
 * 캐시가 모듈 전역이라 새로 import해야 "코어가 Intl을 부르지 않았다"를 셀 수 있다.
 * @param {(markets: any, zones: string[]) => unknown} run 새 모듈과 기록 배열을 받는 본문
 * @returns {Promise<unknown>} 본문의 반환값
 */
async function withTrackedIntl(run){
 const original=Intl.DateTimeFormat,zones=[];
 Intl.DateTimeFormat=class extends original {constructor(...args){zones.push(args[1]?.timeZone);super(...args);}};
 try{return await run(await import(MARKETS_URL+'?timezone-contract='+ ++moduleCase),zones);}finally{Intl.DateTimeFormat=original;}
}

/**
 * 시드 고정 난수 생성기(mulberry32)를 만든다. 새 npm 의존성 없이 실행마다 같은 입력을 재현하려고 직접 쓴다.
 * @param {number} seed 32비트 시드
 * @returns {() => number} [0, 1) 구간의 난수를 돌려주는 함수
 */
function seededRandom(seed){
 let state=seed>>>0;
 return ()=>{state=(state+0x6d2b79f5)>>>0;let value=state;value=Math.imul(value^(value>>>15),value|1);value^=value+Math.imul(value^(value>>>7),value|61);return ((value^(value>>>14))>>>0)/4294967296;};
}

/**
 * V8 Intl이 계산한 지역 시각을 계약 형식의 JSON으로 돌려준다. 연도가 1000~9999 밖이면 null이다.
 * 고정 오프셋 차분 검사의 독립 오라클로 쓴다(V8은 ES2024 오프셋 시간대를 산술로 계산한다).
 * @param {number} time UTC epoch ms
 * @param {string} timezone 시간대 이름이나 ±HH:MM
 * @returns {string|null} 기대 JSON, 지원 연도 밖이면 null
 */
function v8PartsJSON(time,timezone){
 const values={};
 for(const part of new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(time)))values[part.type]=part.value;
 const year=Number(values.year);
 return year>=1000&&year<=9999?partsJSON(values.year,values.month,values.day,values.hour,values.minute,values.second):null;
}

/**
 * 커밋된 번들을 올린 새 vm 컨텍스트를 만든다.
 * @param {string} [prelude] 번들보다 먼저 실행할 원문(Android처럼 Intl shim을 먼저 까는 경우)
 * @returns {{context: vm.Context, run: (source: string) => any}} 컨텍스트와 그 안에서 원문을 실행하는 함수
 */
function bundleContext(prelude=''){
 const context=vm.createContext({});
 if(prelude)vm.runInContext(prelude,context,{timeout:5000});
 vm.runInContext(BUNDLE,context,{timeout:5000});
 return {context,run:source=>vm.runInContext(source,context,{timeout:5000})};
}

/**
 * 번들 컨텍스트 안에서 setSymbol 명령 원문을 만든다. 심볼 객체는 컨텍스트 안에서 JSON.parse로 만든다.
 * @param {string} timezone 심볼 시간대
 * @returns {string} vm에서 실행할 원문
 */
function setSymbolSource(timezone){
 const symbol={id:'TZ',exchange:'TEST',timezone,currency:'USD',volumeUnit:'shares',priceDecimals:2,tickSize:.01,adjustment:'raw'};
 return `nativeCommand('setSymbol',[JSON.parse(${JSON.stringify(JSON.stringify(symbol))})])`;
}

test('named, lowercase, fixed-offset, Etc and POSIX-style zones convert per contract',()=>{
 assert.equal(JSON.stringify(zonedParts(NY_OPEN,'America/New_York')),partsJSON('2026','03','09','09','30','00'));
 assert.equal(JSON.stringify(zonedParts(NY_OPEN,'america/new_york')),partsJSON('2026','03','09','09','30','00'));
 assert.equal(JSON.stringify(zonedParts(NY_OPEN,'+09:00')),partsJSON('2026','03','09','22','30','00'));
 assert.equal(zonedParts(NY_OPEN,'Etc/GMT+9').hour,'04');
 assert.equal(zonedParts(NY_OPEN,'EST5EDT').hour,'09');
 assert.deepEqual(Object.keys(zonedParts(NY_OPEN,'Asia/Seoul')),['year','month','day','hour','minute','second']);
 assert.equal(marketDate(NY_OPEN,'Etc/GMT-14'),'2026-03-10');
});

test('fixed offsets are computed by the core without calling Intl',async()=>{
 await withTrackedIntl((m,zones)=>{
  assert.equal(JSON.stringify(m.zonedParts(NY_OPEN,'+09:00')),partsJSON('2026','03','09','22','30','00'));
  assert.equal(JSON.stringify(m.zonedParts(NY_OPEN,'-03:30')),partsJSON('2026','03','09','10','00','00'));
  assert.equal(JSON.stringify(m.zonedParts(NY_OPEN,'-00:00')),partsJSON('2026','03','09','13','30','00'));
  assert.equal(JSON.stringify(m.zonedParts(NY_OPEN,'+23:59')),partsJSON('2026','03','10','13','29','00'));
  // Intl처럼 시각을 먼저 정수 밀리초로 자른 뒤 오프셋을 더한다(-0.5ms는 1970-01-01T00:00:00.000Z)
  assert.equal(JSON.stringify(m.zonedParts(-0.5,'+09:00')),partsJSON('1970','01','01','09','00','00'));
  assert.equal(JSON.stringify(m.zonedParts(YEAR_1000,'+00:00')),partsJSON('1000','01','01','00','00','00'));
  assert.throws(()=>m.zonedParts(YEAR_1000,'-00:01'),YEAR_OUT_OF_RANGE);
  assert.equal(JSON.stringify(m.zonedParts(YEAR_9999_END,'+00:00')),partsJSON('9999','12','31','23','59','59'));
  assert.throws(()=>m.zonedParts(YEAR_9999_END,'+00:01'),YEAR_OUT_OF_RANGE);
  // ±HH:MM 밖의 오프셋 표기는 고정 오프셋도 이름도 아니다
  for(const zone of ['+24:00','+09:60','+0900','+09','+9:00','09:00','+09:00:00','\u221209:00'])assert.throws(()=>m.zonedParts(0,zone),unsupported(zone),zone);
  assert.deepEqual(zones,[]);
 });
});

test('core fixed-offset arithmetic matches V8 Intl offset zones on seeded instants',()=>{
 const random=seededRandom(0x7a0e),offsets=['+00:00','-00:00','+05:45','-09:30','+14:00','-12:00','+23:59','-23:59','+09:00'];
 const times=[TIME_MIN,TIME_MAX,YEAR_1000,YEAR_1000-1,YEAR_9999_END,YEAR_9999_END+1,0,-0.5,0.5,-1,NY_OPEN];
 for(let i=0;i<300;i++)times.push(TIME_MIN+random()*(TIME_MAX-TIME_MIN));
 let compared=0,rejected=0;
 for(const time of times)for(const offset of offsets){
  const expected=v8PartsJSON(time,offset);
  if(expected===null){assert.throws(()=>zonedParts(time,offset),YEAR_OUT_OF_RANGE,`${time} ${offset}`);rejected++;}
  else{assert.equal(JSON.stringify(zonedParts(time,offset)),expected,`${time} ${offset}`);compared++;}
 }
 assert.ok(compared>2500&&rejected>=10,`compared ${compared}, rejected ${rejected}`);
});

test('host-only and malformed names are rejected before Intl, without a cause',async()=>{
 await withTrackedIntl((m,zones)=>{
  // java.time만 받던 이름(Z, UTC+9, UT…)과 문법 밖 이름은 호스트를 부르기 전에 거절한다
  const names=['Z','z','UTC+9','utc+09:00','GMT+0','GMT-0','gmt-03:00','UT+9','UT','ut',' UTC','UTC\0','Asia/\u212Auala_Lumpur','Asia//Seoul','Asia/','/Asia','9Asia','Asia/Seoul ','Asia.Seoul','\u00e9'+'x'.repeat(127)];
  for(const zone of names){
   const error=thrown(()=>m.zonedParts(0,zone));
   assert.equal(error.name,'RangeError',JSON.stringify(zone));assert.equal(error.message,unsupported(zone).message,JSON.stringify(zone));
   assert.equal(Object.hasOwn(error,'cause'),false,JSON.stringify(zone));
  }
  assert.deepEqual(zones,[]);
 });
});

test('names that pass the grammar but fail in Intl keep the original error as cause',async()=>{
 await withTrackedIntl((m,zones)=>{
  const error=thrown(()=>m.zonedParts(0,'Foo/Bar'));
  assert.equal(error.name,'RangeError');assert.equal(error.message,'Unsupported time zone: Foo/Bar');
  assert.ok(error.cause instanceof RangeError,'original Intl error is kept');assert.match(error.cause.message,/Foo\/Bar/);
  const long='x'.repeat(128),longError=thrown(()=>m.zonedParts(0,long));
  assert.equal(longError.message,'Unsupported time zone: '+'x'.repeat(64));assert.ok(longError.cause instanceof RangeError);
  assert.deepEqual(zones,['Foo/Bar',long]);
 });
});

test('time must be finite and within the supported years, checked in contract order',()=>{
 for(const time of [NaN,Infinity,-Infinity,'0',null,undefined,0n])assert.throws(()=>zonedParts(time,'America/New_York'),{name:'RangeError',message:'Time zone conversion requires a finite time'},String(time));
 assert.throws(()=>zonedParts(1e20,'America/New_York'),YEAR_OUT_OF_RANGE);
 // 순서: 이름 문자열 → 유한한 시각 → 시각 범위 → 이름 문법
 assert.throws(()=>zonedParts(NaN,42),{name:'TypeError',message:'Timezone string, at most 128 characters required'});
 assert.throws(()=>zonedParts(NaN,'Z'),{name:'RangeError',message:'Time zone conversion requires a finite time'});
 assert.throws(()=>zonedParts(TIME_MIN-1,'Z'),YEAR_OUT_OF_RANGE);
 assert.throws(()=>zonedParts(TIME_MIN,'Z'),unsupported('Z'));
 assert.throws(()=>zonedParts(TIME_MAX+1,'Z'),YEAR_OUT_OF_RANGE);
 assert.throws(()=>zonedParts(TIME_MAX,'Z'),unsupported('Z'));
});

test('supported local years are 1000 through 9999 at both edges',()=>{
 // Pacific/Kiritimati는 1901년 전 LMT(−10:29:20)라 쓰지 않는다. Etc/GMT−14가 +14:00 고정이다.
 assert.equal(JSON.stringify(zonedParts(YEAR_1000,'Etc/GMT-14')),partsJSON('1000','01','01','14','00','00'));
 assert.throws(()=>zonedParts(YEAR_1000,'Etc/GMT+12'),YEAR_OUT_OF_RANGE);
 assert.equal(JSON.stringify(zonedParts(YEAR_9999_END,'Etc/GMT+12')),partsJSON('9999','12','31','11','59','59'));
 assert.throws(()=>zonedParts(YEAR_9999_END,'Etc/GMT-14'),YEAR_OUT_OF_RANGE);
});

test('a call that fails the year check does not insert its formatter into the cache',async()=>{
 await withTrackedIntl((m,zones)=>{
  assert.throws(()=>m.zonedParts(YEAR_1000,'Etc/GMT+12'),YEAR_OUT_OF_RANGE);
  m.zonedParts(0,'Etc/GMT+12');m.zonedParts(0,'ETC/GMT+12');
  assert.deepEqual(zones,['Etc/GMT+12','Etc/GMT+12']);
 });
});

test('zonedEpoch keeps the three-sample DST rules on strictly parsed input',()=>{
 assert.equal(zonedEpoch('2026-03-09','09:30','America/New_York'),1773063000000);
 assert.throws(()=>zonedEpoch('2026-03-08','02:30','America/New_York'),{name:'RangeError',message:'Nonexistent local time at DST boundary'});
 assert.equal(zonedEpoch('2026-11-01','01:30','America/New_York'),1793511000000);
 assert.equal(zonedEpoch('2026-11-01','01:30','America/New_York','later'),1793514600000);
 assert.throws(()=>zonedEpoch('2026-11-01','01:30','America/New_York','reject'),{name:'RangeError',message:'Ambiguous local time'});
 assert.throws(()=>zonedEpoch('2026-02-30','09:30','America/New_York'),BAD_DATE_CLOCK);
 assert.equal(zonedEpoch('2026-03-09','09:30:15','America/New_York'),1773063015000);
 assert.equal(zonedEpoch('2024-02-29','12:00','UTC'),Date.UTC(2024,1,29,12));
 assert.equal(zonedEpoch('2000-02-29','00:00','+09:00'),Date.UTC(2000,1,28,15));
 // 날짜·시각 형식을 이름보다 먼저 본다
 assert.throws(()=>zonedEpoch('2026-02-30','09:30','Z'),BAD_DATE_CLOCK);
 assert.throws(()=>zonedEpoch('2026-03-09','09:30','Z'),unsupported('Z'));
 const invalid=[['2026-02-29','09:30'],['1900-02-29','09:30'],['2026-13-01','09:30'],['2026-00-10','09:30'],['2026-01-00','09:30'],['2026-04-31','09:30'],['0999-12-31','09:30'],['2026-3-9','09:30'],['+002026-03-09','09:30'],[' 2026-03-09','09:30'],['2026-03-09\n','09:30'],['2026-03-09','24:00'],['2026-03-09','09:60'],['2026-03-09','09:30:60'],['2026-03-09','9:30'],['2026-03-09','09:30:00.000'],['2026-03-09','09:30Z'],['2026-03-09','\uff10\uff19:30'],[20260309,'09:30'],['2026-03-09',930],['2026-03-09',undefined]];
 for(const [date,clock] of invalid)assert.throws(()=>zonedEpoch(date,clock,'America/New_York'),BAD_DATE_CLOCK,JSON.stringify([date,String(clock)]));
});

test('zonedEpoch near the supported-year edges follows its fixed day samples',()=>{
 // 앞뒤 하루 표본도 지원 연도 안이어야 한다. 표본 순서와 후보 규칙은 바꾸지 않는다(이식 지도 §3.5.3).
 assert.equal(zonedEpoch('1000-01-01','14:00','Etc/GMT-14'),YEAR_1000);
 assert.throws(()=>zonedEpoch('1000-01-01','00:00','UTC'),YEAR_OUT_OF_RANGE);
 assert.equal(zonedEpoch('9999-12-31','10:00','Etc/GMT+12'),253402293600000);
 assert.throws(()=>zonedEpoch('9999-12-31','00:00','UTC'),YEAR_OUT_OF_RANGE);
});

test('shiftDate uses Gregorian calendar arithmetic within the supported years',()=>{
 assert.equal(shiftDate('2026-02-28',1),'2026-03-01');
 assert.equal(shiftDate('2024-02-28',1),'2024-02-29');
 assert.equal(shiftDate('2000-02-28',1),'2000-02-29');
 assert.equal(shiftDate('1900-02-28',1),'1900-03-01');
 assert.equal(shiftDate('2026-03-01',-1),'2026-02-28');
 assert.equal(shiftDate('2026-03-09',-6),'2026-03-03');
 assert.equal(shiftDate('1000-01-02',-1),'1000-01-01');
 assert.equal(shiftDate('9999-12-30',1),'9999-12-31');
 assert.throws(()=>shiftDate('1000-01-01',-1),YEAR_OUT_OF_RANGE);
 assert.throws(()=>shiftDate('9999-12-31',1),YEAR_OUT_OF_RANGE);
 assert.throws(()=>shiftDate('2026-03-01',NaN),YEAR_OUT_OF_RANGE);
 for(const date of ['2026-02-30','2026-13-01','0999-12-31','2026-3-1','x','2026-03-01T00:00',' 2026-03-01',20260301,undefined])assert.throws(()=>shiftDate(date,1),{name:'TypeError',message:'ISO date required'},String(date));
});

test('bundle-level conversions follow the same contract',()=>{
 const {run}=bundleContext();
 assert.equal(run(`JSON.stringify(Aster.zonedParts(${NY_OPEN},'america/new_york'))`),partsJSON('2026','03','09','09','30','00'));
 assert.equal(run(`JSON.stringify(Aster.zonedParts(${NY_OPEN},'+09:00'))`),partsJSON('2026','03','09','22','30','00'));
 assert.equal(run(`JSON.stringify(Aster.zonedParts(${YEAR_1000},'Etc/GMT-14'))`),partsJSON('1000','01','01','14','00','00'));
 assert.throws(()=>run(`Aster.zonedParts(${YEAR_1000},'Etc/GMT+12')`),YEAR_OUT_OF_RANGE);
 assert.throws(()=>run(`Aster.zonedParts(NaN,'UTC')`),{name:'RangeError',message:'Time zone conversion requires a finite time'});
 for(const zone of ['Z','UTC+9','gmt-03:00','Foo/Bar'])assert.throws(()=>run(`Aster.zonedParts(0,${JSON.stringify(zone)})`),unsupported(zone),zone);
 assert.equal(run(`Aster.zonedEpoch('2026-11-01','01:30','America/New_York','later')`),1793514600000);
 assert.throws(()=>run(`Aster.zonedEpoch('2026-03-08','02:30','America/New_York')`),{name:'RangeError',message:'Nonexistent local time at DST boundary'});
 assert.throws(()=>run(`Aster.zonedEpoch('2026-02-30','09:30','America/New_York')`),BAD_DATE_CLOCK);
 assert.equal(run(`Aster.shiftDate('2024-02-28',1)`),'2024-02-29');
 // 플랫폼 테스트와 같은 setSymbol 세 경우
 run(`nativeInit(0,{series:[]})`);
 assert.throws(()=>run(setSymbolSource('Z')),unsupported('Z'));
 run(setSymbolSource('asia/seoul'));run(setSymbolSource('+09:00'));
 assert.equal(run(`nativeModel.timeFormatter(${NY_OPEN})`),'2026-03-09 22:30');
});

test('Android QuickJS shim path: the core gates names, times and years around the host bridge',()=>{
 const shim=/const char \*shim="([^"\\]*)";/.exec(JNI_SOURCE);
 assert.ok(shim,'aster_jni.c timezone shim literal');
 // java.time 흉내: 표 안의 이름만 받고(ASCII 대소문자 무시, UT도 받음), 연도는 %04d, 나머지는 %02d로 쓴다.
 // 실패는 aster_jni.c처럼 RangeError('Invalid timezone/date')다. 시각은 JS_ToInt64처럼 NaN·무한대를 0으로 바꾼다.
 const host=`globalThis.hostCalls=[];
 globalThis.asterZonedParts=function(time,zone){
  hostCalls.push([time,zone]);time=Number.isFinite(time)?Math.trunc(time):0;
  const offset={'asia/seoul':540,'utc':0,'ut':0,'etc/gmt+12':-720,'etc/gmt-14':840}[String(zone).toLowerCase()];
  if(offset===undefined)throw new RangeError('Invalid timezone/date');
  const local=new Date(time+offset*60000),pad=(value,width)=>String(value).padStart(width,'0');
  const values=[pad(local.getUTCFullYear(),4),pad(local.getUTCMonth()+1,2),pad(local.getUTCDate(),2),pad(local.getUTCHours(),2),pad(local.getUTCMinutes(),2),pad(local.getUTCSeconds(),2)];
  return JSON.parse(JSON.stringify(['year','month','day','hour','minute','second'].map((type,index)=>({type,value:values[index]}))));
 };`;
 const {run}=bundleContext(host+shim[1]);
 run(`nativeInit(0,{series:[]})`);
 const calls=()=>JSON.parse(run('JSON.stringify(hostCalls)'));
 for(const zone of ['Z','UTC+9','UT'])assert.throws(()=>run(setSymbolSource(zone)),unsupported(zone),zone);
 assert.deepEqual(calls(),[],'host-only names never reach java.time');
 run(setSymbolSource('+09:00'));assert.deepEqual(calls(),[],'fixed offsets never reach java.time');
 run(setSymbolSource('asia/seoul'));
 assert.ok(calls().length>0&&calls().every(([time,zone])=>time===0&&zone==='asia/seoul'),'original spelling reaches the host');
 assert.equal(run(`JSON.stringify(Aster.zonedParts(${NY_OPEN},'asia/seoul'))`),JSON.stringify(zonedParts(NY_OPEN,'Asia/Seoul')),'shim result equals genuine Intl');
 const before=calls().length;
 assert.throws(()=>run(`Aster.zonedParts(NaN,'Asia/Seoul')`),{name:'RangeError',message:'Time zone conversion requires a finite time'});
 assert.equal(calls().length,before,'non-finite time is rejected before JS_ToInt64 could map it to 1970');
 assert.throws(()=>run(`Aster.zonedParts(${YEAR_1000},'Etc/GMT+12')`),YEAR_OUT_OF_RANGE,'host year 0999 is rejected');
 assert.equal(run(`JSON.stringify(Aster.zonedParts(${YEAR_1000},'Etc/GMT-14'))`),partsJSON('1000','01','01','14','00','00'));
 assert.equal(run(`(()=>{try{Aster.zonedParts(0,'Foo/Bar');}catch(error){return [error.name,error.message,error.cause&&error.cause.message].join('|');}})()`),'RangeError|Unsupported time zone: Foo/Bar|Invalid timezone/date');
});
