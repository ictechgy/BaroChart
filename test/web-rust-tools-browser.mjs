import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {createDemoServer} from '../scripts/serve.mjs';
import {launchBrowser} from '../scripts/cdp.mjs';

const DRAWING_TYPES=[
  'trendline','horizontal','fibonacci','rectangle','ellipse','text','ray','extendedline',
  'channel','fibextension','fibfan','fibtimezones','freehand','measurement','longposition','shortposition',
];

await mkdir('artifacts/web-rust-wasm',{recursive:true});
const server=createDemoServer();
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
let browser;
try{
  browser=await launchBrowser({width:1280,height:900,dpr:1});
  await browser.navigate(`http://127.0.0.1:${server.address().port}/examples/web/?backend=rust-wasm`);
  const result=await browser.evaluate(`(async()=>{
    const owner=await window.baroDemo.ready;
    if(owner?.backend!=='rust-wasm')throw new Error('Rust backend did not mount');
    const {session,chart}=owner;
    const waitFor=async(predicate,label)=>{for(let index=0;index<500;index++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Timeout during '+label);};
    await chart.flush();
    if(session.snapshot().data.length!==100000)throw new Error('Expected 100000 synthetic bars');
    const canvas=chart.canvas,rect=canvas.getBoundingClientRect(),point=(x,y)=>({clientX:rect.left+x,clientY:rect.top+y});
    const dispatchDrag=(id,x1,y1,x2,y2)=>{
      const start=point(x1,y1),middle=point((x1+x2)/2,(y1+y2)/2),end=point(x2,y2);
      canvas.dispatchEvent(new PointerEvent('pointerdown',{...start,pointerId:id,pointerType:'mouse',button:0,buttons:1,bubbles:true,cancelable:true}));
      canvas.dispatchEvent(new PointerEvent('pointermove',{...middle,pointerId:id,pointerType:'mouse',button:0,buttons:1,bubbles:true,cancelable:true}));
      canvas.dispatchEvent(new PointerEvent('pointermove',{...end,pointerId:id,pointerType:'mouse',button:0,buttons:1,bubbles:true,cancelable:true}));
      canvas.dispatchEvent(new PointerEvent('pointerup',{...end,pointerId:id,pointerType:'mouse',button:0,buttons:0,bubbles:true,cancelable:true}));
    };
    const toolResults=[];
    for(const [index,type] of ${JSON.stringify(DRAWING_TYPES)}.entries()){
      const button=document.querySelector('[data-tool="'+type+'"]');
      if(!button)throw new Error('Missing Rust tool button: '+type);
      button.click();
      await waitFor(()=>session.snapshot().interaction.tool===type,'tool '+type);
      if(type==='text'){
        const annotation=document.getElementById('annotation');annotation.value='browser QA '+index;annotation.dispatchEvent(new Event('input',{bubbles:true}));
      }
      const before=(await session.query('web.drawingsState')).items.length;
      dispatchDrag(100+index,120+(index%5)*25,120+(index%4)*30,420+(index%5)*25,250+(index%4)*25);
      await chart.flush();
      const drawings=await session.query('web.drawingsState'),item=drawings.items.at(-1);
      if(drawings.items.length!==before+1||item?.type!==type)throw new Error('Rust drawing creation failed for '+type+': '+JSON.stringify({before,after:drawings.items.length,item}));
      toolResults.push({type,tool:session.snapshot().interaction.tool,count:drawings.items.length,canUndo:drawings.canUndo});
    }
    const allTypes=new Set((await session.query('web.drawingsState')).items.map(item=>item.type));
    if(allTypes.size!==${JSON.stringify(DRAWING_TYPES)}.length||${JSON.stringify(DRAWING_TYPES)}.some(type=>!allTypes.has(type)))throw new Error('Rust tool coverage set mismatch');

    const snap=document.getElementById('crosshair-snap'),magnet=document.getElementById('magnet');
    snap.value='ohlc';snap.dispatchEvent(new Event('change',{bubbles:true}));magnet.value='strong';magnet.dispatchEvent(new Event('change',{bubbles:true}));
    await waitFor(()=>session.snapshot().interaction.crosshairSnap?.mode==='ohlc'&&session.snapshot().interaction.drawingMagnet?.mode==='strong','snap/magnet');
    const beforeView={...session.snapshot().view};
    canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:120,deltaMode:0,clientX:rect.left+300,clientY:rect.top+180,bubbles:true,cancelable:true}));
    await chart.flush();
    const afterWheel=session.snapshot().view;
    if(Object.is(beforeView.from,afterWheel.from)&&Object.is(beforeView.to,afterWheel.to))throw new Error('Rust wheel input did not change the view');

    const drawingsBeforeDelete=(await session.query('web.drawingsState')).items.length;
    canvas.focus();canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}));await chart.flush();
    const deleted=await session.query('web.drawingsState');
    if(deleted.items.length!==drawingsBeforeDelete-1||!deleted.canUndo)throw new Error('DOM Delete did not update Rust drawings');
    canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}));await chart.flush();
    const undone=await session.query('web.drawingsState');if(undone.items.length!==drawingsBeforeDelete)throw new Error('DOM Ctrl+Z did not restore Rust drawing');
    canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}));await chart.flush();
    const redone=await session.query('web.drawingsState');if(redone.items.length!==drawingsBeforeDelete-1)throw new Error('DOM Ctrl+Y did not redo Rust drawing');

    const drawingCount=redone.items.length;
    await chart.replaceRenderer('webgl2').catch(()=>{});await chart.flush();
    const renderer=chart.rendererKind,afterRenderer=await session.query('web.drawingsState');
    if(afterRenderer.items.length!==drawingCount)throw new Error('Renderer replacement changed Rust drawings');
    return {passed:true,backend:owner.backend,bars:session.snapshot().data.length,toolCount:toolResults.length,tools:toolResults,allDrawingTypes:[...allTypes].sort(),snap:session.snapshot().interaction.crosshairSnap,magnet:session.snapshot().interaction.drawingMagnet,wheelChanged:true,domDeleteUndoRedo:true,renderer,rendererPreservedDrawings:true};
  })()`);
  assert.equal(result.passed,true);
  assert.equal(result.toolCount,DRAWING_TYPES.length);
  assert.deepEqual(result.allDrawingTypes,[...DRAWING_TYPES].sort());
  await writeFile('artifacts/web-rust-wasm/tools-browser.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
