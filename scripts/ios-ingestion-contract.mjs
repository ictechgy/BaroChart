import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat = (condition, path) => assert(condition, 'iOS ingestion evidence: ' + path);
const record = (value, path) => {requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), path + ' object required'); return value;};
const array = (value, path, count) => {requireThat(Array.isArray(value), path + ' array required'); if (count !== undefined) requireThat(value.length === count, path + ' count'); return value;};
const integer = (value, path, min = 0, max = Number.MAX_SAFE_INTEGER) => {requireThat(Number.isSafeInteger(value) && value >= min && value <= max, path + ' integer'); return value;};
const finite = (value, path, min = 0) => {requireThat(typeof value === 'number' && Number.isFinite(value) && value >= min, path + ' finite number'); return value;};
const text = (value, path) => {requireThat(typeof value === 'string' && value.length > 0, path + ' string'); return value;};
const digest = (value, path) => requireThat(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), path + ' SHA256');
const near = (a, b, path, epsilon = 1e-6) => requireThat(Number.isFinite(a) && Math.abs(a - b) <= epsilon, path);
// Record failed/unavailable queries without interpreting empty stdout as zero.
// Store only the owned UUID rows, never the user's complete process listing.
export function collectIOSProcessEvidence(query, id) {
  const observed = query?.status === 0 && typeof query.stdout === 'string';
  const processes = observed ? query.stdout.split('\n').filter(row => id && row.includes(id)) : null;
  return {processQueryStatus: query?.status ?? null, processQueryError: typeof query?.stderr === 'string' ? query.stderr.slice(0,1024) : '', ownedUUIDProcessCount: observed ? processes.length : null, ownedUUIDProcesses: processes};
}

// Reject nonportable/nonfinite numeric values even if serialization would turn
// NaN/Infinity into null. This guard is separate from serialized byte binding.
function finiteJSON(value) {
  const stack = [value], seen = new Set();
  while (stack.length) {
    const next = stack.pop();
    if (typeof next === 'number') requireThat(Number.isFinite(next), 'nonfinite JSON number');
    else if (next !== null && typeof next === 'object' && !seen.has(next)) {
      seen.add(next); for (const v of Object.values(next)) stack.push(v);
    }
  }
}
function distribution(actual, values, path) {
  record(actual, path); integer(actual.samples, path + '.samples');
  requireThat(actual.samples === values.length, path + ' sample coverage');
  if (!values.length) {requireThat(Object.keys(actual).length === 1, path + ' empty metric shape'); return;}
  const sorted = [...values].sort((a, b) => a - b);
  for (const [key, fraction] of [['p50', .5], ['p95', .95], ['p99', .99], ['max', 1]]) {
    const expected = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    near(actual[key], expected, path + '.' + key);
  }
}
function processSnapshot(value, path) {
  record(value, path);
  finite(value.sampledAt, path + '.sampledAt');
  finite(value.residentBytes, path + '.residentBytes');
  finite(value.processCPUSeconds, path + '.processCPUSeconds');
  return value.sampledAt;
}
function session(value, path, bars) {
  record(value, path); const p = record(value.policy, path + '.policy');
  for (const key of ['nextSequence', 'accepted', 'applied', 'cancelled', 'rejectedPackets', 'rejectedEvents', 'failedDrains', 'pendingEvents', 'pendingBytes', 'ownedBytes', 'peakPendingEvents', 'peakPendingBytes', 'storedBars', 'storeBytes']) integer(value[key], path + '.' + key);
  requireThat(p.streamId === 'ios-cycle12' && p.generation === 1 && p.firstSequence === 0, path + ' fixture stream/generation');
  requireThat(p.maxQueuedEvents === 4096 && p.maxQueuedBytes === 49 * 4096 && p.maxBatchEvents === 64 && p.maxStoredBars === bars + 32 && p.maxStoreBytes === 96 * 262144, path + ' fixture policy');
  requireThat(value.accepted === value.applied + value.cancelled + value.pendingEvents && value.nextSequence === value.accepted, path + ' ledger conservation');
  requireThat(value.ownedBytes === 49 * 4096 && value.pendingBytes === 49 * value.pendingEvents && value.peakPendingEvents <= 4096 && value.peakPendingBytes === 49 * value.peakPendingEvents && value.peakPendingEvents >= value.pendingEvents, path + ' typed ring accounting');
  requireThat(value.storedBars === bars + 32, path + ' stored rows');
  let capacity = 16; while (capacity < value.storedBars) capacity *= 2;
  requireThat(value.storeBytes === 96 * capacity, path + ' store typed bytes');
  for (const [count, key] of [['applied', 'lastAppliedSequence'], ['cancelled', 'lastCancelledSequence']]) {
    if (value[count] === 0) requireThat(value[key] === null, path + '.' + key);
    else integer(value[key], path + '.' + key, 0, value.nextSequence - value.pendingEvents - 1);
  }
}
function replay(descriptor, payload, feed, bars, path) {
  record(descriptor, path); record(payload, path + ' payload');
  requireThat(payload.file === descriptor.file && Buffer.isBuffer(payload.bytes), path + ' file/payload');
  digest(descriptor.sha256, path); requireThat(sha(payload.bytes) === descriptor.sha256, path + ' binary hash');
  integer(descriptor.rows, path + '.rows', 1, 180000);
  requireThat(descriptor.bytes === descriptor.rows * 65 && payload.bytes.length === descriptor.bytes && descriptor.recordBytes === 65 && descriptor.littleEndian === true && descriptor.performedAfterMeasurement === true, path + ' complete replay coverage');
  requireThat(descriptor.rows === feed.appliedEvents && descriptor.rows === feed.session.applied, path + ' applied rows');
  requireThat(descriptor.historicalCorrections === 2, path + ' historical correction coverage');
  assert.deepEqual(descriptor.historicalIndices, [0, Math.floor((bars + 32) / 2)], path + ' historical indices');
  let tail = 1700000000000 + (bars - 1) * 60000, lastSerial = -1, lastClock = -Infinity, appends = 0;
  const history = [];
  for (let i = 0; i < descriptor.rows; i++) {
    const at = i * 65, bytes = payload.bytes, serial64 = bytes.readBigUInt64LE(at);
    requireThat(serial64 <= BigInt(Number.MAX_SAFE_INTEGER), path + ' producer serial precision');
    const serial = Number(serial64), created = bytes.readDoubleLE(at + 8), kind = bytes[at + 16];
    integer(serial, path + ' serial', 0, feed.hostCreated - 1);
    requireThat(serial > lastSerial && Number.isFinite(created) && created > 0 && created >= lastClock, path + ' serial/clock ordering');
    const values = Array.from({length: 6}, (_, j) => bytes.readDoubleLE(at + 17 + j * 8));
    requireThat(values.every(Number.isFinite), path + ' finite OHLCV bits');
    const [time, open, high, low, close, volume] = values;
    requireThat(low <= Math.min(open, close) && high >= Math.max(open, close) && low <= high && volume >= 0, path + ' OHLCV envelope');
    if (kind === 1) {requireThat(time === tail + 60000, path + ' append timestamp'); tail = time; appends++;}
    else if (kind === 2) requireThat(time === tail, path + ' update timestamp');
    else if (kind === 3) {
      const index = (time - 1700000000000) / 60000;
      integer(index, path + ' correction index', 0, bars + appends - 1);
      history.push({index, created});
    } else requireThat(false, path + ' replay kind');
    lastSerial = serial; lastClock = created;
  }
  requireThat(appends === 32 && history.length === 2, path + ' append/history coverage');
  assert.deepEqual(history.map(v => v.index), descriptor.historicalIndices, path + ' binary historical indices');
  return {firstCreated: payload.bytes.readDoubleLE(8), lastCreated: lastClock, history};
}

/**
 * Fail-closed, read-only final gate for the unchanged Cycle12 Swift fixture.
 * Legacy reports have no absolute probe start/end or in-app run nonce. We bind
 * available UUID/log/config/manifest/report bytes/replay clocks, and explicitly
 * do NOT certify cryptographic same-run identity, undo, GPU, or physical input.
 * Field-mutation tests reserialize/re-hash their report so structural guards
 * cannot pass merely because an earlier checksum rejected the mutation.
 */
export function validateIOSIngestionEvidence(evidence) {
  record(evidence, 'envelope');
  // This policy belongs to the trusted caller. Report fields cannot downgrade a
  // fresh run. Archived legacy reports lacking query status remain explicitly
  // limited reevaluations, never a new OS-query completion certificate.
  const executionPolicy = evidence.executionPolicy ?? 'fresh';
  requireThat(['fresh','legacy-replay'].includes(executionPolicy), 'execution policy');
  const {report: r, manifest: m, run, xctest: x, traces, simulatorCleanup: cleanup} = evidence;
  record(r, 'report'); record(m, 'manifest'); record(run, 'run'); record(x, 'xctest');
  finiteJSON(r);
  requireThat(typeof run.pilot === 'boolean' && typeof m.instrumented === 'boolean', 'pilot/instrumented booleans');
  integer(run.bars, 'run.bars', 512, 100000); finite(run.seconds, 'run.seconds');
  requireThat(run.pilot ? run.seconds >= 30 && run.seconds <= 60 : run.seconds === 900, 'supported corrected pilot or900 request');
  requireThat(typeof run.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(run.id) && run.createdByThisRun === true, 'owned run UUID');
  requireThat(/^com\.apple\.CoreSimulator\.SimRuntime\.iOS-/.test(text(run.runtime, 'runtime')), 'runtime');
  requireThat(r.schema === 'aster.cycle12.ios-pressure' && r.physicalDevice === false && r.platformSpeedComparison === false && !Object.hasOwn(r, 'failed') && !Object.hasOwn(r, 'error') && !Object.hasOwn(r, 'unexpectedMeasuredBackground'), 'successful pressure schema');
  requireThat(r.initialBarsPerSymbol === run.bars && r.requestedSeconds === run.seconds && r.warmupSeconds === (run.pilot ? 2 : 30), 'requested fixture');
  requireThat(r.pilot === run.pilot && r.simulatorID === run.id && r.runtime === run.runtime && r.xcodebuildStatus === 0 && x.status === 0, 'run/execution consistency');
  text(x.stdout, 'xctest log');
  requireThat(x.stdout.includes('-destination id=' + run.id) && x.stdout.includes('** TEST EXECUTE SUCCEEDED **') && /SYSTEM_PINCH_PAIR gesture=1 .*completed/.test(x.stdout) && /SYSTEM_PINCH_PAIR gesture=4 .*completed/.test(x.stdout) && /Actual public XCUI slow-drag calls:[1-9]\d*/.test(x.stdout), 'actual XCUI route/scenarios');
  record(r.buildManifest, 'bundled build manifest');
  for (const key of ['schema', 'protocol', 'packageVersion', 'instrumented', 'simulatorOnly', 'signingAllowed', 'systemInputAPI', 'coreSHA256', 'originalUIKitSHA256', 'hookedUIKitSHA256', 'uikitSHA256', 'hookPatchSHA256']) assert.deepEqual(r.buildManifest[key], m[key], 'iOS bundled manifest ' + key);
  requireThat(m.schema === 'aster.cycle12.ios.build' && m.protocol === 1 && /^\d+\.\d+\.\d+$/.test(m.packageVersion) && m.simulatorOnly === true && m.signingAllowed === false && m.systemInputAPI === 'public XCTest/XCUIAutomation', 'build contract');
  for (const key of ['coreSHA256', 'originalUIKitSHA256', 'hookedUIKitSHA256', 'uikitSHA256', 'hookPatchSHA256', 'appBinarySHA256']) digest(m[key], 'manifest.' + key);
  assert.deepEqual(record(r.buildManifest.sources, 'bundled sources'), record(m.sources, 'host sources'), 'iOS source/fixture hashes');
  const requiredSources = ['native/AsterNative.swift', 'native/AsterColumns.swift', 'native/AsterFrameRenderer.swift', 'examples/ios/cycle12/IngestionApp.swift', 'examples/ios/cycle12/IngestionFeed.swift', 'examples/ios/cycle12/IngestionProbe.swift', 'examples/ios/cycle12/IngestionSystemTests.swift', 'scripts/build-ios-ingestion.mjs', 'scripts/test-ios-ingestion.mjs', 'examples/ios/Info.plist', 'package.json'];
  for (const key of requiredSources) digest(m.sources[key], 'source.' + key);
  const UIKit = Object.keys(m.sources).filter(k => k === 'native/AsterUIKit.swift' || k.endsWith('/native/AsterUIKit.swift'));
  requireThat(UIKit.length === 1 && m.sources[UIKit[0]] === m.originalUIKitSHA256, 'UIKit source ownership');
  requireThat(r.coreSHA256 === m.coreSHA256 && r.originalUIKitSHA256 === m.originalUIKitSHA256 && x.coreSHA256 === m.coreSHA256 && x.appBinarySHA256 === m.appBinarySHA256, 'resource/binary binding');
  requireThat(r.instrumented === m.instrumented && r.nativeDrawHookInstrumented === m.instrumented && m.uikitSHA256 === m.hookedUIKitSHA256 && (m.instrumented ? m.uikitSHA256 !== m.originalUIKitSHA256 : m.uikitSHA256 === m.originalUIKitSHA256), 'instrumentation mode');
  digest(evidence.reportSHA256, 'report');
  requireThat(sha(JSON.stringify(r, null, 2)) === evidence.reportSHA256, 'report byte binding');
  assert.deepEqual(array(r.symbols, 'models', 2), ['A visible UIKit chart', 'B independent offscreen engine'], 'iOS model slots');
  const feeds = array(r.feed, 'feed', 2), oracles = array(r.oracle, 'oracle', 2), descriptors = array(r.appliedTrace, 'replay descriptors', 2);
  array(traces, 'replay payloads', 2);
  requireThat(r.allRawAndOutputsEqual === true, 'full bitwise oracle');
  const golden = record(r.studyGolden, 'golden'); requireThat(golden.passed === true, 'independent golden'); near(golden.expectedMean, 12.4, 'golden mean'); near(golden.expectedPopulationVariance, 3.84, 'golden variance'); text(golden.method, 'golden method');
  const start = processSnapshot(r.measureStartProcess, 'measureStartProcess'), finish = processSnapshot(r.measurementEndProcess, 'measurementEndProcess');
  const ready = processSnapshot(r.readyProcess, 'readyProcess'), close = processSnapshot(r.beforeCloseProcess, 'beforeCloseProcess'), closed = processSnapshot(r.afterCloseProcess, 'afterCloseProcess'), dropped = processSnapshot(r.afterDropProcess, 'afterDropProcess');
  requireThat(ready <= start && start < finish && finish <= close && close <= closed && closed <= dropped && finite(r.backgroundAt, 'backgroundAt') >= finish, 'process/lifecycle clock order');
  for (let i = 0; i < 2; i++) {
    const path = 'feed[' + i + ']', f = record(feeds[i], path), oracle = record(oracles[i], 'oracle[' + i + ']');
    requireThat(f.schema === 'aster.cycle12.ios-feed' && f.rateHz === 100 && f.appendEveryMessages === (run.pilot ? 10 : 500) && f.historyCorrectionIntervalSeconds === (run.pilot ? 6 : 300) && f.historyNeverResetOrEvicted === true, path + ' fixture scheduling');
    array(f.failures, path + '.failures', 0);
    for (const key of ['hostCreated', 'hostAccepted', 'hostCancelled', 'hostRejected', 'hostHighwater', 'appliedEvents', 'appliedDuringOSInput', 'budgetFailures']) integer(f[key], path + '.' + key);
    requireThat(f.appliedEvents > 0 && f.appliedDuringOSInput > 0 && f.appliedDuringOSInput <= f.appliedEvents && f.hostRejected === 0 && f.hostLedgerConserved === true && f.hostCreated === f.hostAccepted + f.hostRejected + f.hostCancelled, path + ' host/input ledger');
    requireThat(f.hostCapacity === 4096 && f.hostHighwater <= 4096 && f.maxAdmissionAndDrain === 64 && f.maximumRawRowsPerTrace === 180000 && f.omittedRawRows === 0, path + ' bounded recorder');
    session(f.session, path + '.session', run.bars);
    requireThat(f.session.state === 'running' && f.session.pendingEvents === 0 && f.session.lastError === null && f.hostAccepted === f.session.accepted && f.appliedEvents === f.session.applied && f.budgetFailures === 1 && f.session.failedDrains === 1 && f.session.rejectedPackets === 0 && f.session.rejectedEvents === 0, path + ' terminal queue');
    requireThat(oracle.equal === true && oracle.columns === 6 && oracle.outputVectors === 22 && oracle.bars === run.bars + 32 && oracle.comparedBytes === (run.bars + 32) * 28 * 8 && oracle.chunkRows === 4096 && oracle.performedAfterMeasurement === true && text(oracle.reference, 'oracle reference').includes('allFloat64bits includingNaN/sign checked'), 'positive full raw6/vector22 bit coverage');
    requireThat(descriptors[i].file === 'applied-symbol-' + i + '.bin', 'distinct replay model slot');
    const binary = replay(descriptors[i], traces[i], f, run.bars, 'replay[' + i + ']');
    requireThat(binary.firstCreated >= start - r.warmupSeconds - 2 && binary.lastCreated <= finish, path + ' replay within feed clock');
    const epochs = array(f.epochs, path + '.epochs', 4), histories = epochs.filter(e => e.kind === 'historical-correction'), budget = epochs.filter(e => e.kind === 'store-budget-explicit-cancel-resume'), stop = epochs.filter(e => e.kind === 'stop-explicit-cancel');
    requireThat(histories.length === 2 && budget.length === 1 && stop.length === 1, path + ' required scenarios');
    for (let j = 0; j < 2; j++) {
      const h = record(histories[j], path + ' history'), target = (j + 1) * f.historyCorrectionIntervalSeconds;
      requireThat(h.index === descriptors[i].historicalIndices[j] && h.historyRows === run.bars + 32 && finite(h.createdAfterMeasurementSeconds, path + ' history created') >= target && h.createdAfterMeasurementSeconds < target + 10 && finite(h.appliedAfterMeasurementSeconds, path + ' history applied') >= h.createdAfterMeasurementSeconds && h.appliedAfterMeasurementSeconds <= run.seconds + 20, path + ' history epoch');
      const historyStart = binary.history[j].created - h.createdAfterMeasurementSeconds;
      requireThat(historyStart >= start && historyStart <= start + .01, path + ' history/replay clock binding');
    }
    const b = budget[0]; session(b.before, path + ' budget before', run.bars); session(b.after, path + ' budget after', run.bars);
    integer(b.hostCancelled, path + ' budget host cancellation');finite(b.at, path + ' budget clock');
    requireThat(b.at >= start - r.warmupSeconds - 2 && b.at <= finish && text(b.before.lastError?.message, path + ' budget error').length <= 256, path + ' budget clock/error');
    requireThat(b.before.state === 'paused' && b.before.pendingEvents > 0 && b.before.lastError?.code === 'DRAIN_FAILED' && b.after.state === 'running' && b.after.pendingEvents === 0 && b.after.lastError === null && b.cancel.events === b.before.pendingEvents && b.after.cancelled === b.before.cancelled + b.cancel.events && b.before.accepted === b.after.accepted && b.before.applied === b.after.applied && b.cancel.firstSequence + b.cancel.events - 1 === b.cancel.lastSequence, path + ' failed prefix retained/cancel/resume');
    requireThat(b.cancel.firstSequence === b.before.nextSequence - b.before.pendingEvents && b.cancel.lastSequence === b.before.nextSequence - 1 && b.after.lastCancelledSequence === b.cancel.lastSequence, path + ' budget cancellation cursor');
    const stopped = stop[0]; session(stopped.before, path + ' stop before', run.bars); session(stopped.after, path + ' stop after', run.bars);
    assert.deepEqual(stopped.after, f.session, path + ' stop terminal');
    requireThat(stopped.cancel.events === stopped.before.pendingEvents && stopped.before.accepted === stopped.after.accepted && stopped.before.applied === stopped.after.applied && stopped.after.cancelled === stopped.before.cancelled + stopped.cancel.events, path + ' explicit stop conservation');
    requireThat(stopped.cancel.events === 0 ? stopped.cancel.firstSequence === null && stopped.cancel.lastSequence === null : stopped.cancel.firstSequence === stopped.before.nextSequence - stopped.before.pendingEvents && stopped.cancel.lastSequence === stopped.before.nextSequence - 1 && stopped.after.lastCancelledSequence === stopped.cancel.lastSequence, path + ' stop cancellation cursor');
    const drains = array(f.rawDrains, path + '.rawDrains'); requireThat(drains.length > 0 && drains.length <= f.appliedEvents, path + ' drain coverage');
    let applied = 0, during = 0, previousEnd = -Infinity, previousSequence = -1, revision = -1;
    for (const d of drains) {
      record(d, path + ' drain'); integer(d.events, path + ' drain.events', 1, 64);
      integer(d.firstSequence, path + ' drain.first'); integer(d.lastSequence, path + ' drain.last'); integer(d.revision, path + ' drain.revision');
      requireThat(d.lastSequence === d.firstSequence + d.events - 1 && d.firstSequence > previousSequence && d.revision > revision && d.lastSequence < f.session.nextSequence, path + ' drain sequence/revision order');
      finite(d.start, path + ' drain.start');finite(d.drainStart, path + ' drain.drainStart');finite(d.end, path + ' drain.end');
      requireThat(d.start >= previousEnd && d.start >= start - r.warmupSeconds - 2 && d.start <= d.drainStart && d.drainStart <= d.end && d.end <= finish && typeof d.appliedDuringOSInput === 'boolean', path + ' drain clock/input shape');
      applied += d.events; if (d.appliedDuringOSInput) during += d.events;
      previousEnd = d.end; previousSequence = d.lastSequence; revision = d.revision;
    }
    requireThat(applied === f.appliedEvents && during === f.appliedDuringOSInput && previousSequence === f.session.lastAppliedSequence, path + ' raw drain ledger coverage');
    array(f.hostQueueAgeMs, path + ' queue ages', f.hostAccepted).forEach(v => finite(v, path + ' queue age'));
  }
  requireThat(descriptors[0].sha256 !== descriptors[1].sha256, 'independent producer replay files');
  const p = record(r.probe, 'probe'); requireThat(p.schema === 'aster.cycle12.private-draw-probe', 'probe schema');
  finite(p.elapsedSeconds, 'probe.elapsedSeconds'); requireThat(p.elapsedSeconds >= run.seconds && p.elapsedSeconds < run.seconds + 20 && finish - start >= p.elapsedSeconds, 'actual requested interval');
  array(p.errors, 'probe errors', 0);
  const input = array(p.rawInput, 'actual input'); integer(p.inputEvents, 'inputEvents', 1, 180000); requireThat(input.length === p.inputEvents, 'raw input coverage');
  let previous = start;
  for (let i = 0; i < input.length; i++) {
    const v = record(input[i], 'input endpoint'); integer(v.touches, 'input touches', 1);
    for(const key of ['entered','returned','oldestTouchTimestamp','newestTouchTimestamp'])finite(v[key], 'input.' + key);
    requireThat(v.epoch === i + 1 && v.entered >= previous && v.entered <= v.returned && v.returned <= finish && v.oldestTouchTimestamp <= v.newestTouchTimestamp && v.newestTouchTimestamp <= v.entered, 'input clock/epoch order'); previous = v.entered;
  }
  distribution(p.osTouchAgeAtDispatchMs, input.map(v => (v.entered - v.oldestTouchTimestamp) * 1000), 'OS touch age');
  distribution(p.windowSendEventWallMs, input.map(v => (v.returned - v.entered) * 1000), 'UIWindow wall');
  requireThat(p.negativeTouchAgeSamples === 0, 'negative input age');
  const frames = array(p.rawFrames, 'frames'); integer(p.frames, 'frames count', 0, 180000); requireThat(frames.length === p.frames && (m.instrumented ? p.frames > 0 : p.frames === 0), 'instrumented frame coverage');
  const seen = new Set(), latencies = []; let lastEpoch = 0, lastEnd = start;
  for (const frame of frames) {
    record(frame, 'frame'); integer(frame.inputEpoch, 'frame epoch', 0, p.inputEvents); integer(frame.revision, 'frame revision');finite(frame.start, 'frame.start');finite(frame.end, 'frame.end');
    requireThat(frame.start >= lastEnd && frame.start <= frame.end && frame.end <= finish && frame.inputEpoch >= lastEpoch, 'frame clock/epoch order');
    if (frame.inputEpoch && !seen.has(frame.inputEpoch)) {seen.add(frame.inputEpoch); const value = (frame.end - input[frame.inputEpoch - 1].entered) * 1000; finite(value, 'input/frame latency'); latencies.push(value);}
    lastEnd = frame.end; lastEpoch = frame.inputEpoch;
  }
  requireThat(p.supersededInputs === lastEpoch - seen.size, 'superseded input accounting');
  distribution(p.drawCPUSectionWallMs, frames.map(v => (v.end - v.start) * 1000), 'draw wall');
  distribution(p.latestInputToCPUSectionCompletionMs, latencies, 'input/draw latency');
  const beats = array(p.rawHeartbeatMs, 'heartbeats'); requireThat(beats.length >= 2 && beats.length <= 180000, 'intermediate heartbeat coverage'); beats.forEach(v => finite(v, 'heartbeat interval'));
  near(beats.reduce((n, v) => n + v, 0), p.elapsedSeconds * 1000, 'heartbeat interval covers measurement end', .1);
  requireThat(p.gapsOver50Ms === beats.filter(v => v >= 50).length, 'heartbeat gap count'); distribution(p.mainHeartbeatGapMs, beats, 'heartbeat distribution');
  const sampler = record(r.sampler, 'sampler'), samples = array(sampler.samples, 'process samples'); requireThat(sampler.intervalMs === 100 && sampler.peakIsSamplingLowerBound === true && samples.length >= 2 && samples.length <= 18000, 'sampler coverage');
  let lastSample = start, peak = 0;
  for (const sample of samples) {const at = processSnapshot(sample, 'sample'); requireThat(at >= lastSample && at <= finish, 'sampler clock'); lastSample = at; peak = Math.max(peak, sample.residentBytes);}
  requireThat(lastSample - samples[0].sampledAt >= run.seconds - .5 && sampler.sampledPeakResidentBytes === peak, 'sampler full interval/peak');
  const drawing = record(r.drawingChecks, 'drawing evidence'); requireThat(drawing.accessibleEscapePreservesCommittedDocument === true && drawing.pointersAfter === 0 && integer(r.accessibleCancelActions, 'accessibleCancelActions', 1) > 0, 'committed Escape/owner pointer cleanup');
  requireThat(text(drawing.inputBoundary, 'drawing input route').includes('XCUI') && drawing.inputBoundary.includes('accessibleEscape'), 'drawing input route');
  const saved = JSON.parse(text(drawing.saved, 'saved drawing document')); requireThat(saved.schema === 'aster.drawings' && [1, 2].includes(saved.version), 'saved drawing schema');
  const drawings = array(saved.drawings, 'saved drawings'); requireThat(drawings.length > 0, 'saved drawing coverage'); const ids = new Set();
  for (const d of drawings) {
    record(d, 'drawing'); text(d.id, 'drawing id'); requireThat(!ids.has(d.id) && d.type === 'trendline' && d.panel === 'price' && typeof d.locked === 'boolean', 'fixture drawing shape'); ids.add(d.id);
    for (const point of array(d.points, 'trendline points', 2)) {record(point, 'drawing point'); requireThat(Number.isFinite(point.time) && Number.isFinite(point.price), 'finite saved anchors');}
  }
  for (const key of ['engineNil', 'contextNil', 'vmNil', 'runtimeNil', 'feedNil', 'viewNil', 'retainedJobsReleased', 'ownerThread', 'afterEventScope']) requireThat(record(r.cleanup, 'ARC cleanup')[key] === true, 'ARC cleanup.' + key);
  requireThat(r.cleanup.retainedCompletedHandles === 2, 'retained handles exercised');
  array(r.observedChanges, 'model observer slots', 2).forEach(v => integer(v, 'observedChanges', 1));
  record(cleanup, 'simulator cleanup');
  const hasProcessQueryStatus = Object.hasOwn(cleanup,'processQueryStatus');
  if (executionPolicy === 'fresh' || hasProcessQueryStatus) requireThat(cleanup.processQueryStatus === 0, 'successful process query required');
  requireThat(cleanup.id === run.id && cleanup.ownedOnly === true && cleanup.remaining === false && cleanup.ownedUUIDProcessCount === 0, 'owned-only OS cleanup');
  array(cleanup.ownedUUIDProcesses, 'owned processes', 0); const operations = array(cleanup.cleanup, 'cleanup operations', 3);
  assert.deepEqual(operations.map(v => v.operation), ['terminate', 'shutdown', 'delete'], 'iOS cleanup operations');
  requireThat((operations[0].status === 0 || operations[0].status === 3 && text(operations[0].stderr, 'termination reason').includes('found nothing to terminate')) && operations[1].status === 0 && operations[2].status === 0, 'OS cleanup results');
  return {passed: true, qualifying900Seconds: !run.pilot, executionPolicy, processQueryVerified: hasProcessQueryStatus, newRunCertified: executionPolicy === 'fresh', pilot: run.pilot, instrumented: m.instrumented, actualSeconds: p.elapsedSeconds, coreSHA256: m.coreSHA256, sourceExact: true, provenance: 'legacy UUID/log/manifest/report-byte/replay-clock consistency; no in-app run nonce or persisted absolute probe clock', undoRedoVerified: false, physicalDevice: false, platformSpeedComparison: false, clockBoundary: m.instrumented ? 'UIWindow delivery and copied draw CPU-section completion; no compositor timing' : 'UIWindow input functional validation; no draw instrumentation or compositor timing'};
}
