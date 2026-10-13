import {readFile, writeFile, realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const fieldDescriptions = {
  inputPrimary: 'pointerToRenderMs: PointerEvent.timeStamp to aster:render, recorded before readback; includes browser input queuing.',
  handler: 'pointerHandlerToRenderMs: capture listener performance.now to aster:render; begins before controller handling.',
  rafCpu: 'drawNowCpuSubmitMs: wrapped actual RAF drawNow entry to aster:render. Includes scene/cache work and renderer submission; excludes benchmark readback.',
  chartTiming: 'chartTimingMs: chart.timings latest entry at aster:render. Library submission CPU is authoritative.',
  rendererCpu: 'rendererCpuSubmitMs: observed chart.renderScene or optional chart.renderLayers interval. renderMethods records the actual entry points.',
  readbackCompletion: 'drawAndReadbackMs: actual draw entry through synchronous one-pixel readback completion. Includes synchronization/readback; not pure GPU time or physical-display FPS.',
  heartbeat: '8ms timer gaps; final unfinished interval always included. Pointer phase covers warmup and samples plus CDP orchestration. Synchronous microbenchmark loops have separate heartbeat fields.',
  microbenchmarks: 'Explicit buildScene and chart.drawNow phases each contain 20 warmups plus 80 measured samples by default, with and without a crosshair. They are separate from actual RAF hover events.',
  warmup: 'pointer.raw includes warmup rows. Histogram and comparison use raw.slice(conditions.warmup); microbenchmarks.raw already excludes warmup.',
  ranges: 'recent-200 stores 100,000 bars and has 201 visible source bars because of inclusive boundary geometry. full-100k uses 100,000 visible source bars represented by 368 candle buckets.',
  canvasBytes: 'canvasRGBAEquivalentBytes includes attached/offscreen canvases tracked at creation; width*height*4 estimates do not measure browser/driver retention.',
  glBytes: 'liveAllocatedGLBufferBytes/liveAllocatedGLTextureBytes track explicit GL storage. Null texImage2D data allocates without upload.',
  renderbufferBytes: 'Explicit renderbuffer storage records requestedSamples, queried actualSamples and RGBA-equivalent width*height*4*max(1,actualSamples). RGBA8 is flagged. Default framebuffer memory and driver overhead are excluded.',
  glCalls: 'Per-render glCalls and cumulativeGLCalls observe standard drawArrays/drawElements variants, blitFramebuffer, buffer/texture storage and upload, and renderbuffer storage/deletion.',
  cleanup: 'Explicit GC surrounds owned setup/measurement/destroy. Cleanup checks subscriptions, canvases, chart listeners, pending RAF and explicit GL capacities. Cleanup heap includes module/telemetry retention.',
  provenance: 'sourceSHA256 covers src plus package.json; harnessSHA256 covers hover.mjs, hover-runtime.mjs, browser-soak.mjs and cdp.mjs. startedAt/completedAt bound each case; they do not prove other workloads were absent.',
  histogram: 'Fixed millisecond bins are lower-inclusive and upper-exclusive, with a final open-ended bin. Nonfinite values are counted separately.',
  comparison: 'Fixture options, harness hash and per-case environment must match; source hashes may differ. Ratios and deltas are observations without significance claims.'
};
const cpuBins = [0, .1, .25, .5, 1, 2, 4, 8, 16, 32, 64, 128, Infinity];
const inputBins = [0, 2, 4, 8, 16, 32, 64, 128, Infinity];
export function histogram(values, edges) {
  return {unit: 'ms', finite: values.filter(Number.isFinite).length, nonfinite: values.filter(value => !Number.isFinite(value)).length,
    belowFirstEdge: values.filter(value => Number.isFinite(value) && value < edges[0]).length,
    bins: edges.slice(0, -1).map((lower, index) => ({lowerInclusive: lower,
      upperExclusive: Number.isFinite(edges[index + 1]) ? edges[index + 1] : null,
      count: values.filter(value => Number.isFinite(value) && value >= lower && value < edges[index + 1]).length}))};
}
const keyOf = row => [row.conditions.renderer, row.conditions.dpr, row.conditions.range].join('/');
export function summarize(report, run = 'before') {
  return {run, timestamp: report.timestamp, completedAt: report.completedAt, status: report.status,
    sourceVersion: report.sourceVersion, sourceRoot: report.sourceRoot, sourceSHA256: report.source.sha256,
    harnessSHA256: report.harness.sha256, sourceUnchanged: report.sourceUnchanged, conditions: report.conditions,
    fieldDescriptions,
    cases: report.cases.map(row => {
      const measured = row.pointer.raw.slice(row.conditions.warmup), metrics = row.pointer.summary.metrics;
      const ledger = row.memory.ledgerBeforeDestroy;
      return {key: keyOf(row), renderer: row.conditions.renderer, dpr: row.conditions.dpr, range: row.conditions.range,
        startedAt: row.startedAt, completedAt: row.completedAt, environment: row.environment,
        storedBars: row.ready.stats.storedBars, visibleSourceBars: row.ready.stats.visibleSourceBars,
        renderedCandleBuckets: row.ready.stats.renderedCandleBuckets, warmup: row.conditions.warmup,
        measuredSamples: measured.length, metrics, heartbeat: row.pointer.heartbeatSummary,
        renderMethods: [...new Set(measured.flatMap(sample => sample.renderMethods ?? []))],
        histograms: {inputPrimary: histogram(measured.map(sample => sample.pointerToRenderMs), inputBins),
          rafCpu: histogram(measured.map(sample => sample.drawNowCpuSubmitMs), cpuBins),
          chartTiming: histogram(measured.map(sample => sample.chartTimingMs), cpuBins),
          rendererCpu: histogram(measured.map(sample => sample.rendererCpuSubmitMs), cpuBins)},
        microbenchmarks: row.microbenchmarks.map(phase => ({operation: phase.operation, crosshair: phase.crosshair, summary: phase.summary})),
        ledger, cleanup: row.cleanup, heap: row.memory, verdict: row.verdict};
    })};
}
export function compare(before, after) {
  const failures = [];
  if (before.harnessSHA256 !== after.harnessSHA256) failures.push('Harness hash differs');
  for (const name of ['bars', 'seed', 'lineSeries', 'width', 'height', 'warmup', 'samples', 'heartbeatMs']) {
    if (before.conditions[name] !== after.conditions[name]) failures.push('Fixture ' + name + ' differs');
  }
  const cases = before.cases.map(prior => {
    const current = after.cases.find(row => row.key === prior.key);
    if (!current) {failures.push('Missing after case ' + prior.key); return {key: prior.key, missing: true};}
    for (const name of ['node', 'platform', 'arch', 'osRelease', 'cpu', 'cpuCount', 'userAgent', 'dpr', 'gpu']) {
      if (JSON.stringify(prior.environment[name]) !== JSON.stringify(current.environment[name])) failures.push(prior.key + ' environment ' + name + ' differs');
    }
    const metrics = {};
    for (const name of ['pointerToRenderMs', 'pointerHandlerToRenderMs', 'drawNowCpuSubmitMs', 'chartTimingMs', 'rendererCpuSubmitMs', 'drawAndReadbackMs']) {
      const b = prior.metrics[name], a = current.metrics[name];
      metrics[name] = {before: b, after: a, p95DeltaMs: a.p95 - b.p95,
        p95Ratio: b.p95 > 0 ? a.p95 / b.p95 : null};
    }
    return {key: prior.key, metrics, heartbeatMaxDeltaMs: current.heartbeat.max - prior.heartbeat.max,
      knownCpuBytesDelta: current.ledger.knownCpuTypedArrayBytes - prior.ledger.knownCpuTypedArrayBytes,
      canvasRGBAEquivalentBytesDelta: current.ledger.canvasRGBAEquivalentBytes - prior.ledger.canvasRGBAEquivalentBytes,
      explicitGLBufferBytesDelta: current.ledger.liveAllocatedGLBufferBytes - prior.ledger.liveAllocatedGLBufferBytes,
      explicitGLTextureBytesDelta: current.ledger.liveAllocatedGLTextureBytes - prior.ledger.liveAllocatedGLTextureBytes,
      explicitGLRenderbufferRGBAEquivalentBytesDelta: (current.ledger.liveAllocatedGLRenderbufferRGBAEquivalentBytes ?? 0) - (prior.ledger.liveAllocatedGLRenderbufferRGBAEquivalentBytes ?? 0)};
  });
  if (after.cases.length !== before.cases.length) failures.push('Case count differs');
  return {comparable: failures.length === 0, failures, cases};
}
const csvCell = value => {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
};
export function toCSV(reports) {
  const names = ['run', 'renderer', 'dpr', 'range', 'startedAt', 'completedAt', 'sourceSHA256', 'harnessSHA256',
    'samples', 'inputP50Ms', 'inputP95Ms', 'handlerP95Ms', 'rafCpuP50Ms', 'rafCpuP95Ms', 'chartTimingP95Ms',
    'rendererCpuP95Ms', 'drawAndReadbackP95Ms', 'heartbeatMaxMs', 'heartbeatFinalIntervalMs',
    'knownCpuTypedBytes', 'canvasRGBAEquivalentBytes', 'GLBufferBytes', 'GLTextureBytes', 'GLRenderbufferRGBAEquivalentBytes',
    'requestedRenderbufferSamples', 'actualRenderbufferSamples', 'renderMethods', 'cleanupCanvases', 'cleanupSubscriptions', 'verdict'];
  const lines = [names];
  for (const report of reports) for (const row of report.cases) {
    const m = row.metrics, l = row.ledger;
    lines.push([report.run, row.renderer, row.dpr, row.range, row.startedAt, row.completedAt, report.sourceSHA256, report.harnessSHA256,
      row.measuredSamples, m.pointerToRenderMs.p50, m.pointerToRenderMs.p95, m.pointerHandlerToRenderMs.p95,
      m.drawNowCpuSubmitMs.p50, m.drawNowCpuSubmitMs.p95, m.chartTimingMs.p95, m.rendererCpuSubmitMs.p95,
      m.drawAndReadbackMs.p95, row.heartbeat.max, row.heartbeat.finalIntervalMs, l.knownCpuTypedArrayBytes,
      l.canvasRGBAEquivalentBytes, l.liveAllocatedGLBufferBytes, l.liveAllocatedGLTextureBytes, l.liveAllocatedGLRenderbufferRGBAEquivalentBytes,
      (l.renderbufferAllocations ?? []).map(buffer => buffer.requestedSamples), (l.renderbufferAllocations ?? []).map(buffer => buffer.actualSamples),
      row.renderMethods, row.cleanup.canvases, row.cleanup.storeSubscriptions, row.verdict.status]);
  }
  return lines.map(line => line.map(csvCell).join(',')).join('\n') + '\n';
}
const invocationPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (invocationPath && pathToFileURL(invocationPath).href === import.meta.url) {
  const [beforePath, outputPrefix, afterPath] = process.argv.slice(2);
  if (!beforePath || !outputPrefix) throw new Error('Usage: node summarize-hover.mjs BEFORE_JSON OUTPUT_PREFIX [AFTER_JSON]');
  const before = summarize(JSON.parse(await readFile(beforePath, 'utf8')), 'before');
  const after = afterPath ? summarize(JSON.parse(await readFile(afterPath, 'utf8')), 'after') : null;
  const result = {before, ...(after ? {after, comparison: compare(before, after)} : {})};
  await writeFile(outputPrefix + '.summary.json', JSON.stringify(result, null, 2));
  await writeFile(outputPrefix + '.csv', toCSV(after ? [before, after] : [before]));
  await writeFile(outputPrefix + '.fields.json', JSON.stringify(fieldDescriptions, null, 2));
  console.log(JSON.stringify({cases: before.cases.length, outputPrefix, comparison: result.comparison?.comparable ?? null}));
}
