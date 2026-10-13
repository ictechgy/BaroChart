import {StrictMode, useCallback, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AsterChart, type AsterChartContext, type AsterChartHandle} from 'barochart/react';
import type {Bar} from 'barochart';

// Synthetic, deterministic data. Keep initial data outside React rendering.
const bars: readonly Bar[] = Array.from({length: 512}, (_, i) => {
  const open = 100 + Math.sin(i / 18) * 6 + i / 80;
  const close = open + Math.sin(i * 1.7) * 1.4;
  return {time: 1700000000000 + i * 60000, open, high: Math.max(open, close) + 1.2,
    low: Math.min(open, close) - 1.2, close, volume: 300 + i % 100};
});
const options = {dpr: () => window.devicePixelRatio || 1};

function App() {
  const chart = useRef<AsterChartHandle>(null);
  const [renderer, setRenderer] = useState<'canvas' | 'webgl2'>('canvas');
  const [light, setLight] = useState(false);
  const [status, setStatus] = useState('Starting chart…');
  const onReady = useCallback(({chart}: AsterChartContext) => {
    setStatus(`${chart.rendererKind === 'canvas' ? 'Canvas' : 'WebGL2'} · synthetic OHLCV`);
  }, []);
  const append = () => {
    const handle = chart.current;
    const model = handle?.model;
    if (!model || !handle?.api) return;
    const last = model.store.at(model.store.length - 1);
    const close = last.close + Math.sin(model.store.length) * 0.8;
    // Market ticks update the chart API directly, without React state per tick.
    handle.api.applyDataEvent({kind: 'append', bar: {time: last.time + 60000,
      open: last.close, high: Math.max(last.close, close) + 1,
      low: Math.min(last.close, close) - 1, close, volume: 450}});
    setStatus(`Added bar ${model.store.length} · synthetic OHLCV`);
  };
  return <main>
    <header><p className="eyebrow">BaroChart / React web</p><h1>A chart, a ref, and your data.</h1>
      <p className="intro">A small TypeScript example using the packaged React adapter. Pan, zoom, or add a synthetic bar.</p></header>
    <section className="card" aria-label="Interactive financial chart">
      <div className="toolbar"><label>Renderer <select value={renderer} onChange={e => setRenderer(e.target.value as 'canvas' | 'webgl2')}><option value="canvas">Canvas</option><option value="webgl2">WebGL2</option></select></label>
        <button onClick={() => setLight(v => !v)}>{light ? 'Dark theme' : 'Light theme'}</button>
        <button onClick={append}>Add bar</button><button onClick={() => chart.current?.api?.fit()}>Fit data</button></div>
      <AsterChart ref={chart} data={bars} renderer={renderer} options={options} onReady={onReady}
        onError={error => setStatus(`Chart error: ${error.message}`)}
        onFallback={reason => setStatus(`Canvas fallback: ${reason}`)}
        theme={light ? {background: '#f8fafc', grid: '#dfe6ee', text: '#53657d', crosshair: '#304158'} :
          {background: '#0c1320', grid: '#1d2a3a', text: '#8093ad', crosshair: '#b9c9de'}}
        style={{height: 420}} aria-label="Synthetic price chart" />
      <p className="status" role="status">{status}</p>
    </section>
    <footer>512 synthetic candles · no market service or account required. React owns the chart lifecycle; the imperative API owns each tick.</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
