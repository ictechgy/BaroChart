import {workspaceSnapshot} from '../core/workspace.mjs';
import {safeCheckpointParse} from '../core/checkpoint-validation.mjs';
import {optionRecord} from '../core/contracts.mjs';
import {interactionOptions,DEFAULT_INTERACTION_OPTIONS} from './interaction-options.mjs';
import {chartToolbarOptions,DEFAULT_TOOLBAR_OPTIONS} from './chart-toolbar-options.mjs';

const UI_CHARS=8192;
function complete(value,keys){optionRecord(value,keys,'Chart UI');if(keys.some(key=>!Object.hasOwn(value,key)))throw new TypeError('Chart UI missing field');}
function configuration(value,document=false){
 const data=workspaceSnapshot(value);
 if(document){
  complete(data,['schema','version','interaction','toolbar']);
  if(data.schema!=='barochart.web-ui'||data.version!==1)throw new TypeError('Chart UI schema/version');
  complete(data.interaction,Object.keys(DEFAULT_INTERACTION_OPTIONS));
  if(data.toolbar!==null)complete(data.toolbar,Object.keys(DEFAULT_TOOLBAR_OPTIONS));
 }else optionRecord(data,['interaction','toolbar'],'Chart UI');
 return Object.freeze({interaction:interactionOptions(Object.hasOwn(data,'interaction')?data.interaction:{}),toolbar:!Object.hasOwn(data,'toolbar')||data.toolbar===null?null:chartToolbarOptions(data.toolbar)});
}
/** Portable preferences only: no chart mutation, DOM, storage or transient state. */
export function saveChartUI(options={}){
 const ui=configuration(options),text=JSON.stringify({schema:'barochart.web-ui',version:1,...ui});
 if(text.length>UI_CHARS)throw new RangeError('Chart UI text limit');
 return text;
}
export function readChartUI(text){
 if(typeof text!=='string'||text.length>UI_CHARS)throw new RangeError('Chart UI text limit');
 return configuration(safeCheckpointParse(text),true);
}
/** Explicit values only; no user-agent detection, mounting or global mutation. */
export function createChartUIPreset(name){
 if(name!=='desktop'&&name!=='mobile')throw new TypeError('Chart UI preset must be desktop or mobile');
 return configuration(name==='mobile'?{
  interaction:{pointer:true,wheelZoom:false,keyboardShortcuts:true,hitTolerancePx:24},
  toolbar:{density:'comfortable',orientation:'horizontal',actions:['fit','undo','redo']},
 }:{interaction:{},toolbar:{}});
}
