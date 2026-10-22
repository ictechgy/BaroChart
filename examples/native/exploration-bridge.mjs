// Ephemeral, explicit semantic selection; no subscriptions or chart invalidation.
const nativeExplorers=new WeakMap();
function nativeExplorationSlot(owner,key){const d=Object.getOwnPropertyDescriptor(owner,key);if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Exploration owner data property required');return d.value;}
function nativeExplorationDisposed(model){const d=Object.getOwnPropertyDescriptor(model,'disposed');if(d&&!Object.hasOwn(d,'value'))throw new TypeError('Exploration disposed data property required');return d?.value===true;}
function nativeExplorationStale(){const error=new Error('Native exploration owner/source changed');error.name='StaleSourceError';return error;}
globalThis.nativeDataExploration=function(action,argument){
 if(!['setActive','navigate','refresh','read'].includes(action))throw new TypeError('Exploration action');
 if(action==='setActive'&&typeof argument!=='boolean')throw new TypeError('Exploration active boolean');
 if(action==='navigate'&&!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(argument))throw new TypeError('Exploration navigation key');
 if((action==='refresh'||action==='read')&&argument!==undefined&&argument!==null)throw new TypeError('Exploration action takes no argument');
 const model=nativeExplorationSlot(globalThis,'nativeModel'),api=nativeExplorationSlot(globalThis,'nativeAPI'),input=nativeExplorationSlot(globalThis,'nativeInput');
 const store=nativeExplorationSlot(model,'store'),version=nativeExplorationSlot(store,'version');
 const check=()=>{if(nativeExplorationSlot(globalThis,'nativeModel')!==model||nativeExplorationSlot(globalThis,'nativeAPI')!==api||nativeExplorationSlot(globalThis,'nativeInput')!==input||nativeExplorationSlot(api,'model')!==model||nativeExplorationSlot(api,'controller')!==input||nativeExplorationSlot(input,'model')!==model||nativeExplorationDisposed(model)||nativeExplorationSlot(model,'store')!==store||nativeExplorationSlot(store,'version')!==version)throw nativeExplorationStale();};
 check();if(action==='setActive'&&argument&&nativeExplorationSlot(input,'gesture'))throw new Error('Exploration requires an idle gesture');
 let owner=nativeExplorers.get(api);
 if(owner&&owner.model!==model){owner.explorer.dispose();nativeExplorers.delete(api);owner=null;}
 if(!owner){owner={model,explorer:new NativeKeyboardDataExplorer(api),busy:false};nativeExplorers.set(api,owner);}
 if(owner.busy)throw new Error('Exploration operation already running');owner.busy=true;
 try{
  let state;
  if(action==='setActive')state=owner.explorer.setActive(argument);
  else{
   owner.explorer.changed();
   if(action==='read')state=owner.explorer.read();
   else{if(action==='navigate'&&!owner.explorer.key(argument))throw new Error('Enable data exploration first');state=owner.explorer.snapshot();}
  }
  check();return {schema:'aster.native-data-exploration',version:1,...state};
 }finally{owner.busy=false;}
};
