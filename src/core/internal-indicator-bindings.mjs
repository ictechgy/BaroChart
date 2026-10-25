import {ChartAPI} from './api.mjs';
import {ChartModel} from './model.mjs';

function ownData(object,key,label,optional=false){
  const descriptor=object&&Object.getOwnPropertyDescriptor(object,key);
  if(!descriptor){if(optional)return undefined;throw new TypeError(label+' own data slot required');}
  if(!Object.hasOwn(descriptor,'value'))throw new TypeError(label+' own data slot required');
  return descriptor.value;
}

/**
 * Restore the complete set of bindings for one live indicator.
 *
 * This module is intentionally not re-exported by either core index. It is a
 * host-side layout-history primitive and delegates all live-owner validation
 * and staged publication to ChartModel's private binding batch path.
 */
export function restoreIndicatorBindings(api,indicatorId,bindings){
  if(!(api instanceof ChartAPI))throw new TypeError('Actual ChartAPI required');
  const model=ownData(api,'model','Chart API');
  if(!(model instanceof ChartModel))throw new TypeError('Actual ChartModel required');
  if(ownData(model,'disposed','Chart',true))throw new Error('Chart disposed');
  const controller=ownData(api,'controller','Chart API',true);
  if(controller!==undefined&&controller!==null&&ownData(controller,'model','Interaction controller')!==model)throw new Error('Indicator binding controller owner mismatch');
  const invalidate=ownData(api,'invalidate','Chart API');
  if(typeof invalidate!=='function')throw new TypeError('Chart API invalidation callback required');
  const result=ChartModel.prototype._restoreIndicatorBindings.call(model,indicatorId,bindings,{owner:api,controller:controller??null,updateControllerTarget:true});
  if(!result.changed)return {changed:0};
  invalidate.call(api);
  return {changed:result.changed};
}
