export const RESOURCE_LIMITS=Object.freeze({maxBars:4194304,maxCanvasDimension:16384,maxCanvasPixels:33554432,maxDrawings:10000,maxDrawingPoints:200000,maxDocumentChars:8388608,maxHistoryBytes:33554432,maxPanels:32,maxAxes:64,maxSeries:256,maxIndicators:128});
export function optionRecord(value,keys,label='Options') {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError(`${label}: object required`);
 const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)throw new TypeError(`${label}: plain object required`);
 for(const key of Object.keys(value))if(['__proto__','constructor','prototype'].includes(key)||!keys.includes(key))throw new TypeError(`${label}: unsupported field ${key.slice(0,64)}`);
 return value;
}
export function boundedText(value,max=128,label='Text',empty=false) {if(typeof value!=='string'||value.length>max||!empty&&!value.length)throw new TypeError(`${label}: string limit ${max}`);return value;}
export function sizeLimit(value,max,label='Size') {if(!Number.isSafeInteger(value)||value<0||value>max)throw new RangeError(`${label}: limit ${max}`);return value;}
export function identifier(value,label='Id') {boundedText(value,128,label);if(['__proto__','prototype','constructor'].includes(value))throw new TypeError(`${label}: reserved identifier`);return value;}
export const PANEL_KEYS=['id','weight','label','scale','inverted','padding','range','base','precision','formatter','axisVisible','axisSide'];
export const AXIS_KEYS=['id','panel','side','scale','inverted','padding','range','base','precision','tickFormat','prefix','suffix','label','visible','width','formatter'];
export const SERIES_KEYS=['id','type','panel','source','values','indicator','output','color','fill','width','baseline','offset','upColor','downColor','visible','axisId','symbolId','label'];
export const THEME_KEYS=['background','grid','text','up','down','crosshair','font'];
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
