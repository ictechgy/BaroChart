// Optional compiler-module/runtime check. Importing this module and npm test never start Java.
// The production nested receipt decoder executes with test-only checked-exception/NULL signatures.
// Android/JNI and JSON parsing, serialization and container methods are never executed.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harnessClass = 'dev.aster.charts.DrawingTranslationReceiptTest';
export const JAVA_DRAWING_TRANSLATION_PRODUCTION_SOURCES = Object.freeze([
    'native/android/java/dev/aster/charts/AsterEngine.java',
    'native/android/java/dev/aster/charts/AsterColumns.java',
    'native/android/java/dev/aster/charts/WorkspaceRestoreJob.java',
    'native/android/java/dev/aster/charts/NativeJobBudget.java',
    'native/android/java/dev/aster/charts/ParamsUpdateJob.java',
]);
export const JAVA_DRAWING_TRANSLATION_HARNESS = 'test/java-drawing-translation-receipt/dev/aster/charts/DrawingTranslationReceiptTest.java';
export const JAVA_DRAWING_TRANSLATION_EXPECTED = Object.freeze({scenarios: 65, checks: 103});
export const JAVA_DRAWING_TRANSLATION_SCENARIOS = Object.freeze([
    'integer-zero', 'long-zero', 'double-zero', 'double-negative-zero',
    'integer-one', 'long-one', 'double-one',
    'integer-positive', 'long-positive', 'double-positive',
    'integer-upper-minus-one', 'long-upper-minus-one', 'double-upper-minus-one',
    'integer-upper-bound', 'long-upper-bound', 'double-upper-bound',
    'byte-zero', 'byte-one', 'byte-upper-minus-one', 'short-zero', 'short-one', 'short-upper-bound',
    'float-zero', 'float-one', 'float-upper-minus-one', 'float-upper-bound', 'float-negative-zero',
    'null', 'json-null-sentinel', 'boolean-false', 'boolean-true', 'string-zero', 'string-one',
    'string-maximum', 'string-fraction', 'object', 'character', 'array',
    'integer-negative', 'long-negative', 'double-negative', 'double-negative-fraction',
    'double-negative-subnormal', 'integer-above-bound', 'long-above-bound', 'double-above-bound',
    'short-above-bound', 'float-above-bound', 'float-half',
    'long-maximum', 'long-minimum', 'integer-maximum', 'integer-minimum', 'double-maximum',
    'double-nan', 'double-positive-infinity', 'double-negative-infinity',
    'float-nan', 'float-positive-infinity', 'float-negative-infinity',
    'double-half', 'double-one-and-half', 'double-upper-minus-half', 'double-upper-plus-half',
    'double-positive-subnormal',
]);
export const JAVA_DRAWING_TRANSLATION_BOUNDARY = Object.freeze({
    evidence: 'Production nested receipt decoder executed; full Engine typechecked against test-only Android/org.json signatures; JSONObject initializes only its opaque NULL placeholder',
    productionDecoderRuntimeTested: true,
    productionDecoderMethodExecuted: 'AsterEngine.DrawingTranslationReceipt.changed',
    javaSourceLevel: 8,
    javaBytecodeTarget: 8,
    javaSE8ApiCompatibilityVerified: false,
    androidSDKCompiled: false,
    androidEngineClassInitialized: false,
    androidEngineHostExecuted: false,
    androidRuntimeExecuted: false,
    jniExecuted: false,
    jsonRuntimeExecuted: false,
    jsonExceptionSignatureExecuted: true,
    jsonNullSentinelSignatureExecuted: true,
    jsonContainerMethodsExecuted: false,
    ownerThreadBehaviorTested: false,
    observerNotificationsRuntimeTested: false,
    nativeDrawingTranslationExecuted: false,
    performanceMeasured: false,
});

export function javaDrawingTranslationCompilerArguments(classes, empty, sources) {
    return ['-m', 'jdk.compiler/com.sun.tools.javac.Main',
        '-source', '8', '-target', '8', '-Xlint:all,-options', '-Werror',
        '-proc:none', '-implicit:none', '-encoding', 'UTF-8',
        '-classpath', empty, '-sourcepath', empty, '-d', classes, ...sources];
}

function runJava(java, args, timeout) {
    const result = spawnSync(java, args, {cwd: root, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024});
    if (result.error || result.status !== 0) throw new Error(
        `Java drawing translation receipt check failed (${result.error?.message ?? result.signal ?? result.status}).\n${result.stdout ?? ''}${result.stderr ?? ''}`);
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

export function verifyJavaDrawingTranslationOutput(stdout, stderr) {
    if (stderr.trim()) throw new Error(`Unexpected decoder runtime diagnostics:\n${stderr}`);
    const lines = stdout.trim().split(/\r?\n/);
    const summary = /^RESULT scenarios=(\d+) checks=(\d+) scope=drawing-translation-receipt-decoder$/.exec(lines.pop() ?? '');
    if (!summary || Number(summary[1]) !== JAVA_DRAWING_TRANSLATION_EXPECTED.scenarios || Number(summary[2]) !== JAVA_DRAWING_TRANSLATION_EXPECTED.checks)
        throw new Error(`Decoder scenario/check counts differ from fixed expected counts ${JSON.stringify(JAVA_DRAWING_TRANSLATION_EXPECTED)}:\n${stdout}`);
    if (lines.length !== JAVA_DRAWING_TRANSLATION_SCENARIOS.length || lines.some((line, index) => line !== `PASS ${JAVA_DRAWING_TRANSLATION_SCENARIOS[index]}`))
        throw new Error('Missing, duplicate, reordered or unexpected decoder scenario result');
    return [...JAVA_DRAWING_TRANSLATION_SCENARIOS];
}

export function verifyJavaDrawingTranslationInitialization(trace) {
    const initialized = [...trace.matchAll(/\bInitializing '([^']+)'/g)].map(match => match[1]);
    const production = initialized.filter(name => name.startsWith('dev/aster/charts/'));
    const decoder = 'dev/aster/charts/AsterEngine$DrawingTranslationReceipt';
    if (!production.includes(decoder)) throw new Error('Class initialization trace did not observe the production nested decoder');
    for (const name of production) if (name !== decoder && name !== harnessClass.replaceAll('.', '/'))
        throw new Error(`Unexpected production host/helper class initialized: ${name}`);
    const android = initialized.filter(name => name.startsWith('android/'));
    if (android.length) throw new Error(`Compile-only Android signatures were initialized: ${android.join(', ')}`);
    const json = initialized.filter(name => name.startsWith('org/json/'));
    if (json.length !== 2 || !json.includes('org/json/JSONException') || !json.includes('org/json/JSONObject'))
        throw new Error(`Expected only checked exception and NULL placeholder signatures, not a JSON runtime: ${json.join(', ')}`);
    return {initializedProductionClasses: production.filter(name => name !== harnessClass.replaceAll('.', '/')),
        initializedAndroidClasses: android, initializedJsonClasses: json};
}

export async function checkJavaDrawingTranslation({java = process.env.ASTER_JAVA ?? 'java'} = {}) {
    const temporary = await mkdtemp(join(tmpdir(), 'aster-java-drawing-translation-'));
    try {
        const classes = join(temporary, 'classes'), empty = join(temporary, 'empty');
        const tracePath = join(temporary, 'class-initialization.log');
        await mkdir(classes); await mkdir(empty);
        const sources = [...JAVA_DRAWING_TRANSLATION_PRODUCTION_SOURCES.map(path => join(root, path)),
            ...await filesIn(join(root, 'test/java-host-stubs'), '.java'), join(root, JAVA_DRAWING_TRANSLATION_HARNESS)];
        const runnerPath = fileURLToPath(import.meta.url);
        const before = await sourceHashes([...sources, runnerPath]);
        const javaVersion = runJava(java, ['-version'], 15000);
        const compiler = runJava(java, ['-m', 'jdk.compiler/com.sun.tools.javac.Main', '-version'], 15000);
        const compilerDiagnostics = runJava(java, javaDrawingTranslationCompilerArguments(classes, empty, sources), 60000);
        const compiled = await filesIn(classes, '.class');
        for (const path of compiled) {
            const bytes = await readFile(path);
            if (bytes.readUInt32BE(0) !== 0xcafebabe || bytes.readUInt16BE(6) !== 52) throw new Error(`Expected Java 8 bytecode: ${path}`);
        }
        for (const name of ['AsterEngine', 'AsterEngine$DrawingTranslationReceipt', 'AsterColumns', 'WorkspaceRestoreJob', 'DrawingTranslationReceiptTest'])
            await readFile(join(classes, 'dev/aster/charts', `${name}.class`));
        // Empty native-library lookup + class-init tracing guard against accidentally running Engine.
        const runtime = runJava(java, ['-ea', `-Djava.library.path=${empty}`,
            `-Xlog:class+init=info:file=${tracePath}`, '-cp', classes, harnessClass], 15000);
        const passedScenarios = verifyJavaDrawingTranslationOutput(runtime.stdout, runtime.stderr);
        const classInitializationTrace = await readFile(tracePath, 'utf8');
        const initialization = verifyJavaDrawingTranslationInitialization(classInitializationTrace);
        const after = await sourceHashes([...sources, runnerPath]);
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('A Java input or runner changed during the check; rerun against a stable source checkpoint.');
        const runnerSHA256 = before[relative(root, runnerPath).split('\\').join('/')];
        delete before[relative(root, runnerPath).split('\\').join('/')];
        return {schema: 'aster.java-drawing-translation-receipt', version: 1, ...JAVA_DRAWING_TRANSLATION_BOUNDARY,
            javaVersion: (javaVersion.stdout + javaVersion.stderr).trim(),
            compiler: (compiler.stdout + compiler.stderr).trim(),
            productionSourcesCompiled: [...JAVA_DRAWING_TRANSLATION_PRODUCTION_SOURCES],
            harnessSources: [JAVA_DRAWING_TRANSLATION_HARNESS], sourceSHA256: before, runnerSHA256,
            ...JAVA_DRAWING_TRANSLATION_EXPECTED, passedScenarios, ...initialization,
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
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/check-java-drawing-translation.mjs (optional ASTER_JAVA=/path/to/java)');
    console.log(JSON.stringify(await checkJavaDrawingTranslation(), null, 2));
}
