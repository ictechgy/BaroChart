// Capture the real example through an isolated agent-browser session.
// Requires locally installed agent-browser and Chromium; installs nothing.
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,mkdtemp,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const run=promisify(execFile);
const root=fileURLToPath(new URL('..',import.meta.url));
const output=resolve(process.argv[2]??join(root,'assets/showcase'));
const temporary=await mkdtemp(join(tmpdir(),'barochart-showcase-'));
const session=`barochart-showcase-${process.pid}`;
const cli=process.env.AGENT_BROWSER_BIN??'agent-browser';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourcePaths=[
 'examples/web/showcase.html','examples/web/showcase.css','examples/web/showcase.mjs',
 'examples/web/showcase-data.mjs','src/core/model.mjs','src/core/scene.mjs',
 'src/core/labels.mjs','src/renderers/canvas.mjs','scripts/capture-showcase.mjs',
];
const snapshots=await Promise.all(sourcePaths.map(async path=>({path,sha256:sha(await readFile(join(root,path)))})));
const probe=createServer();
await new Promise((yes,no)=>{probe.once('error',no);probe.listen(0,'127.0.0.1',yes);});
const port=probe.address().port;
await new Promise(resolve=>probe.close(resolve));
const server=spawn(process.execPath,['scripts/serve.mjs'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let started=false;

async function browser(...args){
 const {stdout}=await run(cli,['--session',session,'--json',...args],{cwd:root,timeout:45000,maxBuffer:2*1024*1024});
 const result=JSON.parse(stdout);
 if(!result.success)throw new Error(result.error??'Browser action failed');
 return result.data;
}

try{
 await new Promise((yes,no)=>{
  const timer=setTimeout(()=>finish(new Error('Showcase server startup timed out')),10000);
  const data=chunk=>{if(String(chunk).includes('Aster demo:'))finish();};
  const failed=error=>finish(error),exited=()=>finish(new Error('Showcase server exited before ready'));
  function finish(error){clearTimeout(timer);server.stdout.off('data',data);server.off('error',failed);server.off('exit',exited);error?no(error):yes();}
  server.stdout.on('data',data);server.once('error',failed);server.once('exit',exited);
 });
 await mkdir(output,{recursive:true});
 const url=`http://127.0.0.1:${port}/examples/web/showcase.html`;
 const launch=['--allowed-domains','127.0.0.1,localhost','--args','--disable-background-networking'];
 if(process.env.CHROME_BIN)launch.push('--executable-path',process.env.CHROME_BIN);
 else if(process.platform==='darwin')launch.push('--executable-path','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
 await browser(...launch,'open',url+'?theme=dark');started=true;
 const images=[];
 for(const [layout,width,height] of [['desktop',1040,650],['mobile',390,780]]){
  for(const theme of ['dark','light']){
   await browser('set','viewport',String(width),String(height),'2');
   await browser('open',url+'?theme='+theme);
   await browser('wait','--fn','window.showcase?.readiness === true');
   const {result:state}=await browser('eval',`({
    ready:window.showcase.readiness,theme:document.body.dataset.theme,
    box:document.querySelector('#showcase').getBoundingClientRect().toJSON(),
    overflow:document.documentElement.scrollWidth>innerWidth,
    dpr:devicePixelRatio,browser:navigator.userAgent,fonts:document.fonts.status,
    stats:window.showcase.stats,canvasCount:document.querySelectorAll('#showcase canvas').length,
    chartError:window.showcase.chart.lastError?.message??null,
    externalRequests:performance.getEntriesByType('resource').filter(r=>new URL(r.name).origin!==location.origin).length
   })`);
   assert.equal(state.ready,true);assert.equal(state.theme,theme);assert.equal(state.fonts,'loaded');
   assert.equal(state.box.width,width);assert.equal(state.box.height,height);
   assert.equal(state.overflow,false);assert.equal(state.dpr,2);assert.equal(state.chartError,null);
   assert.equal(state.externalRequests,0);assert(state.canvasCount>=1);
   const file=`${layout}-${theme}.png`,temporaryImage=join(temporary,file);
   await browser('screenshot','#showcase',temporaryImage);
   const bytes=await readFile(temporaryImage);
   assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
   assert.equal(bytes.readUInt32BE(16),width*2);assert.equal(bytes.readUInt32BE(20),height*2);
   await copyFile(temporaryImage,join(output,file));
   images.push({file,layout,theme,width:width*2,height:height*2,logicalWidth:width,logicalHeight:height,dpr:2,
    bytes:bytes.length,sha256:sha(bytes),browser:state.browser,stats:state.stats});
  }
 }
 for(const source of snapshots)assert.equal(sha(await readFile(join(root,source.path))),source.sha256,'Source changed during capture: '+source.path);
 for(const layout of ['desktop','mobile']){
  const [dark,light]=images.filter(image=>image.layout===layout);
  assert.deepEqual(dark.stats,light.stats,'Theme variants must use identical data and viewport');
 }
 const {stdout:commit}=await run('git',['rev-parse','HEAD'],{cwd:root,timeout:10000});
 const manifest={schema:'barochart.showcase-captures',version:1,captureDateUTC:new Date().toISOString().slice(0,10),
  sourceCommit:commit.trim(),sources:snapshots,example:'examples/web/showcase.html',
  renderer:'Actual browser DOM and production CanvasChart',browserScreenshot:true,nativeSDKExecution:false,
  imageProcessing:'none; original element screenshot PNG bytes',
  design:{provider:'Claude',model:'claude-opus-5',selectedConcept:'Instrument Panel',alternateConcept:'Specimen Plate'},
  data:'Deterministic synthetic OHLCV; 1800 one-minute bars, host-aggregated into 1/5/15-minute intervals',
  capture:{tool:'agent-browser',selector:'#showcase',externalRequests:0,readiness:'document.fonts.ready and two requestAnimationFrame ticks after draw'},
  scope:'Custom example host UI, not the default SDK UI. Browser captures do not establish physical-device, native SDK, accessibility or performance validation.',images};
 await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify({sourceCommit:manifest.sourceCommit,images:images.map(({file,width,height,bytes})=>({file,width,height,bytes}))},null,2));
}finally{
 if(started)await browser('close').catch(()=>{});
 server.kill();
 await rm(temporary,{recursive:true,force:true});
}
