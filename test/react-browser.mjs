import {createServer} from 'node:http';
import {readFile, writeFile, mkdir, copyFile, mkdtemp, stat} from 'node:fs/promises';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join, resolve} from 'node:path';
import {launchBrowser} from '../scripts/cdp.mjs';

const execFile = promisify(execFileCallback);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');

export async function runReactBrowserQA({reactVersion = '19.3.0'} = {}) {
  if (!['19.3.0', '18.3.1'].includes(reactVersion)) throw new RangeError('QA pins React19.3.0 or React18.3.1');
  const harnessSHA256 = await sha(fileURLToPath(import.meta.url));
  const shared = '/tmp/aster-cycle8-react-qa';
  await mkdir(shared, {recursive: true});
  const runDir = await mkdtemp(join(shared, 'run-'));
  const userConfig = join(shared, 'npm-user.conf'), globalConfig = join(shared, 'npm-global.conf');
  await writeFile(userConfig, ''); await writeFile(globalConfig, '');
  const npmFlags = ['--userconfig=' + userConfig, '--globalconfig=' + globalConfig,
    '--cache=' + join(shared, 'npm-cache'), '--no-audit', '--no-fund', '--ignore-scripts'];
  const npm = async (args, cwd) => execFile('npm', [...args, ...npmFlags], {cwd, maxBuffer: 4 * 1024 * 1024});
  const packages = join(runDir, 'packages'); await mkdir(packages);
  const packed = JSON.parse((await npm(['pack', '--json', '--pack-destination', packages], repository)).stdout)[0];
  const tar = join(packages, packed.filename), consumer = join(runDir, 'consumer'); await mkdir(consumer);
  // Pack the already installed, lock-pinned runtime dependencies. Fresh consumer
  // installation is fully offline; it does not rely on a particular npm cache.
  const runtimeTars = {};
  const dependencyRoot = reactVersion === '19.3.0' ? join(repository, 'examples/react-web/node_modules') : join(shared, 'react18/node_modules');
  const runtimeNames = reactVersion === '19.3.0' ? ['react', 'react-dom', 'scheduler'] : ['react', 'react-dom', 'scheduler', 'loose-envify', 'js-tokens'];
  const runtimeMetadata = [];
  for (const name of runtimeNames) {
    const installed = join(dependencyRoot, name), metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    if (['react', 'react-dom'].includes(name) && metadata.version !== reactVersion) throw new Error(`Expected ${name}@${reactVersion}`);
    runtimeMetadata.push({name, version: metadata.version, license: metadata.license});
    const result = JSON.parse((await npm(['pack', '--json', '--pack-destination', packages], installed)).stdout)[0];
    runtimeTars[name] = 'file:' + join(packages, result.filename);
  }
  await writeFile(join(consumer, 'package.json'), JSON.stringify({name: 'aster-react-browser-consumer', private: true, type: 'module',
    dependencies: {'barochart': 'file:' + tar, ...runtimeTars}}, null, 2));
  await npm(['install', '--offline'], consumer);
  // A preserved pre-adapter package proves the previous public export is absent.
  const baselineZip = join(repository, 'artifacts/aster-charts-source-0.2.7-library.zip');
  const hasBaseline = await stat(baselineZip).then(info => info.isFile()).catch(error => {if (error.code === 'ENOENT') return false; throw error;});
  let red = {status: 'skipped', pass: null, packageVersion: '0.2.7', reason: 'Preserved 0.2.7 library ZIP is absent; current functional QA still runs. This is not evidence of a missing prior export.'};
  if (hasBaseline) {
  const oldSource = join(runDir, 'baseline-source'); await mkdir(oldSource);
  await execFile('python3', ['-c',
    'import zipfile,sys,pathlib; z=zipfile.ZipFile(sys.argv[1]); out=pathlib.Path(sys.argv[2]);\nfor n in z.namelist():\n if n=="aster-charts/package.json" or n.startswith("aster-charts/src/"):\n  p=out.joinpath(*pathlib.PurePosixPath(n).parts);\n  if ".." in pathlib.PurePosixPath(n).parts: raise ValueError("unsafe archive path")\n  if not n.endswith("/"): p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(z.read(n))', baselineZip, oldSource]);
  const baselinePack = JSON.parse((await npm(['pack', '--json', '--pack-destination', packages], join(oldSource, 'aster-charts'))).stdout)[0];
  const oldConsumer = join(runDir, 'baseline-consumer'); await mkdir(oldConsumer);
  await writeFile(join(oldConsumer, 'package.json'), JSON.stringify({name: 'aster-react-before-consumer', private: true,
    dependencies: {'aster-financial-charts': 'file:' + join(packages, baselinePack.filename)}}));
  await npm(['install', '--offline'], oldConsumer);
  try {createRequire(join(oldConsumer, 'package.json')).resolve('aster-financial-charts/react'); red = {status: 'checked', pass: false, error: 'Unexpected prior React export'};}
  catch (error) {red = {status: 'checked', pass: error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED', code: error.code, packageVersion: baselinePack.version,
    archiveSHA256: await sha(baselineZip)};}
  }

  for (const name of ['react-browser-fixture.mjs', 'react-ssr-fixture.mjs', 'react-async-ready-types.mts']) await copyFile(join(repository, 'test', name), join(consumer, name));
  const typingTars = [];
  for (const name of ['@types/react', 'csstype']) {
    const result = JSON.parse((await npm(['pack', '--json', '--pack-destination', packages], join(repository, 'examples/react-web/node_modules', name))).stdout)[0];
    typingTars.push('file:' + join(packages, result.filename));
  }
  await npm(['install', '--offline', ...typingTars], consumer);
  let negativeTypes;
  try {
    await execFile(process.execPath, [join(repository, 'examples/react-web/node_modules/typescript/lib/tsc.js'), '--noEmit', '--strict',
      '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--lib', 'ES2022,DOM', 'react-async-ready-types.mts'], {cwd: consumer});
    negativeTypes = {pass: false, exitCode: 0, diagnostics: 'Unsupported async onReady unexpectedly accepted'};
  } catch (error) {
    const diagnostics = String(error.stdout ?? '') + String(error.stderr ?? '');
    const codes = diagnostics.match(/TS\d+/g) ?? [];
    negativeTypes = {pass: error.code === 2 && codes.length === 2 && codes.every(code => code === 'TS2322'), exitCode: error.code, codes, diagnostics};
  }
  const esbuild = await import(pathToFileURL(join(repository, 'examples/react-web/node_modules/esbuild/lib/main.js')));
  await execFile(process.execPath, ['build.mjs'], {cwd: join(repository, 'examples/react-web')});
  await esbuild.build({absWorkingDir: consumer, entryPoints: ['react-browser-fixture.mjs'], bundle: true, platform: 'browser',
    target: 'es2022', format: 'esm', outfile: join(consumer, 'runtime.js'), define: {'process.env.NODE_ENV': '"development"'}, logLevel: 'silent'});
  await writeFile(join(consumer, 'worker-loader.mjs'), "import 'barochart/worker-entry';\n");
  await esbuild.build({absWorkingDir: consumer, entryPoints: ['worker-loader.mjs'], bundle: true, platform: 'browser',
    target: 'es2022', format: 'esm', outfile: join(consumer, 'worker.js'), logLevel: 'silent'});
  // Delay only delivery into the real public worker entry for deterministic
  // cancellation/deadline/stale tests. Its computation and packet are unchanged.
  await writeFile(join(consumer, 'worker-slow-loader.mjs'), "import 'barochart/worker-entry';\nconst compute=self.onmessage;self.onmessage=event=>setTimeout(()=>compute(event),150);\n");
  await esbuild.build({absWorkingDir: consumer, entryPoints: ['worker-slow-loader.mjs'], bundle: true, platform: 'browser',
    target: 'es2022', format: 'esm', outfile: join(consumer, 'worker-slow.js'), logLevel: 'silent'});
  const {ssr} = await import(pathToFileURL(join(consumer, 'react-ssr-fixture.mjs')));
  const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><div id="hydrate"></div><div id="tests"></div><script type="module" src="/runtime.js"></script></body></html>';
  const server = createServer(async (request, response) => {
    const route = new URL(request.url, 'http://127.0.0.1').pathname;
    if (route === '/') {response.writeHead(200, {'Content-Type': 'text/html'}); response.end(html);}
    else if (route === '/ssr.json') {response.writeHead(200, {'Content-Type': 'application/json'}); response.end(JSON.stringify(ssr));}
    else if (route === '/runtime.js') {response.writeHead(200, {'Content-Type': 'text/javascript'}); response.end(await readFile(join(consumer, 'runtime.js')));}
    else if (route === '/worker.js' || route === '/worker-slow.js') {response.writeHead(200, {'Content-Type': 'text/javascript'}); response.end(await readFile(join(consumer, route.slice(1))));}
    else if (route === '/example/') {response.writeHead(200, {'Content-Type': 'text/html'}); response.end(await readFile(join(repository, 'examples/react-web/dist/index.html')));}
    else if (route === '/main.js' || route === '/style.css') {response.writeHead(200, {'Content-Type': route.endsWith('.css') ? 'text/css' : 'text/javascript'}); response.end(await readFile(join(repository, 'examples/react-web/dist', route.slice(1))));}
    else if (route === '/favicon.ico') {response.writeHead(204); response.end();}
    else {response.writeHead(404); response.end();}
  });
  await new Promise((done, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', done);});
  let browser; const exceptions = [], warnings = [], requests = [];
  try {
    browser = await launchBrowser({width: 1200, height: 900, dpr: 1});
    browser.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text));
    browser.on('Runtime.consoleAPICalled', event => {if (['warning', 'error'].includes(event.type)) warnings.push({type: event.type,
      message: event.args.map(arg => arg.value ?? arg.description ?? '').join(' ')});});
    await browser.send('Network.enable'); browser.on('Network.requestWillBeSent', event => requests.push(event.request.url));
    await browser.navigate('http://127.0.0.1:' + server.address().port);
    const ready = await browser.evaluate('Boolean(globalThis.__reactQA?.ready)'); if (!ready) throw new Error('React browser fixture did not load');
    await browser.send('HeapProfiler.collectGarbage');
    const heapBefore = await browser.send('Runtime.getHeapUsage');
    const results = await browser.evaluate('globalThis.__reactQA.run()');
    await browser.send('HeapProfiler.collectGarbage'); const heapAfter = await browser.send('Runtime.getHeapUsage');
    await browser.navigate('http://127.0.0.1:' + server.address().port + '/example/');
    const example = await browser.evaluate(`(async()=>{
      const wait=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      // onReady precedes the first scheduled frame. Wait for its actual bitmap
      // dimensions instead of assuming React passive effects commit in two RAFs.
      for(let i=0;i<20&&document.querySelector('canvas')?.height!==420;i++)await wait();
      const initial={status:document.querySelector('[role=status]').textContent,canvases:document.querySelectorAll('canvas').length,height:document.querySelector('canvas').height};
      document.querySelectorAll('button')[1].click();await wait();const appended=document.querySelector('[role=status]').textContent;
      document.querySelectorAll('button')[0].click();await wait();const themeLabel=document.querySelectorAll('button')[0].textContent;
      const select=document.querySelector('select');select.value='webgl2';select.dispatchEvent(new Event('change',{bubbles:true}));await wait();await wait();
      const gpuStatus=document.querySelector('[role=status]').textContent;
      document.querySelectorAll('button')[2].click();await wait();
      return {initial,appended,themeLabel,gpuStatus,finalCanvases:document.querySelectorAll('canvas').length,
        pass:initial.canvases===1&&initial.height===420&&appended.includes('513')&&themeLabel==='Dark theme'&&gpuStatus.includes('WebGL2')&&document.querySelectorAll('canvas').length===1};
    })()`);
    const screenshot = await browser.send('Page.captureScreenshot', {format: 'png'}); await writeFile(join(runDir, 'example.png'), Buffer.from(screenshot.data, 'base64'));
    const environment = await browser.send('Browser.getVersion');
    const greenPackage = JSON.parse(await readFile(join(consumer, 'node_modules/barochart/package.json'), 'utf8'));
    if (harnessSHA256 !== await sha(fileURLToPath(import.meta.url))) throw new Error('QA harness changed during its run');
    const evidence = {timestamp: new Date().toISOString(), boundary: `React${reactVersion} actual Chrome functional QA; no comparative performance or display FPS`,
      environment: {node: process.version, platform: process.platform, browser: environment, react: reactVersion, reactDOM: reactVersion, esbuild: '0.28.2', runtimeMetadata},
      consumer: {kind: 'npm tarball installed', packageVersion: greenPackage.version, tarSHA256: await sha(tar), tarFile: tar,
        baseline: red, runtimeExport: Object.keys(await import(pathToFileURL(join(consumer, 'node_modules/barochart/src/react/index.mjs'))))},
      provenance: {adapterSHA256: await sha(join(consumer, 'node_modules/barochart/src/react/index.mjs')),
        harnessSHA256, fixtureSHA256: await sha(join(consumer, 'react-browser-fixture.mjs')),
        runtimeFilesSHA256: Object.fromEntries(await Promise.all(['core/api.mjs', 'core/model.mjs', 'core/interaction.mjs', 'core/drawings.mjs', 'web/worker.mjs', 'web/worker-state.mjs'].map(async file =>
          [file, await sha(join(consumer, 'node_modules/barochart/src', file))]))),
        workerEntrySHA256: await sha(join(consumer, 'node_modules/barochart/src/web/worker-entry.mjs')),
        workerBundleSHA256: await sha(join(consumer, 'worker.js')),
        workerSlowBundleSHA256: await sha(join(consumer, 'worker-slow.js')),
        negativeTypesFixtureSHA256: await sha(join(consumer, 'react-async-ready-types.mts')),
        coreAPISHA256: await sha(join(consumer, 'node_modules/barochart/src/core/api.mjs')),
        exampleLockSHA256: await sha(join(repository, 'examples/react-web/package-lock.json'))},
      worker: {kind: 'Native browser module Worker', entry: 'Installed barochart/worker-entry', url: '/worker.js', mocked: false,
        delayedURL: '/worker-slow.js', testDeliveryDelayMs: 150,
        settledGuard: 'One synthetic late progress callback after native termination; no synthetic computation or packet'},
      results, example, negativeTypes, exceptions, warnings, externalRequests: requests.filter(url => !/^http:\/\/127\.0\.0\.1[:/]/.test(url) && !url.startsWith('data:')),
      explicitGC: {before: heapBefore, after: heapAfter, note: 'One-run aggregate observations, not proof of leak freedom.'}};
    evidence.pass = (red.status === 'skipped' || red.pass === true) && negativeTypes.pass && results.resources.failed === 0 && results.errors.length === 0 && example.pass && exceptions.length === 0 && warnings.length === 0 && evidence.externalRequests.length === 0;
    const output = join(runDir, 'results.json'); await writeFile(output, JSON.stringify(evidence, null, 2));
    await writeFile(join(repository, `examples/react-web/qa-results-react-${reactVersion}.json`), JSON.stringify(evidence, null, 2));
    if (reactVersion === '19.3.0') await writeFile(join(repository, 'examples/react-web/qa-results.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({pass: evidence.pass, tests: results.resources, checks: results.checks, baseline: red.code ?? red.status,
      warnings: warnings.length, exceptions: exceptions.length, unexpectedCallbackErrors: results.errors, negativeTypes, example, output,
      failures: results.tests.filter(test => !test.pass).map(({name, error}) => ({name, error}))}, null, 2));
    return evidence;
  } finally {await browser?.close(); await new Promise(resolve => server.close(resolve));}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReactBrowserQA({reactVersion: process.argv.includes('--react18') ? '18.3.1' : '19.3.0'}).then(result => {if (!result.pass) process.exitCode = 1;}).catch(error => {console.error(error); process.exitCode = 1;});
}
