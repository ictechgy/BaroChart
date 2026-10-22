import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {BarStore, ChartModel, ChartAPI, createLayout, buildScene, drawingGeometry} from '../src/core/index.mjs';
import {buildNativeBundle} from '../scripts/native-core-bundle.mjs';

const W = 800, H = 500, TOP = 12, BOTTOM = 466, HEIGHT = BOTTOM - TOP;
const bits = new DataView(new ArrayBuffer(8));
function nextUp(value) {
  if (value === 0) return Number.MIN_VALUE;
  bits.setFloat64(0, value); const word = bits.getBigUint64(0);
  bits.setBigUint64(0, value < 0 ? word - 1n : word + 1n); return bits.getFloat64(0);
}
function ulpSteps(first, count) {const values = [first]; while (values.length <= count) values.push(nextUp(values.at(-1))); return values;}
function fixture(t, values, {inverted = false, independent = false, automatic = false} = {}) {
  const range = automatic ? undefined : [values[0], values.at(-1)];
  const model = new ChartModel({store: new BarStore(values.map((close, i) => ({time: 1000 + i, open: close, high: close, low: close, close, volume: 1}))),
    panels: [{id: 'price', padding: 0, inverted, ...(independent ? {range: [0, 1]} : {range})}],
    axes: independent ? [{id: 'precise', panel: 'price', padding: 0, range, inverted}] : []});
  const axisId = independent ? 'precise' : null;
  model.addSeries({id: 'prices', type: 'line', panel: 'price', axisId, values: Float64Array.from(values), color: '#123456'});
  model.fit(); t.after(() => model.dispose()); return {model, axisId, axis: () => createLayout(model, W, H).axis('price', axisId)};
}
function near(actual, expected, label, epsilon = 1e-9) {assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: ${actual} != ${expected}`);}

// These fixtures remain in a single binary exponent bin (or subnormal spacing).
// Equal adjacent-bit increments therefore have literal equal screen spacing;
// the oracle does not reuse the chart's normalization or subtraction formula.
for (const first of [100, -100, 1e-12, -1e-12, 1e307, -1e307, Number.MIN_VALUE, -16 * Number.MIN_VALUE]) {
  test(`linear adjacent-binary64 prices keep equal screen spacing from ${first}`, t => {
    const values = ulpSteps(first, 8);
    const step = values[1] - values[0];
    assert(values.every((v, i) => i === 0 || v - values[i - 1] === step), 'fixture spacing must be exact');
    for (const inverted of [false, true]) for (const independent of [false, true]) for (const automatic of [false, true]) {
      const f = fixture(t, values, {inverted, independent, automatic}), axis = f.axis();
      assert.deepEqual([axis.top, axis.bottom, axis.min, axis.max], [TOP, BOTTOM, values[0], values.at(-1)]);
      values.forEach((value, i) => {
        const y = TOP + (inverted ? i / 8 : 1 - i / 8) * HEIGHT;
        near(axis.y(value), y, `anchor ${i}, inverted=${inverted}, independent=${independent}, automatic=${automatic}`);
        assert.equal(axis.price(y), value, `exact representable inverse anchor ${i}`);
      });
    }
  });
}

test('two-ULP ordinary-price domain preserves midpoint in scene, drawing and crosshair readout', t => {
  const values = ulpSteps(100, 2), {model, axisId} = fixture(t, values, {independent: true}), api = new ChartAPI(model);
  const scene = buildScene(model, W, H), path = scene.commands.find(c => c.op === 'path' && c.color === '#123456');
  assert(path); assert.deepEqual(path.points.filter((_, i) => i % 2), [BOTTOM, 239, TOP]);
  const id = model.drawings.add({type: 'horizontal', panel: 'price', axisId, points: [{time: 1001, price: values[1]}]});
  const geometry = drawingGeometry(model.drawings.items.find(d => d.id === id), scene.layout);
  assert(geometry.length); near(geometry[0].coords[1], 239, 'drawing midpoint');
  model.crosshair = {x: scene.layout.x(1), y: 239};
  assert.equal(api.crosshairValues(W, H).axes.find(a => a.id === axisId).value, values[1]);
  assert.deepEqual(Array.from(model.store.columns.close.subarray(0, 3)), values);
});

test('adjacent endpoints, signed zero and cross-zero subnormal anchors stay representable', t => {
  for (const inverted of [false, true]) {
    for (const values of [[100, nextUp(100)], [-100, nextUp(-100)], [Number.MIN_VALUE, 2 * Number.MIN_VALUE]]) {
      const axis = fixture(t, values, {inverted}).axis();
      assert.equal(axis.price(inverted ? TOP : BOTTOM), values[0]); assert.equal(axis.price(inverted ? BOTTOM : TOP), values[1]);
      near(axis.y(values[0]), inverted ? TOP : BOTTOM, 'low'); near(axis.y(values[1]), inverted ? BOTTOM : TOP, 'high');
    }
    const values = [-4 * Number.MIN_VALUE, -2 * Number.MIN_VALUE, 0, 2 * Number.MIN_VALUE, 4 * Number.MIN_VALUE], axis = fixture(t, values, {inverted}).axis();
    values.forEach((v, i) => {const y = TOP + (inverted ? i / 4 : 1 - i / 4) * HEIGHT; near(axis.y(v), y, 'cross-zero'); assert.equal(axis.price(y), v);});
    assert.equal(axis.y(-0), axis.y(0));
  }
});

test('asymmetric cross-zero midpoints retain the finite span rounding residual', t => {
  for (const inverted of [false, true]) for (const independent of [false, true]) {
    for (const [low, high, midpoint] of [[-1, 1 + Number.EPSILON, Number.EPSILON / 2], [-1 - Number.EPSILON, 1, -Number.EPSILON / 2], [-Number.MIN_VALUE, 3 * Number.MIN_VALUE, Number.MIN_VALUE], [-3 * Number.MIN_VALUE, 5 * Number.MIN_VALUE, Number.MIN_VALUE], [-(2 ** -1022) + Number.MIN_VALUE, 2 ** -1022 + Number.MIN_VALUE, Number.MIN_VALUE]]) {
      const axis = fixture(t, [low, midpoint, high], {inverted, independent}).axis();
      near(axis.y(midpoint), 239, 'asymmetric midpoint'); assert.equal(axis.price(239), midpoint);
    }
  }
});

test('overflowing spans and off-domain differences retain finite projections and inverse extrapolation', t => {
  const M = Number.MAX_VALUE;
  for (const inverted of [false, true]) {
    const position = f => TOP + (inverted ? f : 1 - f) * HEIGHT;
    const full = fixture(t, [-M, 0, M], {inverted}).axis();
    for (const [value, f] of [[-M, 0], [-M / 2, .25], [0, .5], [M / 2, .75], [M, 1]]) {
      near(full.y(value), position(f), 'overflowing domain'); assert.equal(full.price(position(f)), value);
    }
    const positive = fixture(t, [M / 2, M], {inverted}).axis();
    near(positive.y(-M), position(-3), 'overflowing off-domain difference'); assert.equal(positive.price(position(-3)), -M);
    const negative = fixture(t, [-M, -M / 2], {inverted}).axis();
    near(negative.y(M / 2), position(3), 'finite opposite-sign projection'); assert.equal(negative.price(position(3)), M / 2);
    const result = negative.price(position(3.5)); assert(Number.isFinite(result)); near(result / M, .75, 'finite extrapolation after intermediate overflow', 4 * Number.EPSILON);
    assert(Number.isNaN(fixture(t, [0, 1], {inverted}).axis().y(M)), 'display-float overflow still rejected');
  }
});

test('narrow representable midpoint survives generated core execution', async () => {
  const context = vm.createContext({}); vm.runInContext(await buildNativeBundle(), context, {timeout: 5000});
  const result = vm.runInContext(`(()=>{const low=100,mid=100.00000000000001,high=100.00000000000003,m=new Aster.ChartModel({panels:[{id:'price',range:[low,high],padding:0}]});const axis=Aster.createLayout(m,800,500).panels[0],r=[axis.y(mid),axis.price(239)];m.dispose();return r;})()`, context, {timeout: 5000});
  assert.deepEqual(Array.from(result), [239, 100.00000000000001]);
});
