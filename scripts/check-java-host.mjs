// Explicit optional compiler check. Importing this module and npm test do not run Java.
// This is not an Android SDK build or a JNI/runtime test.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const JAVA_HOST_PRODUCTION_SOURCES = Object.freeze([
    'native/android/java/kr/coden/barochart/BaroChartEngine.java',
    'native/android/java/kr/coden/barochart/BaroChartColumns.java',
        'native/android/java/kr/coden/barochart/WorkspaceRestoreJob.java',
    'native/android/java/kr/coden/barochart/NativeJobBudget.java',
    'native/android/java/kr/coden/barochart/ParamsUpdateJob.java',
]);
/**
 * 엔진이 참조하는 타입 API 파일(값 타입·BaroChartException 등)과 androidx.annotation 컴파일 스텁.
 * 호스트 JVM 검사는 Android UI 타입(View·Bitmap 풀)을 스텁하지 않으므로 그 둘은 뺀다.
 * @param {string} root 저장소 루트
 * @param {string[]} already 이미 목록에 있는 소스(중복 클래스 방지)
 * @returns {Promise<string[]>} 절대 경로 목록
 */
export async function javaTypedApiSources(root, already) {
    const dir = join(root, 'native/android/java/kr/coden/barochart');
    const skip = new Set(['BaroChartView.java', 'BaroChartBitmapCachePool.java', ...already.map(path => path.split('/').at(-1))]);
    const typed = (await readdir(dir)).filter(name => name.endsWith('.java') && !skip.has(name)).sort().map(name => join(dir, name));
    const stubs = join(root, 'native/android/annotation-stubs/androidx/annotation');
    return [...typed, join(stubs, 'NonNull.java'), join(stubs, 'Nullable.java')];
}
export const JAVA_HOST_BOUNDARY = Object.freeze({
    evidence: 'Java typecheck against independent compile-only signatures',
    javaSourceLevel: 8,
    javaBytecodeTarget: 8,
    javaSE8ApiCompatibilityVerified: false,
    androidSDKCompiled: false,
    androidRuntimeExecuted: false,
    jniExecuted: false,
    ownershipRuntimeTested: false,
});

async function filesIn(directory, suffix) {
    const files = [];
    for (const entry of await readdir(directory, {withFileTypes: true})) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Symbolic link is not a host-check input: ${path}`);
        if (entry.isDirectory()) files.push(...await filesIn(path, suffix));
        else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
    }
    return files.sort();
}

export function javaHostCompilerArguments(classes, empty, sources) {
    return ['-m', 'jdk.compiler/com.sun.tools.javac.Main',
        '-source', '8', '-target', '8', '-Xlint:all,-options', '-Werror',
        '-proc:none', '-implicit:none', '-encoding', 'UTF-8',
        '-classpath', empty, '-sourcepath', empty, '-d', classes, ...sources];
}

function javaRun(java, args) {
    const result = spawnSync(java, args, {cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024});
    if (result.error || result.status !== 0) {
        throw new Error(`Java host check failed (${result.error?.message ?? result.signal ?? result.status}).\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    }
    return {stdout: result.stdout, stderr: result.stderr};
}

async function sourceHashes(paths) {
    const entries = [];
    for (const path of paths) entries.push([relative(root, path).split('\\').join('/'),
        createHash('sha256').update(await readFile(path)).digest('hex')]);
    return Object.fromEntries(entries);
}

export async function checkJavaHost({java = process.env.ASTER_JAVA ?? 'java'} = {}) {
    const temporary = await mkdtemp(join(tmpdir(), 'aster-java-host-'));
    try {
        const classes = join(temporary, 'classes'), empty = join(temporary, 'empty');
        await mkdir(classes); await mkdir(empty);
        const sources = [...JAVA_HOST_PRODUCTION_SOURCES.map(path => join(root, path)), ...await javaTypedApiSources(root, JAVA_HOST_PRODUCTION_SOURCES),
            ...await filesIn(join(root, 'test/java-host-stubs'), '.java'),
            ...await filesIn(join(root, 'test/java-host-consumers'), '.java')];
        const before = await sourceHashes(sources);
        const version = javaRun(java, ['-m', 'jdk.compiler/com.sun.tools.javac.Main', '-version']);
        const diagnostics = javaRun(java, javaHostCompilerArguments(classes, empty, sources));
        const after = await sourceHashes(sources);
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('A Java input changed during compilation; rerun against a stable source checkpoint.');
        const compiled = await filesIn(classes, '.class');
        for (const name of ['BaroChartEngine', 'BaroChartEngine$AsyncJob', 'BaroChartEngine$WorkspaceJob', 'WorkspaceRestoreJob', 'BaroChartColumns']) {
            const bytes = await readFile(join(classes, 'kr/coden/barochart', name + '.class'));
            if (bytes.readUInt32BE(0) !== 0xcafebabe || bytes.readUInt16BE(6) !== 52) throw new Error(`Unexpected Java 8 class output: ${name}`);
        }
        return {schema: 'aster.java-host-compile', version: 1, compiler: (version.stdout + version.stderr).trim(),
            ...JAVA_HOST_BOUNDARY, productionSourcesCompiled: [...JAVA_HOST_PRODUCTION_SOURCES],
            sourceSHA256: before, generatedClassCount: compiled.length,
            compilerDiagnostics: diagnostics, warningsAsErrors: true,
            suppressedLintCategories: ['options'],
            temporaryOutputRemoved: true};
    } finally {
        await rm(temporary, {recursive: true, force: true});
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/check-java-host.mjs (optional ASTER_JAVA=/path/to/java)');
    console.log(JSON.stringify(await checkJavaHost(), null, 2));
}
