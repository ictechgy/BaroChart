// Rust JS 의미 커널 대조 하네스(M1 계획 Task 4, 설계 §6.4·§6.5, 이식 지도 §3.1·§5).
// 시드를 고정한 생성기로 작업 코퍼스를 만들고, 같은 작업을 JS 엔진의 내장 함수(V8은 이 Node, 삼각측량은 JSC·QuickJS)로
// 계산한 기대값과 Rust 커널(rust/tools/conformance의 bc-conformance)의 결과를 비교한다. 첫 불일치 20건과 요약을 출력한다.
//
// 작업 형식(JSONL 한 줄 = 작업 하나, bc-conformance와 같은 계약):
// - op: 연산 이름(SUITE_OPS)
// - x, y, t: IEEE-754 비트를 16진 16자리(빅엔디언)로 쓴 수. xs, args는 그런 16진의 배열이다
// - d, p, start, end, unit, year, month, day, days: 정수. toExponential의 d와 slice의 end는 없으면 undefined다
// - text: UTF-8 바이트의 16진. 원문에는 단독 서로게이트를 넣지 않는다(\uXXXX 이스케이프로만 넣는다)
// - units: UTF-16 코드 단위마다 16진 네 자리(단독 서로게이트도 담는다). jsonUnits는 이 형식으로 JS 문자열 원문을 보내
//   문자열 안의 원문 단독 서로게이트까지 시험한다(커널 parse_json_utf16)
// - carrier: jsonLossless에서 오라클만 읽는 표준 JSON. 같은 텍스트에서 특수 값만 표지 객체로 바꿨다
// 결과는 정규 문자열이다. 수는 NaN이면 'NaN', 아니면 16진 비트다(설계 §6.2: Object.is 기준, NaN만 정규화).
// 문자열·JSON은 16진, 정수는 십진, 불리언은 'true'/'false', 오류는 'E:<이름>'이다. 커널 결과 줄은 {"r":"..."}이고,
// 숫자를 쓰는 연산의 QuickJS 방언(Android 빌드) 결과가 다르면 {"r":"...","q":"..."}다(커널 NumberDialect, 리뷰 C1).
//
// 판정(설계 §6.1: 오라클은 같은 플랫폼의 JS 백엔드):
// - 엔진마다 그 플랫폼의 커널 결과와 비교한다. V8(WASM 하네스)·JSC(iOS)는 r, QuickJS(Android)는 q(없으면 r)다.
//   엔진끼리 값이 달라도 판정을 건너뛰지 않는다. 엔진 차이는 따로 세고 예시를 남긴다.
// - 알려진 엔진 차이(KNOWN_DIVERGENCES)는 정해진 엔진과의 비교에서, 커널이 문서화한 쪽으로 답했을 때만 뺀다.
//   어느 엔진과도 비교하지 못한 작업만 제외(excluded)로 센다. 그 밖의 차이는 모두 불일치다.
// - 오라클을 돌리지 못한 엔진('!oracle-error')과, 비교한 작업이 하나도 없는 스위트는 하네스 오류(종료 코드 2)다.
// - 엔진마다 다른 Math.log/exp/hypot(설계 §6.3)은 코퍼스에 넣지 않는다. WASM 하네스(Task 9)가 V8 값을 주입해 맞춘다.
//
// 사용법: node scripts/rust/conformance.mjs [--count N] [--seed S] [--suite LIST] [--engines LIST] [--report PATH]
//         [--work-dir DIR] [--binary PATH] [--emit-corpus]
// 환경 변수: JSC_PATH(JavaScriptCore 셸), QUICKJS_HOST_PATH(미리 빌드한 QuickJS 호스트, 없으면 저장소 QuickJS로 빌드), CC
// 종료 코드: 0 불일치 없음, 1 불일치 있음, 2 인자·환경·하네스 오류
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {arch,platform,release,tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {WORKSPACE,cargoEnvironment,rustupBinDirectory} from './cargo.mjs';

/** 저장소 루트 */
const ROOT=fileURLToPath(new URL('../../',import.meta.url));

/** 스위트 이름(실행 순서) */
export const SUITES=Object.freeze(['number','fixed','precision','exponential','round','json','string','date']);

/** 스위트 → 연산. 작업은 색인 순서로 연산을 돌아가며 고르므로 모든 연산이 고루 나온다 */
export const SUITE_OPS=Object.freeze({
 number:['toString'],
 fixed:['toFixed'],
 precision:['toPrecision'],
 exponential:['toExponential'],
 round:['round','sign','max','min','toInt32','toUint32','objectIs'],
 json:['json','jsonLossless','jsonUnits'],
 string:['trim','toLowerCase','slice','length','isWhitespace','quote'],
 date:['dateUtc','timeClip','toISOString','daysFromCivil','civilFromDays','parseIsoDate','parseIsoClock'],
});

/**
 * 숫자 스위트의 값 원천(M1 계획 Task 4: 무작위 비트, 짧은 소수, 정확한 동률, 2^53 근처, 1e21·1e-7 경계, 부분정규수, 가격형 소수,
 * 그리고 ±2^n 전부를 도는 2의 거듭제곱 스윕과 그 이웃(리뷰 C2))
 */
export const NUMBER_SOURCES=Object.freeze(['randomBits','shortDecimal','exactTie','near2p53','boundary','subnormal','priceDecimal','special','powerOfTwo']);

/** jsonLossless의 carrier에서 특수 값(NaN, ±Infinity, undefined)을 나타내는 표지 객체의 키. 생성기의 키(4단위 이하)와 겹치지 않는다 */
export const SENTINEL_KEY='\u0000bc:special';

/** 기대값을 낼 수 있는 엔진. v8은 이 Node이고 늘 기준이다 */
export const ENGINES=Object.freeze(['v8','jsc','quickjs']);

/** 알려진 엔진 차이: 이유 → 설명. 커널이 문서화한 쪽으로 답한 경우만 판정에서 뺀다 */
export const KNOWN_DIVERGENCES=Object.freeze({
 'date-utc-folded-year':'Date.UTC whose month-folded year lies outside -271821..275760: the kernel returns NaN like QuickJS, while V8 and JSC still compute a value when large time fields bring it back into range (M1 Task 3 ruling; applies to the v8 and jsc comparisons)',
 'unicode-version':'toLowerCase input with code points that this Node treats as unassigned: Node and the kernel use different Unicode versions, so newer case mappings and casing properties differ (applies to the v8 comparison)',
});

/** 기본값: 스위트마다 작업 1만 건, 시드 1, 모든 스위트, V8만 */
const DEFAULTS=Object.freeze({count:10000,seed:1});

/** 출력과 보고서에 남기는 예시 수(불일치·제외·엔진 차이 각각) */
const EXAMPLE_LIMIT=20;

/** 보고서 스키마 이름 */
const REPORT_SCHEMA='barochart.rust-js-kernel-conformance';

/**
 * 보고서 판. 2: 삼각측량에서 엔진마다 그 플랫폼의 커널 결과와 비교하고(byEngine), excluded는 어느 엔진과도 비교하지
 * 못한 작업만 센다(판 1은 엔진 차이를 판정 없이 제외했다).
 */
const REPORT_VERSION=2;

/** macOS 시스템 JavaScriptCore 셸 */
const DEFAULT_JSC='/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc';

/** Android 백엔드와 같은 QuickJS 소스(저장소에 들어 있다) */
const QUICKJS_DIR=join(ROOT,'native/android/quickjs');

/** QuickJS로 대조 스크립트를 실행하는 호스트 소스 */
const QUICKJS_HOST=join(ROOT,'rust/tools/conformance/quickjs-host.c');

/** QuickJS 엔진 소스(scripts/test-quickjs-cloud.mjs와 같은 묶음) */
const QUICKJS_SOURCES=Object.freeze(['quickjs','dtoa','libregexp','libunicode','cutils']);

/** 한 번에 기대값을 계산해 커널에 보내는 작업 수. 삼각측량은 엔진 프로세스를 덜 띄우려고 크게 잡는다 */
const BATCH_SIZE=Object.freeze({v8:4096,engines:20000});

/** CLI 사용법 */
const USAGE=[
 'Usage: node scripts/rust/conformance.mjs [options]',
 '  --count N        tasks per suite (default 10000)',
 '  --seed S         corpus seed, a non-negative integer (default 1)',
 `  --suite LIST     comma-separated ${SUITES.join('|')}|all (default all)`,
 '  --engines LIST   comma-separated v8,jsc,quickjs; v8 is required (default v8)',
 '  --report PATH    merge the run summary into a JSON report',
 '  --work-dir DIR   engine scripts and the QuickJS host build (default <tmp>/barochart-conformance)',
 '  --binary PATH    use this bc-conformance instead of building it with cargo',
 '  --emit-corpus    print the task lines and exit (no cargo, no engines)',
 'Environment: JSC_PATH (JavaScriptCore shell), QUICKJS_HOST_PATH (prebuilt QuickJS host; default builds',
 '  rust/tools/conformance/quickjs-host.c with the repository QuickJS), CC (C compiler for that build)',
].join('\n');

/** 인자가 잘못됐을 때 던진다(종료 코드 2, 사용법을 함께 보인다) */
class UsageError extends Error{}

/** 환경·도구·하네스가 실패했을 때 던진다(종료 코드 2) */
class HarnessError extends Error{}

/** 비트 변환용 8바이트 버퍼(생성기와 표시용, Node 안에서만 쓴다) */
const scratch=new DataView(new ArrayBuffer(8));

/** 짧은 소수·경계에 쓰는 특수 값 */
const SPECIAL_NUMBERS=Object.freeze([
 0,-0,NaN,Infinity,-Infinity,5e-324,-5e-324,1.7976931348623157e308,-1.7976931348623157e308,2.2250738585072014e-308,2.225073858507201e-308,
 1,-1,0.1,0.5,-0.5,1.5,-1.5,2.5,-2.5,0.49999999999999994,-0.49999999999999994,4503599627370497,4503599627370495.5,9007199254740993,
 123456789012344.5,0.125,1.005,8.345,1e21,999999999999999900000,1e-7,1e-6,123456789012345680000,0.30000000000000004,
 4294967296.5,2147483648,-2147483649,4294967295,-4294967296,1e300,-1e-300,
]);

/** 표기·반올림 규칙이 바뀌는 경계(1e21: toFixed와 toString, 1e-7·1e-6: toString 지수 표기, 10^p: toPrecision) */
const BOUNDARIES=Object.freeze([1e21,1e-7,1e-6,1e20,5e-7,9.5,99.5,0.5,1,1e15,1e16,1e17,999999.5,1e-5,1e22,100,1000,1e-300,1e300,2**-1022,2**53,2**31]);

/** 2^53 근처와 정수 변환(ToInt32·ToUint32) 경계 */
const POWERS_NEAR_2P53=Object.freeze([2**53,2**53,2**52,2**52,2**31,2**32,2**63,2**30]);

/** Math.max·min에 섞는 값(NaN 전파, -0 < +0, 무한대) */
const EXTREMA_PROBES=Object.freeze([0,-0,NaN,Infinity,-Infinity,1,-1,5e-324,-5e-324]);

/** 문자열에 섞는 코드 단위: JS 공백 표와 그 경계, 대소문자 특례(Kelvin, final sigma, İ), 제어 문자, 단독 서로게이트 */
const STRING_UNITS=Object.freeze([
 0x61,0x62,0x7a,0x41,0x5a,0x30,0x39,0x20,0x09,0x0a,0x0d,0x0b,0x0c,0x22,0x5c,0x2f,0x00,0x01,0x1f,0x7f,0x80,0x85,0xa0,0xad,0xe9,0xc9,
 0x130,0x131,0x391,0x3a3,0x3c3,0x3c2,0x39f,0x394,0x2e,0x27,0x301,0x345,0x1e9e,0x3f4,0x212a,0x2126,0x212b,0x180e,0x200b,0x2028,0x2029,
 0x3000,0xfeff,0x1680,0x2000,0x200a,0x202f,0x205f,0xfffd,0xff21,0x10a0,0x1c90,0xd800,0xdbff,0xdc00,0xdfff,0x5f,0x2d,
]);

/** 문자열에 섞는 보충 평면 문자(대소문자가 있는 Deseret·Adlam·Medefaidrin 포함) */
const SUPPLEMENTARY=Object.freeze([0x1f600,0x10400,0x10428,0x1d400,0x10ffff,0x1e900,0x16e40,0x10c80,0x118a0]);

/** JSON 객체 키: 배열 인덱스 키와 그 경계('4294967295'는 일반 키), __proto__, 비ASCII, 빈 키 */
const KEYS=Object.freeze(['a','b','c','0','1','2','10','01','00','-0','-1','1.5','4294967294','4294967295','4294967296','__proto__','constructor','toString','é','😀','',' 1','9','1e3','+1','\u00a0','\ud800']);

/** isWhitespace 시험 단위: JS 공백 표 전부와 공백이 아닌 이웃(U+0085, U+180E, U+200B 등) */
const WHITESPACE_PROBES=Object.freeze([
 0x09,0x0a,0x0b,0x0c,0x0d,0x20,0xa0,0x1680,0x2000,0x2001,0x2002,0x2003,0x2004,0x2005,0x2006,0x2007,0x2008,0x2009,0x200a,
 0x2028,0x2029,0x202f,0x205f,0x3000,0xfeff,0x85,0x180e,0x200b,0x200c,0x200d,0x2060,0xfffe,0x08,0x0e,0x1f,0x21,0x9f,0xa1,
 0x167f,0x1681,0x1fff,0x2027,0x202a,0x202e,0x2030,0x205e,0x2fff,0x3001,0xfefe,0xff00,
]);

/** 짧은 JSON 이스케이프 */
const SHORT_ESCAPES=Object.freeze({8:'\\b',9:'\\t',10:'\\n',12:'\\f',13:'\\r'});

/** JSON 공백(SP·TAB·LF·CR) 조각 */
const JSON_SPACES=Object.freeze([' ','\t','\n','\r','  ','\r\n']);

/** JSON 변형에 넣는 조각: 문법 문자와 JSON이 받지 않는 공백(VT, NBSP, BOM, NEL, U+2028) */
const JSON_NOISE=Object.freeze(['',',',']','}','[','{','"',':','x','-','.','e','0','1',' ','\\','tru','nul','NaN','undefined','\u000b','\u00a0','\ufeff','\u0085','\u2028','\t']);

/** jsonUnits 변형 조각: JSON_NOISE에 원문 단독 서로게이트(상위·하위)를 더한다. UTF-8 텍스트로는 나타낼 수 없는 입력이다 */
const JSON_UNITS_NOISE=Object.freeze([...JSON_NOISE,'\ud83d','\ude00','\udbff']);

/**
 * 정확한 반올림·넘침·-0을 시험하는 수 표기. 뒤의 일곱 개는 명시 지수가 6자리 이상이라 커널이 dec2flt 대신
 * 정규화 경로로 읽는 표기다(지수 포화, 앞의 0, 넘침·밑넘침 경계). 자릿수로 지수를 상쇄하는 긴 표기(수십만 자)는
 * 코퍼스에 넣기에 커서 tests/json.rs의 고정 벡터가 맡는다.
 */
const NUMBER_SPELLINGS=Object.freeze([
 '1e400','-1e400','1e-400','-1e-400','-0','-0.0','0e0','-0E+5','0.0','1E2','1e+2','1e-2','123456789012345678901234567890','0.1e1',
 '9007199254740993','4.9406564584124654e-324','2.4703282292062327e-324','2.4703282292062328e-324','1.7976931348623158e308','1.7976931348623159e308',
 '1e100000','-1e-100000','0.000001e1000000','-0e-1000000','123e-999999','1e+0000000000100000','-2.5E+0654321',
]);

/** ISO 날짜·시각 변형에 넣는 조각: 다른 구분자, ASCII가 아닌 숫자(아랍-인도 ٣, 전각 ３, 수학 𝟎), 공백 */
const ISO_NOISE=Object.freeze(['/',' ','\u0663','\uff13','a','-','+',':','0','9','\u00a0','\u{1d7ce}','T','Z','\n']);

/**
 * 시드와 이름에서 32비트 난수 흐름(sfc32)을 만든다. 정수 연산만 써서 어느 기계에서나 같은 수열이다.
 * @param {number} seed 0 이상의 안전한 정수
 * @param {string} label 흐름 이름(스위트 이름). 스위트마다 독립된 흐름이라 고른 스위트와 무관하게 작업이 같다
 * @returns {{uint32: () => number, float: () => number, int: (n: number) => number, range: (low: number, high: number) => number,
 *   chance: (p: number) => boolean, pick: <T>(list: readonly T[]) => T, digits: (n: number) => string}} 난수 도구
 */
export function createRandom(seed,label){
 let a=seed>>>0,b=Math.floor(seed/4294967296)>>>0,c=0x811c9dc5,d=0x9e3779b9;
 for(let index=0;index<label.length;index++)c=Math.imul(c^label.charCodeAt(index),0x01000193)>>>0;
 const uint32=()=>{const t=(a+b|0)+d|0;d=d+1|0;a=b^b>>>9;b=c+(c<<3)|0;c=c<<21|c>>>11;c=c+t|0;return t>>>0;};
 for(let index=0;index<16;index++)uint32();
 const float=()=>uint32()/4294967296,int=n=>Math.floor(float()*n);
 const digits=n=>{let text='';for(let index=0;index<n;index++)text+=String.fromCharCode(48+int(10));return text;};
 return {uint32,float,int,range:(low,high)=>low+int(high-low+1),chance:p=>float()<p,pick:list=>list[int(list.length)],digits};
}

/**
 * 32비트 정수를 16진 8자리로 쓴다.
 * @param {number} value 부호 없는 32비트 정수
 * @returns {string} 16진
 */
const hex8=value=>value.toString(16).padStart(8,'0');

/**
 * 수의 IEEE-754 비트를 16진 16자리(빅엔디언)로 쓴다.
 * @param {number} value 수
 * @returns {string} 16진 비트
 */
export function bitsHex(value){
 scratch.setFloat64(0,value);
 return hex8(scratch.getUint32(0))+hex8(scratch.getUint32(4));
}

/**
 * 16진 비트를 수로 읽는다(표시와 분류용).
 * @param {string} hex 16진 16자리
 * @returns {number} 수
 */
function numberFromBits(hex){
 scratch.setBigUint64(0,BigInt(`0x${hex}`));
 return scratch.getFloat64(0);
}

/**
 * 16진 비트에 정수를 더한다(비트 공간에서 ulp만큼 옮기기, 2^64로 감는다).
 * @param {string} hex 16진 16자리
 * @param {number} delta 더할 정수
 * @returns {string} 16진 비트
 */
function shiftBits(hex,delta){
 return BigInt.asUintN(64,BigInt(`0x${hex}`)+BigInt(delta)).toString(16).padStart(16,'0');
}

/**
 * 부호를 뒤집은 비트(NaN도 비트로 뒤집는다).
 * @param {string} hex 16진 16자리
 * @returns {string} 16진 비트
 */
const flipSign=hex=>(parseInt(hex[0],16)^8).toString(16)+hex.slice(1);

/**
 * 부호 인자: 절반은 -1이다.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @returns {number} 1 또는 -1
 */
const signFactor=random=>random.chance(0.5)?-1:1;

/**
 * 비트에서 만든 값 원천. 비트가 정본이라 신호 NaN 페이로드도 그대로 커널에 간다.
 * @param {number} high 위 32비트
 * @param {number} low 아래 32비트
 * @returns {{bits: string, value: number}} 원천 값
 */
function wordsSource(high,low){
 const bits=hex8(high>>>0)+hex8(low>>>0);
 return {bits,value:numberFromBits(bits)};
}

/**
 * 수에서 만든 값 원천.
 * @param {number} value 수
 * @param {object} [extra] 동률 자리(tie)나 가격 소수 자릿수(price) 같은 자릿수 힌트
 * @returns {{bits: string, value: number}} 원천 값
 */
const valueSource=(value,extra={})=>({bits:bitsHex(value),value,...extra});

/**
 * 정수 동률: ...d5(뒤에 0) 꼴의 2^53 미만 정수. toPrecision(앞자리 수)와 toExponential(앞자리 수 - 1)이 정확한 동률이다.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @returns {object} 원천 값
 */
function integerTie(random){
 const zeros=random.range(0,2),head=`${random.range(1,9)}${random.digits(random.range(0,12-zeros))}`;
 const value=Number(`${head}5${'0'.repeat(zeros)}`)*signFactor(random);
 return valueSource(value,{tie:{precision:head.length,exponential:head.length-1}});
}

/**
 * 소수 동률: m + j/2^k(j는 홀수)라 십진 전개가 정확히 k자리이고 마지막 자리가 5다. 2^53 미만이라 정확하다.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @returns {object} 원천 값(toFixed(k-1), toPrecision(n-1), toExponential(n-2)이 동률)
 */
function fractionTie(random){
 const scale=random.range(1,20),odd=2*random.int(2**(scale-1))+1,whole=random.int(2**Math.min(31,52-scale));
 const value=(whole+odd/2**scale)*signFactor(random);
 const significant=Math.abs(value).toFixed(scale).replace('.','').replace(/^0+/,'').length;
 return valueSource(value,{tie:{fixed:scale-1,precision:significant-1,exponential:significant-2}});
}

/**
 * 경계 값: 고정 경계나 10^k(정확히 반올림한 십진 파싱)에서 ±4 ulp 안.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @returns {number} 경계 근처의 양수
 */
function boundaryValue(random){
 const exponent=random.chance(0.5)?random.range(-10,25):random.range(-320,308);
 const base=random.chance(0.6)?random.pick(BOUNDARIES):Number(`1e${exponent}`);
 return numberFromBits(shiftBits(bitsHex(base),random.range(-4,4)));
}

/**
 * 가격형 소수: 소수 2~8자리. toFixed 자릿수를 그 자리 근처로 고르는 힌트를 함께 준다.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @returns {object} 원천 값
 */
function priceSource(random){
 const fraction=random.range(2,8),whole=String(random.int(10**random.range(1,7)));
 return valueSource(Number(`${random.chance(0.2)?'-':''}${whole}.${random.digits(fraction)}`),{price:fraction});
}

/** 2의 거듭제곱 지수의 개수: 부분정규수 2^-1074부터 2^1023까지 */
const POWER_OF_TWO_COUNT=2098;

/** 지수를 도는 보폭. 2098(= 2 × 1049)과 서로소라 2098번에 모든 지수를 한 번씩 지나고, 작은 코퍼스에서도 범위 전체에 퍼진다 */
const POWER_OF_TWO_STRIDE=1021;

/**
 * 2의 거듭제곱 원천: 순번 셋마다 지수 하나를 맡아 +2^n, -2^n, ±1~2 ulp 이웃(부호 무작위)을 낸다. 순번 3 × 2098개면 ±2^n 전부를 지난다.
 * 무작위 비트로는 가수 0인 정규수가 나올 확률이 2^-52라 QuickJS가 최단이 아닌 자릿수를 쓰는 108값(커널 NumberDialect)이
 * 어느 시드에도 들지 않았다(리뷰 C2). 숫자 스위트는 원천마다의 순번으로 결정적으로 돌고, 순번이 없는 곳(round·json)은 무작위 순번을 쓴다.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {number} [ordinal] 이 원천의 순번(스위트 안에서 이 원천이 나온 차례)
 * @returns {object} 원천 값
 */
function powerOfTwoSource(random,ordinal=random.int(3*POWER_OF_TWO_COUNT)){
 const exponent=-1074+(Math.floor(ordinal/3)*POWER_OF_TWO_STRIDE)%POWER_OF_TWO_COUNT,value=2**exponent;
 if(ordinal%3===0)return valueSource(value);
 if(ordinal%3===1)return valueSource(-value);
 // 가장 작은 두 부분정규수 아래로는 0을 지나 음수 비트로 감기므로 위쪽 이웃만 쓴다
 const step=random.range(1,2),below=exponent>-1073&&random.chance(0.5),neighbor=shiftBits(bitsHex(value),below?-step:step);
 const bits=random.chance(0.5)?flipSign(neighbor):neighbor;
 return {bits,value:numberFromBits(bits)};
}

/** 값 원천 이름 → 생성기(random, 순번). 순번은 숫자 스위트만 넘기고 powerOfTwo만 쓴다 */
const SOURCE_GENERATORS=Object.freeze({
 randomBits:random=>wordsSource(random.uint32(),random.uint32()),
 shortDecimal:random=>valueSource(Number(`${random.chance(0.5)?'-':''}${random.digits(random.range(1,6))}e${random.range(-25,25)}`)),
 exactTie:random=>random.chance(0.3)?integerTie(random):fractionTie(random),
 near2p53:random=>valueSource((random.pick(POWERS_NEAR_2P53)+random.range(-8,8)+random.pick([0,0,0.5,0.25]))*signFactor(random)),
 boundary:random=>valueSource(boundaryValue(random)*signFactor(random)),
 subnormal:random=>wordsSource(random.uint32()&0x800fffff,random.uint32()),
 priceDecimal:priceSource,
 special:random=>valueSource(random.pick(SPECIAL_NUMBERS)),
 powerOfTwo:powerOfTwoSource,
});

/**
 * 자릿수 인자: 85%는 흔한 범위, 15%는 JS 상한 100까지.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {number} low 하한(toPrecision은 1)
 * @returns {number} 자릿수
 */
const digitsIn=(random,low)=>random.chance(0.85)?random.range(low,20):random.range(low,100);

/**
 * toFixed 자릿수: 동률 자리, 가격 소수 자리 근처, 또는 무작위.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {object} source 값 원천
 * @returns {number} 자릿수
 */
function fixedDigits(random,source){
 if(source.tie?.fixed!==undefined&&random.chance(0.5))return source.tie.fixed;
 if(source.price!==undefined&&random.chance(0.5))return source.price-random.int(2);
 return digitsIn(random,0);
}

/**
 * toPrecision 유효 숫자: 동률 자리 또는 무작위.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {object} source 값 원천
 * @returns {number} 유효 숫자
 */
function precisionDigits(random,source){
 if(source.tie?.precision>=1&&random.chance(0.5))return source.tie.precision;
 return digitsIn(random,1);
}

/**
 * toExponential 자릿수: 20%는 undefined(최단 자릿수), 그 밖에는 동률 자리 또는 무작위.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {object} source 값 원천
 * @returns {number|undefined} 자릿수
 */
function exponentialDigits(random,source){
 if(random.chance(0.2))return undefined;
 if(source.tie?.exponential>=0&&random.chance(0.5))return source.tie.exponential;
 return digitsIn(random,0);
}

/**
 * 숫자 스위트 작업 하나. 값 원천은 색인 순서로 돌아가며 고르고, 그 원천의 순번(색인 ÷ 원천 수)을 함께 넘긴다.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {number} index 스위트 안 색인
 * @param {(source: object) => object} build 원천 값 → 작업
 * @returns {{source: string, task: object}} 작업
 */
function numberCase(random,index,build){
 const name=NUMBER_SOURCES[index%NUMBER_SOURCES.length];
 return {source:name,task:build(SOURCE_GENERATORS[name](random,Math.floor(index/NUMBER_SOURCES.length)))};
}

/**
 * Object.is 비교 상대: 같은 비트, 부호 반대, 1 ulp 옆, 다른 NaN, ±0, 무작위.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {object} source 값 원천
 * @returns {string} 16진 비트
 */
function partnerBits(random,source){
 const roll=random.float();
 if(roll<0.4)return source.bits;
 if(roll<0.55)return flipSign(source.bits);
 if(roll<0.7)return shiftBits(source.bits,random.chance(0.5)?1:-1);
 if(roll<0.85)return random.pick(['7ff8000000000000','fff8000000000000','7ff0000000000001','7ff8000000000001','0000000000000000','8000000000000000']);
 return SOURCE_GENERATORS.randomBits(random).bits;
}

/**
 * round 스위트 작업 하나: Math.round/sign/max/min, ToInt32/ToUint32, Object.is.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {number} index 스위트 안 색인
 * @returns {{source: string, task: object}} 작업
 */
function roundCase(random,index){
 const op=SUITE_OPS.round[index%SUITE_OPS.round.length],name=NUMBER_SOURCES[index%NUMBER_SOURCES.length];
 const source=SOURCE_GENERATORS[name](random);
 if(op==='max'||op==='min'){
  const xs=[];
  for(let position=random.range(0,4);position>0;position--)xs.push(!xs.length?source.bits:random.chance(0.6)?SOURCE_GENERATORS[name](random).bits:bitsHex(random.pick(EXTREMA_PROBES)));
  return {source:name,task:{op,xs}};
 }
 if(op==='objectIs')return {source:name,task:{op,x:source.bits,y:partnerBits(random,source)}};
 return {source:name,task:{op,x:source.bits}};
}

/**
 * 무작위 UTF-16 문자열: 특수 단위, 임의 BMP 단위(단독 서로게이트 포함), 보충 평면 문자를 섞는다.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {number} maxLength 최대 길이(문자 수)
 * @returns {string} 문자열
 */
function randomUnits(random,maxLength){
 let text='';
 for(let left=random.range(0,maxLength);left>0;left--){
  const roll=random.float();
  if(roll<0.1)text+=String.fromCodePoint(random.pick(SUPPLEMENTARY));
  else if(roll<0.14)text+=String.fromCodePoint(0x10000+random.int(0x100000));
  else if(roll<0.29)text+=String.fromCharCode(random.int(0x10000));
  else text+=String.fromCharCode(random.pick(STRING_UNITS));
 }
 return text;
}

/**
 * 공백 표의 단위와 그 이웃으로 만든 짧은 문자열(trim 앞뒤에 붙인다).
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @returns {string} 0~3단위
 */
function whitespaceRun(random){
 let text='';
 for(let left=random.range(0,3);left>0;left--)text+=String.fromCharCode(random.pick(WHITESPACE_PROBES));
 return text;
}

/**
 * 문자열을 UTF-16 코드 단위 16진으로 쓴다.
 * @param {string} text 문자열(단독 서로게이트 허용)
 * @returns {string} 16진
 */
function unitsHex(text){
 let hex='';
 for(let index=0;index<text.length;index++)hex+=text.charCodeAt(index).toString(16).padStart(4,'0');
 return hex;
}

/**
 * UTF-16 코드 단위 16진을 문자열로 읽는다(표시와 분류용).
 * @param {string} hex 16진
 * @returns {string} 문자열
 */
function unitsFromHex(hex){
 const units=[];
 for(let index=0;index<hex.length;index+=4)units.push(parseInt(hex.slice(index,index+4),16));
 return String.fromCharCode(...units);
}

/**
 * 올바른 UTF-16 문자열을 UTF-8 바이트 16진으로 쓴다. 단독 서로게이트는 UTF-8로 나타낼 수 없으므로 생성기 버그다.
 * @param {string} text 문자열
 * @returns {string} 16진 바이트
 * @throws {Error} 단독 서로게이트가 있을 때
 */
function utf8Hex(text){
 if(!text.isWellFormed())throw new Error(`corpus generator put a raw lone surrogate in ${JSON.stringify(text)}; write lone surrogates as \\uXXXX escapes`);
 return Buffer.from(text,'utf8').toString('hex');
}

/**
 * slice 위치: 대개 작은 정수, 가끔 아주 큰 값(범위 밖 자르기).
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @returns {number} 정수
 */
const sliceIndex=random=>random.chance(0.9)?random.range(-15,15):random.pick([-(2**31),2**31,-(2**53),2**53,1e6,-1e6]);

/**
 * string 스위트 작업 하나: trim, toLowerCase, slice, length, 공백 판정, JSON.stringify(문자열).
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {number} index 스위트 안 색인
 * @returns {{source: string, task: object}} 작업
 */
function stringCase(random,index){
 const op=SUITE_OPS.string[index%SUITE_OPS.string.length];
 if(op==='isWhitespace')return {source:'unit',task:{op,unit:random.chance(0.5)?random.pick(WHITESPACE_PROBES):random.int(0x10000)}};
 const units=unitsHex(op==='trim'?`${whitespaceRun(random)}${randomUnits(random,8)}${whitespaceRun(random)}`:randomUnits(random,12));
 if(op!=='slice')return {source:'units',task:{op,units}};
 const start=sliceIndex(random),end=random.chance(0.3)?undefined:sliceIndex(random);
 return {source:'units',task:end===undefined?{op,units,start}:{op,units,start,end}};
}

/**
 * JSON 공백: 대개 없고, 가끔 SP·TAB·LF·CR 조각.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @returns {string} 공백
 */
const jsonSpace=random=>random.chance(0.75)?'':random.pick(JSON_SPACES);

/**
 * \uXXXX 이스케이프(16진 대소문자는 무작위).
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {number} unit 코드 단위
 * @returns {string} 이스케이프
 */
function escapeUnit(random,unit){
 const hex=unit.toString(16).padStart(4,'0');
 return `\\u${random.chance(0.5)?hex.toUpperCase():hex}`;
}

/**
 * 서로게이트 쌍을 원문과 이스케이프로 섞어 쓴다(jsonUnits 전용). JS 문자열 원문에서는 원문 상위와 이스케이프한 하위가
 * 이어져도 쌍이 된다.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {number} high 상위 서로게이트
 * @param {number} low 하위 서로게이트
 * @returns {string} 토큰 조각
 */
function mixedPair(random,high,low){
 const roll=random.float();
 if(roll<0.7)return String.fromCharCode(high,low);
 if(roll<0.8)return escapeUnit(random,high)+escapeUnit(random,low);
 if(roll<0.9)return String.fromCharCode(high)+escapeUnit(random,low);
 return escapeUnit(random,high)+String.fromCharCode(low);
}

/**
 * JSON 문자열 토큰. 단독 서로게이트는 늘 이스케이프하고, 서로게이트 쌍은 둘 다 원문이거나 둘 다 이스케이프한다.
 * rawSurrogates(jsonUnits)면 단독 서로게이트를 절반은 원문으로 쓰고, 쌍은 원문·이스케이프를 섞는다.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {string} value 문자열 값
 * @param {boolean} [rawSurrogates] JS 문자열 원문(코드 단위)으로 보낼 텍스트인지
 * @returns {string} 따옴표를 포함한 토큰
 */
function stringToken(random,value,rawSurrogates=false){
 let out='"';
 for(let index=0;index<value.length;index++){
  const unit=value.charCodeAt(index),next=value.charCodeAt(index+1);
  if(rawSurrogates&&unit>=0xd800&&unit<=0xdbff&&next>=0xdc00&&next<=0xdfff){out+=mixedPair(random,unit,next);index++;}
  else if(rawSurrogates&&unit>=0xd800&&unit<=0xdfff)out+=random.chance(0.5)?String.fromCharCode(unit):escapeUnit(random,unit);
  else if(unit>=0xd800&&unit<=0xdbff&&next>=0xdc00&&next<=0xdfff){
   out+=random.chance(0.1)?escapeUnit(random,unit)+escapeUnit(random,next):value.slice(index,index+2);
   index++;
  }else if(unit>=0xd800&&unit<=0xdfff)out+=escapeUnit(random,unit);
  else if(unit===0x22)out+='\\"';
  else if(unit===0x5c)out+='\\\\';
  else if(unit<0x20)out+=random.chance(0.5)&&SHORT_ESCAPES[unit]?SHORT_ESCAPES[unit]:escapeUnit(random,unit);
  else if(unit===0x2f&&random.chance(0.5))out+='\\/';
  else if(random.chance(0.05))out+=escapeUnit(random,unit);
  else out+=value[index];
 }
 return `${out}"`;
}

/**
 * carrier의 특수 값 표지 객체 텍스트.
 * @param {string} token NaN, Infinity, -Infinity, undefined
 * @returns {string} 표준 JSON 객체 텍스트
 */
const sentinelText=token=>`{${JSON.stringify(SENTINEL_KEY)}:"${token}"}`;

/**
 * 41~60자리 가수: 정확한 반올림을 시험한다(QuickJS는 약 40자리 뒤를 버린다, M1 Task 3 판단).
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @returns {string} JSON 수 표기
 */
function longMantissa(random){
 const point=random.chance(0.5)?'.':'',exponent=random.chance(0.5)?`e${random.range(-30,30)}`:'';
 return `${random.chance(0.5)?'-':''}${random.range(1,9)}${point}${random.digits(random.range(40,59))}${exponent}`;
}

/**
 * 유한한 수의 JSON 표기: 최단 표기, 지수 표기(E 포함), 뒤에 0을 붙인 소수.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {number} value 유한한 수
 * @returns {string} JSON 수 표기
 */
function spellNumber(random,value){
 const plain=String(value),roll=random.float();
 if(roll<0.15)return value.toExponential();
 if(roll<0.25)return value.toExponential().replace('e','E');
 if(roll<0.3&&/^-?\d+\.\d+$/.test(plain))return `${plain}000`;
 return plain;
}

/**
 * JSON 수 토큰. Lossless는 NaN·Infinity·-Infinity 토큰도 쓴다(carrier에는 표지 객체).
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {boolean} lossless 무손실 텍스트인지
 * @returns {{text: string, carrier: string}} 텍스트와 carrier 조각
 */
function numberToken(random,lossless){
 const roll=random.float();
 if(lossless&&roll<0.15){const token=random.pick(['NaN','Infinity','-Infinity']);return {text:token,carrier:sentinelText(token)};}
 if(roll<0.3){const text=random.pick(NUMBER_SPELLINGS);return {text,carrier:text};}
 if(roll<0.36){const text=longMantissa(random);return {text,carrier:text};}
 const value=SOURCE_GENERATORS[random.pick(NUMBER_SOURCES)](random).value;
 const text=spellNumber(random,Number.isFinite(value)?value:random.range(-100,100));
 return {text,carrier:text};
}

/**
 * 객체 키: 대개 KEYS에서, 가끔 무작위 짧은 문자열.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @returns {string} 키
 */
const jsonKey=random=>random.chance(0.8)?random.pick(KEYS):randomUnits(random,4);

/**
 * 무작위 JSON 값 나무. 객체 항목은 텍스트 순서이고 중복 키를 허용한다.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {number} depth 남은 깊이
 * @param {boolean} lossless 무손실 값(undefined, NaN, ±Infinity)을 넣을지
 * @returns {object} 값 나무
 */
function jsonNode(random,depth,lossless){
 const roll=random.float();
 if(depth>0&&roll<0.2)return {kind:'array',items:Array.from({length:random.range(0,4)},()=>jsonNode(random,depth-1,lossless))};
 if(depth>0&&roll<0.4)return {kind:'object',entries:Array.from({length:random.range(0,5)},()=>[jsonKey(random),jsonNode(random,depth-1,lossless)])};
 if(roll<0.55)return {kind:'number',...numberToken(random,lossless)};
 if(roll<0.75)return {kind:'string',value:randomUnits(random,6)};
 if(lossless&&roll<0.82)return {kind:'undefined'};
 return {kind:'literal',text:random.pick(['true','false','null'])};
}

/**
 * 깊게 중첩한 값(20~400단계). 엔진이 모두 받는 깊이다(수천 단계부터는 엔진마다 다르게 실패한다, M1 Task 3 판단).
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {boolean} lossless 무손실 값을 넣을지
 * @returns {object} 값 나무
 */
function deepNode(random,lossless){
 let node=jsonNode(random,2,lossless);
 for(let level=random.range(20,400);level>0;level--)node=random.chance(0.5)?{kind:'array',items:[node]}:{kind:'object',entries:[[jsonKey(random),node]]};
 return node;
}

/**
 * 배열·객체를 텍스트와 carrier로 함께 쓴다. 공백 결정은 한 번만 해서 두 텍스트에 같이 쓴다.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {string} open 여는 괄호
 * @param {string} close 닫는 괄호
 * @param {(() => [string, string])[]} parts 항목 쓰기 함수
 * @returns {[string, string]} 텍스트와 carrier
 */
function renderContainer(random,open,close,parts){
 let text=open+jsonSpace(random),carrier=text;
 parts.forEach((render,position)=>{
  if(position){const comma=`${jsonSpace(random)},${jsonSpace(random)}`;text+=comma;carrier+=comma;}
  const [partText,partCarrier]=render();
  text+=partText;carrier+=partCarrier;
 });
 const tail=jsonSpace(random)+close;
 return [text+tail,carrier+tail];
}

/**
 * 값 나무를 JSON 텍스트(Lossless면 BCJSON)와 오라클용 carrier로 쓴다.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {object} node 값 나무
 * @param {boolean} [rawSurrogates] 문자열 토큰에 원문 단독 서로게이트를 쓸지(jsonUnits)
 * @returns {[string, string]} 텍스트와 carrier
 */
function renderJson(random,node,rawSurrogates=false){
 switch(node.kind){
  case 'number':return [node.text,node.carrier];
  case 'literal':return [node.text,node.text];
  case 'undefined':return ['undefined',sentinelText('undefined')];
  case 'string':{const text=stringToken(random,node.value,rawSurrogates);return [text,text];}
  case 'array':return renderContainer(random,'[',']',node.items.map(item=>()=>renderJson(random,item,rawSurrogates)));
  default:return renderContainer(random,'{','}',node.entries.map(([key,value])=>()=>{
   const name=stringToken(random,key,rawSurrogates),colon=`${jsonSpace(random)}:${jsonSpace(random)}`,[text,carrier]=renderJson(random,value,rawSurrogates);
   return [name+colon+text,name+colon+carrier];
  }));
 }
}

/**
 * 텍스트를 코드 포인트 경계에서 한 군데 바꾼다(지우기 또는 조각 넣기). 서로게이트 쌍을 가르지 않는다.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {string} text 원문
 * @param {readonly string[]} noise 넣을 조각
 * @returns {string} 바꾼 텍스트
 */
function mutate(random,text,noise){
 const points=Array.from(text),at=random.int(points.length+1);
 if(random.chance(0.4)&&at<points.length)points.splice(at,1);
 else points.splice(at,0,random.pick(noise));
 return points.join('');
}

/**
 * json 스위트 작업 하나. 넷 중 둘은 표준 JSON(UTF-8 바이트), 하나는 무손실(BCJSON) 왕복, 하나는 JS 문자열 원문
 * (코드 단위, 원문 단독 서로게이트 포함)이다. 표준·코드 단위는 30%를 변형해 오류도 시험한다.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {number} index 스위트 안 색인
 * @returns {{source: string, task: object}} 작업
 */
function jsonCase(random,index){
 const lossless=index%4===2,units=index%4===3,node=random.chance(0.02)?deepNode(random,lossless):jsonNode(random,4,lossless);
 const before=jsonSpace(random),[body,carrierBody]=renderJson(random,node,units),after=jsonSpace(random);
 if(lossless)return {source:'lossless',task:{op:'jsonLossless',text:utf8Hex(before+body+after),carrier:utf8Hex(before+carrierBody+after)}};
 if(units){
  const text=random.chance(0.3)?mutate(random,before+body+after,JSON_UNITS_NOISE):before+body+after;
  return {source:'units',task:{op:'jsonUnits',units:unitsHex(text)}};
 }
 const text=random.chance(0.3)?mutate(random,before+body+after,JSON_NOISE):before+body+after;
 return {source:'standard',task:{op:'json',text:utf8Hex(text)}};
}

/**
 * 고른 생성기를 불러 값을 얻는다(생성기 표에서 하나를 고르는 도우미).
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {(() => number)[]} choices 값 생성기
 * @returns {number} 값
 */
const oneOf=(random,choices)=>random.pick(choices)();

/**
 * Date.UTC 인자 일곱 개: 코어 범위(1000~9999년), 0~99년(1900 규칙), 시각 값 범위 경계, 소수, NaN, -0, 큰 보정.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @returns {number[]} 인자
 */
function dateUtcArgs(random){
 const fraction=()=>random.float();
 return [
  oneOf(random,[()=>random.range(1000,9999),()=>random.range(0,99),()=>random.range(1900,2100),()=>random.range(-271821,275760),()=>random.pick([-271822,-271821,-271820,275759,275760,275761])+random.range(-1,1),()=>random.range(-5,5)+fraction(),()=>NaN,()=>-0,()=>1e9]),
  oneOf(random,[()=>random.range(0,11),()=>random.range(-30,30),()=>random.range(-30,30)+fraction(),()=>-0,()=>random.range(-10000,10000),()=>random.range(-3300000,3300000)]),
  oneOf(random,[()=>random.range(1,31),()=>random.range(-40,40),()=>random.range(-40,40)+fraction(),()=>-0,()=>1e9,()=>random.range(-100000000,100000000)]),
  oneOf(random,[()=>0,()=>random.range(0,23),()=>random.range(-50,50),()=>random.range(-50,50)+fraction(),()=>-0,()=>Infinity,()=>random.range(-2400000000,2400000000)]),
  oneOf(random,[()=>0,()=>random.range(0,59),()=>random.range(-100,100)+fraction(),()=>random.range(-140000000000,140000000000)]),
  oneOf(random,[()=>0,()=>random.range(0,59),()=>random.range(-100,100)+fraction()]),
  oneOf(random,[()=>0,()=>random.range(0,999),()=>random.range(-2000,2000)+fraction(),()=>-0.5,()=>random.range(-8640000000000000,8640000000000000)]),
 ];
}

/**
 * 시각 값: 무작위 비트, 범위 안팎, 하루 경계, 음의 소수(0 쪽 버림), ±8.64e15와 그 바깥, 비유한 수.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @returns {string} 16진 비트
 */
function timeBits(random){
 if(random.chance(0.15))return SOURCE_GENERATORS.randomBits(random).bits;
 return bitsHex(oneOf(random,[
  ()=>(random.float()*2-1)*8.7e15,()=>random.range(-1000000,1000000)*86400000+random.range(0,86399999),()=>(random.float()*2-1)*1e13,
  ()=>random.pick([8.64e15,-8.64e15,8.64e15+1,-8.64e15-1,-0.5,-1.5,0,-0,NaN,Infinity,-Infinity,-62198755200000,253402300799999,253402300800000]),
  ()=>numberFromBits(shiftBits(bitsHex(8.64e15),random.range(-2,2)))*signFactor(random),
 ]));
}

/**
 * 0을 채운 십진수.
 * @param {number} value 0 이상의 정수
 * @param {number} width 자릿수
 * @returns {string} 텍스트
 */
const pad=(value,width)=>String(value).padStart(width,'0');

/**
 * M0 시간대 계약의 날짜 텍스트: 맞는 모양, 범위 밖 연·월·일, 윤일, 30%는 한 군데 변형.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @returns {string} 텍스트(올바른 UTF-16)
 */
function isoDateText(random){
 const year=random.chance(0.8)?random.range(1000,9999):random.pick([999,1000,9999,10000,0,1582,1900,2000,2024,2100]);
 const text=random.chance(0.2)?`${pad(random.pick([2024,2023,1900,2000,2100,1600,year]),4)}-02-29`:`${pad(year,4)}-${pad(random.range(0,13),2)}-${pad(random.range(0,32),2)}`;
 return random.chance(0.3)?mutate(random,text,ISO_NOISE):text;
}

/**
 * M0 시간대 계약의 시각 텍스트: HH:mm 또는 HH:mm:ss, 범위 밖 값, 30%는 한 군데 변형.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @returns {string} 텍스트(올바른 UTF-16)
 */
function isoClockText(random){
 const text=`${pad(random.range(0,25),2)}:${pad(random.range(0,60),2)}${random.chance(0.5)?`:${pad(random.range(0,60),2)}`:''}`;
 return random.chance(0.3)?mutate(random,text,ISO_NOISE):text;
}

/**
 * date 스위트 작업 하나: Date.UTC, TimeClip, toISOString, 그레고리력 변환, M0 계약 파서.
 * @param {ReturnType<typeof createRandom>} random 난수 도구
 * @param {number} index 스위트 안 색인
 * @returns {{source: string, task: object}} 작업
 */
function dateCase(random,index){
 const op=SUITE_OPS.date[index%SUITE_OPS.date.length];
 switch(op){
  case 'dateUtc':return {source:'utc',task:{op,args:dateUtcArgs(random).map(bitsHex)}};
  case 'timeClip':case 'toISOString':return {source:'time',task:{op,t:timeBits(random)}};
  case 'daysFromCivil':{
   const year=oneOf(random,[()=>random.range(1000,9999),()=>random.range(-100,100),()=>random.range(-271000,275000),()=>random.range(1582,1600)]);
   return {source:'civil',task:{op,year,month:random.range(0,24),day:random.range(0,62)}};
  }
  case 'civilFromDays':return {source:'days',task:{op,days:oneOf(random,[()=>random.range(-100000000,100000000),()=>random.range(-719833,2932896),()=>random.range(-5,5),()=>random.pick([-100000000,100000000,-99999999,99999999])])}};
  case 'parseIsoDate':return {source:'iso',task:{op,text:utf8Hex(isoDateText(random))}};
  default:return {source:'iso',task:{op,text:utf8Hex(isoClockText(random))}};
 }
}

/** 스위트 이름 → 작업 생성기 (random, index) → {source, task} */
const SUITE_GENERATORS=Object.freeze({
 number:(random,index)=>numberCase(random,index,source=>({op:'toString',x:source.bits})),
 fixed:(random,index)=>numberCase(random,index,source=>({op:'toFixed',x:source.bits,d:fixedDigits(random,source)})),
 precision:(random,index)=>numberCase(random,index,source=>({op:'toPrecision',x:source.bits,p:precisionDigits(random,source)})),
 exponential:(random,index)=>numberCase(random,index,source=>{
  const d=exponentialDigits(random,source);
  return d===undefined?{op:'toExponential',x:source.bits}:{op:'toExponential',x:source.bits,d};
 }),
 round:roundCase,
 json:jsonCase,
 string:stringCase,
 date:dateCase,
});

/**
 * 시드 고정 코퍼스를 스위트 순서대로 만든다. 같은 시드·수·스위트면 같은 작업이다(스위트마다 따로 난수 흐름을 쓴다).
 * @param {{seed: number, count: number, suites: readonly string[]}} options 시드, 스위트마다 작업 수, 스위트
 * @returns {Generator<{suite: string, index: number, source: string, task: object}>} 작업
 * @throws {TypeError} 모르는 스위트일 때
 */
export function* corpusCases({seed,count,suites}){
 for(const suite of suites){
  const generate=Object.hasOwn(SUITE_GENERATORS,suite)?SUITE_GENERATORS[suite]:null;
  if(!generate)throw new TypeError(`unknown conformance suite "${suite}"; use one of ${SUITES.join(', ')}`);
  const random=createRandom(seed,suite);
  for(let index=0;index<count;index++){const {source,task}=generate(random,index);yield {suite,index,source,task};}
 }
}

/**
 * 코퍼스의 작업 줄 전체(줄마다 개행). 결정성 시험과 --emit-corpus가 같은 바이트를 낸다.
 * @param {{seed: number, count: number, suites: readonly string[]}} options 코퍼스 선택
 * @returns {string} JSONL
 */
export function corpusText(options){
 let text='';
 for(const item of corpusCases(options))text+=`${JSON.stringify(item.task)}\n`;
 return text;
}

/**
 * JS 엔진 쪽 기대값을 내는 오라클을 만든다. 엔진의 내장 함수(Number#toFixed, JSON.parse, String#toLowerCase, Date.UTC 등)로
 * 계산하고 결과를 정규 문자열로 바꾼다. 이 함수는 소스 그대로 JSC·QuickJS 스크립트에 들어가므로 바깥 변수를 쓰지 않고
 * Node 전용 API도 쓰지 않는다(engineScript 참고).
 * @returns {(task: object) => string} 작업 → 정규 결과
 */
export function createOracle(){
 'use strict';
 // SENTINEL_KEY와 같은 값이다(이 함수는 바깥 변수를 볼 수 없다)
 var SENTINEL='\u0000bc:special';
 var view=new DataView(new ArrayBuffer(8));
 // 16진 두·네·여덟 자리
 function hex2(value){return (value<16?'0':'')+value.toString(16);}
 function hex4(value){return ('000'+value.toString(16)).slice(-4);}
 function hex8(value){return ('0000000'+value.toString(16)).slice(-8);}
 // 16진 비트 → 수, 수 → 정규 문자열(NaN은 페이로드와 무관하게 'NaN')
 function fromBits(hex){view.setUint32(0,parseInt(hex.slice(0,8),16));view.setUint32(4,parseInt(hex.slice(8,16),16));return view.getFloat64(0);}
 function canonical(value){if(value!==value)return 'NaN';view.setFloat64(0,value);return hex8(view.getUint32(0))+hex8(view.getUint32(4));}
 // 문자열 → UTF-8 16진. 단독 서로게이트는 3바이트(WTF-8)로 써서 차이가 드러나게 한다
 function utf8Hex(text){
  var out=[];
  for(var index=0;index<text.length;index++){
   var code=text.charCodeAt(index);
   if(code>=0xd800&&code<=0xdbff&&index+1<text.length){var next=text.charCodeAt(index+1);if(next>=0xdc00&&next<=0xdfff){code=0x10000+(code-0xd800<<10)+(next-0xdc00);index++;}}
   if(code<0x80)out.push(hex2(code));
   else if(code<0x800)out.push(hex2(0xc0|code>>6),hex2(0x80|code&63));
   else if(code<0x10000)out.push(hex2(0xe0|code>>12),hex2(0x80|code>>6&63),hex2(0x80|code&63));
   else out.push(hex2(0xf0|code>>18),hex2(0x80|code>>12&63),hex2(0x80|code>>6&63),hex2(0x80|code&63));
  }
  return out.join('');
 }
 // UTF-8 16진 → 문자열(생성기가 올바른 UTF-8만 보낸다)
 function decodeUtf8(hex){
  var bytes=[],out='',index;
  for(index=0;index<hex.length;index+=2)bytes.push(parseInt(hex.slice(index,index+2),16));
  for(index=0;index<bytes.length;){
   var lead=bytes[index],extra=lead<0x80?0:lead>=0xf0?3:lead>=0xe0?2:1,code=extra?lead&(0x3f>>extra):lead;
   for(var position=1;position<=extra;position++)code=code<<6|bytes[index+position]&63;
   index+=extra+1;
   out+=String.fromCodePoint(code);
  }
  return out;
 }
 // UTF-16 코드 단위 16진 ↔ 문자열
 function unitsHex(text){var out='';for(var index=0;index<text.length;index++)out+=hex4(text.charCodeAt(index));return out;}
 function decodeUnits(hex){var units=[];for(var index=0;index<hex.length;index+=4)units.push(parseInt(hex.slice(index,index+4),16));return String.fromCharCode.apply(null,units);}
 // carrier의 표지 객체를 특수 값으로 되돌린다. 대입은 JSON.parse가 만든 자기 키의 자리를 지킨다(__proto__ 포함)
 function special(token){
  switch(token){
   case 'NaN':return NaN;
   case 'Infinity':return Infinity;
   case '-Infinity':return -Infinity;
   case 'undefined':return undefined;
   default:throw new TypeError('unknown special token '+token);
  }
 }
 function revive(value){
  if(value===null||typeof value!=='object')return value;
  var index,keys;
  if(Array.isArray(value)){for(index=0;index<value.length;index++)value[index]=revive(value[index]);return value;}
  keys=Object.keys(value);
  if(keys.length===1&&keys[0]===SENTINEL)return special(value[SENTINEL]);
  for(index=0;index<keys.length;index++)value[keys[index]]=revive(value[keys[index]]);
  return value;
 }
 // M0 계획 Task 5의 BCJSON writer: 자기 키 순서, JSON.stringify 이스케이프, String(n), 특수 값 토큰
 function lossless(value){
  if(value===undefined)return 'undefined';
  if(value===null)return 'null';
  if(typeof value==='boolean')return value?'true':'false';
  if(typeof value==='number'){
   if(value!==value)return 'NaN';
   if(value===Infinity)return 'Infinity';
   if(value===-Infinity)return '-Infinity';
   return value===0&&1/value<0?'-0':String(value);
  }
  if(typeof value==='string')return JSON.stringify(value);
  var parts=[],index;
  if(Array.isArray(value)){for(index=0;index<value.length;index++)parts.push(lossless(value[index]));return '['+parts.join(',')+']';}
  var keys=Object.keys(value);
  for(index=0;index<keys.length;index++)parts.push(JSON.stringify(keys[index])+':'+lossless(value[keys[index]]));
  return '{'+parts.join(',')+'}';
 }
 // M0 계획 Task 2의 시간대 계약 파서(정규식 \d는 ASCII 숫자만이다)
 function parseIsoDate(text){
  var match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if(!match)return 'none';
  var year=+match[1],month=+match[2],day=+match[3];
  if(year<1000||year>9999||month<1||month>12||day<1)return 'none';
  return new Date(Date.UTC(year,month-1,day)).getUTCDate()===day?year+','+month+','+day:'none';
 }
 function parseIsoClock(text){
  var match=/^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if(!match)return 'none';
  var hour=+match[1],minute=+match[2],second=match[3]===undefined?0:+match[3];
  return hour<=23&&minute<=59&&second<=59?hour+','+minute+','+second:'none';
 }
 var operations={
  toString:function(task){return String(fromBits(task.x));},
  toFixed:function(task){return fromBits(task.x).toFixed(task.d);},
  toPrecision:function(task){return fromBits(task.x).toPrecision(task.p);},
  toExponential:function(task){var x=fromBits(task.x);return task.d===undefined?x.toExponential():x.toExponential(task.d);},
  round:function(task){return canonical(Math.round(fromBits(task.x)));},
  sign:function(task){return canonical(Math.sign(fromBits(task.x)));},
  max:function(task){return canonical(Math.max.apply(Math,task.xs.map(fromBits)));},
  min:function(task){return canonical(Math.min.apply(Math,task.xs.map(fromBits)));},
  toInt32:function(task){return String(fromBits(task.x)|0);},
  toUint32:function(task){return String(fromBits(task.x)>>>0);},
  objectIs:function(task){return String(Object.is(fromBits(task.x),fromBits(task.y)));},
  json:function(task){
   var value;
   try{value=JSON.parse(decodeUtf8(task.text));}catch(error){return 'E:'+error.name;}
   return utf8Hex(JSON.stringify(value));
  },
  jsonUnits:function(task){
   var value;
   try{value=JSON.parse(decodeUnits(task.units));}catch(error){return 'E:'+error.name;}
   return utf8Hex(JSON.stringify(value));
  },
  jsonLossless:function(task){
   // 최상위 undefined의 표준 텍스트는 null이다(설계 §4.2 표준 결과 인코딩, aster_jni.c:60, M1 Task 3 판단)
   var value=revive(JSON.parse(decodeUtf8(task.carrier))),standard=JSON.stringify(value);
   return utf8Hex(standard===undefined?'null':standard)+','+utf8Hex(lossless(value));
  },
  trim:function(task){return unitsHex(decodeUnits(task.units).trim());},
  toLowerCase:function(task){return unitsHex(decodeUnits(task.units).toLowerCase());},
  slice:function(task){var text=decodeUnits(task.units);return unitsHex(task.end===undefined?text.slice(task.start):text.slice(task.start,task.end));},
  length:function(task){return String(decodeUnits(task.units).length);},
  isWhitespace:function(task){return String(String.fromCharCode(task.unit).trim()==='');},
  quote:function(task){return utf8Hex(JSON.stringify(decodeUnits(task.units)));},
  dateUtc:function(task){var a=task.args.map(fromBits);return canonical(Date.UTC(a[0],a[1],a[2],a[3],a[4],a[5],a[6]));},
  timeClip:function(task){return canonical(new Date(fromBits(task.t)).getTime());},
  toISOString:function(task){try{return new Date(fromBits(task.t)).toISOString();}catch(error){return 'E:'+error.name;}},
  // setUTCFullYear는 Date.UTC와 달리 0~99년에 1900을 더하지 않는다
  daysFromCivil:function(task){return String(new Date(0).setUTCFullYear(task.year,task.month-1,task.day)/86400000);},
  civilFromDays:function(task){var date=new Date(task.days*86400000);return date.getUTCFullYear()+','+(date.getUTCMonth()+1)+','+date.getUTCDate();},
  parseIsoDate:function(task){return parseIsoDate(decodeUtf8(task.text));},
  parseIsoClock:function(task){return parseIsoClock(decodeUtf8(task.text));}
 };
 return function expected(task){
  if(!Object.prototype.hasOwnProperty.call(operations,task.op))throw new TypeError('unknown conformance op '+task.op);
  return operations[task.op](task);
 };
}

/**
 * 오라클이 던진 오류를 결과 문자열로 바꾼다(엔진 스크립트와 같은 모양). expectBatch·engineResults가 이 표지를 보고
 * 하네스 오류(종료 코드 2)로 멈춘다. 커널 불일치나 엔진 차이로 셈하지 않는다.
 * @param {unknown} error 오류
 * @returns {string} 표지 결과
 */
const oracleFailure=error=>`!oracle-error ${String(error).replace(/\n/g,' ')}`;

/**
 * 작업 줄로 엔진 대조 스크립트를 만든다.
 * @param {string[]} lines 작업 JSON 줄
 * @returns {string} 스크립트 소스
 */
function engineScriptFromLines(lines){
 return [
  '// scripts/rust/conformance.mjs가 만든 엔진 대조 스크립트: 오라클과 작업 배열. 결과 줄을 print와 완료 값으로 낸다',
  String(createOracle),
  `var conformanceTasks=[\n${lines.join(',\n')}\n];`,
  'var conformanceExpected=createOracle(),conformanceResults=[];',
  'for(var index=0;index<conformanceTasks.length;index++){',
  ' var conformanceResult;',
  ' try{conformanceResult=conformanceExpected(conformanceTasks[index]);}catch(error){conformanceResult="!oracle-error "+String(error).replace(/\\n/g," ");}',
  ' conformanceResults.push(conformanceResult);',
  '}',
  'conformanceResults=conformanceResults.join("\\n");',
  'if(typeof print==="function")print(conformanceResults);',
  'conformanceResults;',
  '',
 ].join('\n');
}

/**
 * JSC·QuickJS에서 그대로 실행하는 대조 스크립트. 완료 값(QuickJS 호스트, node:vm)과 print 출력(jsc)이 결과 줄이다.
 * @param {object[]} tasks 작업
 * @returns {string} 스크립트 소스
 */
export function engineScript(tasks){
 return engineScriptFromLines(tasks.map(task=>JSON.stringify(task)));
}

/**
 * 명령을 실행하고 실패하면 원인과 해결 방향을 담아 던진다.
 * @param {string} command 실행 파일
 * @param {string[]} args 인자
 * @param {string} hint 실패했을 때 할 일
 * @returns {string} 표준출력
 * @throws {HarnessError} 실행하지 못했거나 0이 아닌 코드로 끝났을 때
 */
function runTool(command,args,hint){
 const result=spawnSync(command,args,{encoding:'utf8',maxBuffer:1<<30});
 if(!result.error&&result.status===0)return result.stdout;
 const cause=result.error?result.error.message:`exit ${result.status}${result.signal?`, signal ${result.signal}`:''}`;
 throw new HarnessError(`${command} ${args.join(' ')} failed (${cause}): ${(result.stderr??'').trim().slice(0,4000)}; ${hint}`);
}

/**
 * 저장소의 QuickJS로 대조 호스트를 빌드한다. 소스·컴파일러가 같으면 work-dir에 둔 빌드를 다시 쓴다.
 * @param {string} workDir 작업 디렉터리
 * @returns {string} 호스트 실행 파일
 */
function buildQuickjsHost(workDir){
 const cc=process.env.CC||'cc',version=readFileSync(join(QUICKJS_DIR,'VERSION'),'utf8').trim(),hash=createHash('sha256');
 hash.update(JSON.stringify({cc,version,sources:QUICKJS_SOURCES}));
 const files=[QUICKJS_HOST,...readdirSync(QUICKJS_DIR).filter(name=>/\.[ch]$/.test(name)).sort().map(name=>join(QUICKJS_DIR,name))];
 for(const file of files)hash.update(readFileSync(file));
 const directory=join(workDir,`quickjs-${hash.digest('hex').slice(0,16)}`),binary=join(directory,'quickjs-host');
 if(existsSync(binary))return binary;
 mkdirSync(directory,{recursive:true});
 const hint='set CC to a working C compiler or drop quickjs from --engines';
 runTool(cc,['-std=gnu11','-O2','-Wall','-Wextra','-Werror','-D_GNU_SOURCE','-isystem',QUICKJS_DIR,'-c',QUICKJS_HOST,'-o',join(directory,'host.o')],hint);
 runTool(cc,['-std=gnu11','-O2','-Werror','-D_GNU_SOURCE',`-DCONFIG_VERSION="${version}"`,'-I',QUICKJS_DIR,join(directory,'host.o'),...QUICKJS_SOURCES.map(name=>join(QUICKJS_DIR,`${name}.c`)),'-lm','-pthread','-o',`${binary}.partial`],hint);
 renameSync(`${binary}.partial`,binary);
 return binary;
}

/**
 * 삼각측량 엔진을 준비한다: jsc 경로를 확인하고 QuickJS 호스트를 빌드한다.
 * @param {{engines: string[], workDir: string}} options CLI 선택
 * @returns {{workDir: string, batch: number, jsc?: string, quickjs?: string}} 엔진 실행 정보
 * @throws {HarnessError} jsc나 QUICKJS_HOST_PATH가 없거나 QuickJS 빌드가 실패할 때
 */
function prepareEngines(options){
 const engines={workDir:options.workDir,batch:0};
 if(options.engines.length>1)mkdirSync(options.workDir,{recursive:true});
 if(options.engines.includes('jsc')){
  engines.jsc=process.env.JSC_PATH||DEFAULT_JSC;
  if(!existsSync(engines.jsc))throw new HarnessError(`jsc not found at ${engines.jsc}; set JSC_PATH to a JavaScriptCore shell or drop jsc from --engines`);
 }
 if(options.engines.includes('quickjs')){
  const host=process.env.QUICKJS_HOST_PATH;
  if(host&&!existsSync(host))throw new HarnessError(`QUICKJS_HOST_PATH ${host} does not exist; point it at a QuickJS host or unset it to build one from native/android/quickjs`);
  engines.quickjs=host||buildQuickjsHost(options.workDir);
 }
 return engines;
}

/**
 * 작업 묶음을 JSC나 QuickJS로 계산한다. 실패하면 스크립트를 지우지 않고 경로를 알린다.
 * @param {'jsc'|'quickjs'} engine 엔진
 * @param {string[]} lines 작업 JSON 줄
 * @param {ReturnType<typeof prepareEngines>} engines 엔진 실행 정보
 * @returns {string[]} 작업마다 정규 결과
 * @throws {HarnessError} 엔진이 실패하거나, 결과 수가 맞지 않거나, 오라클을 돌리지 못한 작업('!oracle-error')이 있을 때
 */
function engineResults(engine,lines,engines){
 const script=join(engines.workDir,`batch-${process.pid}-${engines.batch++}-${engine}.js`);
 writeFileSync(script,engineScriptFromLines(lines));
 const output=runTool(engines[engine],[script],`the script is kept at ${script}; rerun ${engine} on it to debug`);
 const results=output.endsWith('\n')?output.slice(0,-1).split('\n'):output.split('\n');
 if(results.length!==lines.length)throw new HarnessError(`${engine} returned ${results.length} results for ${lines.length} tasks; the script is kept at ${script}`);
 const failed=results.findIndex(value=>value.startsWith('!'));
 if(failed>=0)throw new HarnessError(`${engine} could not run the oracle for task ${lines[failed]}: ${results[failed]}; the batch script is kept at ${script}; fix the engine or drop ${engine} from --engines`);
 rmSync(script,{force:true});
 return results;
}

/**
 * 작업 묶음의 기대값을 낸다. 엔진이 여럿이면 값이 모두 같을 때만 기대값이고, 다르면 엔진별 값을 남긴다.
 * @param {object[]} chunk 코퍼스 작업
 * @param {string[]} engineNames 엔진(첫째는 v8)
 * @param {{oracle: (task: object) => string, engines: object}} context 실행 정보
 * @returns {object[]} 판정할 항목(작업 줄, 기대값, 엔진 차이)
 * @throws {HarnessError} 어느 엔진이든 오라클을 돌리지 못했을 때
 */
function expectBatch(chunk,engineNames,context){
 const lines=chunk.map(item=>JSON.stringify(item.task)),results={v8:chunk.map(item=>context.oracle(item.task))};
 const failed=results.v8.findIndex(value=>value.startsWith('!'));
 if(failed>=0)throw new HarnessError(`the V8 oracle failed on task ${lines[failed]}: ${results.v8[failed]}; this is a bug in createOracle or the corpus generator`);
 for(const engine of engineNames)if(engine!=='v8')results[engine]=engineResults(engine,lines,context.engines);
 return chunk.map((item,index)=>{
  const values=engineNames.map(engine=>results[engine][index]),agreed=values.every(value=>value===values[0]);
  return {...item,line:lines[index],expected:values[0],engineValues:agreed?null:Object.fromEntries(engineNames.map((engine,position)=>[engine,values[position]]))};
 });
}

/**
 * 코퍼스를 묶음으로 나눠 기대값을 붙인다.
 * @param {object} options CLI 선택
 * @param {object} context 실행 정보
 * @returns {Generator<object[]>} 판정할 항목 묶음
 */
function* expectedBatches(options,context){
 const size=options.engines.length>1?BATCH_SIZE.engines:BATCH_SIZE.v8;
 let chunk=[];
 for(const item of corpusCases(options)){
  chunk.push(item);
  if(chunk.length===size){yield expectBatch(chunk,options.engines,context);chunk=[];}
 }
 if(chunk.length)yield expectBatch(chunk,options.engines,context);
}

/**
 * 스트림의 줄을 차례로 낸다.
 * @param {import('node:stream').Readable} stream UTF-8 스트림
 * @returns {AsyncGenerator<string>} 줄(개행 제외)
 */
async function* readLines(stream){
 stream.setEncoding('utf8');
 let rest='';
 for await(const chunk of stream){
  const parts=(rest+chunk).split('\n');
  rest=parts.pop();
  yield* parts;
 }
 if(rest)yield rest;
}

/**
 * 쓰기 스트림이 다시 받을 수 있거나 끝날 때까지 기다린다. 이미 닫힌 스트림은 이벤트를 다시 내지 않으므로 바로 돌아온다.
 * @param {import('node:stream').Writable} stream 쓰기 스트림
 * @returns {Promise<void>} drain, error, close 가운데 먼저 오는 것
 */
function writable(stream){
 if(stream.destroyed||!stream.writableNeedDrain)return Promise.resolve();
 return new Promise(resolve=>{
  const done=()=>{stream.off('drain',done);stream.off('error',done);stream.off('close',done);resolve();};
  stream.on('drain',done);stream.on('error',done);stream.on('close',done);
 });
}

/**
 * 결과 줄 `{"r":"..."}` 또는 `{"r":"...","q":"..."}`를 읽는다. q는 커널의 QuickJS 방언 결과가 r과 다를 때만 있다.
 * @param {string} line 결과 줄
 * @returns {{r: string, q?: string}} 정규 결과
 * @throws {HarnessError} 형식이 틀렸을 때
 */
function parseResult(line){
 let parsed;
 try{parsed=JSON.parse(line);}
 catch(error){throw new HarnessError(`bc-conformance wrote a line that is not JSON (${error.message}): ${line.slice(0,200)}`);}
 if(typeof parsed?.r!=='string'||(parsed.q!==undefined&&typeof parsed.q!=='string'))throw new HarnessError(`bc-conformance results must look like {"r":"..."} or {"r":"...","q":"..."}; got ${line.slice(0,200)}`);
 return parsed.q===undefined?{r:parsed.r}:{r:parsed.r,q:parsed.q};
}

/**
 * 엔진과 비교할 커널 값: V8(WASM 하네스)·JSC(iOS)는 ECMA 방언 r, QuickJS(Android)는 QuickJS 방언 q(같으면 r).
 * @param {string} engine 엔진
 * @param {{r: string, q?: string}} result 커널 결과
 * @returns {string} 그 엔진의 플랫폼에서 커널이 낼 값
 */
const kernelValueFor=(engine,result)=>engine==='quickjs'?(result.q??result.r):result.r;

/**
 * 한 엔진과 다른 커널 결과가 그 엔진의 알려진 차이인지 본다. 커널이 문서화한 쪽으로 답했을 때만 이유를 돌려준다.
 * @param {object} task 작업
 * @param {string} actual 그 엔진과 비교한 커널 결과
 * @param {string} expected 그 엔진의 결과
 * @param {string} engine 엔진
 * @param {{unicodeDiffers: boolean}} context 실행 정보
 * @returns {string|null} KNOWN_DIVERGENCES의 이유
 */
function knownDivergence(task,actual,expected,engine,context){
 if(task.op==='dateUtc'&&(engine==='v8'||engine==='jsc')&&actual==='NaN'&&expected!=='NaN'&&foldedYearOutOfRange(task.args))return 'date-utc-folded-year';
 if(task.op==='toLowerCase'&&engine==='v8'&&context.unicodeDiffers&&/\p{Cn}/u.test(unitsFromHex(task.units)))return 'unicode-version';
 return null;
}

/**
 * Date.UTC에서 달을 연도로 접은 연도가 시각 값 범위(-271821~275760년) 밖인지 본다. 커널 make_day와 같은 식이다.
 * @param {string[]} args 16진 비트 인자 일곱 개
 * @returns {boolean} 범위 밖이면 true(인자에 비유한 수가 있으면 모든 엔진이 NaN이라 false)
 */
function foldedYearOutOfRange(args){
 const values=args.map(numberFromBits);
 if(!values.every(Number.isFinite))return false;
 const truncated=Math.trunc(values[0]),year=truncated>=0&&truncated<=99?1900+truncated:truncated;
 const folded=year+Math.floor(Math.trunc(values[1])/12);
 return folded< -271821||folded>275760;
}

/**
 * 판정 통계를 만든다. 스위트마다 엔진별로 커널과 같았던 수, 알려진 차이(이유별), 불일치 수를 센다(byEngine).
 * 이름으로 세는 표(ops, excluded, divergent)는 프로토타입 없는 객체다. 연산 이름 'toString'이
 * Object.prototype.toString을 읽으면 개수가 문자열로 이어 붙으며 자라기 때문이다.
 * @param {object} options CLI 선택
 * @returns {object} 스위트별 통계와 예시
 */
function createStats(options){
 const engineTallies=()=>Object.fromEntries(options.engines.map(engine=>[engine,{matched:0,divergent:Object.create(null),mismatched:0}]));
 const suites=Object.fromEntries(options.suites.map(suite=>[suite,{cases:0,compared:0,excluded:Object.create(null),disagreements:0,mismatches:0,ops:Object.create(null),byEngine:engineTallies()}]));
 return {received:0,expectedTotal:options.count*options.suites.length,suites,examples:{mismatches:[],excluded:[],disagreements:[]}};
}

/**
 * 예시 목록에 한도까지 더한다.
 * @param {object[]} list 예시 목록
 * @param {object} item 예시
 */
function remember(list,item){
 if(list.length<EXAMPLE_LIMIT)list.push(item);
}

/**
 * 커널 결과 하나를 판정한다. 엔진마다 그 플랫폼의 커널 값(kernelValueFor)과 비교한다.
 * - 어느 엔진과든 알려진 차이가 아닌데 다르면 불일치다(비교한 작업으로 센다).
 * - 불일치 없이 한 엔진이라도 같으면 비교한 작업이다. 다른 엔진과의 알려진 차이는 byEngine에 남는다.
 * - 모든 엔진과 알려진 차이로만 갈렸으면 제외다(비교하지 못한 작업).
 * 엔진끼리 값이 다르면(삼각측량) 그것과 별개로 엔진 차이를 세고 예시를 남긴다.
 * @param {object} stats 판정 통계
 * @param {object} entry 기대값을 붙인 작업
 * @param {{r: string, q?: string}} result 커널 결과
 * @param {{engineNames: string[], unicodeDiffers: boolean}} context 실행 정보
 */
function judge(stats,entry,result,context){
 const suite=stats.suites[entry.suite],{op}=entry.task,label=`${entry.suite}#${entry.index}`;
 stats.received++;suite.cases++;suite.ops[op]=(suite.ops[op]??0)+1;
 if(entry.engineValues){
  suite.disagreements++;
  remember(stats.examples.disagreements,{label,source:entry.source,task:entry.task,engines:entry.engineValues,rust:result});
 }
 let matched=0;
 const divergences=[],failures=[];
 for(const engine of context.engineNames){
  const tally=suite.byEngine[engine],expected=entry.engineValues?entry.engineValues[engine]:entry.expected,actual=kernelValueFor(engine,result);
  if(actual===expected){tally.matched++;matched++;continue;}
  const reason=knownDivergence(entry.task,actual,expected,engine,context);
  if(reason){tally.divergent[reason]=(tally.divergent[reason]??0)+1;divergences.push({engine,reason,expected,actual});continue;}
  tally.mismatched++;failures.push({engine,expected,actual});
 }
 if(failures.length){
  suite.compared++;suite.mismatches++;
  remember(stats.examples.mismatches,{label,source:entry.source,task:entry.task,failures});
  return;
 }
 if(matched){suite.compared++;return;}
 const [{reason,expected,actual}]=divergences;
 suite.excluded[reason]=(suite.excluded[reason]??0)+1;
 remember(stats.examples.excluded,{label,source:entry.source,reason,task:entry.task,expected,actual,divergences});
}

/** 판정을 끝낸 결과 칸을 이만큼 모으면 대기열 앞을 잘라 낸다 */
const QUEUE_COMPACT_AT=65536;

/**
 * bc-conformance를 띄우고 표준오류(앞 8 KiB), 입력 쓰기 오류, 종료를 지켜본다.
 * @param {string} binary bc-conformance 실행 파일
 * @returns {Promise<{child: import('node:child_process').ChildProcess, stderr: string, inputError: Error|null,
 *   closed: Promise<{code: number|null, signal: string|null}>}>} 커널 세션
 * @throws {HarnessError} 실행하지 못했을 때
 */
async function startKernel(binary){
 const child=spawn(binary,[],{stdio:['pipe','pipe','pipe']}),session={child,stderr:'',inputError:null};
 child.stderr.setEncoding('utf8');
 child.stderr.on('data',chunk=>{if(session.stderr.length<8192)session.stderr+=chunk;});
 child.stdin.on('error',error=>{session.inputError=error;});
 session.closed=new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})));
 await new Promise((resolve,reject)=>{
  child.once('spawn',resolve);
  child.once('error',error=>reject(new HarnessError(`cannot start ${binary} (${error.message}); build it with node scripts/rust/cargo.mjs build --release -p bc-conformance or fix --binary`)));
 });
 return session;
}

/**
 * 커널 결과를 읽어 보낸 순서대로 판정한다.
 * @param {object} session 커널 세션
 * @param {{pending: (object|undefined)[], head: number}} queue 결과를 기다리는 작업(보낸 순서)
 * @param {object} stats 판정 통계
 * @param {object} context 실행 정보
 * @throws {HarnessError} 결과가 작업보다 많거나 형식이 틀렸을 때
 */
async function readResults(session,queue,stats,context){
 for await(const line of readLines(session.child.stdout)){
  const entry=queue.pending[queue.head];
  if(!entry)throw new HarnessError(`bc-conformance wrote more results than tasks: ${line.slice(0,200)}`);
  queue.pending[queue.head++]=undefined;
  judge(stats,entry,parseResult(line),context);
 }
}

/**
 * 작업 줄을 커널에 보낸다. 파이프가 차면 기다리고, 커널이 닫혔거나 다른 쪽이 실패하면 멈춘다.
 * @param {object} session 커널 세션
 * @param {{pending: (object|undefined)[], head: number}} queue 결과를 기다리는 작업
 * @param {Iterable<object[]>} batches 기대값을 붙인 작업 묶음
 * @param {() => boolean} failed 다른 쪽이 실패했는지
 */
async function writeTasks(session,queue,batches,failed){
 const {stdin}=session.child;
 for(const batch of batches){
  for(const entry of batch){
   queue.pending.push(entry);
   if(!stdin.write(`${entry.line}\n`))await writable(stdin);
   if(session.inputError||failed()||stdin.destroyed)return;
  }
  if(queue.head>QUEUE_COMPACT_AT){queue.pending.splice(0,queue.head);queue.head=0;}
 }
 stdin.end();
}

/**
 * 커널을 띄워 코퍼스를 흘려보내고 결과를 판정한다. 쓰기와 읽기를 함께 돌려 파이프가 막히지 않게 하고,
 * 한쪽이 실패하면 커널을 멈춰 다른 쪽도 끝나게 한다.
 * @param {object} options CLI 선택
 * @param {string} binary bc-conformance 실행 파일
 * @param {object} context 실행 정보
 * @param {object} stats 판정 통계
 * @throws {HarnessError} 커널이 실패하거나 결과 수가 맞지 않을 때
 */
async function compareWithKernel(options,binary,context,stats){
 const session=await startKernel(binary),queue={pending:[],head:0};
 let failure=null;
 const abort=error=>{failure??=error;session.child.kill();};
 await Promise.all([
  readResults(session,queue,stats,context).catch(abort),
  writeTasks(session,queue,expectedBatches(options,context),()=>failure!==null).catch(abort),
 ]);
 const {code,signal}=await session.closed;
 if(failure)throw failure;
 if(stats.received!==stats.expectedTotal||code!==0){
  const exit=signal?`signal ${signal}`:`exit ${code}`,stderr=session.stderr.trim();
  const writeNote=session.inputError?`; writing tasks failed with ${session.inputError.code??session.inputError.message}`:'';
  throw new HarnessError(`bc-conformance ended after ${stats.received} of ${stats.expectedTotal} results (${exit})${stderr?`: ${stderr}`:''}${writeNote}`);
 }
}

/**
 * cargo로 bc-conformance를 release로 빌드하고 실행 파일 경로를 cargo가 알려 주는 대로 얻는다.
 * @returns {string} 실행 파일
 * @throws {HarnessError} rustup cargo가 없거나 빌드가 실패할 때
 */
function buildKernel(){
 const bin=rustupBinDirectory(process.env),cargo=join(bin,'cargo');
 if(!existsSync(cargo))throw new HarnessError(`rustup cargo not found at ${cargo}; install rustup (https://rustup.rs) or pass --binary <path to bc-conformance>`);
 const result=spawnSync(cargo,['build','--release','--locked','-p','bc-conformance','--message-format=json-render-diagnostics'],{cwd:WORKSPACE,env:cargoEnvironment(process.env,bin),encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:256<<20});
 if(result.error||result.status!==0)throw new HarnessError(`cargo build -p bc-conformance failed (${result.error?.message??`exit ${result.status}`}); fix the errors printed above`);
 const messages=result.stdout.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
 const executable=messages.find(message=>message.reason==='compiler-artifact'&&message.target?.name==='bc-conformance'&&message.executable)?.executable;
 if(!executable)throw new HarnessError('cargo build did not report the bc-conformance executable; run node scripts/rust/cargo.mjs build --release -p bc-conformance to inspect it');
 return executable;
}

/**
 * 커널이 쓰는 std의 유니코드 판을 묻는다.
 * @param {string} binary bc-conformance 실행 파일
 * @returns {string} 판(예: 17.0.0)
 * @throws {HarnessError} 답이 없거나 형식이 틀렸을 때
 */
function kernelUnicodeVersion(binary){
 const version=runTool(binary,['--unicode-version'],'rebuild bc-conformance or fix --binary').trim();
 if(!/^\d+\.\d+(?:\.\d+)?$/.test(version))throw new HarnessError(`${binary} --unicode-version printed ${JSON.stringify(version)}; expected a version such as 17.0.0`);
 return version;
}

/**
 * 판의 주·부 번호(17.0.0 → 17.0).
 * @param {string} version 판
 * @returns {string} 주.부
 */
const majorMinor=version=>version.split('.').slice(0,2).join('.');

/**
 * 파일에서 정규식의 첫 그룹을 읽는다(없으면 null).
 * @param {string} path 파일
 * @param {RegExp} pattern 정규식
 * @returns {string|null} 값
 */
function readMatch(path,pattern){
 return pattern.exec(readFileSync(path,'utf8'))?.[1]??null;
}

/**
 * 실행 환경(엔진·커널 판, 플랫폼)을 적는다.
 * @param {object} options CLI 선택
 * @param {object} context 실행 정보
 * @returns {object} 환경
 */
function describeEnvironment(options,context){
 const environment={
  node:process.version,v8:process.versions.v8,nodeUnicode:process.versions.unicode,kernelUnicode:context.kernelUnicode,
  rustToolchain:readMatch(join(WORKSPACE,'rust-toolchain.toml'),/^channel\s*=\s*"([^"]+)"/m),
  ryuJs:readMatch(join(WORKSPACE,'crates/barochart-js/Cargo.toml'),/^ryu-js\s*=\s*"=?([^"]+)"/m),
  platform:`${platform()} ${release()} ${arch()}`,
 };
 if(options.engines.includes('jsc')){
  const productVersion=spawnSync('sw_vers',['-productVersion'],{encoding:'utf8'});
  environment.jsc={path:context.engines.jsc,macOS:productVersion.status===0?productVersion.stdout.trim():null};
 }
 if(options.engines.includes('quickjs')){
  environment.quickjs=readFileSync(join(QUICKJS_DIR,'VERSION'),'utf8').trim();
  if(process.env.QUICKJS_HOST_PATH)environment.quickjsHost=process.env.QUICKJS_HOST_PATH;
 }
 return environment;
}

/**
 * 같은 선택을 다시 돌리는 명령줄.
 * @param {object} options CLI 선택
 * @returns {string} 명령
 */
function commandLine(options){
 const engines=options.engines.length>1?` --engines ${options.engines.join(',')}`:'';
 return `node scripts/rust/conformance.mjs --suite ${options.suites.join(',')} --count ${options.count} --seed ${options.seed}${engines}`;
}

/**
 * 판정 통계를 실행 요약으로 정리한다.
 * @param {object} stats 판정 통계
 * @param {object} options CLI 선택
 * @param {object} environment 실행 환경
 * @param {number} seconds 걸린 시간(초)
 * @returns {object} 실행 요약(보고서의 runs 원소)
 */
function summarize(stats,options,environment,seconds){
 const totals={cases:0,compared:0,excluded:0,disagreements:0,mismatches:0},reasons=new Set();
 const byEngine=Object.fromEntries(options.engines.map(engine=>[engine,{matched:0,divergent:Object.create(null),mismatched:0}]));
 for(const suite of Object.values(stats.suites)){
  totals.cases+=suite.cases;totals.compared+=suite.compared;totals.disagreements+=suite.disagreements;totals.mismatches+=suite.mismatches;
  for(const [reason,count] of Object.entries(suite.excluded)){totals.excluded+=count;reasons.add(reason);}
  for(const [engine,tally] of Object.entries(suite.byEngine)){
   const total=byEngine[engine];
   total.matched+=tally.matched;total.mismatched+=tally.mismatched;
   for(const [reason,count] of Object.entries(tally.divergent)){total.divergent[reason]=(total.divergent[reason]??0)+count;reasons.add(reason);}
  }
 }
 return {
  command:commandLine(options),date:new Date().toISOString().slice(0,10),seed:options.seed,count:options.count,suites:options.suites,engines:options.engines,
  result:totals.mismatches?'fail':'pass',totals,byEngine,bySuite:stats.suites,
  knownDivergences:Object.fromEntries([...reasons].sort().map(reason=>[reason,KNOWN_DIVERGENCES[reason]])),
  examples:stats.examples,environment,durationSeconds:Math.round(seconds*10)/10,
 };
}

/**
 * 수를 읽기 좋게 쓴다(-0을 드러낸다).
 * @param {number} value 수
 * @returns {string} 텍스트
 */
const formatNumber=value=>Object.is(value,-0)?'-0':String(value);

/**
 * 작업 입력을 읽을 수 있게 풀어 쓴다(16진 비트·바이트·코드 단위를 값으로).
 * @param {object} task 작업
 * @returns {string} 입력 설명
 */
function describeInput(task){
 return Object.entries(task).filter(([key])=>key!=='op').map(([key,value])=>{
  if(key==='x'||key==='y'||key==='t')return `${key}=${value}(${formatNumber(numberFromBits(value))})`;
  if(key==='xs'||key==='args')return `${key}=[${value.map(bits=>formatNumber(numberFromBits(bits))).join(',')}]`;
  if(key==='text'||key==='carrier')return `${key}=${JSON.stringify(Buffer.from(value,'hex').toString('utf8'))}`;
  if(key==='units')return `${key}=${JSON.stringify(unitsFromHex(value))}`;
  return `${key}=${value}`;
 }).join(' ');
}

/** 결과가 수(16진 비트)인 연산 */
const NUMBER_RESULT_OPS=new Set(['round','sign','max','min','dateUtc','timeClip']);

/**
 * 정규 결과를 읽을 수 있게 풀어 쓴다.
 * @param {string} op 연산
 * @param {unknown} value 정규 결과
 * @returns {string} 결과 설명
 */
function describeResult(op,value){
 if(typeof value!=='string'||value.startsWith('E:')||value.startsWith('!'))return JSON.stringify(value);
 if(op==='json'||op==='jsonUnits'||op==='quote')return JSON.stringify(Buffer.from(value,'hex').toString('utf8'));
 if(op==='jsonLossless')return value.split(',').map(part=>JSON.stringify(Buffer.from(part,'hex').toString('utf8'))).join(' | ');
 if(op==='trim'||op==='toLowerCase'||op==='slice')return JSON.stringify(unitsFromHex(value));
 if(NUMBER_RESULT_OPS.has(op)&&/^[0-9a-f]{16}$/.test(value))return `${value}(${formatNumber(numberFromBits(value))})`;
 return JSON.stringify(value);
}

/**
 * 실행 요약을 출력한다: 스위트 표, 불일치·엔진 차이·제외 예시, 마지막 판정 줄.
 * @param {object} run 실행 요약
 */
function printSummary(run){
 console.log(`conformance: seed ${run.seed}, ${run.count} cases per suite, suites ${run.suites.join(',')}, engines ${run.engines.join(',')}`);
 const rows=[['suite','cases','compared','excluded','disagreements','mismatches'],...run.suites.map(name=>{
  const suite=run.bySuite[name],excluded=Object.values(suite.excluded).reduce((sum,value)=>sum+value,0);
  return [name,suite.cases,suite.compared,excluded,suite.disagreements,suite.mismatches];
 })];
 for(const row of rows)console.log(row.map((cell,index)=>index?String(cell).padStart(14):String(cell).padEnd(12)).join(''));
 if(run.engines.length>1)for(const [engine,tally] of Object.entries(run.byEngine)){
  const reasons=Object.entries(tally.divergent),divergent=reasons.reduce((sum,[,count])=>sum+count,0);
  const detail=reasons.length?` (${reasons.map(([reason,count])=>`${reason} ${count}`).join(', ')})`:'';
  console.log(`engine ${engine}: ${tally.matched} matched the kernel${engine==='quickjs'?' (QuickJS dialect)':''}, ${divergent} known divergences${detail}, ${tally.mismatched} mismatched`);
 }
 for(const item of run.examples.mismatches){
  const failures=item.failures.map(failure=>`${failure.engine} expected ${describeResult(item.task.op,failure.expected)} actual ${describeResult(item.task.op,failure.actual)}`).join('; ');
  console.log(`MISMATCH ${item.label} op=${item.task.op} ${describeInput(item.task)} source=${item.source} ${failures}`);
 }
 for(const item of run.examples.disagreements){
  const values=Object.entries(item.engines).map(([engine,value])=>`${engine} ${describeResult(item.task.op,value)}`).join(' ');
  const dialect=item.rust.q===undefined?'':` (QuickJS dialect ${describeResult(item.task.op,item.rust.q)})`;
  console.log(`DISAGREE ${item.label} op=${item.task.op} ${describeInput(item.task)} ${values} rust ${describeResult(item.task.op,item.rust.r)}${dialect}`);
 }
 for(const item of run.examples.excluded.slice(0,5))console.log(`EXCLUDED ${item.label} op=${item.task.op} reason=${item.reason} ${describeInput(item.task)} expected ${describeResult(item.task.op,item.expected)} actual ${describeResult(item.task.op,item.actual)}`);
 for(const [reason,text] of Object.entries(run.knownDivergences))console.log(`known divergence ${reason}: ${text}`);
 const {totals}=run,noun=totals.mismatches===1?'mismatch':'mismatches';
 console.log(`conformance: ${run.result==='pass'?'PASS':'FAIL'} — ${totals.cases} cases: ${totals.compared} compared, ${totals.excluded} excluded, ${totals.disagreements} engine disagreements, ${totals.mismatches} ${noun} (${run.durationSeconds} s)`);
}

/**
 * 비교한 작업이 하나도 없는 스위트(모든 작업이 알려진 차이로 빠졌다). 그런 실행은 아무것도 증명하지 못한다.
 * @param {object} run 실행 요약
 * @returns {string[]} 스위트 이름
 */
const unverifiedSuites=run=>run.suites.filter(name=>run.bySuite[name].cases>0&&run.bySuite[name].compared===0);

/**
 * 보고서에서 같은 선택의 실행을 찾는 열쇠.
 * @param {object} run 실행 요약
 * @returns {string} 열쇠
 */
const runKey=run=>`${run.suites.join(',')}|${run.engines.join(',')}|${run.seed}|${run.count}`;

/**
 * 실행 요약을 JSON 보고서에 합친다. 같은 선택(스위트, 엔진, 시드, 수)의 실행은 바꾸고, 다른 실행은 남긴다.
 * @param {string} path 보고서 경로
 * @param {object} run 실행 요약
 * @throws {HarnessError} 기존 파일이 이 스키마·판의 보고서가 아닐 때
 */
function writeReport(path,run){
 let report={schema:REPORT_SCHEMA,version:REPORT_VERSION,description:'barochart-js (Rust JS-semantics kernel) compared with JavaScript engines on seeded corpora; with --engines every engine is compared with the kernel built for its platform (v8 and jsc: ECMA number dialect r, quickjs: QuickJS number dialect q); written by node scripts/rust/conformance.mjs --report (M1 plan Task 4)',runs:[]};
 if(existsSync(path)){
  try{report=JSON.parse(readFileSync(path,'utf8'));}
  catch(error){throw new HarnessError(`cannot read the report ${path} (${error.message}); fix or delete it`);}
  if(report?.schema!==REPORT_SCHEMA||!Array.isArray(report.runs))throw new HarnessError(`${path} is not a ${REPORT_SCHEMA} report; choose another --report path`);
  if(report.version!==REPORT_VERSION)throw new HarnessError(`${path} is a version ${report.version} report but this harness writes version ${REPORT_VERSION} (engine comparisons changed); move it aside or delete it and rerun`);
 }
 const position=report.runs.findIndex(saved=>runKey(saved)===runKey(run));
 if(position<0)report.runs.push(run);else report.runs[position]=run;
 report.updated=run.date;
 mkdirSync(dirname(path),{recursive:true});
 writeFileSync(path,`${JSON.stringify(report,null,2)}\n`);
}

/**
 * 코퍼스 작업 줄을 표준출력에 흘려 쓴다(백프레셔를 지킨다).
 * @param {object} options 코퍼스 선택
 */
async function emitCorpus(options){
 let buffer='';
 for(const item of corpusCases(options)){
  buffer+=`${JSON.stringify(item.task)}\n`;
  if(buffer.length>=1<<20){if(!process.stdout.write(buffer))await writable(process.stdout);buffer='';}
 }
 if(buffer&&!process.stdout.write(buffer))await writable(process.stdout);
}

/**
 * 정수 옵션을 읽는다.
 * @param {string|undefined} text 옵션 값
 * @param {string} flag 옵션 이름
 * @param {number} fallback 기본값
 * @param {number} low 하한
 * @param {number} high 상한
 * @returns {number} 정수
 * @throws {UsageError} 범위 밖이거나 정수가 아닐 때
 */
function integerOption(text,flag,fallback,low,high){
 if(text===undefined)return fallback;
 const value=/^\d+$/.test(text)?Number(text):NaN;
 if(!(value>=low&&value<=high))throw new UsageError(`${flag} must be an integer from ${low} to ${high}; got "${text}"`);
 return value;
}

/**
 * 쉼표 목록 옵션을 정해진 이름 순서로 읽는다.
 * @param {string|undefined} text 옵션 값
 * @param {string} flag 옵션 이름
 * @param {readonly string[]} names 허용 이름(순서 기준)
 * @param {readonly string[]} fallback 기본값
 * @returns {string[]} 고른 이름(중복 없이 names 순서)
 * @throws {UsageError} 모르는 이름이 있을 때
 */
function listOption(text,flag,names,fallback){
 if(text===undefined)return [...fallback];
 const chosen=new Set(text.split(',').map(name=>name.trim()));
 if(flag==='--suite'&&chosen.delete('all'))for(const name of names)chosen.add(name);
 const unknown=[...chosen].filter(name=>!names.includes(name));
 if(unknown.length||!chosen.size)throw new UsageError(`${flag} accepts ${names.join(',')}${flag==='--suite'?' or all':''}; got "${text}"`);
 return names.filter(name=>chosen.has(name));
}

/**
 * CLI 인자를 읽는다.
 * @param {string[]} args CLI 인자
 * @returns {object} 선택
 * @throws {UsageError} 인자가 잘못됐을 때
 */
function parseOptions(args){
 let values;
 try{
  ({values}=parseArgs({args,strict:true,allowPositionals:false,options:{
   count:{type:'string'},seed:{type:'string'},suite:{type:'string'},engines:{type:'string'},report:{type:'string'},
   'work-dir':{type:'string'},binary:{type:'string'},'emit-corpus':{type:'boolean'},help:{type:'boolean'},
  }}));
 }catch(error){throw new UsageError(error.message);}
 const engines=listOption(values.engines,'--engines',ENGINES,['v8']);
 if(!engines.includes('v8'))throw new UsageError('--engines must include v8, the reference engine');
 return {
  count:integerOption(values.count,'--count',DEFAULTS.count,1,1e9),
  seed:integerOption(values.seed,'--seed',DEFAULTS.seed,0,Number.MAX_SAFE_INTEGER),
  suites:listOption(values.suite,'--suite',SUITES,SUITES),
  engines,
  report:values.report===undefined?null:resolve(values.report),
  workDir:resolve(values['work-dir']??join(tmpdir(),'barochart-conformance')),
  binary:values.binary===undefined?null:resolve(values.binary),
  emitCorpus:values['emit-corpus']??false,
  help:values.help??false,
 };
}

/**
 * CLI 본체.
 * @param {string[]} args CLI 인자
 * @returns {Promise<number>} 종료 코드(0 통과, 1 불일치)
 * @throws {HarnessError} 비교한 작업이 없는 스위트가 있을 때(종료 코드 2)
 */
async function main(args){
 const options=parseOptions(args);
 if(options.help){console.log(USAGE);return 0;}
 if(options.emitCorpus){await emitCorpus(options);return 0;}
 const started=performance.now(),binary=options.binary??buildKernel(),expected=createOracle();
 const context={engines:prepareEngines(options),engineNames:options.engines,kernelUnicode:kernelUnicodeVersion(binary),oracle:task=>{
  try{return expected(task);}catch(error){return oracleFailure(error);}
 }};
 context.unicodeDiffers=majorMinor(context.kernelUnicode)!==majorMinor(process.versions.unicode);
 const stats=createStats(options);
 await compareWithKernel(options,binary,context,stats);
 const run=summarize(stats,options,describeEnvironment(options,context),(performance.now()-started)/1000);
 printSummary(run);
 const unverified=unverifiedSuites(run);
 if(unverified.length)throw new HarnessError(`nothing was compared in suite ${unverified.join(', ')}: every task was excluded as a known divergence, so the run proves nothing; check the KNOWN_DIVERGENCES rules and the kernel answers (the report was not written)`);
 if(options.report)writeReport(options.report,run);
 return run.totals.mismatches?1:0;
}

// CLI: node scripts/rust/conformance.mjs [...]. exitCode를 써서 파이프로 나가는 출력이 잘리지 않게 한다.
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 try{process.exitCode=await main(process.argv.slice(2));}
 catch(error){
  if(error instanceof UsageError)console.error(`conformance: ${error.message}\n${USAGE}`);
  else if(error instanceof HarnessError)console.error(`conformance: ${error.message}`);
  else console.error(`conformance: unexpected failure; this is a harness bug: ${error?.stack??error}`);
  process.exitCode=2;
 }
}
