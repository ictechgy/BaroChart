// Documentation rasterization, not a browser screenshot or a native SDK test.
// Optional development-only backend: @napi-rs/canvas 0.1.100. No runtime dependency.
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ChartModel,DARK_THEME,LIGHT_THEME,seededColumns,buildScene} from '../src/core/index.mjs';
import {renderCanvas,createChartUIPreset} from '../src/renderers/canvas.mjs';

export const PREVIEW_SOURCE = '01e4e1a83a560552c0e0274eaa685befced67412';
export const PREVIEW_SIZE = Object.freeze({width:390,height:896,dpr:2,chartWidth:366,chartHeight:460});
export function previewScene(themeName) {
  if (!['dark','light'].includes(themeName)) throw new TypeError('Preview theme');
  const model = new ChartModel({theme:{...(themeName === 'dark' ? DARK_THEME : LIGHT_THEME),font:'12px \"DejaVu Sans Mono\"'},
    panels:[{id:'price',weight:3.5},{id:'volume',weight:1,precision:0}]});
  try {
    model.store.setColumns(seededColumns(512));
    model.addSeries({id:'price',type:'candles',panel:'price'});
    model.addSeries({id:'volume',type:'histogram',source:'volume',panel:'volume',color:'#4c8cad'});
    model.setVisibleRange(443.5,511.5);
    const scene = buildScene(model,PREVIEW_SIZE.chartWidth,PREVIEW_SIZE.chartHeight);
    return {width:scene.width,height:scene.height,background:scene.background,
      commands:scene.commands,stats:scene.stats,view:{...model.view}};
  } finally { model.dispose(); }
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function generatePreviews(output = new URL('../assets/previews/',import.meta.url)) {
  const require = createRequire(import.meta.url);
  const {createCanvas} = require('@napi-rs/canvas');
  const backend = require('@napi-rs/canvas/package.json');
  const {width,height,dpr,chartWidth,chartHeight} = PREVIEW_SIZE;
  const preset = createChartUIPreset('mobile'), images = [];
  await mkdir(output,{recursive:true});
  for (const themeName of ['dark','light']) {
    const dark = themeName === 'dark', scene = previewScene(themeName);
    const colors = dark ? {background:'#0c1320',surface:'#111d2e',text:'#dfe8f4',border:'#8195ad',selected:'#18352f',selectedText:'#7ce8ca'}
      : {background:'#f8fafc',surface:'#ffffff',text:'#203047',border:'#8195ad',selected:'#d6eee7',selectedText:'#0c4b3c'};
    const canvas = createCanvas(width*dpr,height*dpr), ctx = canvas.getContext('2d');
    ctx.scale(dpr,dpr);
    const box = (x,y,w,h,fill,stroke=null) => {ctx.fillStyle=fill;ctx.fillRect(x,y,w,h);if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=1;ctx.strokeRect(x+.5,y+.5,w-1,h-1);}};
    const text = (value,x,y,size=13,color=colors.text,weight='normal') => {ctx.fillStyle=color;ctx.font=`${weight} ${size}px \"DejaVu Sans\"`;ctx.fillText(value,x,y);};
    box(0,0,width,height,colors.background);
    text('Mobile web preview',12,29,23,colors.text,'bold');
    text('Source-derived · not a browser screenshot',12,51,12);
    text('Chart area only; settings panel omitted',12,70,12);
    box(12,84,366,212,colors.surface,colors.border);
    text('UI / UX customization',24,109,17,colors.text,'bold');
    text(`Mobile preset · ${dark?'Dark':'Light'} appearance`,24,132,13);
    const controls = [
      ['select','Select / pan',18,146,173],['trendline','Trend line',197,146,173],
      ['horizontal','Horizontal line',18,196,173],['rectangle','Rectangle',197,196,173],
      ['fit','Fit all',18,246,112],['undo','Undo',136,246,112],['redo','Redo',254,246,116],
    ];
    for (const [id,label,x,y,w] of controls) {
      const selected=id==='select', disabled=id==='undo'||id==='redo';
      ctx.save();if(disabled)ctx.globalAlpha=.5;
      box(x,y,w,44,selected?colors.selected:colors.background,colors.border);
      text(label,x+10,y+27,13,selected?colors.selectedText:colors.text);ctx.restore();
    }
    const chart = createCanvas(chartWidth*dpr,chartHeight*dpr);
    renderCanvas(chart.getContext('2d'),scene,dpr); // Actual production draw path.
    ctx.drawImage(chart,12,314,chartWidth,chartHeight);
    text('512 synthetic bars · zoomed chart view',12,799,13);
    text(`${preset.interaction.hitTolerancePx}px hit tolerance · wheel zoom off`,12,822,13);
    text('Illustrated chrome based on current CSS.',12,849,12);
    text('Touch / browser layout remain unverified.',12,867,12);
    text('Not an iOS or Android native screen.',12,885,12);
    const bytes=canvas.toBuffer('image/png'),file=`mobile-web-${themeName}-preview.png`;
    await writeFile(new URL(file,output),bytes);
    images.push({file,theme:themeName,width:width*dpr,height:height*dpr,logicalWidth:width,logicalHeight:height,
      bytes:bytes.length,sha256:hash(bytes),sceneSha256:hash(JSON.stringify(scene)),stats:scene.stats});
  }
  const sourceFiles=['src/core/model.mjs','src/core/scene.mjs','src/renderers/canvas.mjs','src/renderers/chart-ui.mjs',
    'src/renderers/chart-toolbar.mjs','examples/web/customization.css','examples/web/customization.mjs','scripts/readme-previews.mjs'];
  const sources=[];for(const path of sourceFiles)sources.push({path,sha256:hash(await readFile(new URL('../'+path,import.meta.url)))});
  const manifest={schema:'barochart.documentation-previews',version:1,sourceCommit:PREVIEW_SOURCE,
    generatedDateUTC:new Date().toISOString().slice(0,10),renderer:'Production buildScene + renderCanvas in Node, using '+backend.name+' '+backend.version,
    browserScreenshot:false,nativeSDKExecution:false,data:'seededColumns(512), synthetic; visible range 443.5..511.5',
    chrome:'Schematic application chrome based on customization CSS and mobile preset. Settings omitted and labels shortened; not computed browser CSS.',
    limitations:'No browser/device, touch, focus, screen-reader or performance validation. Fonts and raster output can vary by backend/environment.',
    fonts:{chrome:'DejaVu Sans',chart:'DejaVu Sans Mono'},size:PREVIEW_SIZE,mobilePreset:preset,sources,images};
  await writeFile(new URL('manifest.json',output),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const manifest=await generatePreviews();
  console.log(JSON.stringify({images:manifest.images,renderer:manifest.renderer},null,2));
}
