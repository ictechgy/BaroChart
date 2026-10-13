import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Static source assertions only. This does not compile or execute Swift, JSC,
// ARC, DispatchQueue, or creator run loops. Apple SDK/runtime checks remain
// necessary to establish actual publication, cancellation, and release behavior.
const raw = readFileSync(new URL('../native/AsterNative.swift', import.meta.url), 'utf8');
const source = raw.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
  token => token.startsWith('/') ? token.replace(/[^\n]/g, ' ') : token);
const compact = value => value.replace(/\s+/g, '');
// Scope checks to declarations and ignore comments/string braces. Whitespace
// and unrelated source formatting are deliberately not part of this contract.
function block(scope, declaration) {
  const match = declaration.exec(scope);
  assert.ok(match, `Missing Swift declaration: ${declaration}`);
  const structure = scope.replace(/"(?:\\.|[^"\\])*"/g, token => ' '.repeat(token.length));
  let parens = 0, brackets = 0, begin = -1;
  // A default closure argument (completion: () -> Void = {}) is not the body.
  for (let i = match.index; i < structure.length; i++) {
    if (structure[i] === '(') parens++;
    else if (structure[i] === ')') parens--;
    else if (structure[i] === '[') brackets++;
    else if (structure[i] === ']') brackets--;
    else if (structure[i] === '{' && !parens && !brackets) {begin = i;break;}
  }
  assert.ok(begin >= 0, `Missing Swift body: ${declaration}`);
  let depth = 1, end = begin + 1;
  for (; end < structure.length && depth; end++) {
    if (structure[end] === '{') depth++;
    else if (structure[end] === '}') depth--;
  }
  assert.equal(depth, 0, `Unbalanced Swift body: ${declaration}`);
  return scope.slice(begin + 1, end - 1);
}
function ordered(scope, ...parts) {
  const code = compact(scope);
  let after = 0;
  for (const part of parts) {
    const fragment = compact(part), index = code.indexOf(fragment, after);
    assert.ok(index >= 0, `Expected ordered Swift source fragment: ${part}`);
    after = index + fragment.length;
  }
}
const record = block(source, /\bclass\s+AsterWorkspaceSourceRecord\b/);
const registry = block(source, /\benum\s+AsterWorkspaceRegistry\b/);
const job = block(source, /\bclass\s+AsterWorkspaceJob\b/);
const runtime = block(source, /\bclass\s+AsterWorkspaceRuntime\b/);
const retirement = block(source, /\bclass\s+AsterRuntimeRetirement\b/);
const engine = block(source, /\bclass\s+AsterEngine\b/);
const genericJob = block(source, /\bclass\s+AsterAsyncJob\b/);
const method = (scope, name) => block(scope, new RegExp(`\\bfunc\\s+${name}\\s*(?:<[^>]+>)?\\s*\\(`));
const staticTest = (name, run) => test(`Swift workspace static source assertion: ${name}`, run);

staticTest('registration and active ownership precede deferred Begin', () => {
  const restore = method(engine, 'restoreWorkspaceAsync');
  ordered(restore, 'try asyncPreflight(timeout)', 'JSONSerialization.data(',
    'try asyncPreflight(timeout)', 'guard contextBacking === source, revision == capturedRevision',
    'AsterWorkspaceRegistry.reserve(source,contextRuntime)', 'AsterWorkspaceJob(',
    'activeWorkspace = job', 'DispatchQueue.main.async', 'job.start(bundle:bundle)');
  assert.doesNotMatch(restore, /nativeWorkspaceSourceBegin/);
  const start = method(job, 'start');
  ordered(start, 'record.began = true',
    'asterInvoke($0,"nativeWorkspaceSourceBegin",[document,binding,sourceRevision,asterWorkspaceMaxBytes,registration])',
    'receipt["registration"]', 'receipt["ticket"]', 'admit(ticket:ticket,bundle:bundle)');
  assert.match(compact(start), /catch\{fail\(error\)\}/);
});

staticTest('two global slots and admitted bytes are independently bounded', () => {
  assert.match(compact(source), /asterWorkspaceMaxBytes=768\*1024\*1024/);
  assert.match(compact(registry), /staticvarrecords:\[Int:AsterWorkspaceSourceRecord\]=\[:\]/);
  const reserve = compact(method(registry, 'reserve'));
  assert.match(reserve, /guardrecords\.count<2,next<9007199254740991/);
  ordered(reserve, 'next += 1', 'AsterWorkspaceSourceRecord(registration:next',
    'records[record.registration] = record');
  assert.doesNotMatch(reserve, /\bbytes\b|\.admitted|\.admit\(/);
  assert.match(compact(record), /varbytes=0,admitted=false/);
  ordered(method(registry, 'admit'), 'records[record.registration] === record', '!record.admitted',
    'cost > 0', 'cost <= asterWorkspaceMaxBytes - bytes',
    'bytes += cost', 'record.bytes = cost', 'record.admitted = true');
  ordered(method(job, 'admit'), 'AsterWorkspaceDescriptor(value,ticket:ticket)',
    'AsterWorkspaceRegistry.admit(record,plan.bytes)', 'AsterWorkspaceRuntime(', 'runtime.start()');
  const status = compact(method(registry, 'status'));
  assert.match(status, /admittedLogicalBytes:\$0\.bytes/);
  assert.match(status, /admitted:\$0\.admitted/);
});

staticTest('pending records retain source ownership but no job, engine, Error, or callback', () => {
  const fields = record.slice(0, record.search(/\binit\s*\(/));
  assert.match(compact(fields), /letregistration:Int/);
  assert.match(compact(fields), /varcontext:JSContext\?/);
  assert.match(compact(fields), /varruntime:AsterContextRuntime\?/);
  assert.doesNotMatch(fields, /\b(?:AsterWorkspaceJob|AsterEngine|Error|Result|Any|AnyObject|JSValue)\b|->|\b(?:completion|callback|progress)\b/);
  const fail = method(job, 'fail');
  ordered(fail, 'try record.abort()', 'AsterWorkspaceRegistry.remove(record)',
    'self.record = nil', 'descriptor = nil', 'targetRuntime = nil', 'finish(.failure(error),notify:nil)');
  const unconfirmed = block(fail, /\bcatch\s*/);
  ordered(unconfirmed, 'record.pending = true', 'engine?.pendingWorkspaceRegistration = registration',
    'self.record = nil', 'descriptor = nil', 'targetRuntime = nil',
    'finish(.failure(AsterWorkspaceError.cleanupPending(registration:registration)),notify:nil)');
  assert.doesNotMatch(fail, /record\.\w+\s*=\s*(?:error|failure|self|engine|completion|progress)\b/);
  ordered(method(job, 'finish'), 'document = nil', 'binding = nil', 'descriptor = nil',
    'let callback = completion', 'completion = nil', 'progress = nil', 'callback?(');
});

staticTest('Abort uses the immutable registration and original context without a ticket', () => {
  const abort = method(record, 'abort');
  ordered(abort, 'precondition(Thread.isMainThread)', 'if released {return}',
    'if began', 'try autoreleasepool', 'guard let context = context',
    'asterInvoke(context,"nativeWorkspaceSourceAbort",[registration])', 'guard value.isBoolean', 'released = true');
  // True means released now; false confirms no matching registration remains.
  assert.doesNotMatch(abort, /\b(?:ticket|engine|descriptor)\b|\.toBool\(/);
  const retry = method(registry, 'retry');
  assert.match(compact(retry), /letcandidates=Array\(records\.values\)/);
  assert.match(compact(retry), /record\.pending&&!record\.retrying&&!record\.detaching&&\(registration==nil\|\|registration==record\.registration\)/);
  ordered(retry, 'record.retrying = true', 'try record.abort()', 'record.retrying = false', 'remove(record)');
  assert.match(compact(retry), /catch\{record\.retrying=false;record\.failures=min\(32,record\.failures\+1\)\}/);
  assert.doesNotMatch(retry, /DispatchQueue|while\s|completion|notifyChanges/);
});

staticTest('confirmed cleanup holds reservations until source retirement is acknowledged', () => {
  const remove = method(registry, 'remove');
  ordered(remove, 'precondition(Thread.isMainThread && record.released)',
    'guard records[record.registration] === record',
    '!record.detaching', 'record.detach',
    'records.removeValue(forKey:record.registration)', 'bytes -= record.bytes', 'completion()');
  const detached = block(remove, /record\.detach\b\s*/);
  ordered(detached, 'precondition(Thread.isMainThread)', 'guard records[record.registration] === record',
    'records.removeValue(forKey:record.registration)', 'bytes -= record.bytes', 'completion()');
  assert.equal((compact(remove).match(/records\.removeValue/g) ?? []).length, 1);
  ordered(method(record, 'detach'), 'precondition(Thread.isMainThread && released && !detaching)',
    'detaching = true', 'context = nil', 'let owner = runtime', 'runtime = nil',
    'owner.releaseCaptureLease(afterRetirementIfNeeded:completion)');
  assert.match(compact(method(record, 'detach')), /else\{completion\(\)\}/);
  assert.match(compact(method(registry, 'status')), /awaitingCreatorCleanup:\$0\.detaching/);
  assert.doesNotMatch(registry, /NSLock|\.lock\(|\.unlock\(|DispatchQueue|Timer\s*\(/);
});

staticTest('source Finish precedes callback-free locked final publication', () => {
  const install = method(job, 'install');
  ordered(install, 'nativeWorkspaceSourceFinish', 'receipt["schema"]', 'receipt["revision"]',
    'record.released = true', 'var oldContext = record.context', 'var oldRuntime = engine?.contextRuntime',
    'lock.lock()', 'if cancelled', 'guard !terminal && !committed',
    'asterClock() - started >= timeout', 'let owner = try finalOwner()',
    'owner.contextBacking = context', 'owner.workspaceContextInstalled = true',
    'owner.contextRuntime = runtime', 'committed = true', 'lock.unlock()');
  const critical = install.slice(install.indexOf('lock.lock()'), install.indexOf('lock.unlock()'));
  assert.doesNotMatch(critical, /\b(?:asterInvoke|sourceCall|notifyChanges|autoreleasepool|retire|releaseCaptureLease|progress|completion|callback)\s*\??\s*\(/);
  const finalOwner = method(job, 'finalOwner');
  assert.match(compact(finalOwner), /!engine\.closed&&!engine\.closing/);
  assert.match(compact(finalOwner), /engine\.activeWorkspace===self,engine\.revision==sourceRevision/);
  assert.match(compact(finalOwner), /letsource=record\?\.context,engine\.contextBacking===source/);
  assert.doesNotMatch(finalOwner, /asterInvoke|sourceCall|notifyChanges|\.call\(|progress|completion|callback/);
});

staticTest('source operations check ownership before and after callback-capable JS', () => {
  ordered(method(job, 'sourceCall'), 'precondition(Thread.isMainThread)', 'try check()', 'try finalOwner()',
    'try autoreleasepool', 'guard let source = record?.context',
    '"nativeWorkspaceSourceCheck",[ticket,sourceRevision]', 'try operation(source)',
    'try check()', 'try finalOwner()', 'return result');
});

staticTest('reservations and active ownership clear before observers and completion', () => {
  const install = method(job, 'install');
  ordered(install, 'committed = true', 'lock.unlock()', 'targetRuntime = nil',
    'oldContext = nil', 'oldRuntime?.retire()', 'return owner');
  assert.doesNotMatch(install, /AsterWorkspaceRegistry\.remove|activeWorkspace\s*=|notifyChanges|completion\?\(|progress\?\(/);
  const succeed = method(job, 'succeed');
  const released = block(succeed, /AsterWorkspaceRegistry\.remove\(record\)\s*/);
  ordered(released, 'self.record = nil', 'descriptor = nil', 'finish(.success(metrics),notify:owner)');
  ordered(method(job, 'finish'), 'terminal = true', 'lock.unlock()',
    'engine.activeWorkspace = nil',
    'completion = nil', 'progress = nil', 'owner?.notifyChanges()', 'callback?(');
  assert.match(compact(method(job, 'cancel')), /if!terminal&&!committed\{cancelled=true\}/);
  assert.match(compact(method(job, 'fail')), /letdone=terminal\|\|committed\|\|finishing;if!done\{finishing=true\};lock\.unlock\(\);ifdone\{return\}/);
});

staticTest('worker autorelease pool drains before the main handoff', () => {
  const initial = method(runtime, 'performInitialJob');
  const pool = block(initial, /\bautoreleasepool\s*/);
  assert.match(compact(pool), /outcome=\.success\(trycompute\(job,plan\)\)/);
  assert.doesNotMatch(pool, /DispatchQueue|job\.install|job\.succeed/);
  ordered(initial, 'initialJob = nil', 'initialPlan = nil', 'autoreleasepool', 'switch outcome!',
    'let delivery = AsterWorkspaceDelivery(ownedContext)', 'DispatchQueue.main.async', 'try autoreleasepool',
    'try job.install(context,runtime:self,copied:copied)', 'delivery.context = nil', 'job.succeed(owner)');
  assert.match(compact(initial), /catch\{delivery\.context=nil;failAfterCreatorCleanup\(job,error\)\}/);
  assert.match(compact(initial), /case\.failure\(leterror\):failAfterCreatorCleanup\(job,error\)/);
  assert.doesNotMatch(initial, /job\.fail\(/);
  const compute = method(runtime, 'compute');
  ordered(compute, 'ownedContext = context', 'nativeWorkspaceTargetCreate',
    'nativeAsyncStart', 'nativeWorkspaceTargetFinish', '"target-ready"',
    'asterWorkspaceBool(receipt["hostPublished"]) == false', 'try job.check()', 'return copied');
  assert.doesNotMatch(compute, /\.install\(|nativeAsyncUI|notifyChanges/);
});

staticTest('failure waits for creator cleanup before source Abort and completion', () => {
  const failure = method(runtime, 'failAfterCreatorCleanup');
  ordered(failure, 'cleanupLock.lock()', 'precondition(afterCreatorCleanup == nil)',
    'afterCreatorCleanup = {job.fail(error)}', 'cleanupLock.unlock()', 'retire()');
  assert.doesNotMatch(failure, /DispatchQueue|AsterWorkspaceRegistry|\.abort\(/);
  const run = method(runtime, 'run');
  ordered(run, 'while !retirement.shouldStop', 'autoreleasepool {ownedContext = nil}',
    'RunLoop.current.remove(', 'port.invalidate()', 'retirement.install(nil)',
    'cleanupLock.lock()', 'let completion = afterCreatorCleanup',
    'afterCreatorCleanup = nil', 'cleanupLock.unlock()', 'DispatchQueue.main.async(execute:completion)');
  assert.doesNotMatch(run, /job\.fail\(|AsterWorkspaceRegistry|\.abort\(/);
  ordered(method(job, 'fail'), 'try record.abort()', 'AsterWorkspaceRegistry.remove(record)',
    'finish(.failure(error),notify:nil)');
});

staticTest('creator finally clears the workspace context after retirement leases drain', () => {
  assert.match(compact(runtime), /privatevarownedContext:JSContext\?/);
  ordered(method(runtime, 'run'), 'retirement.install(CFRunLoopGetCurrent())',
    'performInitialJob()', 'while !retirement.shouldStop',
    'autoreleasepool {ownedContext = nil}', 'RunLoop.current.remove(',
    'retirement.install(nil)', 'retirement.didFinish()');
  assert.equal((compact(runtime).match(/ownedContext=nil/g) ?? []).length, 1);
  ordered(method(retirement, 'acquire'), 'lock.lock()', 'guard !requested', 'leases += 1');
  assert.match(compact(block(retirement, /\bvar\s+shouldStop\s*:\s*Bool/)), /returnrequested&&leases==0/);
  ordered(method(retirement, 'release'), 'precondition(leases > 0)', 'leases -= 1', 'let wait = requested',
    'completions.append(completion)', 'wait && leases == 0 ? loop : nil',
    'lock.unlock()', 'CFRunLoopStop(wake)', 'if !wait {completion?()}');
  ordered(method(retirement, 'didFinish'), 'lock.lock()', 'let ready = completions',
    'completions = []', 'lock.unlock()', 'DispatchQueue.main.async(execute:completion)');
  ordered(method(retirement, 'retire'), 'requested = true',
    'leases == 0 ? loop : nil', 'lock.unlock()', 'CFRunLoopStop(wake)');
  for (const name of ['acquireCaptureLease', 'releaseCaptureLease', 'retire']) {
    assert.match(method(runtime, name), /retirement\./);
  }
});

staticTest('progress is coalesced and terminal delivery clears stored callbacks', () => {
  const report = method(job, 'report');
  ordered(report, 'lock.lock()', 'if terminal', 'latestProgress = value',
    'if progressPending', 'progressPending = true', 'lock.unlock()', 'DispatchQueue.main.async',
    'finished = terminal', 'progressPending = false', 'lock.unlock()',
    'guard !finished', 'try progress(value)');
  assert.equal((report.match(/DispatchQueue\.main\.async/g) ?? []).length, 1);
  assert.match(compact(report), /callbackErrors=min\(32,callbackErrors\+1\)/);
  ordered(method(job, 'finish'), 'terminal = true', 'latestProgress = nil',
    'completion = nil', 'progress = nil', 'owner?.notifyChanges()');
});

staticTest('only workspace-installed backing is dropped on close or deinit', () => {
  assert.match(compact(engine), /varcontextBacking:JSContext\?/);
  const context = block(engine, /\bvar\s+context\s*:\s*JSContext/);
  assert.match(compact(context), /set\{contextBacking=newValue;workspaceContextInstalled=false\}/);
  assert.match(compact(context), /get\{guardletcontext=contextBackingelse\{preconditionFailure\(/);
  const close = method(engine, 'close');
  ordered(close, 'guard Thread.current === owner', 'if closing',
    'AsterWorkspaceRegistry.retry(pending)', 'if closed', 'activeWorkspace?.cancel()',
    'closed = true', 'if workspaceContextInstalled {contextBacking = nil}',
    'contextRuntime?.retire()', 'contextRuntime = nil');
  const deinit = block(engine, /\bdeinit\s*/);
  ordered(deinit, 'activeWorkspace?.cancel()',
    'if workspaceContextInstalled {contextBacking = nil}', 'contextRuntime?.retire()');
  for (const body of [close, deinit]) {
    assert.equal((compact(body).match(/contextBacking=nil/g) ?? []).length, 1);
    assert.doesNotMatch(body, /ownedContext\s*=|\.detach\(/);
  }
});

staticTest('generic jobs lease source retirement only for workspace-installed contexts', () => {
  const init = block(genericJob, /\binit\s*\(/);
  const conditional = block(init, /if\s+engine\.workspaceContextInstalled\s*,\s*let\s+runtime\s*=\s*engine\.contextRuntime\s*/);
  assert.match(compact(conditional), /ifruntime\.acquireCaptureLease\(\)\{workspaceSourceRuntime=runtime\}/);
  assert.match(compact(conditional), /else\{stopped=AsterAsyncError\.invalidProtocol\(/);
  assert.equal((init.match(/acquireCaptureLease\(/g) ?? []).length, 1);
  ordered(method(genericJob, 'finish'), 'source = nil',
    'let leasedRuntime = workspaceSourceRuntime', 'workspaceSourceRuntime = nil',
    'leasedRuntime?.releaseCaptureLease()', 'callback?(');
  assert.match(compact(block(record, /\binit\s*\(/)), /ifletruntime=runtime,!runtime\.acquireCaptureLease\(\)/);
});

staticTest('public entry points preserve main/owner and closed-engine guards', () => {
  ordered(method(engine, 'asyncPreflight'), 'guard Thread.current === owner',
    'guard Thread.isMainThread', 'guard !closed', 'try workspaceAvailability()', 'guard activeAsync == nil');
  for (const name of ['restoreWorkspaceAsync', 'prepareColumnsAsync', 'prepareSeededAsync']) {
    assert.match(method(engine, name), /try\s+asyncPreflight\(timeout\)/);
  }
  for (const [name, access] of [['workspaceCleanupStatus', 'AsterWorkspaceRegistry.status()'],
    ['retryWorkspaceCleanup', 'AsterWorkspaceRegistry.retry()']]) {
    ordered(method(engine, name), 'guard Thread.isMainThread', access);
  }
  ordered(method(engine, 'applyDataEventAsync'), 'guard Thread.current === owner',
    'guard Thread.isMainThread', 'guard !closed', 'try workspaceAvailability()');
  ordered(method(engine, 'call'), 'guard Thread.current === owner', 'guard !closed', 'function.call(');
  ordered(method(engine, 'command'), 'guard Thread.current === owner', 'guard !closed', 'try call(');
  ordered(method(engine, 'workspaceAvailability'), 'guard !closing',
    'AsterWorkspaceRegistry.contains(pending)', 'guard activeWorkspace == nil');
  assert.match(compact(block(job, /\bvar\s+cleanupPending\s*:\s*Bool/)), /precondition\(Thread\.isMainThread\);returnAsterWorkspaceRegistry\.status\(\)/);
  for (const name of ['reserve', 'contains', 'admit', 'remove', 'status', 'retry']) {
    assert.match(compact(method(registry, name)), /^precondition\(Thread\.isMainThread(?:\)|&&)/);
  }
});
