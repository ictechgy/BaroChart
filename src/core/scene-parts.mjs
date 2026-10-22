import {isPositionDrawing} from './position-drawing.mjs';
import {resolveCrosshairSnapshot,crosshairAxisPrice} from './crosshair-snap.mjs';
import {drawingGeometry} from './drawings.mjs';
import {boundedText,portableColor} from './contracts.mjs';
import {labelMetrics,labelCommand} from './labels.mjs';

// Internal display-list parts shared by full/native scenes and browser layers.
// They take the same layout, so overlay coordinates and price units cannot drift.
export function formatAxisValue(model, axis, value) {
  const precision=axis.precision??(axis.scale==='percent'?2:model.precision);
  if(axis.formatter)return boundedText(String(axis.formatter(value)),256,'Axis formatter output',true);
  if(axis.axisId==null&&axis.scale!=='percent'&&model.priceFormatter&&axis.id==='price')return boundedText(String(model.priceFormatter(value)),256,'Price formatter output',true);
  const n=axis.scale==='percent'?axis.transform(value):value;
  return (axis.prefix??'')+(axis.tickFormat==='scientific'?n.toExponential(precision):n.toFixed(precision))+(axis.scale==='percent'?'%':'')+(axis.suffix??'');
}

export function aggregateVolumeSeries(series) {
  return series.type === 'histogram' && series.source === 'volume' && !series.values && !series.indicator && (series.offset ?? 0) === 0 && (series.baseline ?? 0) === 0;
}

export function createDrawingCommands(model, layout) {
  const commands = [], theme = model.theme;
  for (const drawing of model.drawings.items) {
    if(drawing.visible===false)continue;
    const panel = layout.drawingAxis(drawing);
    if (!panel) continue;
    if(isPositionDrawing(drawing.type)&&drawing.points.some(point=>{const q=layout.toScreen(point,drawing.panel,drawing.axisId);return !Number.isFinite(q.x)||!Number.isFinite(q.y);}))continue;
    const a = layout.toScreen(drawing.points[0], drawing.panel,drawing.axisId), b = drawing.points[1] ? layout.toScreen(drawing.points[1], drawing.panel,drawing.axisId) : a;
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
    const color = drawing.style?.color ?? '#f5b85a', clip = [panel.left, panel.top, panel.right - panel.left, panel.bottom - panel.top];
    for (const command of drawingGeometry(drawing, layout)) commands.push(command.op === 'text' ? {...command, font: drawing.style?.font ?? theme.font} : command);
    if (drawing.id === model.drawings.selected) for (const point of drawing.points) {
      const p = layout.toScreen(point, drawing.panel,drawing.axisId);
      commands.push({op: 'box', x: p.x - 4, y: p.y - 4, w: 8, h: 8, fill: drawing.locked ? theme.text : theme.background, color, width: 1, clip});
    }
  }
  return commands;
}

export function createCrosshairCommands(model, layout) {
  const cursor = model.crosshair, commands = [], theme = model.theme;
  if (!cursor || !model.store.length) return commands;
  const snapshot=resolveCrosshairSnapshot(model,layout);if(!snapshot)return commands;const {x,y}=snapshot.resolved,panel=layout.panels.find(p=>p.id===snapshot.panel);
  for (const p of layout.panels) commands.push({op: 'lines', coords: [x, p.top, x, p.bottom], color: theme.crosshair, width: 1, clip: null, dash: [4, 4]});
  commands.push({op: 'lines', coords: [panel.left, y, panel.right, y], color: theme.crosshair, width: 1, clip: null, dash: [4, 4]});
  const metrics=labelMetrics(theme.font),background=portableColor(theme.background).slice(0,7)+'ff';
  if(panel.bottom-panel.top>=metrics.height+8)for(const axis of panel.axes.filter(a=>a.visible)){
    const clip=[axis.axisLeft,panel.top,axis.axisRight-axis.axisLeft,panel.bottom-panel.top],top=Math.max(panel.top+4,Math.min(panel.bottom-metrics.height-4,y-metrics.height/2)),command=labelCommand(formatAxisValue(model,axis,crosshairAxisPrice(snapshot,axis)),axis.axisLeft+4,top+metrics.ascent,axis.axisRight-axis.axisLeft-8,theme.font,theme.crosshair,clip,{role:'crosshair-price',panelId:panel.id,axisId:axis.axisId});
    if(command){commands.push({op:'box',x:axis.axisLeft,y:top-4,w:axis.axisRight-axis.axisLeft,h:metrics.height+8,fill:background,color:background,width:0,clip});commands.push(command);}
  }
  return commands;
}

// Shared readout keeps native cached hover on the already prepared layout.
export function crosshairValuesAt(model,layout){
  const c=model.crosshair;if(!c||!model.store.length)return null;const snapshot=resolveCrosshairSnapshot(model,layout);if(!snapshot)return null;const p=layout.panels.find(p=>p.id===snapshot.panel);
  const index=snapshot.snapped?snapshot.index:Math.round(layout.index(c.x));if(index<0||index>=model.store.length)return null;const store=model.store;
  return {index,time:store.columns.time[index],primary:{symbolId:model.symbol?.id??null,bar:store.at(index)},series:model.series.filter(s=>s.visible!==false).map(s=>{const sourceIndex=index-(s.offset??0);let array=s.values;if(array==null){if(s.indicator){const data=model.indicators.get(s.indicator);array=data.outputs[s.output??Object.keys(data.outputs)[0]];}else array=store.columns[s.source??'close'];}const value=sourceIndex>=0&&sourceIndex<store.length?array[sourceIndex]:NaN,finite=Number.isFinite(value);return {id:s.id,label:s.label??s.id,symbolId:s.values?s.symbolId??null:model.symbol?.id??null,panel:s.panel,axisId:s.axisId??null,value:finite?value:null,sourceIndex,sourceTime:finite?store.columns.time[sourceIndex]:null};}),axes:p.axes.map(a=>({id:a.axisId,panel:p.id,value:crosshairAxisPrice(snapshot,a),formatted:formatAxisValue(model,a,crosshairAxisPrice(snapshot,a))}))};
}
