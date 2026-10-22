// Internal shared raw-price selection. Never queries indicators or creates layout.
export function nearestVisibleOHLC(model,layout,x,y,target,fields=['open','high','low','close']){
 const axis=layout.axis(target.panel,target.axisId),store=model.store;
 if(!axis||!store.length||x<axis.left||x>axis.right||y<axis.top||y>axis.bottom)return null;
 const eligible=s=>s.visible!==false&&s.panel===target.panel&&(s.axisId??null)===(target.axisId??null)&&['candles','ohlc'].includes(s.type)&&!(s.offset??0)&&!s.indicator&&!s.values&&!s.source&&!s.symbolId;
 const series=target.seriesId!=null?model.series.find(s=>s.id===target.seriesId&&eligible(s)):model.series.find(eligible);
 if(!series)return null;
 const first=Math.max(0,Math.ceil(model.view.from)),last=Math.min(store.length-1,Math.floor(model.view.to));
 if(first>last)return null;
 // Two adjacent visible centers; exact ties choose the earlier bar. Only that
 // bar is inspected, with field-order ties. No fallback to a remote source bar.
 const index=layout.index(x),a=Math.max(first,Math.min(last,Math.floor(index))),b=Math.max(first,Math.min(last,Math.ceil(index))),ax=layout.x(a),bx=layout.x(b),at=Math.abs(x-ax)<=Math.abs(x-bx)?a:b,sx=layout.x(at);
 if(!Number.isFinite(sx)||sx<axis.left||sx>axis.right)return null;
 let price,field,sy,dy=Infinity;
 for(const key of fields){const value=store.columns[key][at],py=axis.y(value);if(!Number.isFinite(value)||!Number.isFinite(py)||py<axis.top||py>axis.bottom)continue;const distance=Math.abs(py-y);if(distance<dy){dy=distance;price=value;field=key;sy=py;}}
 return price===undefined?null:{index:at,time:store.columns.time[at],price,field,x:sx,y:sy,axisId:target.axisId??null,seriesId:series.id};
}
