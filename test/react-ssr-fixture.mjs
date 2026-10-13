import {createElement, StrictMode} from 'react';
import {renderToString} from 'react-dom/server';
import {AsterChart} from 'barochart/react';
let factories = 0;
const props = {id: 'hydrated-chart', className: 'hydrated', style: {height: 180},
  'data-qa': 'ssr', createModel: () => {factories++; throw new Error('SSR invoked factory');}};
const html = renderToString(createElement(StrictMode, null, createElement(AsterChart, props)));
export const ssr = {html, factories, hasCanvas: html.includes('<canvas'),
  expected: '<div id="hydrated-chart" class="hydrated" data-qa="ssr" style="height:180px"></div>'};
