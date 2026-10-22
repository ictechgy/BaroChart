// Chart annotations only: no position sizing, orders, fills or account state.
export function isPositionDrawing(type){return type==='longposition'||type==='shortposition';}
export function positionMetricsFor(d){
 const [entry,stop,target,extent]=d.points,direction=d.type==='longposition'?'long':'short',sign=direction==='long'?1:-1;
 const risk=(entry.price-stop.price)*sign,reward=(target.price-entry.price)*sign,ratio=reward/risk;
 if(stop.time!==entry.time||target.time!==entry.time||extent.price!==entry.price||!(extent.time>entry.time))throw new RangeError('Position anchors require shared start/entry and positive time extent');
 if(!(risk>0&&reward>0&&ratio>0)||![risk,reward,ratio].every(Number.isFinite))throw new RangeError('Position requires ordered entry/stop/target and finite positive risk, reward and ratio');
 const percent=value=>{const n=value/Math.abs(entry.price)*100;return Number.isFinite(n)?n:null;};
 return {direction,startTime:entry.time,endTime:extent.time,entry:entry.price,stop:stop.price,target:target.price,risk,reward,riskPercent:percent(risk),rewardPercent:percent(reward),ratio};
}
export function positionPointsValid(type,points){
 if(points.length!==4||points.some(p=>!Number.isFinite(p.time)||Math.abs(p.time)>8640000000000000||!Number.isFinite(p.price)))return false;
 try{positionMetricsFor({type,points});return true;}catch{return false;}
}
// Four stable semantic handles: entry/start, stop, target, extent/entry.
export function positionHandlePoints(points,handle,point){
 const next=points.map(p=>({...p}));
 if(handle===0){next[0]={...point};next[1].time=next[2].time=point.time;next[3].price=point.price;}
 else if(handle===1||handle===2)next[handle].price=point.price;
 else if(handle===3)next[3].time=point.time;
 return next;
}
export function initialPositionPoints(type,point,layout,target){
 const axis=layout.axis(target.panel,target.axisId),screen=layout.toScreen(point,target.panel,target.axisId);
 if(!axis)return null;
 const a=axis.price(screen.y-40),b=axis.price(screen.y+40),low=Math.min(a,b),high=Math.max(a,b),long=type==='longposition';
 const points=[{...point},{time:point.time,price:long?low:high},{time:point.time,price:long?high:low},{time:layout.fromScreen(screen.x+80,screen.y,target.panel,target.axisId).time,price:point.price}];
 return positionPointsValid(type,points)?points:null;
}
// New semantics must never be silently represented as a legacy document.
export function drawingDocumentVersion(items){return items.some(d=>d.visible!==undefined)?4:items.some(d=>isPositionDrawing(d.type))?3:items.some(d=>d.axisId!=null||d.seriesId!=null)?2:1;}
export function validateDrawingDocumentVersion(d,version){
 if(d.visible!==undefined&&version<4)throw new TypeError('Drawing visibility requires document version 4');
 if(isPositionDrawing(d.type)&&version<3)throw new TypeError('Position drawings require document version 3');
 if(version===1&&(d.axisId!=null||d.seriesId!=null))throw new TypeError('Bound drawings require document version 2');
}
