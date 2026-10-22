import {isPositionDrawing,positionMetricsFor,drawingDocumentVersion,validateDrawingDocumentVersion} from './position-drawing.mjs';
import {validateDrawing} from './drawing-validation.mjs';
import {labelMetrics,labelWidth} from './labels.mjs';
import {optionRecord,boundedText,sizeLimit,RESOURCE_LIMITS} from './contracts.mjs';
export {DRAWING_TYPES,drawingPointCount} from './drawing-validation.mjs';
import {DRAWING_TYPES,drawingPointCount} from './drawing-validation.mjs';
const copyDrawing = x => JSON.parse(JSON.stringify(x, (key,value)=>['axisId','seriesId'].includes(key)&&value===null?undefined:value));

const frozenDrawing=d=>{for(const point of d.points)Object.freeze(point);Object.freeze(d.points);if(d.style)Object.freeze(d.style);return Object.freeze(d);};
// Import and export use the same canonical, minimal-version document budget.
const drawingDocument=(items,limit)=>boundedText(JSON.stringify({schema:'aster.drawings',version:drawingDocumentVersion(items),drawings:items}),limit,'Drawing document',true);
const drawingWeights=new WeakMap();
function drawingWeight(d){let weight=drawingWeights.get(d);if(weight===undefined){weight=JSON.stringify(d).length*2;drawingWeights.set(d,weight);}return weight;}
export class DrawingStore {
  constructor({historyLimit=100,maxDrawings=RESOURCE_LIMITS.maxDrawings,maxPoints=RESOURCE_LIMITS.maxDrawingPoints,maxDocumentChars=RESOURCE_LIMITS.maxDocumentChars,historyBytes=RESOURCE_LIMITS.maxHistoryBytes}={}) {
    if(!Number.isInteger(historyLimit)||historyLimit<1||historyLimit>10000)throw new RangeError('History limit 1..10000');for(const [name,value] of Object.entries({maxDrawings,maxPoints,maxDocumentChars,historyBytes}))sizeLimit(value,name==='maxPoints'?2097152:name==='maxDocumentChars'?RESOURCE_LIMITS.maxDocumentChars: name==='maxDrawings'?10000:RESOURCE_LIMITS.maxHistoryBytes,name);
    Object.assign(this,{maxDrawings,maxPoints,maxDocumentChars,historyBytes,historyLimit});this.items=[];this.undoStack=[];this.redoStack=[];this.selected=null;this.transaction=null;this.serial=0;this.historyWeights=new WeakMap();
  }
  snapshot(){return copyDrawing(this.items);}
  budget(items){if(items.length>this.maxDrawings)throw new RangeError('Drawing count limit');let points=0,text=0;for(const d of items){points+=d.points.length;text+=d.text?.length??0;}if(points>this.maxPoints||text>1000000)throw new RangeError('Drawing points/text limit');}
  weight(snapshot){let value=this.historyWeights.get(snapshot);if(value===undefined){value=snapshot.length*8+snapshot.reduce((n,d)=>n+drawingWeight(d),0);this.historyWeights.set(snapshot,value);}return value;}
  trim(){let bytes=[...this.undoStack,...this.redoStack].reduce((n,s)=>n+this.weight(s),0);while(this.undoStack.length>this.historyLimit||bytes>this.historyBytes){const old=this.undoStack.length?this.undoStack.shift():this.redoStack.shift();if(!old)break;bytes-=this.weight(old);}this.retainedHistoryBytes=bytes;}
  begin(){if(this.transaction)throw new Error('A drawing transaction is already active');this.transaction=this.items.slice();}
  commit(){if(!this.transaction)return;const before=this.transaction;this.transaction=null;if(before.length!==this.items.length||before.some((d,i)=>d!==this.items[i])){this.undoStack.push(before);this.redoStack=[];this.trim();}}
  cancel(){if(this.transaction){this.items=this.transaction.slice();this.transaction=null;if(!this.items.some(x=>x.id===this.selected&&x.visible!==false))this.selected=null;}}
  mutate(fn){const own=!this.transaction;if(own)this.begin();try{fn();if(own)this.commit();}catch(error){if(own)this.cancel();throw error;}}
  // ChartAPI may preflight against the committed snapshot, then cancel pointer
  // ownership only after validation succeeds. Pointer/manual callers use the
  // default current items and retain their existing transaction grouping.
  // Validate the JSON-normalized copy too: nested getters/toJSON may change
  // values after the initial caller-shape check but before publication.
  add(input,{items=this.items,beforeMutation=null}={}){optionRecord(input,['id','type','panel','points','style','text','locked','visible','axisId','seriesId'],'Drawing');let id=input.id,serial=this.serial;if(!id){do{id=`drawing-${++serial}`;}while(items.some(d=>d.id===id));}const d={id,panel:'price',locked:false,style:{color:'#f5b85a',width:1.5},...input,id};validateDrawing(d);const copy=copyDrawing(d);validateDrawing(copy);frozenDrawing(copy);if(items.some(x=>x.id===id))throw new Error('Duplicate drawing id');const next=[...items,copy];this.budget(next);beforeMutation?.();this.mutate(()=>{this.items=next;});this.serial=serial;if(copy.visible!==false)this.selected=id;return id;}
  edit(id,patch,{items=this.items,beforeMutation=null}={}){optionRecord(patch,['type','panel','points','style','text','locked','visible','axisId','seriesId'],'Drawing patch');const i=items.findIndex(x=>x.id===id);if(i<0)throw new Error('Missing drawing');const previous=items[i];if(previous.locked&&Object.keys(patch).some(k=>!['locked','visible'].includes(k)))throw new Error('Drawing is locked');const next={...previous,...patch};validateDrawing(next);if(JSON.stringify(previous)===JSON.stringify(next)){beforeMutation?.();return;}const copy=copyDrawing(next);validateDrawing(copy);frozenDrawing(copy);const changed=items.slice();changed[i]=copy;this.budget(changed);beforeMutation?.();this.mutate(()=>{this.items=changed;if(copy.visible===false&&this.selected===id)this.selected=null;});}
  remove(id,{items=this.items,beforeMutation=null}={}){const d=items.find(x=>x.id===id);if(!d||d.locked)return false;const next=items.filter(x=>x.id!==id);beforeMutation?.();this.mutate(()=>{this.items=next;});if(this.selected===id)this.selected=null;return true;}
  undo(){if(this.transaction)this.cancel();if(!this.undoStack.length)return false;this.redoStack.push(this.items.slice());this.items=this.undoStack.pop().slice();this.selected=null;this.trim();return true;}
  redo(){if(this.transaction)this.cancel();if(!this.redoStack.length)return false;this.undoStack.push(this.items.slice());this.items=this.redoStack.pop().slice();this.selected=null;this.trim();return true;}
  save(){if(this.transaction)throw new Error('Commit or cancel before saving');return drawingDocument(this.items,this.maxDocumentChars);}
  load(text,{styleDecoder=null,validatePanel=null,validateBinding=null}={}) {
    boundedText(text,this.maxDocumentChars,'Drawing document',true);const doc=JSON.parse(text);optionRecord(doc,['schema','version','drawings'],'Drawing document');if(doc.schema!=='aster.drawings'||![1,2,3,4].includes(doc.version)||!Array.isArray(doc.drawings)||doc.drawings.length>this.maxDrawings)throw new TypeError('Unsupported drawing document');
    const items=doc.drawings.map(d=>{validateDrawing(d);validateDrawingDocumentVersion(d,doc.version);if(validateBinding&&!validateBinding(d))throw new Error('Invalid drawing binding');if(validatePanel&&!validatePanel(d.panel))throw new Error('Missing drawing panel');const next=copyDrawing(d);if(styleDecoder&&next.style)next.style=styleDecoder(next.style);validateDrawing(next);return frozenDrawing(next);});this.budget(items);if(new Set(items.map(d=>d.id)).size!==items.length)throw new TypeError('Duplicate drawing ids');if(this.transaction)throw new Error('Cannot load during a gesture');drawingDocument(items,this.maxDocumentChars);this.mutate(()=>{this.items=items;});this.selected=null;
  }
}

function segmentDistance(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
}
function extendedSegment(a,b,p,ray=false) {
 const dx=b.x-a.x,dy=b.y-a.y;if(!dx&&!dy)return [];
 let lo=ray?0:-Infinity,hi=Infinity;
 for(const [origin,delta,min,max] of [[a.x,dx,p.left,p.right],[a.y,dy,p.top,p.bottom]]){if(!delta){if(origin<min||origin>max)return [];}else{const t=(min-origin)/delta,z=(max-origin)/delta;lo=Math.max(lo,Math.min(t,z));hi=Math.min(hi,Math.max(t,z));}}
 return lo<=hi?[a.x+dx*lo,a.y+dy*lo,a.x+dx*hi,a.y+dy*hi]:[];
}
// One geometry definition drives all renderers and hit testing. Fibonacci price
// levels interpolate raw price, then apply the panel transform (including log).
function calculateGeometry(d,layout) {
 if(d.visible===false)return [];
 const p=layout.drawingAxis?layout.drawingAxis(d):layout.panels.find(p=>p.id===d.panel);if(!p)return [];
 const points=d.points.map(q=>layout.toScreen(q,d.panel,d.axisId));if(points.some(q=>!Number.isFinite(q.x)||!Number.isFinite(q.y)))return [];
 const [a,b=a,c=b]=points,commands=[],color=d.style?.color??'#f5b85a',width=d.style?.width??1.5,clip=[p.left,p.top,p.right-p.left,p.bottom-p.top];
 const line=(coords,dash=null)=>{if(coords.length)commands.push({op:'lines',coords,color,width,clip,dash});},label=(x,y,text)=>commands.push({op:'text',x,y,text,color,font:'12px monospace',clip});
 if(isPositionDrawing(d.type)){
  const metrics=positionMetricsFor(d),extent=points[3],left=a.x,right=extent.x;
  for(const [level,fill] of [[b,'#ef535044'],[c,d.style?.fill??'#26a69a44']])commands.push({op:'box',x:left,y:Math.min(a.y,level.y),w:right-left,h:Math.abs(a.y-level.y),fill,color,width,clip});
  line([left,a.y,right,a.y]);
  const number=n=>n.toPrecision(6),percent=n=>n===null?'n/a':number(n)+'%';
  label(left+4,a.y-4,`${metrics.direction==='long'?'Long':'Short'} entry ${String(metrics.entry)} · R/R ${number(metrics.ratio)}`);
  label(left+4,b.y-4,`Stop ${String(metrics.stop)} · Δ ${number(metrics.risk)} · ${percent(metrics.riskPercent)} of |entry|`);
  label(left+4,c.y-4,`Target ${String(metrics.target)} · Δ ${number(metrics.reward)} · ${percent(metrics.rewardPercent)} of |entry|`);
 }
 else if(d.type==='horizontal')line([p.left,a.y,p.right,a.y]);
 else if(['trendline','measurement'].includes(d.type)){line([a.x,a.y,b.x,b.y]);if(d.type==='measurement'){const delta=d.points[1].price-d.points[0].price,percent=d.points[0].price===0?'n/a':(delta/d.points[0].price*100).toFixed(2)+'%',bars=layout.index(b.x)-layout.index(a.x),seconds=(d.points[1].time-d.points[0].time)/1000;label((a.x+b.x)/2,Math.min(a.y,b.y)-8,`Δ ${delta.toPrecision(6)} (${percent}) · ${bars.toFixed(1)} bars · ${seconds.toFixed(0)}s`);}}
 else if(d.type==='ray'||d.type==='extendedline')line(extendedSegment(a,b,p,d.type==='ray'));
 else if(d.type==='channel'){line(extendedSegment(a,b,p));line(extendedSegment(c,{x:c.x+b.x-a.x,y:c.y+b.y-a.y},p));line(extendedSegment({x:(a.x+c.x)/2,y:(a.y+c.y)/2},{x:(a.x+c.x)/2+b.x-a.x,y:(a.y+c.y)/2+b.y-a.y},p),[4,4]);}
 else if(d.type==='fibonacci'||d.type==='fibextension'){
  const ratios=d.type==='fibonacci'?[0,.236,.382,.5,.618,.786,1]:[0,.618,1,1.272,1.618,2.618];
  for(const r of ratios){const price=d.type==='fibonacci'?d.points[0].price+(d.points[1].price-d.points[0].price)*r:d.points[2].price+(d.points[1].price-d.points[0].price)*r,y=p.y(price);if(!Number.isFinite(y))continue;line([a.x,y,d.type==='fibextension'?p.right:b.x,y]);label(Math.min(a.x,b.x)+4,y-3,`${(r*100).toFixed(1)}%`);}
 }else if(d.type==='fibfan'){for(const r of [.382,.5,.618]){const target={x:b.x,y:p.y(d.points[0].price+(d.points[1].price-d.points[0].price)*r)};if(Number.isFinite(target.y))line(extendedSegment(a,target,p,true));}label(a.x,a.y-8,'38.2 / 50 / 61.8');}
 else if(d.type==='fibtimezones'){for(const r of [0,1,2,3,5,8,13,21,34]){const x=a.x+(b.x-a.x)*r;line([x,p.top,x,p.bottom]);label(x+3,p.top+28,String(r));}}
 else if(d.type==='freehand'){const coords=[];for(let i=1;i<points.length;i++)coords.push(points[i-1].x,points[i-1].y,points[i].x,points[i].y);line(coords);}
 else if(d.type==='text')label(a.x,a.y,d.text??'Note');
 else commands.push({op:d.type==='rectangle'?'box':'ellipse',x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.abs(a.x-b.x),h:Math.abs(a.y-b.y),color,width,fill:d.style?.fill,clip});
 return commands;
}
const geometryCache=new WeakMap(),boundsCache=new WeakMap();
export function drawingGeometry(d,layout) {
 const cached=geometryCache.get(d);if(layout.geometryKey&&cached?.key===layout.geometryKey)return cached.commands;
 const commands=calculateGeometry(d,layout);
 if(layout.geometryKey&&Object.isFrozen(d)){for(const c of commands){if(c.coords)Object.freeze(c.coords);if(c.clip)Object.freeze(c.clip);Object.freeze(c);}Object.freeze(commands);geometryCache.set(d,{key:layout.geometryKey,commands});}return commands;
}
function candidateBounds(d,layout,x,y,tolerance) {
 if(!['freehand','trendline','rectangle','ellipse','text','measurement'].includes(d.type))return true;
 let bounds=boundsCache.get(d);if(!bounds){let timeMin=Infinity,timeMax=-Infinity,priceMin=Infinity,priceMax=-Infinity;for(const p of d.points){timeMin=Math.min(timeMin,p.time);timeMax=Math.max(timeMax,p.time);priceMin=Math.min(priceMin,p.price);priceMax=Math.max(priceMax,p.price);}bounds={timeMin,timeMax,priceMin,priceMax};if(Object.isFrozen(d))boundsCache.set(d,bounds);}
 const a=layout.toScreen({time:bounds.timeMin,price:bounds.priceMin},d.panel,d.axisId),b=layout.toScreen({time:bounds.timeMax,price:bounds.priceMax},d.panel,d.axisId);
 const fontSize=Number((d.style?.font??layout.geometryFont??'12px monospace').match(/([0-9.]+)px/)?.[1]??12),textWidth=d.type==='text'?(d.text?.length??4)*fontSize*1.2:0,labelHeight=['text','measurement'].includes(d.type)?fontSize*2:0;
 return x>=Math.min(a.x,b.x)-tolerance&&x<=Math.max(a.x,b.x)+tolerance+textWidth&&y>=Math.min(a.y,b.y)-tolerance-labelHeight&&y<=Math.max(a.y,b.y)+tolerance+labelHeight;
}
export function drawingHitTest(store, layout, x, y, tolerance = 8) {
  if(!Number.isFinite(tolerance)||tolerance<1||tolerance>32)throw new RangeError('Drawing hit tolerance must be 1..32 logical pixels');
  const panel = layout.panels.find(p => y >= p.top && y <= p.bottom && x >= p.left && x <= p.right); if (!panel) return null;
  // Selected handles precede other geometry; otherwise latest drawing wins.
  const ordered = [...store.items].reverse().filter(d=>d.visible!==false).filter(d=>!isPositionDrawing(d.type)||d.points.every(point=>{const q=layout.toScreen(point,d.panel,d.axisId);return Number.isFinite(q.x)&&Number.isFinite(q.y);})); const selected = ordered.find(d => d.id === store.selected);
  if (selected && (!layout.drawingAxis||layout.drawingAxis(selected)) && !selected.locked && selected.panel === panel.id) {
    const points = selected.points.map(p => layout.toScreen(p, panel.id,selected.axisId));
    let handle=-1,distance=Infinity;for(let i=0;i<points.length;i++){const d=Math.hypot(points[i].x-x,points[i].y-y);if(d<=tolerance&&d<distance){handle=i;distance=d;}}if(handle>=0)return {id:selected.id,handle};
  }
  for (const d of ordered) {
    // Keep the existing centerline allowance for thin strokes, but include the
    // visible half-width of thick bodies. Handles/text retain their own radius.
    const bodyTolerance=d.type==='text'?tolerance:Math.max(tolerance,(d.style?.width??1.5)/2);
    if((layout.drawingAxis&&!layout.drawingAxis(d))||d.panel!==panel.id||!candidateBounds(d,layout,x,y,bodyTolerance))continue; const a = layout.toScreen(d.points[0], d.panel,d.axisId), b = d.points[1] ? layout.toScreen(d.points[1], d.panel,d.axisId) : a;
    let hit = false;
    if(isPositionDrawing(d.type)){const c=layout.toScreen(d.points[2],d.panel,d.axisId),end=layout.toScreen(d.points[3],d.panel,d.axisId);hit=x>=a.x-bodyTolerance&&x<=end.x+bodyTolerance&&y>=Math.min(b.y,c.y)-bodyTolerance&&y<=Math.max(b.y,c.y)+bodyTolerance;}
    else if (d.type === 'horizontal') hit = Math.abs(y - a.y) <= bodyTolerance;
    else if(d.type==='text'){const metrics=labelMetrics(d.style?.font??layout.geometryFont??'12px monospace');hit=x>=a.x-tolerance&&x<=a.x+labelWidth(d.text??'Note',metrics)+tolerance&&y>=a.y-metrics.ascent-tolerance&&y<=a.y+metrics.descent+tolerance;}
    else if (!['rectangle','ellipse'].includes(d.type)) {for(const c of drawingGeometry(d,layout))if(c.op==='lines'){for(let i=0;i<c.coords.length;i+=4)if(segmentDistance(x,y,{x:c.coords[i],y:c.coords[i+1]},{x:c.coords[i+2],y:c.coords[i+3]})<=bodyTolerance){hit=true;break;}if(hit)break;}}
    else if (d.type === 'rectangle') {const l = Math.min(a.x, b.x), r = Math.max(a.x, b.x), t = Math.min(a.y, b.y), z = Math.max(a.y, b.y); hit = x >= l - bodyTolerance && x <= r + bodyTolerance && y >= t - bodyTolerance && y <= z + bodyTolerance && Math.min(Math.abs(x - l), Math.abs(x - r), Math.abs(y - t), Math.abs(y - z)) <= bodyTolerance;}
    else {
      const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
      if (rx && ry) hit = Math.abs(Math.hypot((x - (a.x + b.x) / 2) / rx, (y - (a.y + b.y) / 2) / ry) - 1) * Math.min(rx, ry) <= bodyTolerance;
      // One collapsed radius still draws an axis-aligned stroke. A point with
      // both radii zero has no outline; only its existing selected handles hit.
      else if (rx || ry) hit = segmentDistance(x, y, a, b) <= bodyTolerance;
    }
    if (hit) return {id: d.id, handle: -1, locked: !!d.locked};
  }
  return null;
}
