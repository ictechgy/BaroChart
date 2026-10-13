# React web example

From the repository root, use Node 22 or later:

```sh
cd examples/react-web
npm ci
npm run typecheck
npm start
# Open http://127.0.0.1:5174
```

This example consumes `barochart` through a local package dependency and its `/react` export. It uses React 19.3.0, TypeScript 5.9.3 and esbuild 0.28.2; `package-lock.json` pins development dependencies. No service, account, API key or market feed is needed. The candles are synthetic.

The adapter creates a default candle model and manages its lifetime. Give the host a height, pass initial copied data, then use a ref for incoming ticks:

```tsx
import {useRef} from 'react';
import {AsterChart, type AsterChartHandle} from 'barochart/react';
import type {Bar} from 'barochart';

export function PriceChart({bars}: {bars: readonly Bar[]}) {
  const chart = useRef<AsterChartHandle>(null);
  // In your feed callback:
  // chart.current?.api?.applyDataEvent({kind: 'append', bar: nextBar});
  return <AsterChart ref={chart} data={bars} style={{height: 420}} />;
}
```

`data` updates when its identity or `dataRevision` changes. Typed columns are copied and their source buffers stay attached. Do not rerender React for every market tick; use the imperative API. A borrowed `model` remains yours to dispose. A `createModel` factory creates a fresh owned model after a renderer/reset/constructor-option change; do not pass both props. Keep factory work out of render. Ref getters become null when that lifecycle ends.

`onReady` runs after initial controlled data/theme/tool/range and can return a synchronous cleanup. Cleanup runs before chart destruction, including StrictMode's development checks. Keep callbacks short; use `onError` for reported failures. Changing callbacks does not create a new chart.

`npm run build` writes ignored `dist/` with React/esbuild legal comments. BaroChart is Apache-2.0; third-party dependencies retain their own licenses. Installed React/React DOM/scheduler and esbuild use MIT; TypeScript uses Apache-2.0; typings/csstype use MIT. Their license files remain in scoped `node_modules/`.

Actual tarball consumer/browser QA: `node test/react-browser.mjs` from repository root. It uses isolated Chrome and a loopback server. See cycle 8 QA (not included in this source distribution) for coverage and limits. This is a React web example; React Native and Next.js are not verified by it.
