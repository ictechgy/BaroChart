import {createHash} from 'node:crypto';
import {readFile, writeFile, readdir, realpath} from 'node:fs/promises';
import {resolve, relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {cpus, platform, arch, release} from 'node:os';
import {startFixtureServer} from './browser-soak.mjs';
import {launchBrowser} from '../scripts/cdp.mjs';
import {hoverRuntime} from './hover-runtime.mjs';

export function hoverOptions(input = {}) {
  if(input.profile!==undefined&&typeof input.profile!=='boolean'||input.layerCaching!==undefined&&input.layerCaching!==null&&typeof input.layerCaching!=='boolean')throw new TypeError('Hover profile/cache options');
  const options = {bars: 100000, seed: 42, lineSeries: 32, width: 1200, height: 700,
    warmup: 20, samples: 80, heartbeatMs: 8, renderers: ['canvas', 'webgl2'], dprs: [1, 2],
    ranges: ['recent-200', 'full-100k'], ...input};
  for (const [key, min, max] of [['bars', 200, 1048576], ['seed', 0, 4294967295], ['lineSeries', 1, 64],
    ['width', 300, 4000], ['height', 200, 4000], ['warmup', 0, 1000], ['samples', 1, 1000], ['heartbeatMs', 1, 1000]]) {
    if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) throw new RangeError('Hover ' + key);
  }
  for (const [key, allowed] of [['renderers', ['canvas', 'webgl2']], ['dprs', [1, 2]], ['ranges', ['recent-200', 'full-100k']]]) {
    if (!Array.isArray(options[key]) || !options[key].length || new Set(options[key]).size !== options[key].length ||
      options[key].some(value => !allowed.includes(value))) throw new RangeError('Hover ' + key);
  }
  return options;
}
export function hoverCases(options = hoverOptions()) {
  return options.dprs.flatMap(dpr => options.renderers.flatMap(renderer => options.ranges.map(range => ({renderer, dpr, range}))));
}
export function hoverPoint(index, {width = 1200, height = 700} = {}) {
  if (!Number.isInteger(index) || index < 0) throw new RangeError('Pointer sample index');
  return {x: 80 + (index * 37) % (width - 180), y: 60 + (index * 29) % (height - 120)};
}
export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = fraction => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : null;
  return {count: sorted.length, min: sorted[0] ?? null, p50: at(.5), p95: at(.95), max: sorted.at(-1) ?? null,
    mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null};
}
export function heartbeatSummary(heartbeat) {
  if (!heartbeat?.raw?.length || !heartbeat.raw.at(-1).final) throw new Error('Missing final heartbeat interval');
  return {...distribution(heartbeat.raw.map(row => row.gapMs)), requestedIntervalMs: heartbeat.requestedIntervalMs,
    regularIntervals: heartbeat.raw.filter(row => !row.final).length, finalIntervalMs: heartbeat.raw.at(-1).gapMs};
}
export function summarizePointerSamples(raw, warmup = 20) {
  const measured = raw.slice(warmup), metrics = {};
  for (const metric of ['pointerToRenderMs', 'pointerHandlerToRenderMs', 'eventTimeStampToRenderMs', 'queuedInputMs', 'rafWaitMs', 'eventToRafMs', 'drawNowCpuSubmitMs',
    'rendererCpuSubmitMs', 'drawAndReadbackMs', 'pointerToReadbackMs', 'pointerHandlerToReadbackMs', 'readbackMs', 'chartTimingMs']) {
    metrics[metric] = distribution(measured.map(row => row[metric]));
  }
  metrics.rafRenderIntervalsMs = distribution(measured.slice(1).map((row, index) => row.renderEventAt - measured[index].renderEventAt));
  return {warmup: raw.length - measured.length, samples: measured.length, metrics};
}
export function validateHoverCase(row, options) {
  const failures = [];
  if (row.pointer.raw.length !== options.warmup + options.samples) failures.push('Pointer sample count');
  if (row.pointer.raw.some(sample => !sample.event.isTrusted || sample.event.pointerType !== 'mouse' || sample.event.buttons !== 0)) failures.push('Real idle mouse pointer events');
  if (row.pointer.raw.some(sample => sample.crosshair?.x !== sample.point?.x || sample.crosshair?.y !== sample.point?.y)) failures.push('Rendered pointer coordinates');
  if (row.pointer.raw.some(sample => !sample.raf || sample.rendererKind !== row.conditions.renderer ||
    !Number.isFinite(sample.pointerToRenderMs) || sample.pointerToRenderMs < 0 || sample.readbackEnd < sample.renderEventAt)) failures.push('RAF render/latency/completion provenance');
  if (!row.pointer.final.unchangedView || row.pointer.final.errors.length) failures.push('Hover view/errors');
  const cleanup = row.cleanup;
  if (cleanup.canvases || cleanup.storeSubscriptions || cleanup.chartListeners || cleanup.framePending ||
    !cleanup.modelDisposed || !cleanup.chartDisposed || cleanup.liveAllocatedGLBufferBytes || cleanup.liveAllocatedGLTextureBytes ||
    cleanup.liveAllocatedGLRenderbufferRGBAEquivalentBytes || cleanup.liveAllocatedGLRenderbuffers ||
    cleanup.rendererDisposed === false) failures.push('Owned cleanup');
  if (row.protocolEvents.externalRequests.length || row.protocolEvents.exceptions.length || row.protocolEvents.crashes.length) failures.push('Browser protocol errors/external requests');
  if (!row.microbenchmarks.every(phase => phase.raw.length === options.samples && phase.heartbeat.raw.at(-1).final)) failures.push('Microbenchmark samples/final heartbeat');
  return {status: failures.length ? 'fail' : 'pass', failures};
}
const digest = value => createHash('sha256').update(value).digest('hex');
async function sourceManifest(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push({path: relative(root, path), sha256: digest(await readFile(path))});
    }
  }
  await visit(resolve(root, 'src'));
  files.push({path: 'package.json', sha256: digest(await readFile(resolve(root, 'package.json')))});
  return {sha256: digest(files.map(file => file.path + ' ' + file.sha256 + '\n').join('')), files};
}
async function harnessManifest() {
  const files = await Promise.all(['hover.mjs', 'hover-runtime.mjs', 'browser-soak.mjs', '../scripts/cdp.mjs'].map(async name =>
    ({path: name, sha256: digest(await readFile(new URL(name, import.meta.url)))})));
  return {sha256: digest(files.map(file => file.path + ' ' + file.sha256 + '\n').join('')), files};
}
export async function runHoverBenchmark({sourceRoot = '.', output = 'benchmarks/results/hover.json', options: input = {}, sourceArchive = null} = {}) {
  const options = hoverOptions(input), root = await realpath(resolve(sourceRoot)), pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const source = await sourceManifest(root), harness = await harnessManifest();
  const archive = sourceArchive ? {path: resolve(sourceArchive), sha256: digest(await readFile(resolve(sourceArchive)))} : null;
  const report = {timestamp: new Date().toISOString(), status: 'running', sourceVersion: pkg.version, sourceRoot: root,
    source, sourceArchive: archive, harness, conditions: options,
    environment: {node: process.version, platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0]?.model, cpuCount: cpus().length},
    method: {
      fixture: '100,000 stored seed-42 bars, candles plus 32 aligned Float64 line series; recent-200 and full-100k at 1200x700 CSS pixels. Each renderer/DPR/range case uses a fresh isolated headless Chrome target. Cases run serially.',
      primary: 'Real CDP Input.dispatchMouseEvent mouseMoved events. Primary pointerToRenderMs uses the browser PointerEvent.timeStamp through aster:render, including queued input. pointerHandlerToRenderMs starts at the capture listener performance.now before controller handling. aster:render timestamps precede readback. Each move waits for its actual RAF render before the next dispatch. Event.isTrusted, idle buttons, renderer and RAF provenance are validated. This does not measure physical-display FPS or browser compositor presentation.',
      cpu: 'Separate buildScene and explicit chart.drawNow synchronous microbenchmarks, without and with a crosshair. Scene/index/glyph caches are warmed; 20 warmups and 80 samples by default. drawNow total and chart.timings are authoritative full submission CPU. Renderer CPU observes renderScene or an optional renderLayers entry point when present (names recorded); no future entry point is required by old source. Wrapper and telemetry overhead remain in measurements.',
      completion: 'One-pixel Canvas getImageData or WebGL readPixels after render-event timestamp forces completion. Submission plus completion includes synchronization and readback; it is neither pure GPU execution nor display time.',
      heartbeat: '8ms setInterval; the final unfinished interval is always recorded. Microbenchmark phases intentionally run synchronous sample loops; those gaps are separate from real pointer/RAF gaps. Pointer heartbeat covers warmup and measured moves plus CDP orchestration.',
      memory: 'Explicit HeapProfiler.collectGarbage before setup, before measurements, before destroy and after destroy. Known CPU arrays, Canvas/offscreen canvas RGBA-equivalent pixel bytes, GL buffer/texture allocations, uploads, all standard GL draw calls and framebuffer blits are recorded. Explicit renderbuffer storage records requested/queried actual samples and RGBA-equivalent bytes. texImage2D(null) counts allocation without upload. Default framebuffer/driver memory and transient allocation peaks are unmeasured; RGBA8 renderbuffer estimates use width*height*4*max(1,actualSamples).',
      source: 'Only existing 0.2.4 API/properties are used; no future scene-layer fields. Per-case source/harness SHA256 and environment are copied from this run. Source manifest is rechecked at completion.'
    }, cases: []};
  const runtimeSource = `import('/src/index.mjs').then(()=>(${hoverRuntime.toString()})(${JSON.stringify(options)})).catch(error=>{globalThis.__asterHoverInitError=error.stack??error.message})`;
  // startFixtureServer confines source reads and HTTP access to the owned loopback fixture.
  let server = null, browser = null;
  try {
    for (const conditions of hoverCases(options)) {
      const startedAt = new Date().toISOString(), config = {...options, ...conditions};
      // A new server runtime contains the specific case, while sourceRoot stays reusable.
      server = await startFixtureServer(root, runtimeSource.replace(JSON.stringify(options), JSON.stringify(config)));
      browser = await launchBrowser({dpr: conditions.dpr, width: options.width + 48, height: options.height + 48});
      const protocolEvents = {externalRequests: [], exceptions: [], crashes: []};
      browser.on('Runtime.exceptionThrown', event => protocolEvents.exceptions.push(event.exceptionDetails.text));
      browser.on('Inspector.targetCrashed', () => protocolEvents.crashes.push('Main target crashed'));
      await browser.send('Network.enable'); await browser.send('Inspector.enable');
      browser.on('Network.requestWillBeSent', event => {
        if (!event.request.url.startsWith(server.origin + '/')) protocolEvents.externalRequests.push(event.request.url);
      });
      await browser.send('HeapProfiler.collectGarbage'); const blankHeap = await browser.send('Runtime.getHeapUsage');
      await browser.navigate(server.origin + '/harness.html');
      await browser.evaluate(`new Promise((resolve,reject)=>{const end=performance.now()+30000,t=setInterval(()=>{if(globalThis.__asterHover){clearInterval(t);resolve(true)}else if(globalThis.__asterHoverInitError||performance.now()>end){clearInterval(t);reject(Error(globalThis.__asterHoverInitError??'Hover initialization timeout'))}},10)})`);
      const ready = await browser.evaluate('__asterHover.ready()');
      await browser.send('HeapProfiler.collectGarbage'); const beforeHeap = await browser.send('Runtime.getHeapUsage');
      const microbenchmarks = await browser.evaluate('__asterHover.microbenchmark()');
      for (const phase of microbenchmarks) {
        phase.summary = {cpuMs: distribution(phase.raw.map(row => row.cpuMs)), heartbeat: heartbeatSummary(phase.heartbeat)};
        if (phase.operation === 'drawNow') for (const metric of ['rendererCpuSubmitMs', 'drawAndReadbackMs', 'readbackMs', 'chartTimingMs']) phase.summary[metric] = distribution(phase.raw.map(row => row[metric]));
      }
      await browser.evaluate('__asterHover.beginPointers()');
      const raw = [];
      for (let index = 0; index < options.warmup + options.samples; index++) {
        const point = hoverPoint(index, options), position = await browser.evaluate(`__asterHover.armPointer(${index},${JSON.stringify(point)})`);
        const dispatchBegin = performance.now();
        await browser.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: position.x, y: position.y, button: 'none', buttons: 0, pointerType: 'mouse'});
        const dispatchRoundtripMs = performance.now() - dispatchBegin;
        const row = await browser.evaluate('__asterHover.waitPointer()'); row.cdpDispatchRoundtripMs = dispatchRoundtripMs; raw.push(row);
      }
      const final = await browser.evaluate('__asterHover.endPointers()');
      await browser.send('HeapProfiler.collectGarbage'); const measuredHeap = await browser.send('Runtime.getHeapUsage');
      const ledgerBeforeDestroy = await browser.evaluate('__asterHover.ledger()');
      const cleanup = await browser.evaluate('__asterHover.destroy()');
      await browser.send('HeapProfiler.collectGarbage'); const cleanupHeap = await browser.send('Runtime.getHeapUsage');
      const row = {startedAt, completedAt: new Date().toISOString(), conditions: config,
        provenance: {sourceRoot: root, sourceVersion: pkg.version, sourceSHA256: source.sha256, archiveSHA256: archive?.sha256 ?? null, harnessSHA256: harness.sha256},
        environment: {...report.environment, ...await browser.evaluate('__asterHover.environment')}, ready,
        microbenchmarks, pointer: {raw, summary: summarizePointerSamples(raw, options.warmup), heartbeatSummary: heartbeatSummary(final.heartbeat), final},
        memory: {blankHeap, beforeHeap, measuredHeap, cleanupHeap, ledgerBeforeDestroy,
          cleanupMinusBlankHeapBytes: cleanupHeap.usedSize - blankHeap.usedSize,
          cleanupMinusBlankBackingBytes: (cleanupHeap.backingStorageSize ?? 0) - (blankHeap.backingStorageSize ?? 0)}, cleanup, protocolEvents};
      row.verdict = validateHoverCase(row, options); report.cases.push(row);
      await writeFile(output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({case: conditions, verdict: row.verdict.status,
        pointerP50Ms: row.pointer.summary.metrics.pointerToRenderMs.p50, pointerP95Ms: row.pointer.summary.metrics.pointerToRenderMs.p95,
        rafCpuP95Ms: row.pointer.summary.metrics.drawNowCpuSubmitMs.p95, heartbeatMaxMs: row.pointer.heartbeatSummary.max}));
      await browser.close(); browser = null; await server.close(); server = null;
    }
    report.sourceUnchanged = (await sourceManifest(root)).sha256 === source.sha256;
    report.status = report.sourceUnchanged && report.cases.every(row => row.verdict.status === 'pass') ? 'pass' : 'fail';
    report.completedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2)); return report;
  } catch (error) {
    report.status = 'failed'; report.error = error.stack ?? error.message; await writeFile(output, JSON.stringify(report, null, 2)); throw error;
  } finally {await browser?.close(); await server?.close();}
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [sourceRoot = '.', output = 'benchmarks/results/hover.json', optionsJSON = '{}', sourceArchive = null] = process.argv.slice(2);
  const report = await runHoverBenchmark({sourceRoot, output, options: JSON.parse(optionsJSON), sourceArchive});
  console.log(JSON.stringify({output, status: report.status, cases: report.cases.length,
    activeResourcesAfterCleanup: process.getActiveResourcesInfo()})); if (report.status !== 'pass') process.exitCode = 1;
}
