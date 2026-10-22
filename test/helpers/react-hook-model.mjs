export let hookState;
export function reset(host){hookState={host,refs:[],refIndex:0,effects:[],effectIndex:0,pending:[]};}
export function begin(){hookState.refIndex=hookState.effectIndex=0;hookState.pending=[];}
export function commit(){for(const i of hookState.pending){const e=hookState.effects[i];e.cleanup?.();e.cleanup=e.callback();}}
export function dispose(){for(const e of hookState.effects)e.cleanup?.();}
export const forwardRef=fn=>fn;
export function useRef(value){const i=hookState.refIndex++;return hookState.refs[i]??=({current:value});}
export function useEffect(callback,deps){const i=hookState.effectIndex++,old=hookState.effects[i];if(!old||!deps||deps.some((v,j)=>!Object.is(v,old.deps?.[j]))){hookState.effects[i]={callback,deps,cleanup:old?.cleanup};hookState.pending.push(i);}}
export const useLayoutEffect=useEffect;
export function useImperativeHandle(ref,fn){if(ref)ref.current=fn();}
export function createElement(tag,props){if(props.ref)props.ref.current=hookState.host;return {tag,props};}
