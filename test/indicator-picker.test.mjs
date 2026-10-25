import test from 'node:test';
import assert from 'node:assert/strict';
import {builtinIndicators} from '../src/core/index.mjs';
import {createIndicatorPicker, filterIndicatorCatalog, INDICATOR_CATALOG} from '../examples/web/indicator-picker.mjs';
import {fixture, event} from './helpers/customization-dom.mjs';

function controls(env, initial = 'ema') {
  const search = env.node('input');
  const category = env.node('select');
  const all = env.node('option'); all.value = ''; all.textContent = '전체'; category.append(all);
  const select = env.node('select'); select.value = initial;
  const summary = env.node('p');
  return {search, category, select, summary};
}

test('picker metadata is immutable and covers every builtin registry key', () => {
  assert.equal(INDICATOR_CATALOG.length, builtinIndicators.size);
  assert.deepEqual(new Set(INDICATOR_CATALOG.map(item => item.id)), new Set(builtinIndicators.keys()));
  assert.ok(Object.isFrozen(INDICATOR_CATALOG));
  for (const item of INDICATOR_CATALOG) {
    assert.ok(Object.isFrozen(item));
    assert.ok(item.name && item.koreanName && item.aliases.length);
    assert.ok(['trend', 'momentum', 'volatility', 'volume'].includes(item.category));
  }
  assert.deepEqual(filterIndicatorCatalog(' RSI ').map(item => item.id), ['rsi', 'stochRSI']);
  assert.deepEqual(filterIndicatorCatalog('볼린저').map(item => item.id), ['bollinger']);
  assert.deepEqual(filterIndicatorCatalog('bands bollinger').map(item => item.id), ['bollinger']);
  assert.deepEqual(filterIndicatorCatalog('average exponential').map(item => item.id), ['ema', 'dema', 'tema', 'trix']);
  assert.deepEqual(filterIndicatorCatalog('거래량 가중 평균 가격').map(item => item.id), ['vwap']);
  assert.deepEqual(filterIndicatorCatalog('이동 평균').map(item => item.id), ['sma', 'vwma', 'ema', 'wma', 'macd', 'dema', 'tema', 'hma']);
  assert.deepEqual(filterIndicatorCatalog('', 'volume').map(item => item.id), ['obv', 'vwap', 'mfi', 'cmf', 'adl', 'chaikin', 'forceIndex', 'volumeOscillator']);
});

test('picker renders filtered labels, preserves selection, and reports empty results', t => {
  const env = fixture(t), controlsSet = controls(env), selected = [];
  const picker = createIndicatorPicker({...controlsSet, onSelect: value => selected.push(value)});
  assert.equal(controlsSet.select.children.length, 35);
  assert.equal(controlsSet.select.value, 'ema');
  assert.match(controlsSet.select.children.find(option => option.value === 'ema').textContent, /Exponential Moving Average/);

  controlsSet.search.value = ' Bollinger ';
  event(controlsSet.search, 'input');
  assert.deepEqual(controlsSet.select.children.map(option => option.value), ['bollinger']);
  assert.equal(controlsSet.select.value, 'bollinger');
  assert.match(controlsSet.summary.textContent, /1.*볼린저|1.*indicator/i);

  controlsSet.search.value = 'does not exist';
  event(controlsSet.search, 'input');
  assert.equal(controlsSet.select.children.length, 0);
  assert.equal(controlsSet.select.value, '');
  assert.match(controlsSet.summary.textContent, /없|no result/i);
  assert.equal(picker.selectedName, null);
  assert.equal(selected.at(-1), null);
  picker.destroy();
});

test('picker handles categories, IME composition, Escape, availability, and destruction', t => {
  const env = fixture(t), controlsSet = controls(env), selected = [];
  const picker = createIndicatorPicker({...controlsSet, onSelect: value => selected.push(value)});
  controlsSet.category.value = 'trend';
  event(controlsSet.category, 'change');
  assert.ok(controlsSet.select.children.length > 0);
  assert.ok(controlsSet.select.children.every(option => ['sma', 'vwma', 'ema', 'wma', 'dema', 'tema', 'hma', 'supertrend', 'ichimoku', 'adx', 'vortex', 'pivots', 'parabolicSAR', 'aroon'].includes(option.value)));

  controlsSet.category.value = '';
  event(controlsSet.category, 'change');
  controlsSet.search.value = 'rsi';
  event(controlsSet.search, 'input');
  event(controlsSet.search, 'compositionstart');
  event(controlsSet.search, 'input');
  assert.equal(controlsSet.select.children.length, 2, 'composition does not clear the current result');
  event(controlsSet.search, 'compositionend');
  assert.deepEqual(controlsSet.select.children.map(option => option.value), ['rsi', 'stochRSI']);
  event(controlsSet.search, 'compositionstart');
  event(controlsSet.search, 'keydown', {key: 'Escape', isComposing: false});
  assert.equal(controlsSet.search.value, 'rsi', 'Escape does not clear during active composition');
  event(controlsSet.search, 'keydown', {key: 'Escape', isComposing: true});
  assert.equal(controlsSet.search.value, 'rsi', 'Escape does not clear composing events');
  event(controlsSet.search, 'compositionend');
  controlsSet.search.focus();
  event(controlsSet.search, 'keydown', {key: 'Escape'});
  assert.equal(controlsSet.search.value, '');
  assert.equal(env.document.activeElement, controlsSet.search);

  picker.sync({busy: true, ready: false});
  assert.equal(controlsSet.search.disabled, false);
  assert.equal(controlsSet.category.disabled, false);
  assert.equal(controlsSet.select.disabled, false);
  controlsSet.select.value = 'rsi';
  event(controlsSet.select, 'change');
  assert.match(controlsSet.summary.textContent, /상대강도지수/);
  picker.destroy();
  const before = controlsSet.select.children.length;
  controlsSet.search.value = 'macd';
  event(controlsSet.search, 'input');
  assert.equal(controlsSet.select.children.length, before);
});

test('empty catalog disables controls and has no selected value', t => {
  const env = fixture(t), controlsSet = controls(env);
  const picker = createIndicatorPicker({...controlsSet, catalog: []});
  assert.equal(controlsSet.search.disabled, true);
  assert.equal(controlsSet.category.disabled, true);
  assert.equal(controlsSet.select.disabled, true);
  assert.equal(controlsSet.select.value, '');
  assert.equal(picker.selectedName, null);
  assert.match(controlsSet.summary.textContent, /없|no indicator/i);
  picker.destroy();
});
