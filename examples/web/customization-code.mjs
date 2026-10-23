import {readCustomizationProfile,saveCustomizationProfile} from './customization-profile.mjs';

const LANGUAGES=new Set(['javascript','typescript']);

// JSON is used as the source literal format, but JSON permits characters that
// are awkward in an inline module. Escaping the HTML-sensitive characters also
// keeps a generated module safe to place in a script element or code block.
function sourceLiteral(value){
 const text=JSON.stringify(value);
 if(text===undefined)throw new TypeError('Customization code value is not serializable');
 return text.replace(/[<>&/\u2028\u2029]/g,character=>({
  '<':'\\u003C','>':'\\u003E','&':'\\u0026','/':'\\u002F','\u2028':'\\u2028','\u2029':'\\u2029',
 }[character]));
}

function generatedTypes(language){
 if(language==='javascript')return {imports:"import {CanvasChart,ChartModel,attachChartNavigator,attachChartOverlays,attachChartToolbar,attachTradeMarkers} from 'barochart';",types:'',signature:'host,bars,markers=[]',locals:'let ownedRoot=null,model=null,chart=null,toolbar=null,navigator=null,overlays=null,tradeMarkers=null,destroyed=false;'};
 return {
  imports:"import {CanvasChart,ChartModel,attachChartNavigator,attachChartOverlays,attachChartToolbar,attachTradeMarkers} from 'barochart';\nimport type {Bar,TradeMarker} from 'barochart';",
  types:`export interface CustomizedChartMount {
 readonly chart: CanvasChart;
 readonly model: ChartModel;
 readonly toolbar: ReturnType<typeof attachChartToolbar> | null;
 readonly navigator: ReturnType<typeof attachChartNavigator> | null;
 readonly overlays: ReturnType<typeof attachChartOverlays> | null;
 readonly tradeMarkers: ReturnType<typeof attachTradeMarkers> | null;
 destroy(): void;
}
`,
  signature:'host: HTMLElement,bars: Bar[],markers: readonly TradeMarker[]=[]',
  locals:`let ownedRoot: HTMLElement|null=null,model: ChartModel|null=null,chart: CanvasChart|null=null,
  toolbar: ReturnType<typeof attachChartToolbar>|null=null,navigator: ReturnType<typeof attachChartNavigator>|null=null,
  overlays: ReturnType<typeof attachChartOverlays>|null=null,tradeMarkers: ReturnType<typeof attachTradeMarkers>|null=null,destroyed=false;`,
 };
}

/**
 * Produce a self-contained public-API module for a customization-studio
 * profile. The input is passed through the profile codec so the generated
 * source contains only detached, normalized data and no caller objects.
 */
export function generateCustomizationCode(profile,{language='javascript'}={}){
 if(!LANGUAGES.has(language))throw new TypeError('Customization code language must be javascript or typescript');
 const normalized=readCustomizationProfile(saveCustomizationProfile(profile));
 const embedded={theme:normalized.theme,layout:normalized.layout,ui:normalized.ui,extras:normalized.extras};
 const {imports,types,signature,locals}=generatedTypes(language);
 const literal=sourceLiteral(embedded);
 return `${imports}

const customizationProfile=Object.freeze(${literal}${language==='typescript'?' as const':''});

${types}export function mountCustomizedChart(${signature}) {
 const profile=customizationProfile;
 if(!host||typeof host.append!=='function')throw new TypeError('A DOM host element is required');
 const documentForMount=host.ownerDocument??globalThis.document;
 if(!documentForMount||typeof documentForMount.createElement!=='function')throw new TypeError('The host must belong to a document');
 ${locals}
 const destroy=()=>{
  if(destroyed)return;
  const cleanupErrors=[];
  for(const helper of [tradeMarkers,overlays,navigator,toolbar]){
   try{helper?.destroy();}catch(error){cleanupErrors.push(error);}
  }
  try{if(chart)chart.destroy({disposeModel:true});}catch(error){cleanupErrors.push(error);}
  try{model?.dispose();}catch(error){cleanupErrors.push(error);}
  try{ownedRoot?.remove();}catch(error){cleanupErrors.push(error);}
  if(cleanupErrors.length){
   if(cleanupErrors.length===1)throw cleanupErrors[0];
   throw new AggregateError(cleanupErrors,'Customized chart cleanup failed');
  }
  destroyed=true;
 };
 try{
  ownedRoot=documentForMount.createElement('div');
  ownedRoot.className='barochart-customized-chart';
  ownedRoot.setAttribute('data-barochart-owned','customization');
  ownedRoot.style.cssText='box-sizing:border-box;display:flex;gap:8px;width:100%;min-height:320px;min-width:0;align-items:stretch;';
  const placement=String(profile.layout.placement);
  ownedRoot.style.flexDirection=placement==='top'?'column':'row';

  const body=documentForMount.createElement('div');
  body.style.cssText='box-sizing:border-box;display:flex;flex:1 1 auto;flex-direction:column;gap:8px;min-width:0;min-height:320px;';
  const surface=documentForMount.createElement('div');
  surface.style.cssText='box-sizing:border-box;position:relative;flex:1 1 auto;min-width:0;min-height:320px;';
  const chartHost=documentForMount.createElement('div');
  chartHost.style.cssText='position:absolute;inset:0;min-width:0;min-height:0;';
  surface.append(chartHost);

  const toolbarHost=profile.ui.toolbar?documentForMount.createElement('div'):null;
  if(toolbarHost)toolbarHost.style.cssText='box-sizing:border-box;min-width:0;min-height:0;overflow:auto;'+(placement==='top'?'flex:0 0 auto;max-width:100%;':'flex:0 0 160px;max-width:40%;');
  const navigatorHost=profile.extras.navigator?documentForMount.createElement('div'):null;
  if(navigatorHost)navigatorHost.style.cssText='box-sizing:border-box;flex:0 0 auto;min-width:0;';
  const overlayHost=profile.extras.overlays?documentForMount.createElement('div'):null;
  if(overlayHost)overlayHost.style.cssText='position:absolute;inset:0;z-index:2;pointer-events:none;';
  const markerHost=profile.extras.tradeMarkers?documentForMount.createElement('div'):null;
  if(markerHost)markerHost.style.cssText='position:absolute;inset:0;z-index:3;pointer-events:none;';
  if(overlayHost)surface.append(overlayHost);
  if(markerHost)surface.append(markerHost);
  body.append(surface);
  if(navigatorHost)body.append(navigatorHost);
  if(placement==='right'){
   ownedRoot.append(body);
   if(toolbarHost)ownedRoot.append(toolbarHost);
  }else{
   if(toolbarHost)ownedRoot.append(toolbarHost);
   ownedRoot.append(body);
  }
  host.append(ownedRoot);

  model=new ChartModel({
   theme:profile.theme,
   panels:[
    {id:'price',weight:profile.layout.priceWeight,axisSide:profile.layout.axisSide},
    {id:'volume',weight:profile.layout.volumeWeight,axisSide:'right',precision:0},
   ],
  });
  model.store.setData(Array.from(bars));
  model.addSeries({id:'price',type:'candles',panel:'price'});
  model.addSeries({id:'volume',type:'histogram',source:'volume',panel:'volume',color:'#4c8cad'});
  chart=new CanvasChart(chartHost,model,{
   interaction:profile.ui.interaction,
   dpr:()=>Number.isFinite(globalThis.devicePixelRatio)?globalThis.devicePixelRatio:1,
   observeResize:typeof globalThis.ResizeObserver==='function',
  });
  if(toolbarHost&&profile.ui.toolbar)toolbar=attachChartToolbar(toolbarHost,chart,profile.ui.toolbar);
  if(navigatorHost)navigator=attachChartNavigator(navigatorHost,chart,{label:'Chart navigator'});
  if(overlayHost)overlays=attachChartOverlays(overlayHost,chart,{label:'Chart overlays'});
  if(markerHost)tradeMarkers=attachTradeMarkers(markerHost,chart,{markers});
  return {chart,model,toolbar,navigator,overlays,tradeMarkers,destroy};
 }catch(error){
  try{destroy();}catch(cleanupError){throw new AggregateError([error,cleanupError],'Customized chart mount and cleanup failed',{cause:error});}
  throw error;
 }
}
`;
}
