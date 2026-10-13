import {buildScene} from './scene.mjs';
import {createDrawingCommands, createCrosshairCommands} from './scene-parts.mjs';

function staticState(model, width, height) {
  const state = [width, height, model.store, model.store.version, model.store.length, model.store.timeVersion, model.view.from, model.view.to, model.axisWidth, model.precision, model.priceFormatter, model.timeFormatter];
  for (const key of ['background', 'grid', 'text', 'up', 'down', 'font']) state.push(model.theme[key]);
  state.push(model.panels.length);
  for (const p of model.panels) state.push(p.id, p.weight, p.scale, p.inverted, p.padding, p.range?.[0], p.range?.[1], p.base, p.precision, p.label,p.formatter,p.axisVisible,p.axisSide);
  state.push(model.axes.length);for(const a of model.axes)state.push(a.id,a.panel,a.side,a.scale,a.inverted,a.padding,a.range?.[0],a.range?.[1],a.base,a.precision,a.tickFormat,a.prefix,a.suffix,a.label,a.visible,a.width,a.formatter);
  state.push(model.series.length);
  for (const s of model.series) {
    state.push(s.id, s.type, s.panel, s.visible, s.offset, s.values, s.source, s.indicator, s.output, s.color, s.upColor, s.downColor, s.fill, s.width, s.baseline,s.dirtyFrom,s.axisId,s.symbolId,s.label);
    const entry = s.indicator ? model.indicators.entries.get(s.indicator) : null;
    state.push(entry, entry?.def, entry?.revision, entry?.dirty, entry?.length);
  }
  return state;
}
function same(a, b) {return !!a && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));}

// One latest scene only. No growing map or full data/output copies on hover.
export class SceneCache {
  constructor() {this.clear();}
  clear() {this.base = null; this.state = null; this.items = null; this.selected = undefined; this.drawingCommands = null;}
  frame(model, width, height, {forceBase = false} = {}) {
    const next = staticState(model, width, height), baseChanged = forceBase || !same(this.state, next);
    let base = this.base;
    if (baseChanged) base = buildScene(model, width, height, {crosshair: false, drawings: false});
    const items = model.drawings.items, drawingsChanged = baseChanged || this.selected !== model.drawings.selected || !same(this.items, items);
    const drawings = drawingsChanged ? model.store.length ? createDrawingCommands(model, base.layout) : [] : this.drawingCommands;
    const hover = createCrosshairCommands(model, base.layout), commands = base.commands.concat(drawings, hover);
    const scene = {...base, commands, stats: {...base.stats, commandCount: commands.length}};
    this.base = base; this.state = staticState(model, width, height); this.items = items.slice(); this.selected = model.drawings.selected; this.drawingCommands = drawings;
    return {scene, base, drawings: {...base, commands: drawings}, hover: {...base, commands: hover}, baseChanged, drawingsChanged};
  }
}
