import assert from 'node:assert/strict';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {AsterChart} from 'barochart/react';
export function smoke(){let allocated=0,ready=0;const html=renderToString(React.createElement(AsterChart,{createModel(){allocated++;throw new Error('SSR allocated a model');},onReady(){ready++;},className:'aster-consumer','data-package-probe':'ssr',style:{height:360}}));assert.equal(allocated,0);assert.equal(ready,0);assert.match(html,/data-package-probe="ssr"/);assert.match(html,/aster-consumer/);assert(!/canvas/.test(html));return {html,allocated,ready};}
