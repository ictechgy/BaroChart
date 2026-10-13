import React from 'react';
import {createRoot} from 'react-dom/client';
// Same createRoot, mount/unmount, host lookup and ESM entry as react-client.mjs.
// This fixture contains only React/ReactDOM and an empty host element.
export function mount(host){const root=createRoot(host);root.render(React.createElement('div',{style:{height:320}}));return ()=>root.unmount();}
const host=globalThis.document?.getElementById('aster-package-host');if(host)mount(host);
