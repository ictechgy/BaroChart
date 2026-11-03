export const RESOURCE_LIMITS=Object.freeze({maxBars:4194304,maxCanvasDimension:16384,maxCanvasPixels:33554432,maxDrawings:10000,maxDrawingPoints:200000,maxDocumentChars:8388608,maxHistoryBytes:33554432,maxPanels:32,maxAxes:64,maxSeries:256,maxIndicators:128});
/** 허용 목록에 있어도 자기 키로는 받지 않는 예약 이름. 프로토타입을 바꾸는 키를 레코드에 남기지 않는다. */
const RESERVED_RECORD_KEYS=['__proto__','constructor','prototype'];
/** 순회 중 덮어쓴 Object.prototype 메서드에 흔들리지 않도록 처음 값을 잡아 둔다. */
const recordEnumerable=Object.prototype.propertyIsEnumerable;
/**
 * 두 문자열을 UTF-16 코드 단위 순서로 비교한다. 기본 sort와 같은 순서지만 기준을 코드에 드러내
 * Rust 이식 때 바이트·코드 포인트 순서와 헷갈리지 않게 한다.
 * @param {string} a 앞 문자열
 * @param {string} b 뒤 문자열
 * @returns {number} a가 앞이면 음수, 같으면 0, 뒤면 양수
 */
function utf16Ascending(a,b){return a<b?-1:a>b?1:0;}
/**
 * 키 배열을 정규 순서로 늘어놓는다.
 * @param {readonly (string|symbol)[]} keys 늘어놓을 키(자기 키 목록)
 * @param {readonly string[]} allowed 앞자리를 정하는 키 목록
 * @returns {(string|symbol)[]} allowed에 있는 키(그 순서) → 나머지 문자열 키(UTF-16 오름차순) → 심볼 키(원래 순서)
 */
function canonicalKeyOrder(keys,allowed){
 const present=new Set(keys),placed=new Set(),ordered=[],rest=[],symbols=[];
 for(const key of allowed)if(present.has(key)&&!placed.has(key)){placed.add(key);ordered.push(key);}
 for(const key of keys){if(typeof key==='symbol')symbols.push(key);else if(!placed.has(key))rest.push(key);}
 return ordered.concat(rest.sort(utf16Ascending),symbols);
}
/**
 * 검증 순회용 키 배열을 돌려준다. 입력 키 순서와 상관없이 같은 배열이 나오므로,
 * 여러 필드가 함께 틀려도 먼저 보고할 필드가 하나로 정해진다.
 * @param {object} value 검사할 레코드
 * @param {readonly string[]} allowed 허용 키 목록. 이 순서가 앞자리를 정한다
 * @param {readonly (string|symbol)[]} [keys=Object.keys(value)] 순회할 키. Reflect.ownKeys로 검사하는 검증기는 그 결과를 넘긴다
 * @returns {(string|symbol)[]} allowed에 있는 키(그 순서) → 허용되지 않은 문자열 키(UTF-16 오름차순) → 심볼 키
 */
export function canonicalKeys(value,allowed,keys=Object.keys(value)){return canonicalKeyOrder(keys,allowed);}
/**
 * keys 순서를 앞에 둔 새 평범한 객체를 만든다. 저장 문서와 반환값의 키 순서를 입력 키 순서와 무관하게 고정한다.
 * - keys에 있는 자기 열거 키를 그 순서대로 먼저 담는다. 값이 undefined인 키도 자리를 유지한다.
 * - 나머지 자기 열거 문자열 키는 UTF-16 코드 단위 오름차순으로, 심볼 키는 원래 순서로 뒤에 붙인다.
 * 객체 펼치기({...value})처럼 getter를 한 번씩 읽고 원본은 바꾸지 않는다. `__proto__`도 평범한 자기 키로 옮긴다.
 * 정수 모양 키는 JS 규칙대로 항상 맨 앞(오름차순)에 온다.
 * @param {object} value 원본 레코드
 * @param {readonly string[]} keys 앞자리를 정하는 키 목록
 * @returns {object} 정규 순서의 새 평범한 객체
 */
export function orderedRecord(value,keys){
 const own=Reflect.ownKeys(value).filter(key=>recordEnumerable.call(value,key));
 return Object.fromEntries(canonicalKeyOrder(own,keys).map(key=>[key,value[key]]));
}
export function optionRecord(value,keys,label='Options') {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError(`${label}: object required`);
 const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)throw new TypeError(`${label}: plain object required`);
 const own=Object.keys(value);
 // 틀린 키가 있을 때만 정규 순서(허용 키 → 나머지 UTF-16 오름차순)로 다시 본다. 예약 이름은 허용 목록에 있어도 나머지로 보낸다
 if(own.some(key=>RESERVED_RECORD_KEYS.includes(key)||!keys.includes(key)))for(const key of canonicalKeys(value,keys.filter(key=>!RESERVED_RECORD_KEYS.includes(key)),own))if(RESERVED_RECORD_KEYS.includes(key)||!keys.includes(key))throw new TypeError(`${label}: unsupported field ${key.slice(0,64)}`);
 return value;
}
export function boundedText(value,max=128,label='Text',empty=false) {if(typeof value!=='string'||value.length>max||!empty&&!value.length)throw new TypeError(`${label}: string limit ${max}`);return value;}
/** 순회 중 String.prototype 변경에 흔들리지 않도록 원래 읽기 함수를 잡아 둔다. */
const jsonDepthCharCodeAt=Function.prototype.call.bind(String.prototype.charCodeAt);
/**
 * JSON.parse 전에 텍스트의 컨테이너 깊이만 반복형으로 검사한다. 문자열·이스케이프 안 괄호는 세지 않고,
 * 나머지 문법 검사는 JSON.parse에 맡긴다. 가장 바깥 배열·객체가 깊이 1이다.
 * JSON.parse와 같은 ToString(string hint, Symbol 거절)을 한 번만 하고 그 텍스트를 반환한다.
 * @param {unknown} value JSON 텍스트 또는 JSON.parse가 문자열로 바꿀 입력
 * @param {number} limit 최대 컨테이너 깊이
 * @param {string} message 넘었을 때의 RangeError 문구
 * @returns {string} 검사한 문자열(호출자는 이것을 JSON.parse에 넘긴다)
 */
export function assertJsonTextDepth(value,limit,message){
 const text=typeof value==='string'?value:`${value}`;
 let depth=0,string=false,escaped=false;
 for(let index=0;index<text.length;index++){
  const code=jsonDepthCharCodeAt(text,index);
  if(string){
   if(escaped)escaped=false;
   else if(code===0x5c)escaped=true;
   else if(code===0x22)string=false;
  }else if(code===0x22)string=true;
  else if(code===0x7b||code===0x5b){if(++depth>limit)throw new RangeError(message);}
  else if((code===0x7d||code===0x5d)&&depth>0)depth--;
 }
 return text;
}
export function sizeLimit(value,max,label='Size') {if(!Number.isSafeInteger(value)||value<0||value>max)throw new RangeError(`${label}: limit ${max}`);return value;}
export function identifier(value,label='Id') {boundedText(value,128,label);if(['__proto__','prototype','constructor'].includes(value))throw new TypeError(`${label}: reserved identifier`);return value;}
export const PANEL_KEYS=['id','weight','label','scale','inverted','padding','range','base','precision','formatter','axisVisible','axisSide'];
export const AXIS_KEYS=['id','panel','side','scale','inverted','padding','range','base','precision','tickFormat','prefix','suffix','label','visible','width','formatter'];
export const SERIES_KEYS=['id','type','panel','source','values','indicator','output','color','fill','width','baseline','offset','upColor','downColor','visible','axisId','symbolId','label'];
export const THEME_KEYS=['background','grid','text','up','down','crosshair','font'];
/** 심볼 레코드의 정규 키 순서. 작업공간 검증기의 허용 목록 순서(필수 8개, 선택 2개)와 같다. */
export const SYMBOL_KEYS=['id','exchange','timezone','currency','volumeUnit','priceDecimals','tickSize','adjustment','provider','adjustmentVersion'];
// Only callbacks installed by ChartAPI.setSymbol can be recreated in a new VM.
// A symbol object alone must not silently authorize replacement of custom callbacks.
const symbolFormatterRecords=new WeakMap();
export function rememberSymbolFormatters(model){symbolFormatterRecords.set(model,{symbol:model.symbol,price:model.priceFormatter,time:model.timeFormatter});}
export function hasPortableFormatters(model){const record=symbolFormatterRecords.get(model);return !model.priceFormatter&&!model.timeFormatter||!!record&&record.symbol===model.symbol&&record.price===model.priceFormatter&&record.time===model.timeFormatter;}

// Portable colors are normalized before crossing the native rendering boundary.
export function portableColor(value) {
 if(typeof value!=='string')throw new TypeError('Color string required');boundedText(value,128,'Color');
 const names={black:'#000000',silver:'#c0c0c0',gray:'#808080',white:'#ffffff',maroon:'#800000',red:'#ff0000',purple:'#800080',fuchsia:'#ff00ff',green:'#008000',lime:'#00ff00',olive:'#808000',yellow:'#ffff00',navy:'#000080',blue:'#0000ff',teal:'#008080',aqua:'#00ffff',transparent:'#00000000'};
 let color=value.trim().toLowerCase();if(Object.hasOwn(names,color))color=names[color];
 if(/^#[\da-f]{3,4}$/.test(color))color='#'+[...color.slice(1)].map(c=>c+c).join('');
 if(/^#[\da-f]{6}$/.test(color))return color+'ff';if(/^#[\da-f]{8}$/.test(color))return color;
 const match=color.match(/^rgba?\(([^)]+)\)$/);
 if(match){const parts=match[1].split(',').map(x=>x.trim());if((parts.length===3||parts.length===4)&&parts.every(x=>/^\d*\.?\d+%?$/.test(x))){const rgb=parts.slice(0,3).map(x=>Number(x.replace('%',''))*(x.endsWith('%')?2.55:1)),alpha=parts.length===4?Number(parts[3].replace('%',''))*(parts[3].endsWith('%')?.01:1):1;if(rgb.every(x=>Number.isFinite(x)&&x>=0&&x<=255)&&Number.isFinite(alpha)&&alpha>=0&&alpha<=1)return '#'+[...rgb,alpha*255].map(x=>Math.round(x).toString(16).padStart(2,'0')).join('');}}
 throw new RangeError('Portable color: hex, comma RGB/RGBA or basic named color required');
}
export function portableFont(value) {
 boundedText(value,256,'Font');const match=value.trim().match(/^((?:(?:bold|italic|normal)\s+)*)(\d+(?:\.\d+)?)px\s+([\w ."'\-,]+)$/);
 if(!match||Number(match[2])<4||Number(match[2])>96)throw new RangeError('Font size limit: 4..96px');return value.trim();
}
export function portableStyle(options,colors=['color','fill','upColor','downColor'],preserveHex=false) {
 const next={...options};for(const key of colors)if(next[key]!==undefined&&!(key==='fill'&&next[key]===null)){const value=next[key];next[key]=preserveHex&&typeof value==='string'&&/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value)?value:portableColor(value);}
 if(next.font!==undefined)next.font=portableFont(next.font);return next;
}
