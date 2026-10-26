// Optional compiler-module/runtime check. Importing this module and npm test never start Java.
// Only the production nested layout decoder executes; Android/JNI is excluded.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harnessClass = 'dev.aster.charts.LayoutReceiptTest';
export const JAVA_LAYOUT_PRODUCTION_SOURCES = Object.freeze([
    'native/android/java/dev/aster/charts/AsterEngine.java',
    'native/android/java/dev/aster/charts/AsterColumns.java',
    'native/android/java/dev/aster/charts/WorkspaceRestoreJob.java',
    'native/android/java/dev/aster/charts/NativeJobBudget.java',
    'native/android/java/dev/aster/charts/ParamsUpdateJob.java',
]);
export const JAVA_LAYOUT_HARNESS = 'test/java-layout-receipt/dev/aster/charts/LayoutReceiptTest.java';
export const JAVA_LAYOUT_JSON_FIXTURE = 'test/java-layout-receipt/org/json/JSONObject.java';
export const JAVA_LAYOUT_EXPECTED = Object.freeze({scenarios: 19, checks: 32});
export const JAVA_LAYOUT_SCENARIOS = Object.freeze([
    'panel-order-false', 'panel-order-true', 'panel-order-null', 'panel-order-number', 'panel-order-string',
    'placement-zero', 'placement-one', 'placement-upper-bound', 'placement-double-upper-bound',
    'placement-missing', 'placement-null', 'placement-boolean', 'placement-string',
    'placement-negative', 'placement-fraction', 'placement-upper-bound-plus-one',
    'placement-infinity', 'placement-nan', 'placement-subnormal',
]);
export const JAVA_LAYOUT_BOUNDARY = Object.freeze({
    evidence: 'Production nested layout receipt decoder executed with a test-only JSONObject fixture; full Engine typechecked against compile-only Android/org.json signatures',
    productionDecoderRuntimeTested: true,
    productionDecoderMethodsExecuted: ['AsterEngine.LayoutReceipt.panelOrder', 'AsterEngine.LayoutReceipt.indicatorPlacement'],
    javaSourceLevel: 8,
    javaBytecodeTarget: 8,
    javaSE8ApiCompatibilityVerified: false,
    androidSDKCompiled: false,
    androidEngineClassInitialized: false,
    androidEngineHostExecuted: false,
    androidRuntimeExecuted: false,
    jniExecuted: false,
    jsonRuntimeExecuted: false,
    jsonFixtureExecuted: true,
    ownerThreadBehaviorTested: false,
    observerNotificationsRuntimeTested: false,
    nativeLayoutCommandsExecuted: false,
    performanceMeasured: false,
});

export function javaLayoutCompilerArguments(classes, empty, sources) {
    return ['-m', 'jdk.compiler/com.sun.tools.javac.Main',
        '-source', '8', '-target', '8', '-Xlint:all,-options', '-Werror',
        '-proc:none', '-implicit:none', '-encoding', 'UTF-8',
        '-classpath', empty, '-sourcepath', empty, '-d', classes, ...sources];
}

function runJava(java, args, timeout) {
    const result = spawnSync(java, args, {cwd: root, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024});
    if (result.error || result.status !== 0) throw new Error(
        `Java layout notification check failed (${result.error?.message ?? result.signal ?? result.status}).\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    return {stdout: result.stdout, stderr: result.stderr};
}

async function filesIn(directory, suffix) {
    const paths = [];
    for (const entry of await readdir(directory, {withFileTypes: true})) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link in Java check: ${path}`);
        if (entry.isDirectory()) paths.push(...await filesIn(path, suffix));
        else if (entry.isFile() && entry.name.endsWith(suffix)) paths.push(path);
    }
    return paths.sort();
}

async function sourceHashes(paths) {
    const entries = [];
    for (const path of paths) entries.push([relative(root, path).split('\\').join('/'),
        createHash('sha256').update(await readFile(path)).digest('hex')]);
    return Object.fromEntries(entries);
}

export function verifyJavaLayoutOutput(stdout, stderr) {
    if (stderr.trim()) throw new Error(`Unexpected decoder runtime diagnostics:\n${stderr}`);
    const lines = stdout.trim().split(/\r?\n/);
    const summary = /^RESULT scenarios=(\d+) checks=(\d+) scope=layout-notification-receipt-decoder$/.exec(lines.pop() ?? '');
    if (!summary || Number(summary[1]) !== JAVA_LAYOUT_EXPECTED.scenarios || Number(summary[2]) !== JAVA_LAYOUT_EXPECTED.checks)
        throw new Error(`Decoder scenario/check counts differ from fixed expected counts ${JSON.stringify(JAVA_LAYOUT_EXPECTED)}:\n${stdout}`);
    if (lines.length !== JAVA_LAYOUT_SCENARIOS.length || lines.some((line, index) => line !== `PASS ${JAVA_LAYOUT_SCENARIOS[index]}`))
        throw new Error('Missing, duplicate, reordered or unexpected decoder scenario result');
    return [...JAVA_LAYOUT_SCENARIOS];
}

export function verifyJavaLayoutInitialization(trace) {
    const initialized = [...trace.matchAll(/\bInitializing '([^']+)'/g)].map(match => match[1]);
    const production = initialized.filter(name => name.startsWith('dev/aster/charts/'));
    const harness = harnessClass.replaceAll('.', '/');
    const decoders = ['dev/aster/charts/AsterEngine$LayoutReceipt'];
    for (const decoder of decoders) if (!production.includes(decoder)) throw new Error(`Class initialization trace did not observe ${decoder}`);
    for (const name of production) if (!decoders.includes(name) && name !== harness)
        throw new Error(`Unexpected production host/helper class initialized: ${name}`);
    const android = initialized.filter(name => name.startsWith('android/'));
    if (android.length) throw new Error(`Compile-only Android signatures were initialized: ${android.join(', ')}`);
    const json = initialized.filter(name => name.startsWith('org/json/'));
    if (json.length !== 2 || !json.includes('org/json/JSONException') || !json.includes('org/json/JSONObject'))
        throw new Error(`Expected only layout fixture JSON classes, not: ${json.join(', ')}`);
    return {initializedProductionClasses: production.filter(name => name !== harness),
        initializedAndroidClasses: android, initializedJsonClasses: json};
}

export async function checkJavaLayoutNotifications({java = process.env.ASTER_JAVA ?? 'java'} = {}) {
    const temporary = await mkdtemp(join(tmpdir(), 'aster-java-layout-notifications-'));
    try {
        const classes = join(temporary, 'classes'), empty = join(temporary, 'empty');
        const tracePath = join(temporary, 'class-initialization.log');
        await mkdir(classes); await mkdir(empty);
        const hostStubs = (await filesIn(join(root, 'test/java-host-stubs'), '.java'))
            .filter(path => !path.endsWith('/org/json/JSONObject.java'));
        const fixture = join(root, JAVA_LAYOUT_JSON_FIXTURE);
        const sources = [...JAVA_LAYOUT_PRODUCTION_SOURCES.map(path => join(root, path)),
            ...hostStubs, fixture, join(root, JAVA_LAYOUT_HARNESS)];
        const runnerPath = fileURLToPath(import.meta.url);
        const before = await sourceHashes([...sources, runnerPath]);
        const javaVersion = runJava(java, ['-version'], 15000);
        const compiler = runJava(java, ['-m', 'jdk.compiler/com.sun.tools.javac.Main', '-version'], 15000);
        const compilerDiagnostics = runJava(java, javaLayoutCompilerArguments(classes, empty, sources), 60000);
        const compiled = await filesIn(classes, '.class');
        for (const path of compiled) {
            const bytes = await readFile(path);
            if (bytes.readUInt32BE(0) !== 0xcafebabe || bytes.readUInt16BE(6) !== 52) throw new Error(`Expected Java 8 bytecode: ${path}`);
        }
        for (const name of ['AsterEngine', 'AsterEngine$LayoutReceipt', 'AsterColumns', 'WorkspaceRestoreJob', 'LayoutReceiptTest'])
            await readFile(join(classes, 'dev/aster/charts', `${name}.class`));
        await readFile(join(classes, 'org/json/JSONObject.class'));
        const runtime = runJava(java, ['-ea', `-Djava.library.path=${empty}`,
            `-Xlog:class+init=info:file=${tracePath}`, '-cp', classes, harnessClass], 15000);
        const passedScenarios = verifyJavaLayoutOutput(runtime.stdout, runtime.stderr);
        const classInitializationTrace = await readFile(tracePath, 'utf8');
        const initialization = verifyJavaLayoutInitialization(classInitializationTrace);
        const after = await sourceHashes([...sources, runnerPath]);
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('A Java input or runner changed during the check; rerun against a stable source checkpoint.');
        const runnerSHA256 = before[relative(root, runnerPath).split('\\').join('/')];
        delete before[relative(root, runnerPath).split('\\').join('/')];
        return {schema: 'aster.java-layout-notification-receipt', version: 1, ...JAVA_LAYOUT_BOUNDARY,
            javaVersion: (javaVersion.stdout + javaVersion.stderr).trim(),
            compiler: (compiler.stdout + compiler.stderr).trim(),
            productionSourcesCompiled: [...JAVA_LAYOUT_PRODUCTION_SOURCES],
            harnessSources: [JAVA_LAYOUT_HARNESS, JAVA_LAYOUT_JSON_FIXTURE], sourceSHA256: before, runnerSHA256,
            ...JAVA_LAYOUT_EXPECTED, passedScenarios, ...initialization,
            generatedClassCount: compiled.length, allGeneratedClassesJava8Bytecode: true,
            compilerDiagnostics, runtimeDiagnostics: {stdout: runtime.stdout, stderr: runtime.stderr, classInitializationTrace},
            warningsAsErrors: true, suppressedLintCategories: ['options'],
            nativeLibrarySearchPath: 'isolated empty directory',
            timeoutsMillis: {version: 15000, compile: 60000, decoder: 15000}, temporaryOutputRemoved: true};
    } finally {
        await rm(temporary, {recursive: true, force: true});
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/check-java-layout-notifications.mjs (optional ASTER_JAVA=/path/to/java)');
    console.log(JSON.stringify(await checkJavaLayoutNotifications(), null, 2));
}
