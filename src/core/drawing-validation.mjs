import {isPositionDrawing,positionMetricsFor} from './position-drawing.mjs';
// Shared structural validation; callers retain their existing copy/commit policy.
import {optionRecord,identifier,boundedText,portableFont,orderedRecord} from './contracts.mjs';
export const DRAWING_TYPES = ['trendline', 'horizontal', 'fibonacci', 'rectangle', 'ellipse', 'text', 'ray', 'extendedline', 'channel', 'fibextension', 'fibfan', 'fibtimezones', 'freehand', 'measurement', 'longposition', 'shortposition'];
/** 저장 드로잉의 정규 키 순서. 레거시 픽스처 순서(id…text) 뒤에 나머지를 허용 목록 순서로 둔다. */
export const DRAWING_RECORD_KEYS=['id','panel','locked','style','type','points','text','visible','axisId','seriesId'];
/** 드로잉 스타일의 정규 키 순서. 레거시 픽스처 순서(color, width) 뒤에 나머지를 허용 목록 순서로 둔다. */
export const DRAWING_STYLE_KEYS=['color','width','fill','font'];
/** 앵커의 정규 키 순서. */
export const DRAWING_POINT_KEYS=['time','price'];
/**
 * 앵커를 정규 키 순서의 새 객체로 만든다.
 * 앵커는 한 문서에 20만 개까지 있으므로, 자기 열거 키가 time·price뿐인 검증된 앵커는 범용 정렬 없이 바로 만든다.
 * 이 지름길이 버리는 심볼 키는 호출자가 하는 JSON 복사(또는 이미 JSON에서 온 입력)에서 어차피 남지 않는다.
 * @param {object} point 검증된 앵커
 * @returns {object} {time, price} 순서의 새 앵커
 */
function canonicalDrawingPoint(point){const keys=Object.keys(point);return keys.length===2&&keys.includes('time')&&keys.includes('price')?{time:point.time,price:point.price}:orderedRecord(point,DRAWING_POINT_KEYS);}
/**
 * 드로잉 레코드를 정규 키 순서의 새 레코드로 만든다. 스타일과 앵커도 새 객체로 정렬하고, 값은 그대로 옮긴다.
 * 평범한 객체로 다시 만들기 때문에 검증을 마친 레코드나 JSON 복사본에만 쓴다. 검증 전에 쓰면 프로토타입 검사를 건너뛰게 된다.
 * 객체가 아닌 앵커·스타일(toJSON이 바꾼 값 등)은 그대로 두어, 뒤이은 validateDrawing이 원래 오류 문구로 거절하게 한다.
 * @param {object} d 검증된 드로잉 레코드
 * @returns {object} 정규 키 순서의 새 드로잉 레코드
 */
export function canonicalDrawing(d){
 const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value),next=orderedRecord(d,DRAWING_RECORD_KEYS);
 if(Array.isArray(next.points))next.points=next.points.map(point=>record(point)?canonicalDrawingPoint(point):point);
 if(record(next.style))next.style=orderedRecord(next.style,DRAWING_STYLE_KEYS);
 return next;
}
export function drawingPointCount(type) {return isPositionDrawing(type)?4:['horizontal','text'].includes(type)?1:['channel','fibextension'].includes(type)?3:2;}
export function validateDrawing(d) {
  optionRecord(d,['id','type','panel','points','style','text','locked','visible','axisId','seriesId'],'Drawing');identifier(d.id,'Drawing id');identifier(d.panel,'Drawing panel');for(const key of ['axisId','seriesId'])if(d[key]!==undefined&&d[key]!==null)identifier(d[key],'Drawing '+key);
  if(!DRAWING_TYPES.includes(d.type))throw new TypeError('Drawing type');const count=drawingPointCount(d.type);
  if(!Array.isArray(d.points)||(d.type==='freehand'?d.points.length<2||d.points.length>2048:d.points.length!==count))throw new TypeError('Drawing anchors');
  for(const point of d.points){optionRecord(point,['time','price'],'Anchor');if(!Number.isFinite(point.time)||Math.abs(point.time)>8640000000000000||!Number.isFinite(point.price))throw new TypeError('Anchor time/price must be finite and within Date range');}
  if(isPositionDrawing(d.type))positionMetricsFor(d);
  if(d.visible!==undefined&&typeof d.visible!=='boolean')throw new TypeError('Drawing visible must be boolean');
  if(d.text!==undefined)boundedText(d.text,2000,'Drawing text',true);if(d.locked!==undefined&&typeof d.locked!=='boolean')throw new TypeError('Locked must be boolean');
  if(d.style!==undefined){optionRecord(d.style,['color','fill','width','font'],'Drawing style');if(d.style.width!==undefined&&(!Number.isFinite(d.style.width)||d.style.width<.1||d.style.width>50))throw new RangeError('Stroke width');for(const key of ['color','fill'])if(d.style[key]!==undefined)boundedText(d.style[key],128,'Color');if(d.style.font!==undefined)portableFont(d.style.font);}
}
