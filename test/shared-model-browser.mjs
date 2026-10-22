import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {launchBrowser} from '../scripts/cdp.mjs';
import {startFixtureServer} from '../benchmarks/browser-soak.mjs';
import {sharedModelFixture, sharedModelVerdict} from './shared-model-browser-fixture.mjs';

export function sharedModelRuntimeSource() {
  return `try { const A = await import('/src/index.mjs');
globalThis.__sharedModelResult = await (${sharedModelFixture.toString()})(A, {execution: 'browser'});
} catch (error) { globalThis.__sharedModelResult = {status: 'failed', errors: [String(error?.message ?? error)]}; }`;
}

export function sharedModelBrowserVerdict(report) {
  const fixture = sharedModelVerdict(report?.fixture), errors = [...fixture.errors];
  if (!Array.isArray(report?.errors) || report.errors.length) errors.push('Runner errors missing or nonzero');
  for (const key of ['exceptions', 'crashes', 'consoleErrors', 'externalRequests'])
    if (!Array.isArray(report?.protocol?.[key]) || report.protocol[key].length) errors.push('Protocol ' + key + ' missing or nonzero');
  if (report?.cleanup?.browserConfirmed !== true || report.cleanup.serverClosed !== true) errors.push('Owned runner cleanup unconfirmed');
  return {...fixture, status: errors.length ? 'fail' : 'pass', errors, actualBrowser: errors.length === 0};
}

// Passive on import. The second argument exists solely for deterministic Node
// runner-contract tests; CLI always uses the owned browser and loopback server.
export async function runSharedModelBrowser({output = 'artifacts/shared-model-browser.json'} = {}, dependencies = {}) {
  const start = dependencies.startFixtureServer ?? startFixtureServer, launch = dependencies.launchBrowser ?? launchBrowser;
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const report = {schema: 'barochart-shared-model-browser-v1', fixture: null, errors: [],
    protocol: {exceptions: [], crashes: [], consoleErrors: [], externalRequests: []},
    cleanup: {browserConfirmed: false, serverClosed: false},
    conditions: {chartsCreated: 4, peakCharts: 3, models: 2, sharedViews: 2, renderer: 'canvas', dpr: 1, width: 1440, height: 1200},
    fixtureSHA256: createHash('sha256').update(await readFile(new URL('./shared-model-browser-fixture.mjs', import.meta.url))).digest('hex')};
  let server, browser;
  try {
    server = await start(sourceRoot, sharedModelRuntimeSource());
    browser = await launch({width: 1440, height: 1200, dpr: 1, timeoutMs: 15000});
    const primary = meta => !meta?.sessionId || meta.sessionId === browser.sessionId;
    browser.on('Runtime.exceptionThrown', (event, meta) => {if (primary(meta)) report.protocol.exceptions.push(event.exceptionDetails?.text ?? 'Runtime exception');});
    browser.on('Inspector.targetCrashed', (_event, meta) => {if (primary(meta)) report.protocol.crashes.push('Primary target crashed');});
    browser.on('Runtime.consoleAPICalled', (event, meta) => {if (primary(meta) && event.type === 'error') report.protocol.consoleErrors.push('Console error');});
    browser.on('Network.requestWillBeSent', (event, meta) => {if (primary(meta) && /^https?:/.test(event.request.url) && new URL(event.request.url).origin !== server.origin) report.protocol.externalRequests.push(event.request.url);});
    await browser.send('Network.enable');
    await browser.send('Inspector.enable');
    await browser.navigate(server.origin + '/harness.html', {timeout: 15000, label: 'shared-model:navigate'});
    report.fixture = await browser.evaluate(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 10000;
      const timer = setInterval(() => {
        if (globalThis.__sharedModelResult) {clearInterval(timer); resolve(globalThis.__sharedModelResult);}
        else if (performance.now() >= deadline) {clearInterval(timer); reject(Error('Shared-model fixture timeout'));}
      }, 20);
    })`, {timeout: 15000, label: 'shared-model:result'});
  } catch (error) {
    report.errors.push(String(error?.message ?? error));
  } finally {
    // Failure to close one resource must never skip closing the other.
    try {if (browser) {const result = await browser.close(); report.cleanup.browserConfirmed = result?.terminationConfirmed === true && result.profileRemoved === true;}}
    catch (error) {report.errors.push('Browser cleanup: ' + error.message);}
    try {if (server) {await server.close(); report.cleanup.serverClosed = true;}}
    catch (error) {report.errors.push('Server cleanup: ' + error.message);}
  }
  report.verdict = sharedModelBrowserVerdict(report);
  if (output !== null) {await mkdir(dirname(resolve(output)), {recursive: true}); await writeFile(output, JSON.stringify(report, null, 2) + '\n');}
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output' || args[1].startsWith('--'))) throw new Error('Usage: node test/shared-model-browser.mjs [--output path]');
  const report = await runSharedModelBrowser({output: args[1]});
  console.log(JSON.stringify(report.verdict));
  if (report.verdict.status !== 'pass') process.exitCode = 1;
}
