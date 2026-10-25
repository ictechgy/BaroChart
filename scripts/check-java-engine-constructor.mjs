// Explicit host harness for the production AsterEngine constructor. It is not
// part of npm test because it requires a JDK and executes generated Java.
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PRODUCTION_SOURCE = 'native/android/java/dev/aster/charts/AsterEngine.java';
const constructorSignature = 'public AsterEngine(Context context,int count,JSONObject options) throws IOException,JSONException {';

export function extractConstructor(source) {
    const start = source.indexOf(constructorSignature);
    if (start < 0) throw new Error('AsterEngine constructor signature not found');
    const open = source.indexOf('{', start + constructorSignature.length - 1);
    let depth = 0;
    for (let index = open; index < source.length; index++) {
        if (source[index] === '{') depth++;
        else if (source[index] === '}' && --depth === 0) return source.slice(open + 1, index);
    }
    throw new Error('AsterEngine constructor body is unbalanced');
}

export function renderHarness(constructorBody) {
    const body = constructorBody.replace(/^/gm, '        ');
    return `import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

public final class ConstructorSourceHarness {
    private static int created;
    private static int freed;
    private static boolean failFree;
    private static Failure failure = Failure.NONE;

    private enum Failure { NONE, CHECKED, RUNTIME, ERROR, OOM }

    private static final class CloseFailure extends ByteArrayInputStream {
        CloseFailure() { super(new byte[] {65}); }
        @Override public void close() throws IOException { throw new IOException("asset close failure"); }
    }

    private static final class Assets {
        private final InputStream input;
        Assets(InputStream input) { this.input = input; }
        InputStream open(String name) throws IOException {
            if (!"aster-core.js".equals(name)) throw new IOException("unexpected asset");
            return input;
        }
    }

    private static final class Context {
        private final Assets assets;
        Context(InputStream input) { assets = new Assets(input); }
        Assets getAssets() { return assets; }
    }

    private static final class JSONObject {
        static final Object NULL = new Object();
    }

    private static final class JSONException extends Exception {
        private static final long serialVersionUID = 1L;
        JSONException(String message) { super(message); }
    }

    private long handle;
    private final String sourceBundle;

    ConstructorSourceHarness(Context context,int count,JSONObject options) throws IOException,JSONException {
${body}
    }

    private static long create(String source) {
        if (!"A".equals(source)) throw new AssertionError("unexpected source");
        return ++created;
    }

    private Object invoke(String name,Object... args) throws JSONException {
        if (!"nativeInit".equals(name)) throw new IllegalArgumentException("unexpected native call");
        switch (failure) {
            case CHECKED: throw new JSONException("native init failure");
            case RUNTIME: throw new IllegalStateException("native init runtime failure");
            case ERROR: throw new AssertionError("native init error failure");
            case OOM: throw new OutOfMemoryError("native init oom failure");
            default: return null;
        }
    }

    private static void free(long ignored) {
        ++freed;
        if (failFree) throw new IllegalStateException("free failure");
    }

    private static void require(boolean condition,String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) throws Throwable {
        int baselineCreated = created, baselineFreed = freed;
        failure = Failure.NONE;
        try { new ConstructorSourceHarness(new Context(new CloseFailure()), 1, null); }
        catch (IOException expected) {}
        require(created == baselineCreated && freed == baselineFreed,
            "asset close failure must happen before native create");

        for (Failure next : new Failure[] {Failure.CHECKED, Failure.RUNTIME, Failure.ERROR, Failure.OOM}) {
            failure = next;
            try { new ConstructorSourceHarness(new Context(new ByteArrayInputStream(new byte[] {65})), 1, null); }
            catch (Throwable expected) {}
            require(created == freed, "post-create failure leaked for " + next);
        }

        failure = Failure.RUNTIME;
        failFree = true;
        try { new ConstructorSourceHarness(new Context(new ByteArrayInputStream(new byte[] {65})), 1, null); }
        catch (IllegalStateException primary) {
            require("native init runtime failure".equals(primary.getMessage()), "primary init error was replaced");
            require(primary.getSuppressed().length == 1, "cleanup failure was not suppressed");
        }
        require(created == freed, "cleanup failure changed ownership accounting");

        failure = Failure.NONE;
        failFree = false;
        ConstructorSourceHarness success = new ConstructorSourceHarness(
            new Context(new ByteArrayInputStream(new byte[] {65})), 1, null);
        require(success.handle != 0 && "A".equals(success.sourceBundle), "successful initialization changed state");
        System.out.println("constructor source checks=7 created=" + created + " freed=" + freed);
    }
}
`;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...options});
    if (result.error || result.status !== 0) {
        throw new Error(`${command} failed (${result.error?.message ?? result.signal ?? result.status}).\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    }
    return result;
}

export async function checkJavaEngineConstructor({java = process.env.ASTER_JAVA ?? 'java', source = join(root, PRODUCTION_SOURCE)} = {}) {
    const javac = process.env.ASTER_JAVAC ?? join(dirname(java), 'javac');
    const output = await mkdtemp(join(tmpdir(), 'aster-java-engine-constructor-'));
    try {
        const sourceText = await readFile(source, 'utf8');
        const generated = join(output, 'ConstructorSourceHarness.java');
        await writeFile(generated, renderHarness(extractConstructor(sourceText)));
        run(javac, ['-source', '8', '-target', '8', '-Xlint:all,-options', '-Werror', '-d', output, generated]);
        const result = run(java, ['-cp', output, 'ConstructorSourceHarness']);
        if (!/constructor source checks=7 created=6 freed=5/.test(result.stdout)) throw new Error(`Unexpected harness result: ${result.stdout}`);
        return {source, java, javac, output: result.stdout.trim(), generatedSource: generated};
    } finally {
        await rm(output, {recursive: true, force: true});
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const sourceIndex = process.argv.indexOf('--source');
    const source = sourceIndex >= 0 ? resolve(process.argv[sourceIndex + 1]) : join(root, PRODUCTION_SOURCE);
    const javaIndex = process.argv.indexOf('--java');
    const java = javaIndex >= 0 ? process.argv[javaIndex + 1] : process.env.ASTER_JAVA ?? 'java';
    console.log(JSON.stringify(await checkJavaEngineConstructor({java, source}), null, 2));
}
