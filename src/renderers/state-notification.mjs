// Private, dispatch-scoped classification. Public event shape and delivery stay
// unchanged; replayed or host-created events deliberately require a full refresh.
const hoverOwners=new WeakMap();
export function notifyChartState(canvas,kind){
 const event=new Event('aster:state',{bubbles:true});
 if(kind==='hover')hoverOwners.set(event,canvas);
 try{canvas.dispatchEvent(event);}finally{hoverOwners.delete(event);}
}
export function isHoverStateEvent(event,canvas){return hoverOwners.get(event)===canvas&&canvas!==undefined;}
