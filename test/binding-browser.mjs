import {createServer} from 'node:http';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, extname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchBrowser} from '../scripts/cdp.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDir = '/tmp/aster-cycle9-web-qa';
const label = process.argv.includes('--tool-before') ? 'tool-before' : process.argv.includes('--before') ? 'before' : 'after';
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/favicon.ico') {response.writeHead(204); response.end(); return;}
  if (!/^\/(src|examples\/web)\//.test(pathname) || pathname.includes('..')) {response.writeHead(404); response.end(); return;}
  try {const content = await readFile(resolve(root, '.' + pathname));
    response.writeHead(200, {'Content-Type': {'.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css'}[extname(pathname)] ?? 'application/octet-stream', 'Cache-Control': 'no-store'}); response.end(content);
  } catch {response.writeHead(404); response.end();}
});
await mkdir(outputDir, {recursive: true});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser; const results = [], exceptions = [], warnings = [], requests = [];
try {
  for (const width of [1280, 430]) for (const renderer of ['canvas', 'webgl2']) {
    browser = await launchBrowser({width, height: 1100, dpr: width === 430 ? 2 : 1});
    browser.on('Runtime.exceptionThrown', e => exceptions.push(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text));
    browser.on('Runtime.consoleAPICalled', e => {if (['warning', 'error'].includes(e.type)) warnings.push(e.args.map(a => a.value ?? a.description).join(' '));});
    await browser.send('Network.enable'); browser.on('Network.requestWillBeSent', e => requests.push(e.request.url));
    await browser.navigate(`http://127.0.0.1:${server.address().port}/examples/web/axes.html`);
    const initial = await browser.evaluate(`(async()=>{const wait=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await wait();const e=window.axesExample,$=id=>document.getElementById(id);$('renderer').value=${JSON.stringify(renderer)};$('renderer').dispatchEvent(new Event('change'));await wait();$('target').value='c';$('target').dispatchEvent(new Event('change'));const selected=e.chart.api.addDrawing({id:'unrelated-c',type:'horizontal',panel:'price',seriesId:'c',points:[{time:e.fixture.bars[3].time,price:1.052e-12}]});e.chart.api.selectDrawing(selected);$('series').click();await wait();const box=e.chart.canvas.getBoundingClientRect(),axis=e.chart.lastScene.layout.axis('price','c-axis'),panel=e.chart.lastScene.layout.panels[0];return {renderer:e.chart.rendererKind,ui:$('target').value,target:e.chart.controller.drawingTarget,selected:e.model.drawings.selected,bPresent:e.model.series.some(s=>s.id==='b'),point:{x:box.left+(panel.left+panel.right)/2,y:box.top+(axis.top+axis.bottom)/2}};})()`);
    await browser.evaluate(`document.querySelector('[data-tool="horizontal"]').click()`);
    await browser.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: initial.point.x, y: initial.point.y});
    await browser.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x: initial.point.x, y: initial.point.y});
    await browser.send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: initial.point.x, y: initial.point.y});
    const follow = await browser.evaluate(`(async()=>{const wait=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await wait();const e=window.axesExample,$=id=>document.getElementById(id),drawing=structuredClone(e.model.drawings.items.at(-1));$('target').value='c';$('target').dispatchEvent(new Event('change'));e.chart.api.selectDrawing('unrelated-c');$('series').click();await wait();const restored={ui:$('target').value,target:structuredClone(e.chart.controller.drawingTarget),selected:e.model.drawings.selected,bDisabled:$('target').querySelector('[value=b]').disabled};$('target').value='b';$('target').dispatchEvent(new Event('change'));$('series').click();await wait();const activeRemoved={ui:$('target').value,target:structuredClone(e.chart.controller.drawingTarget),bDisabled:$('target').querySelector('[value=b]').disabled};e.chart.api.setText('Preserved C annotation');$('renderer').value=${JSON.stringify(renderer === 'canvas' ? 'webgl2' : 'canvas')};$('renderer').dispatchEvent(new Event('change'));await wait();const switched={kind:e.chart.rendererKind,ui:$('target').value,target:structuredClone(e.chart.controller.drawingTarget),tool:e.chart.controller.tool,text:e.chart.controller.text,pressed:document.querySelector('[data-tool][aria-pressed=true]')?.dataset.tool,status:$('status').textContent};$('series').click();await wait();const restoredFromPrimary={ui:$('target').value,target:structuredClone(e.chart.controller.drawingTarget)};const overflow=document.documentElement.scrollWidth>innerWidth;e.cleanup();return {drawing,restored,activeRemoved,switched,restoredFromPrimary,overflow,cleanup:{canvases:document.querySelectorAll('#chart canvas').length,listeners:e.model.store.listeners.size}};})()`);
    const checks = [], check = (value, name) => checks.push({name, pass: Boolean(value)});
    check(initial.renderer === renderer, 'actual requested renderer'); check(initial.ui === 'c' && initial.target?.seriesId === 'c' && initial.target?.axisId === 'c-axis', 'unrelated B removal preserves C target and matching select');
    check(initial.selected === 'unrelated-c', 'unrelated selected C drawing survives B removal');
    check(follow.drawing.seriesId === 'c' && follow.drawing.axisId === 'c-axis', 'CDP pointer horizontal drawing uses C binding');
    check(Math.abs(follow.drawing.points[0].price - 1.064e-12) < 2e-15, 'horizontal price lies in independent literal C domain');
    check(follow.restored.ui === 'c' && follow.restored.target?.seriesId === 'c' && follow.restored.selected === 'unrelated-c', 'B restoration preserves unrelated C target and selection');
    check(!follow.restored.bDisabled, 'B option becomes available on restoration');
    check(follow.activeRemoved.ui === 'a' && follow.activeRemoved.target === null && follow.activeRemoved.bDisabled, 'active B removal reflects primary target and unavailable option');
    check(follow.switched.kind === (renderer === 'canvas' ? 'webgl2' : 'canvas') && follow.switched.ui === 'a' && follow.switched.target === null && !follow.switched.status.includes('못했습니다'), 'renderer remount while B missing preserves primary target');
    check(follow.switched.tool === 'horizontal' && follow.switched.text === 'Preserved C annotation' && follow.switched.pressed === 'horizontal', 'renderer remount preserves actual tool/text and pressed selector');
    check(follow.restoredFromPrimary.ui === 'a' && follow.restoredFromPrimary.target === null, 'B restoration leaves deliberately selected primary target');
    check(!follow.overflow, 'no horizontal viewport overflow'); check(follow.cleanup.canvases === 0 && follow.cleanup.listeners === 0, 'cleanup canvas and subscriptions');
    results.push({width, dpr: width === 430 ? 2 : 1, renderer, browser: await browser.send('Browser.getVersion'), initial, ...follow, checks}); await browser.close(); browser = null;
  }
  const hashes = {};
  for (const name of ['examples/web/axes.mjs', 'src/core/api.mjs', 'src/core/model.mjs', 'src/core/interaction.mjs', 'src/core/drawings.mjs', 'test/binding-browser.mjs']) hashes[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
  const evidence = {timestamp: new Date().toISOString(), label, boundary: 'Actual isolated Chrome DOM controls and CDP-generated pointer; no physical input/display performance claims.', hashes, results, exceptions, warnings,
    externalRequests: requests.filter(url => !url.startsWith('http://127.0.0.1:') && !url.startsWith('data:'))};
  evidence.checks = results.reduce((sum, r) => sum + r.checks.length, 0); evidence.failed = results.reduce((sum, r) => sum + r.checks.filter(c => !c.pass).length, 0);
  evidence.pass = evidence.failed === 0 && !exceptions.length && !warnings.length && !evidence.externalRequests.length;
  const output = join(outputDir, `binding-${label}.json`); await writeFile(output, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({pass: evidence.pass, checks: evidence.checks, failed: evidence.failed, output, cases: results.map(r => ({width: r.width, renderer: r.renderer, failures: r.checks.filter(c => !c.pass).map(c => c.name)}))}, null, 2));
  if (!evidence.pass) process.exitCode = 1;
} finally {await browser?.close(); await new Promise(done => server.close(done));}
