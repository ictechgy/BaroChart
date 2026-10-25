import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartAPI, builtinIndicators} from '../src/index.mjs';
import {createIndicatorEditor, INDICATOR_DESCRIPTORS} from '../examples/web/indicator-editor.mjs';
import {fixture} from './helpers/customization-dom.mjs';

function walk(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children ?? []) {
    const found = walk(child, predicate);
    if (found) return found;
  }
  return null;
}

function byId(root, id) {
  const node = walk(root, candidate => candidate.id === id);
  assert.ok(node, `missing #${id}`);
  return node;
}

function paramsFor(name) {
  return {...INDICATOR_DESCRIPTORS[name].defaults};
}

test('indicator editor metadata covers every builtin and its defaults build real definitions', () => {
  assert.equal(builtinIndicators.size, 35);
  assert.deepEqual(new Set(Object.keys(INDICATOR_DESCRIPTORS)), new Set(builtinIndicators.keys()));
  for (const name of builtinIndicators.keys()) {
    const definition = builtinIndicators.get(name)(paramsFor(name));
    assert.ok(Array.isArray(definition.outputs) && definition.outputs.length, name);
  }

  const crossFields = [
    ['macd', {fast: 5, slow: 9, signal: 3}],
    ['keltner', {period: 9, atrPeriod: 5, multiplier: 1.25}],
    ['stochRSI', {period: 7, stochPeriod: 9, smoothK: 2, smoothD: 4}],
    ['vwap', {sessionMs: 3600000, source: 'hl2', deviation: 2}],
    ['pivots', {sessionMs: 3600000}],
    ['parabolicSAR', {step: .01, max: .5}]
  ];
  for (const [name, params] of crossFields) assert.ok(builtinIndicators.get(name)(params).outputs, name);
});

test('editor replaces the bootstrap empty notice when a live chart arrives and uses Korean source labels', t => {
  const env = fixture(t), root = env.node('div'), statuses = [];
  let chart;
  const editor = createIndicatorEditor({root, getChart: () => chart, onStatus: message => statuses.push(message)});
  assert.match(statuses.at(-1), /표시할 지표가 없습니다/);

  const model = env.makeModel(), api = new ChartAPI(model);
  api.addIndicator('ema', 'ema', {});api.addSeries({id: 'ema-line', type: 'line', panel: 'price', indicator: 'ema'});
  chart = {model, api};editor.sync();
  assert.equal(statuses.at(-1), '지표별 기간과 표시 방법을 조정할 수 있습니다.');
  const statusCount = statuses.length;editor.sync();assert.equal(statuses.length, statusCount, 'ordinary repeated sync does not overwrite status');
  const source = byId(root, 'editor-param-source');
  assert.deepEqual(source.children.map(option => option.textContent), ['시각', '시가', '고가', '저가', '종가', '거래량']);
  editor.dispose();
});

test('editor renders accessible controls, keeps drafts stable, and preserves unknown parameters', async t => {
  const env = fixture(t), model = env.makeModel(), api = new ChartAPI(model);
  api.addIndicator('ema', 'ema', {period: 20, source: 'close', customKeep: 'opaque'});
  api.addSeries({id: 'ema-line', type: 'line', panel: 'price', indicator: 'ema', color: '#7898ff', width: 1.5});
  const root = env.node('div'), statuses = [], paramsCalls = [], styleCalls = [];
  const editor = createIndicatorEditor({
    root,
    getChart: () => ({model, api}),
    isBusy: () => false,
    onApplyParams: async (id, params) => { paramsCalls.push([id, params]);api.setIndicatorParams(id, params); },
    onApplyStyle: async (id, patch) => { styleCalls.push([id, patch]);api.setSeries(id, patch); },
    onRemove: async id => api.removeIndicator(id),
    onStatus: message => statuses.push(message)
  });
  assert.ok(byId(root, 'editor-indicator'));
  assert.ok(byId(root, 'editor-param-period'));
  assert.ok(byId(root, 'editor-apply-params'));
  assert.ok(byId(root, 'editor-output'));
  assert.ok(byId(root, 'editor-color'));
  assert.ok(byId(root, 'editor-width'));
  assert.ok(byId(root, 'editor-visible'));
  assert.ok(byId(root, 'editor-apply-style'));
  assert.ok(byId(root, 'editor-remove'));
  const indicatorSelect = byId(root, 'editor-indicator'), firstIndicatorOption = indicatorSelect.children[0];
  editor.sync();
  assert.equal(indicatorSelect.children[0], firstIndicatorOption, 'repeated sync keeps selector option nodes');

  const period = byId(root, 'editor-param-period');period.focus();period.value = '50';period.oninput();editor.sync();
  assert.equal(env.document.activeElement, period, 'hover/stream sync keeps the focused draft control');
  await byId(root, 'editor-apply-params').onclick();
  assert.deepEqual(paramsCalls, [['ema', {period: 50, source: 'close', customKeep: 'opaque'}]]);
  assert.equal(model.indicators.entries.get('ema').params.customKeep, 'opaque');

  api.setSeries('ema-line', {color: '#11223380', width: 2, visible: false});editor.sync();
  const color = byId(root, 'editor-color');assert.equal(color.value, '#112233');
  const width = byId(root, 'editor-width');width.value = '3';width.oninput();
  await byId(root, 'editor-apply-style').onclick();
  assert.deepEqual(styleCalls.at(-1), ['ema-line', {width: 3, visible: false}], 'width edits do not submit an untouched RGB color');
  assert.equal(model.series.find(series => series.id === 'ema-line').color, '#11223380', 'untouched alpha survives style apply');

  period.value = '77';period.oninput();
  api.setIndicatorParams('ema', {period: 20, source: 'close', customKeep: 'replaced'});editor.sync();
  assert.equal(byId(root, 'editor-param-period').value, '20', 'entry replacement resets the parameter draft');
  assert.equal(model.indicators.entries.get('ema').params.customKeep, 'replaced');
  assert.equal(statuses.some(message => /적용했습니다/.test(message)), true);
  editor.dispose();
  assert.equal(root.children.length, 0);
});

test('editor selects duplicate output bindings by series id and resolves implicit first output', async t => {
  const env = fixture(t), model = env.makeModel(), api = new ChartAPI(model), styleCalls = [];
  api.addIndicator('macd', 'macd', {});
  api.addSeries({id: 'macd-first', type: 'line', panel: 'price', indicator: 'macd'});
  api.addSeries({id: 'macd-second', type: 'line', panel: 'price', indicator: 'macd', output: 'macd'});
  api.addSeries({id: 'macd-signal', type: 'line', panel: 'price', indicator: 'macd', output: 'signal'});
  const root = env.node('div');
  const editor = createIndicatorEditor({
    root,
    getChart: () => ({model, api}),
    onApplyStyle: async (id, patch) => { styleCalls.push([id, patch]);api.setSeries(id, patch); }
  });
  const output = byId(root, 'editor-output');
  assert.deepEqual(output.children.map(option => [option.value, option.textContent]), [
    ['macd-first', 'macd · macd-first'],
    ['macd-second', 'macd · macd-second'],
    ['macd-signal', 'signal · macd-signal']
  ]);
  output.value = 'macd-first';output.onchange();
  let width = byId(root, 'editor-width');width.value = '2';width.oninput();await byId(root, 'editor-apply-style').onclick();
  const currentOutput = byId(root, 'editor-output');currentOutput.value = 'macd-second';currentOutput.onchange();
  width = byId(root, 'editor-width');width.value = '3';width.oninput();await byId(root, 'editor-apply-style').onclick();
  assert.deepEqual(styleCalls.map(([id, patch]) => [id, patch.width]), [['macd-first', 2], ['macd-second', 3]]);
  assert.equal(model.series.find(series => series.id === 'macd-first').width, 2);
  assert.equal(model.series.find(series => series.id === 'macd-second').width, 3);
  editor.dispose();
});

test('editor restores async focus and preserves a newer external focus choice', async t => {
  const env = fixture(t), model = env.makeModel(), api = new ChartAPI(model);
  api.addIndicator('ema', 'ema', {});api.addSeries({id: 'ema-line', type: 'line', panel: 'price', indicator: 'ema'});
  api.addIndicator('rsi', 'rsi', {});api.addSeries({id: 'rsi-line', type: 'line', panel: 'price', indicator: 'rsi'});
  const root = env.node('div');let resolveParams,resolveStyle,resolveRemove;
  const editor = createIndicatorEditor({
    root,
    getChart: () => ({model, api}),
    onApplyParams: () => new Promise(resolve => { resolveParams = resolve; }),
    onApplyStyle: () => new Promise(resolve => { resolveStyle = resolve; }),
    onRemove: id => new Promise(resolve => { resolveRemove = () => { api.removeIndicator(id);resolve(); }; })
  });
  const applyParams = byId(root, 'editor-apply-params');applyParams.focus();const paramsWork = applyParams.onclick();
  assert.equal(env.document.activeElement, null, 'busy state may clear the disabled button focus');
  resolveParams();await paramsWork;
  assert.equal(env.document.activeElement, byId(root, 'editor-apply-params'), 'parameter action restores its original control');

  const applyStyle = byId(root, 'editor-apply-style');applyStyle.focus();const styleWork = applyStyle.onclick();
  const external = env.node('button');external.focus();resolveStyle();await styleWork;
  assert.equal(env.document.activeElement, external, 'a newer external focus choice is preserved');

  const remove = byId(root, 'editor-remove');remove.focus();const removeWork = remove.onclick();
  resolveRemove();await removeWork;
  assert.equal(env.document.activeElement, byId(root, 'editor-indicator'), 'removal focuses the surviving indicator picker');
  editor.dispose();
});

test('editor validates cross-fields before callback and removes every bound output', async t => {
  const env = fixture(t), model = env.makeModel(), api = new ChartAPI(model), statuses = [], calls = [];
  api.addIndicator('macd', 'macd', {});
  for (const output of ['macd', 'signal', 'histogram']) api.addSeries({id: `macd-${output}`, type: 'line', panel: 'price', indicator: 'macd', output});
  api.addIndicator('obv', 'obv', {});api.addSeries({id: 'obv-line', type: 'line', panel: 'price', indicator: 'obv'});
  const root = env.node('div');let busy = false;
  const editor = createIndicatorEditor({root, getChart: () => ({model, api}), isBusy: () => busy, onApplyParams: async (...args) => calls.push(args), onApplyStyle: async (...args) => calls.push(['style', ...args]), onRemove: async id => api.removeIndicator(id), onStatus: message => statuses.push(message)});
  editor.select('macd');
  const fast = byId(root, 'editor-param-fast'), slow = byId(root, 'editor-param-slow');fast.value = '30';fast.oninput();slow.value = '20';slow.oninput();
  await byId(root, 'editor-apply-params').onclick();
  assert.equal(calls.length, 0, 'invalid cross-field values do not call the root');
  assert.match(statuses.at(-1), /빠른 기간/);

  busy = true;editor.sync();
  assert.equal(byId(root, 'editor-indicator').disabled, true);
  await byId(root, 'editor-apply-params').onclick();
  await byId(root, 'editor-apply-style').onclick();
  await byId(root, 'editor-remove').onclick();
  assert.equal(editor.select('obv'), null, 'busy picker does not change selection');
  assert.equal(calls.length, 0, 'busy actions never call root callbacks');
  assert.equal(model.indicators.entries.has('macd'), true);
  busy = false;editor.sync();

  editor.select('obv');
  assert.equal(walk(root, candidate => candidate.id?.startsWith('editor-param-')), null, 'OBV has no parameter controls');
  await byId(root, 'editor-remove').onclick();
  assert.equal(model.indicators.entries.has('obv'), false);
  assert.equal(model.series.some(series => series.indicator === 'obv'), false);
  assert.match(statuses.at(-1), /모든 출력/);
  editor.select('macd');await byId(root, 'editor-remove').onclick();
  assert.equal(model.indicators.entries.has('macd'), false);
  assert.equal(model.series.some(series => series.indicator === 'macd'), false);
  editor.dispose();
});

test('editor exposes primitive session fields and keeps Ichimoku displacement read-only', async t => {
  const env = fixture(t), model = env.makeModel(), api = new ChartAPI(model), calls = [];
  api.addIndicator('vwap', 'vwap', {sessionMs: 3600000, source: 'close'});
  api.addSeries({id: 'vwap-line', type: 'line', panel: 'price', indicator: 'vwap'});
  api.addIndicator('cloud', 'ichimoku', {});
  api.addSeries({id: 'cloud-tenkan', type: 'line', panel: 'price', indicator: 'cloud', output: 'tenkan'});
  const root = env.node('div');
  const editor = createIndicatorEditor({
    root,
    getChart: () => ({model, api}),
    onApplyParams: async (id, params) => { calls.push([id, params]);api.setIndicatorParams(id, params); }
  });
  editor.select('vwap');
  assert.ok(byId(root, 'editor-param-sessionMs'));
  assert.ok(byId(root, 'editor-param-source'));
  assert.equal(walk(root, candidate => candidate.id === 'editor-param-calendar'), null);
  assert.equal(walk(root, candidate => candidate.id === 'editor-param-deviation'), null, 'adding bands would change the output schema');
  const sourceInput = byId(root, 'editor-param-source');sourceInput.value = 'hl2';
  await byId(root, 'editor-apply-params').onclick();
  assert.deepEqual(calls[0], ['vwap', {sessionMs: 3600000, source: 'hl2'}]);

  editor.select('cloud');
  const displacement = byId(root, 'editor-param-displacement');
  assert.equal(displacement.readOnly, true);
  assert.equal(displacement.value, '26');
  byId(root, 'editor-param-conversion').value = '10';
  await byId(root, 'editor-apply-params').onclick();
  assert.deepEqual(calls[1], ['cloud', {conversion: 10, base: 26, span: 52}]);
  assert.deepEqual(model.indicators.entries.get('cloud').def.plotOffsets, {spanA: 26, spanB: 26, chikou: -26});
  editor.dispose();
});
