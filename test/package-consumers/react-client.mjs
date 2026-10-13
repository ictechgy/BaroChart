import React from 'react';
import {createRoot} from 'react-dom/client';
import {BarStore,ChartModel,seededColumns} from 'barochart/core';
import {AsterChart} from 'barochart/react';
export function mount(host){const root=createRoot(host);root.render(React.createElement(AsterChart,{createModel(){const store=new BarStore();store.setColumns(seededColumns(32,42));const model=new ChartModel({store});model.addSeries({id:'p',type:'candles',panel:'price'});return model;},renderer:'canvas'}));return ()=>root.unmount();}
const host=globalThis.document?.getElementById('aster-package-host');if(host)mount(host);
