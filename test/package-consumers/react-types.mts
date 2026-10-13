import {createElement,createRef} from 'react';
import {ChartModel,BarStore,type ColumnInput} from 'barochart/core';
import {AsterChart,type AsterChartHandle,type AsterChartContext,type AsterChartData,type AsterChartProps} from 'barochart/react';
const model=new ChartModel({store:new BarStore()}),ref=createRef<AsterChartHandle>();
const columns:ColumnInput={time:[],open:[],high:[],low:[],close:[],volume:[]};const data:AsterChartData={columns,length:0};
const props:AsterChartProps={createModel:()=>new ChartModel(),data,dataRevision:1,renderer:'canvas',options:{observeResize:false},theme:{background:'#000000'},drawingTarget:null,visibleRange:[0,20],onReady(ctx:AsterChartContext){ctx.chart.api.fit();return ()=>ctx.model.view.from.toFixed();},onState(ctx,event){event.type.toUpperCase();ctx.model.store.length.toFixed();},'aria-label':'Financial chart'};
createElement(AsterChart,{...props,ref});createElement(AsterChart,{model,ref,resetKey:'session-2'});ref.current?.api?.inspect();ref.current?.chart?.resize();ref.current?.model?.store.length.toFixed();
// @ts-expect-error An explicit model and owned model factory are mutually exclusive.
const both:AsterChartProps={model,createModel:()=>model};
// @ts-expect-error Browser renderer names remain explicit.
createElement(AsterChart,{model,renderer:'metal'});
// @ts-expect-error AsterChart owns the host contents.
createElement(AsterChart,{model,children:'unsupported'});
// @ts-expect-error Public handle getters cannot be assigned by a caller.
if(ref.current)ref.current.model=model;
void both;
