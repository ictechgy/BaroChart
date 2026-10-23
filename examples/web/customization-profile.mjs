import {ChartAPI,ChartModel,readChartUI,saveChartUI} from '../../src/index.mjs';

const PROFILE_SCHEMA='barochart.customization-profile',PROFILE_VERSION=1,PROFILE_CHARS=16384;
const THEME_KEYS=['background','grid','text','up','down','crosshair','font'];
const LAYOUT_KEYS=['priceWeight','volumeWeight','axisSide','placement'];
const UI_KEYS=['interaction','toolbar'];
const EXTRA_KEYS=['navigator','overlays','tradeMarkers'];
const RESERVED=new Set(['__proto__','constructor','prototype','toJSON']);

function plain(value,label){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError(label+': plain object required');
 return value;
}
function dataRecord(value,keys,label){
 plain(value,label);const own=Reflect.ownKeys(value);
 if(own.length!==keys.length||own.some(key=>typeof key!=='string'||RESERVED.has(key)||!keys.includes(key)))throw new TypeError(label+': exact fields required');
 for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))throw new TypeError(label+': own data fields required');}
 return value;
}
function scalar(value,label){
 if(value===null||typeof value==='boolean'||typeof value==='string')return value;
 if(typeof value==='number'&&Number.isFinite(value))return value;
 throw new TypeError(label+': portable value required');
}
function copyPortable(value,label='Profile value',ancestors=new Set(),depth=0){
 if(value===null||typeof value!=='object'){scalar(value,label);return value;}
 if(ancestors.has(value)||depth>32)throw new RangeError(label+': cyclic/deep value');
 ancestors.add(value);
 let result;
 if(Array.isArray(value)){
  const keys=Reflect.ownKeys(value),length=value.length;
  if(!Number.isSafeInteger(length)||length>10000||keys.length!==length+1||keys.some(key=>key!=='length'&& (typeof key!=='string'||!/^(?:0|[1-9]\d*)$/.test(key)||Number(key)>=length)))throw new TypeError(label+': array data fields required');
  const lengthDescriptor=Object.getOwnPropertyDescriptor(value,'length');
  if(!lengthDescriptor||lengthDescriptor.enumerable||!Object.hasOwn(lengthDescriptor,'value'))throw new TypeError(label+': array length');
  result=[];
  for(let index=0;index<length;index++){
   const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
   if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))throw new TypeError(label+': dense array required');
   result.push(copyPortable(descriptor.value,label+'['+index+']',ancestors,depth+1));
  }
 }else{
  plain(value,label);result={};
  for(const key of Reflect.ownKeys(value)){
   if(typeof key!=='string'||RESERVED.has(key))throw new TypeError(label+': reserved/symbol field');
   const descriptor=Object.getOwnPropertyDescriptor(value,key);
   if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))throw new TypeError(label+': own data fields required');
   Object.defineProperty(result,key,{value:copyPortable(descriptor.value,label+'.'+key,ancestors,depth+1),enumerable:true,writable:true,configurable:true});
  }
 }
 ancestors.delete(value);return result;
}
function numberRange(value,min,max,label){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new RangeError(label+': '+min+'..'+max);return value;}
function validateLayout(value){
 const layout=dataRecord(value,LAYOUT_KEYS,'Profile layout');
 if(!['left','right'].includes(layout.axisSide))throw new TypeError('Profile axis side');
 if(!['left','top','right'].includes(layout.placement))throw new TypeError('Profile placement');
 return {priceWeight:numberRange(layout.priceWeight,.5,8,'Price weight'),volumeWeight:numberRange(layout.volumeWeight,.5,8,'Volume weight'),axisSide:layout.axisSide,placement:layout.placement};
}
function validateExtras(value){
 const extras=dataRecord(value,EXTRA_KEYS,'Profile extras');
 for(const key of EXTRA_KEYS)if(typeof extras[key]!=='boolean')throw new TypeError('Profile extra must be boolean: '+key);
 return {navigator:extras.navigator,overlays:extras.overlays,tradeMarkers:extras.tradeMarkers};
}
function validateFont(value){
 if(typeof value!=='string')throw new TypeError('Profile font required');
 const match=value.trim().match(/^((?:(?:bold|italic|normal)\s+)*)(\d+(?:\.\d+)?)px\s+monospace$/);
 if(!match||!Number.isFinite(Number(match[2]))||Number(match[2])<10||Number(match[2])>24)throw new RangeError('Profile font must be 10..24px monospace');
 return value;
}
function normalizedTheme(value){
 const theme=dataRecord(value,THEME_KEYS,'Profile theme');validateFont(theme.font);
 let model;
 try{
  model=new ChartModel();const api=new ChartAPI(model);api.setTheme(theme);
  return Object.fromEntries(THEME_KEYS.map(key=>[key,model.theme[key]]));
 }finally{model?.dispose();}
}
function normalizedUI(value){
 const ui=dataRecord(value,UI_KEYS,'Profile UI');
 const copy=copyPortable(ui,'Profile UI');
 const text=saveChartUI(copy),normalized=readChartUI(text);
 return {text,normalized};
}
function validateToolbarPlacement(ui,layout){
 if(ui.toolbar===null)throw new TypeError('Customization profile toolbar is required');
 const expected=layout.placement==='top'?'horizontal':'vertical';
 if(ui.toolbar.orientation!==expected)throw new TypeError('Customization profile toolbar orientation does not match placement');
}
function normalizedInput(input){
 const config=dataRecord(input,['theme','layout','ui','extras'],'Customization profile');
 const theme=copyPortable(config.theme,'Profile theme');
 const layout=copyPortable(config.layout,'Profile layout');
 const ui=copyPortable(config.ui,'Profile UI');
 const extras=copyPortable(config.extras,'Profile extras');
 const normalizedLayout=validateLayout(layout),normalizedUi=normalizedUI(ui);validateToolbarPlacement(normalizedUi.normalized,normalizedLayout);
 return {theme:normalizedTheme(theme),layout:normalizedLayout,ui:normalizedUi,extras:validateExtras(extras)};
}
function freeze(value){
 if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
function readDocument(text){
 if(typeof text!=='string'||text.length>PROFILE_CHARS)throw new RangeError('Customization profile text limit');
 let document;try{document=JSON.parse(text);}catch(error){throw new TypeError('Customization profile JSON', {cause:error});}
 dataRecord(document,['schema','version','theme','layout','extras','uiText'],'Customization profile document');
 if(document.schema!==PROFILE_SCHEMA||document.version!==PROFILE_VERSION)throw new TypeError('Customization profile schema/version');
 if(typeof document.uiText!=='string')throw new TypeError('Customization profile UI text required');
 const theme=copyPortable(document.theme,'Profile theme'),layout=copyPortable(document.layout,'Profile layout'),extras=copyPortable(document.extras,'Profile extras');
 const ui=readChartUI(document.uiText),normalizedLayout=validateLayout(layout);validateToolbarPlacement(ui,normalizedLayout);
 return freeze({theme:normalizedTheme(theme),layout:normalizedLayout,ui,extras:validateExtras(extras)});
}

/** Serialize only the customization-studio appearance and host-owned chrome choices. */
export function saveCustomizationProfile(input){
 const {theme,layout,ui,extras}=normalizedInput(input);
 const text=JSON.stringify({schema:PROFILE_SCHEMA,version:PROFILE_VERSION,theme,layout,extras,uiText:ui.text});
 if(text.length>PROFILE_CHARS)throw new RangeError('Customization profile text limit');
 return text;
}

/** Read a detached, deeply frozen customization-studio configuration. */
export function readCustomizationProfile(text){return readDocument(text);}
