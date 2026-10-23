import {BarStore, ChartModel, createChart} from '../../src/index.mjs';
import {createShowcaseBars} from './showcase-data.mjs';

const COLORS = {
  dark: {background: '#0E1522', grid: 'rgba(148,163,184,0.10)', text: '#8495AC', up: '#2FC39E', down: '#F2647A', crosshair: '#94A3B8'},
  light: {background: '#FFFFFF', grid: 'rgba(11,18,32,0.10)', text: '#64748B', up: '#11A37F', down: '#D6455B', crosshair: '#55606F'},
};

const root = document.getElementById('showcase');
const chartHost = document.getElementById('chart');
const errorNode = document.getElementById('showcase-error');
const media = window.matchMedia('(max-width: 720px)');
const queryTheme = new URLSearchParams(window.location.search).get('theme');
let theme = queryTheme === 'light' || queryTheme === 'dark' ? queryTheme : 'dark';
let interval = 5;
let chart = null;
let model = null;
let disposed = false;
let resizeQueued = false;

const $ = id => document.getElementById(id);
const money = value => Number.isFinite(value) ? value.toFixed(2) : '—';
const volume = value => {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
};
const percent = value => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

function setError(error) {
  const message = error instanceof Error ? error.message : String(error);
  errorNode.textContent = `Chart unavailable · ${message}`;
  errorNode.hidden = false;
  if (window.showcase) window.showcase.readiness = false;
}

function setTheme(next) {
  theme = next;
  document.body.dataset.theme = theme;
  root.dataset.theme = theme;
  const light = theme === 'light';
  $('theme-toggle').setAttribute('aria-pressed', String(light));
  $('theme-toggle').setAttribute('aria-label', `Switch to ${light ? 'dark' : 'light'} theme`);
  $('theme-toggle-text').textContent = light ? 'Dark' : 'Light';
  if (model && chart) {
    if (window.showcase) window.showcase.readiness = false;
    try {
      chart.api.setTheme({...COLORS[theme], font: '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'});
      chart.api.setSeries('ema-fast', {color: light ? '#B9821B' : '#E3B341'});
      chart.api.setSeries('ema-slow', {color: light ? '#3C6FC0' : '#7C9CD0'});
      chart.api.setSeries('volume', {color: light ? 'rgba(17,163,127,.34)' : 'rgba(47,195,158,.42)'});
      chart.api.setSeries('rsi', {color: light ? '#4A5566' : '#C7D2E8'});
      chart.drawNow();
      markReady();
    } catch (error) { setError(error); }
  }
}

function updateReadout() {
  if (!model || !model.store.length) return;
  const first = model.store.at(0);
  const last = model.store.at(model.store.length - 1);
  const change = last.close - first.open;
  const changePercent = first.open ? change / first.open * 100 : 0;
  const changeText = `${change >= 0 ? '+' : ''}${change.toFixed(2)} (${percent(changePercent)})`;
  $('last-price').textContent = money(last.close);
  $('mobile-price').textContent = money(last.close);
  $('sample-change').textContent = `Sample change ${changeText}`;
  $('mobile-change').textContent = changeText;
  $('sample-change').classList.toggle('positive', change >= 0);
  $('sample-change').classList.toggle('negative', change < 0);
  $('mobile-change').classList.toggle('positive', change >= 0);
  $('mobile-change').classList.toggle('negative', change < 0);
  const from = model.store.length - 1;
  const bar = model.store.at(from);
  const ema12 = model.indicators.get('ema12').outputs.value[from];
  const ema26 = model.indicators.get('ema26').outputs.value[from];
  $('ohlcv-readout').textContent = `O ${money(bar.open)}  H ${money(bar.high)}  L ${money(bar.low)}  C ${money(bar.close)}  V ${volume(bar.volume)}`;
  $('bar-count').textContent = String(Math.max(1, Math.round(model.view.to - model.view.from)));
  if (window.showcase) {
    window.showcase.stats = {
      sourceBars: 1800,
      intervalMinutes: interval,
      bars: model.store.length,
      visibleBars: Math.max(1, Math.round(model.view.to - model.view.from)),
      lastPrice: last.close,
      sampleChange: change,
      sampleChangePercent: changePercent,
      readoutIndex: from,
      readout: {...bar, ema12, ema26},
    };
  }
}

function visibleBars() { return media.matches ? 56 : 120; }

function applyVisibleRange() {
  if (!model || !chart) return;
  const count = Math.min(model.store.length, visibleBars());
  model.setVisibleRange(Math.max(-.5, model.store.length - count - .5), model.store.length - .5);
  chart.resize();
  chart.drawNow();
  updateReadout();
}

function cleanupChart() {
  if (!chart) return;
  try { chart.destroy({disposeModel: true}); } catch (error) { setError(error); }
  chart = null;
  model = null;
}

function markReady() {
  const current = window.showcase;
  if (!current || disposed || !chart || chart.disposed) return;
  const finish = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!window.showcase || disposed || !chart || chart.disposed) return;
    window.showcase.readiness = true;
  }));
  try {
    if (document.fonts?.ready) document.fonts.ready.then(finish, finish);
    else finish();
  } catch (error) { setError(error); }
}

function mount(nextInterval = interval) {
  try {
    window.showcase && (window.showcase.readiness = false);
    cleanupChart();
    interval = nextInterval;
    const bars = createShowcaseBars(interval);
    model = new ChartModel({
      store: new BarStore(bars),
      theme: {...COLORS[theme], font: '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'},
      visibleBars: visibleBars(),
      axisWidth: 60,
      panels: [
        {id: 'price', weight: 4.8},
        {id: 'volume', weight: 1, precision: 0, formatter: volume},
        {id: 'rsi', weight: 1.5, label: 'RSI', range: [0, 100], padding: .04},
      ],
    });
    model.indicators.add('ema12', 'ema', {period: 12});
    model.indicators.add('ema26', 'ema', {period: 26});
    model.indicators.add('rsi14', 'rsi', {period: 14});
    model.addSeries({id: 'candles', type: 'candles', panel: 'price'});
    model.addSeries({id: 'ema-fast', type: 'line', panel: 'price', indicator: 'ema12', color: theme === 'light' ? '#B9821B' : '#E3B341', width: 1.25, label: 'EMA 12'});
    model.addSeries({id: 'ema-slow', type: 'line', panel: 'price', indicator: 'ema26', color: theme === 'light' ? '#3C6FC0' : '#7C9CD0', width: 1.25, label: 'EMA 26'});
    model.addSeries({id: 'volume', type: 'histogram', panel: 'volume', source: 'volume', color: theme === 'light' ? 'rgba(17,163,127,.34)' : 'rgba(47,195,158,.42)', baseline: 0});
    model.addSeries({id: 'rsi', type: 'line', panel: 'rsi', indicator: 'rsi14', color: theme === 'light' ? '#4A5566' : '#C7D2E8', width: 1.25, label: '14'});
    model.fit();
    chart = createChart(chartHost, model, {renderer: 'canvas', onError: setError});
    chart.canvas.addEventListener('aster:state', updateReadout);
    chart.canvas.setAttribute('aria-label', 'SYNTH-A candlestick chart with EMA 12, EMA 26, volume, and RSI 14');
    applyVisibleRange();
    for (const button of document.querySelectorAll('[data-interval]')) button.setAttribute('aria-pressed', String(Number(button.dataset.interval) === interval));
    errorNode.hidden = true;
    if (window.showcase) { window.showcase.chart = chart; window.showcase.model = model; }
    markReady();
  } catch (error) { setError(error); }
}

window.showcase = {chart: null, model: null, readiness: false, stats: {sourceBars: 1800}};
setTheme(theme);
for (const button of document.querySelectorAll('[data-interval]')) button.addEventListener('click', () => mount(Number(button.dataset.interval)));
$('theme-toggle').addEventListener('click', () => setTheme(theme === 'dark' ? 'light' : 'dark'));
const handleViewport = () => {
  if (resizeQueued || !model || !chart) return;
  if (window.showcase) window.showcase.readiness = false;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    try { applyVisibleRange(); markReady(); } catch (error) { setError(error); }
  });
};
if (media.addEventListener) media.addEventListener('change', handleViewport);
else media.addListener(handleViewport);
window.addEventListener('resize', handleViewport, {passive: true});
window.addEventListener('pagehide', event => { if (!event.persisted) { disposed = true; cleanupChart(); } });
window.addEventListener('pageshow', event => { if (event.persisted) { disposed = false; chart?.resize(); markReady(); } });
mount();
