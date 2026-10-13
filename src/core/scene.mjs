import {createLayout} from './model.mjs';
import {labelMetrics,labelWidth,labelCommand,panelTitle} from './labels.mjs';
import {formatAxisValue,aggregateVolumeSeries,createDrawingCommands,createCrosshairCommands} from './scene-parts.mjs';

// Renderer-neutral CSS-pixel display list. Raw price/time never become float32.
export function buildScene(model, width, height, {crosshair = true, drawings = true} = {}) {
  const layout = createLayout(model, width, height), theme = model.theme, commands = [], {from, to} = layout;
  const line = (coords, color, stroke = 1, clip = null, dash = null) => {if (coords.length) commands.push({op: 'lines', coords, color, width: stroke, clip, dash});};
  const metrics=labelMetrics(theme.font);
  const text=(value,x,y,maxWidth,clip,metadata)=>{const c=labelCommand(value,x,y,maxWidth,theme.font,theme.text,clip,metadata);if(c)commands.push(c);return c;};
  if(!model.store.length){commands.push({op:'text',x:Math.max(12,width/2-60),y:height/2,text:'No data',color:theme.text,font:theme.font});return {width,height,background:theme.background,commands,layout,stats:{storedBars:0,visibleSourceBars:0,renderedCandleBuckets:0,commandCount:1}};}
  const buckets = model.store.aggregate(from, to, Math.max(1, Math.floor((layout.panels[0].right-layout.panels[0].left) / 3)));
  for (const p of layout.panels) {
    const clip = [p.left, p.top, p.right - p.left, p.bottom - p.top], grid = [];
    const priceTicks=Math.max(1,Math.min(4,Math.floor((p.bottom-p.top)/40)));
    for(let j=0;j<=priceTicks;j++){const y=p.top+j*(p.bottom-p.top)/priceTicks;grid.push(p.left,y,p.right,y);}
    for(let j=0;j<=5;j++){const x=p.left+(p.right-p.left)*j/5;grid.push(x,p.top,x,p.bottom);}line(grid,theme.grid);
    for(const axis of p.axes.filter(a=>a.visible)){
      const axisClip=[axis.axisLeft,p.top,axis.axisRight-axis.axisLeft,p.bottom-p.top],x=axis.axisLeft+4,maxWidth=axis.axisRight-x-4,hasTitle=!!axis.label&&p.bottom-p.top>=metrics.height*2+12;
      let labelTop=p.top+4;if(hasTitle){text(axis.label,x,labelTop+metrics.ascent,maxWidth,axisClip,{role:'axis-title',panelId:p.id,axisId:axis.axisId});labelTop+=metrics.height+4;}
      const space=p.bottom-4-labelTop,count=Math.max(0,Math.min(5,Math.floor((space+4)/(metrics.height+4))));
      for(let j=0;j<count;j++){const top=labelTop+(count===1?(space-metrics.height)/2:j*(space-metrics.height)/(count-1)),y=top+metrics.ascent,at=Math.max(p.top,Math.min(p.bottom,top+metrics.height/2));text(formatAxisValue(model,axis,axis.price(at)),x,y,maxWidth,axisClip,{role:'price-tick',panelId:p.id,axisId:axis.axisId});}
    }
    for (const s of model.series.filter(s => s.panel === p.id && s.visible !== false)) {
      const axis=layout.axis(p.id,s.axisId);if(!axis)continue;
      if (s.type === 'candles' || s.type === 'ohlc') {
        const upRects = [], downRects = [], upLines = [], downLines = [];
        for (const b of buckets) {
          const x = layout.x(b.index), w = Math.max(.8, (layout.x(b.end) - layout.x(b.start)) * .72), up = b.close >= b.open, coords = up ? upLines : downLines;
          coords.push(x, axis.y(b.high), x, axis.y(b.low));
          if (s.type === 'ohlc') coords.push(x - w / 2, axis.y(b.open), x, axis.y(b.open), x, axis.y(b.close), x + w / 2, axis.y(b.close));
          else (up ? upRects : downRects).push(x - w / 2, Math.min(axis.y(b.open), axis.y(b.close)), w, Math.max(1, Math.abs(axis.y(b.open) - axis.y(b.close))));
        }
        line(upLines, s.upColor ?? theme.up, s.width ?? 1, clip); line(downLines, s.downColor ?? theme.down, s.width ?? 1, clip);
        if (upRects.length) commands.push({op: 'rects', coords: upRects, color: s.upColor ?? theme.up, clip});
        if (downRects.length) commands.push({op: 'rects', coords: downRects, color: s.downColor ?? theme.down, clip});
      } else if (aggregateVolumeSeries(s)) {
        const coords = [], baseline = axis.y(0);
        for (const b of buckets) {const x = layout.x(b.index), w = Math.max(.8, (layout.x(b.end) - layout.x(b.start)) * .72); coords.push(x - w / 2, Math.min(baseline,axis.y(b.volume)), w, Math.max(1, Math.abs(baseline - axis.y(b.volume))));}
        if (coords.length) commands.push({op: 'rects', coords, color: s.color, clip});
      } else {
        const sf = Math.min(model.store.length,Math.max(0,Math.floor(model.view.from-(s.offset??0)))), st = Math.max(sf,Math.min(model.store.length,Math.ceil(model.view.to+1-(s.offset??0))));
        const {values, index} = model.seriesData(s), count = Math.min(st - sf, Math.max(1, Math.floor(p.right - p.left))), coords = [], rects = [], paths = [], gaps = index.hasGaps(sf,st); let path = [];
        const flush=()=>{if(path.length===2){const x=path[0],y=path[1];coords.push(x-.25,y,x+.25,y);}else if(path.length)paths.push(path);path=[];};
        const histogram=(x,v,width)=>{const baseline=axis.y(s.baseline??0);rects.push(x-width/2,Math.min(baseline,axis.y(v)),width,Math.max(1,Math.abs(baseline-axis.y(v))));};
        for (let k = 0; k < count; k++) {
          const a=sf+Math.floor(k*(st-sf)/count),b=sf+Math.floor((k+1)*(st-sf)/count),end=Math.min(b,values.length),finite=gaps?index.finiteCount(a,end):end-a;
          if(!finite){flush();continue;}
          if(finite!==end-a){
            // A mixed bucket is split into actual finite runs, never discarded
            // or bridged. Isolated finite samples get a small point glyph.
            const width=Math.max(1,Math.abs(layout.x(a+1)-layout.x(a))*.8);
            for(let i=a;i<end;i++){const v=values[i];if(!Number.isFinite(v)){flush();continue;}const x=layout.x(i+(s.offset??0));if(s.type==='histogram')histogram(x,v,width);else path.push(x,axis.y(v));}
            continue;
          }
          const x=layout.x((a+b-1)/2+(s.offset??0)),v=values[end-1];
          if(s.type==='histogram')histogram(x,v,Math.max(1,(p.right-p.left)/count*.8));
          else{const q=index.query(a,end);path.push(x,axis.y(v));if(b-a>1&&q.max!==q.min)coords.push(x,axis.y(q.min),x,axis.y(q.max));}
        }
        flush();
        if (rects.length) commands.push({op: 'rects', coords: rects, color: s.color, clip});
        for (const points of paths) commands.push({op: 'path', points, color: s.color, width: s.width, fill: s.type === 'area' ? s.fill ?? '#7898ff22' : null, baseline:s.type==='area'?axis.y(s.baseline??0):undefined, clip});
        line(coords, s.color, s.width, clip);
      }
    }
    if(p.bottom-p.top>=metrics.height+8){const title=labelCommand(panelTitle(model,p),p.left+4,p.top+4+metrics.ascent,p.right-p.left-8,theme.font,theme.text,clip,{role:'panel-title',panelId:p.id});if(title){commands.push({op:'box',x:p.left,y:p.top,w:title.labelBounds[2]+8,h:metrics.height+8,fill:theme.background,color:theme.background,width:0,clip});commands.push(title);}}
  }
  const firstPanel=layout.panels[0],timeWidth=firstPanel.right-firstPanel.left,timeClip=[firstPanel.left,Math.max(firstPanel.bottom+4,height-metrics.height-8),timeWidth,Math.min(metrics.height+8,height-firstPanel.bottom-4)],baseline=height-4-metrics.descent;
  if(timeClip[3]>=metrics.height){
    const valueAt=fraction=>{const i=model.view.from+(model.view.to-model.view.from)*fraction,t=model.store.timeAtIndex(i);return model.timeFormatter?model.timeFormatter(t):new Date(t).toISOString().slice(5,16).replace('T',' ');};
    const maxLabelWidth=Math.max(labelWidth(String(valueAt(0)),metrics),labelWidth(String(valueAt(1)),metrics)),count=Math.max(1,Math.min(5,Math.floor((timeWidth+4)/(maxLabelWidth+4))));let lastRight=-Infinity;
    for(let j=0;j<count;j++){const fraction=count===1?.5:j/(count-1),value=valueAt(fraction),candidate=labelCommand(value,0,baseline,timeWidth,theme.font,theme.text,timeClip,{role:'time-tick'});if(!candidate)continue;const x=Math.max(firstPanel.left,Math.min(firstPanel.right-candidate.labelBounds[2],firstPanel.left+timeWidth*fraction-candidate.labelBounds[2]/2));if(x<lastRight+4)continue;candidate.x=x;candidate.labelBounds[0]=x;commands.push(candidate);lastRight=x+candidate.labelBounds[2];}
  }
  if (drawings) for(const command of createDrawingCommands(model,layout))commands.push(command);
  if (crosshair) for(const command of createCrosshairCommands(model,layout))commands.push(command);
  return {width, height, background: theme.background, commands, layout, stats: {storedBars: model.store.length, visibleSourceBars: to - from, renderedCandleBuckets: buckets.length, commandCount: commands.length}};
}
