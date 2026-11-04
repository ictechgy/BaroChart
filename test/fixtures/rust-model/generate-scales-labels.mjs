#!/usr/bin/env node
// 공개 ChartModel/createLayout과 실제 label helper에서 M4 대조 벡터를 만든다.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ORACLE_COMMIT = 'e0ab2f917a297a48f844cdae90d5877d768698fd';
const BUNDLE_SHA256 = '007ac99f8553b5912ef0c32ec392b5d30d196daf97bb17181c183004258ef512';
const SOURCES = {
  'src/core/model.mjs': '64bb1a0a042841a9386a6f8f500c0e5f96a952d4a09602f91e2f3ef333f356ad',
  'src/core/labels.mjs': 'a5f47cd2a29aead2ee553a2acf2f6c3125205b353c29ad956f304391bad93ffa',
  'src/core/contracts.mjs': '832a919e16aa29f5c5655210308256e6195c032fc9e4831176e4adf53e4b78e2',
};
const SCHEMA = 'aster.rust-model-scales-labels';
const SCHEMA_VERSION = 1;
const PINNED_NODE = 'v22.20.0';
const PINNED_V8 = '12.4.254.21-node.33';
const DIALECT = 'Ecma';
const WIDTH = 800, HEIGHT = 500;
const [
  {BarStore, ChartModel, createLayout},
  labels,
] = await Promise.all([
  import(pathToFileURL(resolve(ROOT, 'src/core/index.mjs'))),
  import(pathToFileURL(resolve(ROOT, 'src/core/labels.mjs'))),
]);

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [path, expected] of Object.entries(SOURCES)) {
  assert.equal(sha256(await readFile(resolve(ROOT, path))), expected, `${path} changed from the reviewed oracle`);
}
assert.equal(
  sha256(await readFile(resolve(ROOT, 'native/Resources/aster-core.js'))),
  BUNDLE_SHA256,
  'native bundle changed from the recorded JS source snapshot',
);

const metadata = {
  schema: SCHEMA,
  schemaVersion: SCHEMA_VERSION,
  oracleCommit: ORACLE_COMMIT,
  bundleSha256: BUNDLE_SHA256,
  sourceSha256: SOURCES,
  numberDialect: DIALECT,
  runtime: process.version,
  v8: process.versions.v8,
  icu: process.versions.icu,
  unicode: process.versions.unicode,
  tz: process.versions.tz,
};

const writeFixture = process.argv.includes('--write');
const checkFixture = process.argv.includes('--check');
assert(!(writeFixture && checkFixture), 'Choose either --write or --check');
if (writeFixture || checkFixture) {
  assert.equal(process.version, PINNED_NODE, `Fixture oracle requires Node ${PINNED_NODE}`);
  assert.equal(process.versions.v8, PINNED_V8, `Fixture oracle requires V8 ${PINNED_V8}`);
}

const bitBuffer = new DataView(new ArrayBuffer(8));
function encodeNumber(value) {
  if (Number.isNaN(value)) return {$f64: 'NaN'};
  if (value === Infinity) return {$f64: 'Infinity'};
  if (value === -Infinity) return {$f64: '-Infinity'};
  if (Object.is(value, -0)) return {$f64: '-0'};
  bitBuffer.setFloat64(0, value, false);
  return {$f64: bitBuffer.getBigUint64(0, false).toString(16).padStart(16, '0')};
}
function wire(value) {
  if (typeof value === 'number') return encodeNumber(value);
  if (Array.isArray(value)) return value.map(wire);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).map(key => [key, wire(value[key])]));
}
const rowText = row => JSON.stringify(wire(row));

const MAX = Number.MAX_VALUE, MIN = Number.MIN_VALUE;
function nextUp(value) {
  if (value === 0) return MIN;
  bitBuffer.setFloat64(0, value, false);
  const bits = bitBuffer.getBigUint64(0, false);
  bitBuffer.setBigUint64(0, value < 0 ? bits - 1n : bits + 1n, false);
  return bitBuffer.getFloat64(0, false);
}

const axisScenarios = [
  {id: 'linear.auto-padding', values: [10, 20, 30], scale: 'linear', padding: .08, samples: [0, 10, 20, 30, 40]},
  {id: 'linear.explicit-range-inverted', values: [-2, 5, 8], scale: 'linear', padding: .2, range: [-10, 10], inverted: true, samples: [-10, -2, 5, 10, 30]},
  {id: 'histogram.zero-baseline', values: [2, 10], seriesType: 'histogram', baseline: 0, scale: 'linear', padding: .1, samples: [-1, 0, 2, 10, 11]},
  {id: 'linear.equal-domain-padding-zero', values: [5, 5, 5], scale: 'linear', padding: 0, samples: [4.999999999995, 5, 5.000000000005]},
  {id: 'linear.narrow-binary64', values: [100, nextUp(100), nextUp(nextUp(100))], scale: 'linear', padding: 0, samples: [100, nextUp(100), nextUp(nextUp(100))]},
  {id: 'linear.cross-zero-subnormal', values: [-4 * MIN, -2 * MIN, 0, 2 * MIN, 4 * MIN], scale: 'linear', padding: 0, samples: [-4 * MIN, -MIN, 0, MIN, 4 * MIN]},
  {id: 'linear.opposite-max-span', values: [-MAX, 0, MAX], scale: 'linear', padding: 0, inverted: true, samples: [-MAX, -MAX / 2, 0, MAX / 2, MAX]},
  {id: 'linear.projection-overflow', values: [MAX / 2, MAX], scale: 'linear', padding: 0, range: [0, 1], samples: [MAX]},
  {id: 'log.positive-inverted', values: [1, Math.E], scale: 'log', padding: 0, inverted: true, samples: [1, 2, Math.E], screenSamples: [12, 239, 466]},
  {
    id: 'log.wide-explicit-range-inverted',
    barValues: [0.01, 1e300],
    seriesType: 'candles',
    scale: 'log',
    padding: 0,
    range: [0.01, 1e300],
    inverted: true,
    samples: [0.01, 1, 2, Math.E, 1e150, 1e300],
    screenSamples: [12, 239, 466],
  },
  {
    id: 'log.wide-padding-positive-min-inverted',
    barValues: [1, 10],
    seriesType: 'candles',
    scale: 'log',
    padding: 0.11,
    inverted: true,
    samples: [0.01, 1, 2, Math.E, 1e150, 1e300],
    screenSamples: [12, 239, 466],
  },
  {id: 'log.nonpositive-visible-data', values: [-1, 1, 10], scale: 'log', padding: 0, samples: [-1, 1, 10]},
  {id: 'log.padding-crosses-zero', values: [1, 10], scale: 'log', padding: .2, samples: [1, 2, 10]},
  {id: 'percent.explicit-base', values: [90, 100, 110], scale: 'percent', base: 100, padding: 0, samples: [80, 90, 100, 110, 120]},
  {id: 'percent.default-first-close-base', values: [90, 100, 110], scale: 'percent', padding: 0, storeFirstClose: 100, samples: [90, 100, 110]},
  {id: 'percent.transform-overflow', values: [-MAX, MAX], scale: 'percent', base: MIN, padding: 0, samples: [-MAX, 0, MAX]},
  {id: 'linear.no-finite-visible-values', values: [NaN, Infinity], scale: 'linear', padding: .08, samples: [0, 1, 10]},
];

function sourceBounds(scenario) {
  let min = Infinity, max = -Infinity;
  for (const value of scenario.barValues ?? scenario.values) {
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const hasBaseline = ['histogram', 'area'].includes(scenario.seriesType);
  const baseline = scenario.baseline ?? 0;
  if (hasBaseline) {
    min = Math.min(min, baseline);
    max = Math.max(max, baseline);
  }
  return {
    sourceMin: min,
    sourceMax: max,
    zeroBaseline: min === 0 && hasBaseline && baseline === 0,
  };
}

function makeBars(scenario) {
  if (scenario.barValues) {
    return scenario.barValues.map((value, index) => ({
      time: 1_700_000_000_000 + index * 60_000,
      open: value,
      high: value,
      low: value,
      close: value,
      volume: 1,
    }));
  }
  const close = scenario.storeFirstClose ?? scenario.values.find(Number.isFinite) ?? 1;
  return scenario.values.map((_, index) => ({
    time: 1_700_000_000_000 + index * 60_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));
}

function axisVector(scenario) {
  const bars = makeBars(scenario);
  let model;
  const bounds = sourceBounds(scenario);
  const screenSamples = scenario.screenSamples ?? [12, 239, 466, -895, 1378];
  const input = {
    source_min: bounds.sourceMin,
    source_max: bounds.sourceMax,
    scale: scenario.scale,
    padding: scenario.padding,
    range: scenario.range ?? null,
    base: scenario.base ?? null,
    first_close: bars.length ? bars[0].close : null,
    zero_baseline: bounds.zeroBaseline,
    inverted: scenario.inverted ?? false,
    top: 12,
    bottom: 466,
    samples: scenario.samples,
    screen_samples: screenSamples,
  };
  // Linux native QuickJS가 같은 공개 ChartModel/createLayout 입력을 다시 실행할 수 있게
  // V8 기대값과 분리된 원본 series/bar 구성도 함께 보존한다. Rust 결과에서 파생하지 않는다.
  const oracleModel = wire({
    values: scenario.values ?? null,
    barValues: scenario.barValues ?? null,
    seriesType: scenario.seriesType ?? 'line',
    baseline: scenario.baseline ?? null,
    storeFirstClose: scenario.storeFirstClose ?? null,
  });
  try {
    const panel = {
      id: 'price',
      scale: scenario.scale,
      padding: scenario.padding,
      inverted: scenario.inverted ?? false,
    };
    if (scenario.range !== undefined) panel.range = scenario.range;
    if (scenario.base !== undefined) panel.base = scenario.base;
    model = new ChartModel({store: new BarStore(bars), panels: [panel]});
    model.addSeries({
      id: 'axis-source',
      type: scenario.seriesType ?? 'line',
      panel: 'price',
      ...(scenario.baseline === undefined ? {} : {baseline: scenario.baseline}),
      ...(scenario.values === undefined ? {} : {values: Float64Array.from(scenario.values)}),
    });
    model.setVisibleRange(0, bars.length - 1);
    const layout = createLayout(model, WIDTH, HEIGHT);
    const axis = layout.axis('price');
    input.top = axis.top;
    input.bottom = axis.bottom;
    const result = {
      min: axis.min,
      max: axis.max,
      base: axis.base,
      top: axis.top,
      bottom: axis.bottom,
      lo: axis.lo,
      hi: axis.hi,
      y: scenario.samples.map(value => axis.y(value)),
      price: input.screen_samples.map(value => axis.price(value)),
      transform: scenario.samples.map(value => axis.transform(value)),
      inverse: scenario.samples.map(value => axis.inverse(axis.transform(value))),
    };
    return {
      ...metadata,
      kind: 'axis',
      scenarioId: scenario.id,
      oracleModel,
      input: rowText(input),
      expected: rowText(result),
      error: null,
    };
  } catch (error) {
    return {
      ...metadata,
      kind: 'axis',
      scenarioId: scenario.id,
      oracleModel,
      input: rowText(input),
      expected: null,
      error: {name: error.name, message: error.message},
    };
  } finally {
    model?.dispose();
  }
}

const metricFonts = [
  '12px monospace', '14px sans-serif', 'noise 1..2px invalid', 'prefix .5px',
  'prefix 12.px', 'leading 00012px', 'font 1e2px', 'no size', null, 18, [14, 'px'],
  '96px monospace',
  {family: 'sans-serif'},
];
const textValues = [
  'MW@% ASCII', '한글/漢字', 'emoji 😀 rocket 🚀', 'a\tb\n c\u00a0d\u2028e',
  '\ud800 lone high', 'lone low \udfff', '',
];
const font = '12px monospace';
function labelVectors() {
  const rows = [];
  for (const [index, font] of metricFonts.entries()) {
    rows.push({
      ...metadata,
      kind: 'labelMetrics',
      scenarioId: `label-metrics-${index}`,
      input: rowText({font}),
      expected: rowText(labels.labelMetrics(font)),
    });
  }
  const metrics = labels.labelMetrics(font);
  for (const [index, value] of textValues.entries()) {
    rows.push({
      ...metadata,
      kind: 'labelWidth',
      scenarioId: `label-width-${index}`,
      input: rowText({value, metrics}),
      expected: rowText(labels.labelWidth(value, metrics)),
    });
  }
  const fits = [
    ['ascii-truncate', 'WM% label text', 40, font],
    ['cjk-emoji-truncate', '中文 😀 label 🚀', 54, font],
    ['whitespace-collapse', 'a\tb\nc\u00a0d\u2028e', 100, font],
    ['ellipsis-too-wide', 'x', 1, '24px monospace'],
    ['zero-width', 'x', 0, font],
    ['negative-width', 'x', -1, font],
    ['nan-width', 'x', NaN, font],
    ['infinite-width', 'x', Infinity, font],
    ['lone-surrogates', '\ud800abc\udfff', 50, font],
  ];
  for (const [scenarioId, value, maxWidth, fontValue] of fits) {
    rows.push({
      ...metadata,
      kind: 'fitLabel',
      scenarioId,
      input: rowText({value, maxWidth, font: fontValue}),
      expected: rowText(labels.fitLabel(value, maxWidth, labels.labelMetrics(fontValue))),
    });
  }
  rows.push({
    ...metadata,
    kind: 'labelCommand',
    scenarioId: 'command-metadata-overrides-and-full-text',
    input: rowText({
      value: 'long heading 🚀', x: 3.5, y: 20.25, maxWidth: 54, font,
      color: '#ff0000', clip: [0, 0, 320, 200],
      metadata: {text: 'metadata text', x: 99, fullText: 'metadata full', extra: '\ud800'},
    }),
    expected: rowText(labels.labelCommand(
      'long heading 🚀', 3.5, 20.25, 54, font, '#ff0000', [0, 0, 320, 200],
      {text: 'metadata text', x: 99, fullText: 'metadata full', extra: '\ud800'},
    )),
  });
  rows.push({
    ...metadata,
    kind: 'labelCommand',
    scenarioId: 'command-320px-large-font-ellipsis',
    input: rowText({
      value: 'A long label with CJK 中文 and emoji 🚀', x: 8, y: 120, maxWidth: 320,
      font: '96px monospace', color: '#112233', clip: [0, 0, 320, 200], metadata: {source: 'axis-title'},
    }),
    expected: rowText(labels.labelCommand(
      'A long label with CJK 中文 and emoji 🚀', 8, 120, 320, '96px monospace', '#112233',
      [0, 0, 320, 200], {source: 'axis-title'},
    )),
  });
  rows.push({
    ...metadata,
    kind: 'panelTitle',
    scenarioId: 'panel-title-visible-deduplicated-labels',
    input: rowText({
      panel: {id: 'price', label: 'Price'},
      series: [
        {panel: 'price', visible: true, label: 'EMA'},
        {panel: 'price', visible: true, label: 'EMA', indicator: 'ignored'},
        {panel: 'price', visible: true, indicator: 'MFI'},
        {panel: 'price', visible: true, label: ''},
        {panel: 'price', visible: false, label: 'Hidden'},
        {panel: 'other', visible: true, label: 'Other'},
        {panel: 'price', visible: true, label: '\ud800'},
      ],
    }),
    expected: rowText(labels.panelTitle(
      {series: [
        {panel: 'price', visible: true, label: 'EMA'},
        {panel: 'price', visible: true, label: 'EMA', indicator: 'ignored'},
        {panel: 'price', visible: true, indicator: 'MFI'},
        {panel: 'price', visible: true, label: ''},
        {panel: 'price', visible: false, label: 'Hidden'},
        {panel: 'other', visible: true, label: 'Other'},
        {panel: 'price', visible: true, label: '\ud800'},
      ]},
      {id: 'price', label: 'Price'},
    )),
  });
  return rows;
}

const axisRows = axisScenarios.map(axisVector);
const rows = [...axisRows, ...labelVectors()];
if (writeFixture || checkFixture) {
  // Node/V8 is the existing fixture source. Store a second exact output for successful log
  // cases because native Rust uses platform libm (matching local JavaScriptCore), while the
  // wasm harness imports V8 Math.log/exp.
  const successfulLogScenarios = axisScenarios.filter(scenario => {
    const row = axisRows.find(candidate => candidate.scenarioId === scenario.id);
    return scenario.scale === 'log' && row?.expected !== null;
  });
  const jscPath = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc';
  const jscOutput = execFileSync(
    jscPath,
    ['-m', resolve(ROOT, 'test/fixtures/rust-model/generate-scales-labels-jsc.mjs'), '--', JSON.stringify(successfulLogScenarios)],
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024},
  );
  const jscGoldens = new Map(jscOutput.trim().split('\n').filter(Boolean).map(line => {
    const row = JSON.parse(line);
    return [row.scenarioId, row.expectedJsc];
  }));
  assert.equal(jscGoldens.size, successfulLogScenarios.length, 'JavaScriptCore oracle missed a log scenario');
  const axisRowsWithJsc = axisRows.map(row => {
    const expectedJsc = jscGoldens.get(row.scenarioId);
    return expectedJsc === undefined ? row : {...row, expectedJsc};
  });
  const destination = resolve(ROOT, 'test/fixtures/rust-model');
  await mkdir(destination, {recursive: true});
  const fixture = [...axisRowsWithJsc, ...rows.slice(axisRows.length)]
    .map(row => JSON.stringify(row)).join('\n') + '\n';
  const fixturePath = resolve(destination, 'scales-labels-oracle.jsonl');
  if (writeFixture) {
    await writeFile(fixturePath, fixture);
  } else {
    assert.equal(
      await readFile(fixturePath, 'utf8'),
      fixture,
      'Fixture is stale; regenerate it with the pinned Node 22 oracle using --write',
    );
  }
  process.stdout.write(`${axisRows.length} axis vectors; ${rows.length - axisRows.length} label vectors\n`);
} else {
  process.stdout.write(`${JSON.stringify({axis: axisRows.length, labels: rows.length - axisRows.length, ...metadata})}\n`);
}
