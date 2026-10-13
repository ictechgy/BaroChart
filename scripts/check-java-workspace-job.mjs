// Explicit ownership runtime check; importing this module or npm test never starts Java.
// Uses the production helper and an independent fake host, not Android/JNI/JSON stubs.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harnessClass = 'dev.aster.charts.WorkspaceRestoreJobHarness';
export const JAVA_WORKSPACE_JOB_SOURCES = Object.freeze([
    'native/android/java/dev/aster/charts/WorkspaceRestoreJob.java',
    'test/java-workspace-job/dev/aster/charts/WorkspaceRestoreJobHarness.java',
]);
export const JAVA_WORKSPACE_JOB_EXPECTED = Object.freeze({scenarios: 108, checks: 1635,
    unavailableOwnerScenarios: 1, unavailableOwnerChecks: 9});
export const JAVA_WORKSPACE_JOB_BOUNDARY = Object.freeze({
    evidence: 'Production package-private Java ownership state machine executed against independent fake Host',
    productionOwnershipRuntimeTested: true,
    adapterInitialEnqueueMethodExecuted: 'WorkspaceRestoreJob.enqueueInitial',
    realWorkerThreads: true,
    ownerScheduler: 'Bounded FIFO per owner; main thread except explicit two-owner budget-race scenario',
    concurrentBudgetOwnerThreads: 2,
    javaSourceLevel: 8,
    javaBytecodeTarget: 8,
    javaSE8ApiCompatibilityVerified: false,
    androidSDKCompiled: false,
    androidEngineHostExecuted: false,
    androidRuntimeExecuted: false,
    jniExecuted: false,
    nativeAllocatorExecuted: false,
    jsonRuntimeExecuted: false,
    performanceMeasured: false,
    unavailableOwnerCleanupSupported: false,
});

export function javaWorkspaceJobCompilerArguments(classes, empty, sources) {
    return ['-m', 'jdk.compiler/com.sun.tools.javac.Main',
        '-source', '8', '-target', '8', '-Xlint:all,-options', '-Werror',
        '-proc:none', '-implicit:none', '-encoding', 'UTF-8',
        '-classpath', empty, '-sourcepath', empty, '-d', classes, ...sources];
}

function runJava(java, args, timeout) {
    const result = spawnSync(java, args, {cwd: root, encoding: 'utf8', timeout,
        maxBuffer: 4 * 1024 * 1024});
    if (result.error || result.status !== 0) throw new Error(
        `Java workspace job check failed (${result.error?.message ?? result.signal ?? result.status}).\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    return {stdout: result.stdout, stderr: result.stderr};
}

async function hashes(paths) {
    const entries = [];
    for (const path of paths) entries.push([relative(root, path).split('\\').join('/'),
        createHash('sha256').update(await readFile(path)).digest('hex')]);
    return Object.fromEntries(entries);
}

async function classFiles(directory) {
    const result = [];
    for (const entry of await readdir(directory, {withFileTypes: true})) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in Java output');
        if (entry.isDirectory()) result.push(...await classFiles(path));
        else if (entry.isFile() && entry.name.endsWith('.class')) result.push(path);
    }
    return result.sort();
}

export function verifyWorkspaceJobOutput(stdout, stderr, expected = JAVA_WORKSPACE_JOB_EXPECTED) {
    if (stderr.trim()) throw new Error(`Unexpected Java runtime diagnostics, including possible uncaught worker exception:\n${stderr}`);
    const lines = stdout.trim().split(/\r?\n/);
    const summary = /^RESULT scenarios=(\d+) checks=(\d+) owner=main worker=real-thread$/.exec(lines.pop() ?? '');
    if (!summary || Number(summary[1]) !== expected.scenarios || Number(summary[2]) !== expected.checks)
        throw new Error(`Workspace scenario/check counts differ from fixed expected counts ${JSON.stringify(expected)}:\n${stdout}`);
    if (lines.length !== expected.scenarios || lines.some(line => !/^PASS [a-z0-9-]+$/.test(line)) || new Set(lines).size !== lines.length)
        throw new Error('Missing, duplicate or unexpected Java scenario result');
    return lines.map(line => line.slice(5));
}

export function verifyUnavailableOwnerOutput(stdout, stderr) {
    if (stderr.trim()) throw new Error(`Unexpected unavailable-owner diagnostics:\n${stderr}`);
    if (stdout.trim() !== `UNAVAILABLE_OWNER scenarios=${JAVA_WORKSPACE_JOB_EXPECTED.unavailableOwnerScenarios} checks=${JAVA_WORKSPACE_JOB_EXPECTED.unavailableOwnerChecks} terminal=false sourceRelease=false budgetRelease=false targetFreed=true`)
        throw new Error(`Unavailable-owner boundary changed and needs explicit review:\n${stdout}`);
}

export async function checkJavaWorkspaceJob({java = process.env.ASTER_JAVA ?? 'java'} = {}) {
    const temporary = await mkdtemp(join(tmpdir(), 'aster-java-workspace-job-'));
    try {
        const classes = join(temporary, 'classes'), empty = join(temporary, 'empty');
        await mkdir(classes); await mkdir(empty);
        const sources = JAVA_WORKSPACE_JOB_SOURCES.map(path => join(root, path));
        const before = await hashes(sources);
        const javaVersion = runJava(java, ['-version'], 15000);
        const compilerVersion = runJava(java, ['-m', 'jdk.compiler/com.sun.tools.javac.Main', '-version'], 15000);
        const compilerDiagnostics = runJava(java, javaWorkspaceJobCompilerArguments(classes, empty, sources), 60000);
        const compiled = await classFiles(classes);
        for (const path of compiled) {
            const bytes = await readFile(path);
            if (bytes.readUInt32BE(0) !== 0xcafebabe || bytes.readUInt16BE(6) !== 52) throw new Error(`Expected Java 8 bytecode: ${path}`);
        }
        const runtime = runJava(java, ['-ea', '-cp', classes, harnessClass], 60000);
        const scenarios = verifyWorkspaceJobOutput(runtime.stdout, runtime.stderr);
        // A fresh JVM isolates the intentionally unrecoverable owner-unavailable reservation.
        const unavailableOwner = runJava(java, ['-ea', '-cp', classes, harnessClass, '--unavailable-owner'], 15000);
        verifyUnavailableOwnerOutput(unavailableOwner.stdout, unavailableOwner.stderr);
        const after = await hashes(sources);
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('A Java source input changed during the check; rerun on a stable source checkpoint.');
        return {
            schema: 'aster.java-workspace-job-ownership', version: 1,
            ...JAVA_WORKSPACE_JOB_BOUNDARY,
            javaVersion: (javaVersion.stdout + javaVersion.stderr).trim(),
            compiler: (compilerVersion.stdout + compilerVersion.stderr).trim(),
            productionSourcesExecuted: [JAVA_WORKSPACE_JOB_SOURCES[0]],
            harnessSources: [JAVA_WORKSPACE_JOB_SOURCES[1]],
            sourceSHA256: before,
            runnerSHA256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
            ...JAVA_WORKSPACE_JOB_EXPECTED,
            passedScenarios: scenarios,
            unavailableOwner: {terminal: false, sourceReleased: false, budgetReleased: false,
                targetFreed: true, isolatedProcess: true,
                limitation: 'If all owner posts are permanently rejected, the worker can free its unpublished target but cannot release owner-only source ownership, clear reservations or deliver terminal completion. This is observed pending cleanup, not a successful cleanup claim.'},
            generatedClassCount: compiled.length,
            compilerDiagnostics, warningsAsErrors: true, suppressedLintCategories: ['options'],
            timeoutsMillis: {version: 15000, compile: 60000, ownership: 60000, unavailableOwner: 15000},
            temporaryOutputRemoved: true,
        };
    } finally {
        await rm(temporary, {recursive: true, force: true});
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/check-java-workspace-job.mjs (optional ASTER_JAVA=/path/to/java)');
    console.log(JSON.stringify(await checkJavaWorkspaceJob(), null, 2));
}
