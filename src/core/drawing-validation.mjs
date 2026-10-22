import {isPositionDrawing,positionMetricsFor} from './position-drawing.mjs';
// Shared structural validation; callers retain their existing copy/commit policy.
import {optionRecord,identifier,boundedText,portableFont} from './contracts.mjs';
export const DRAWING_TYPES = ['trendline', 'horizontal', 'fibonacci', 'rectangle', 'ellipse', 'text', 'ray', 'extendedline', 'channel', 'fibextension', 'fibfan', 'fibtimezones', 'freehand', 'measurement', 'longposition', 'shortposition'];
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
