import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JAVA_COMPACTION_BOUNDARY, JAVA_COMPACTION_EXPECTED, JAVA_COMPACTION_HARNESS,
    JAVA_COMPACTION_PRODUCTION_SOURCES, JAVA_COMPACTION_SCENARIOS,
    javaCompactionCompilerArguments, verifyJavaCompactionOutput,
    verifyJavaCompactionInitialization} from '../scripts/check-java-compaction.mjs';

// Node-only source/runner contract tests. npm test never compiles or executes Java.
const validOutput = JAVA_COMPACTION_SCENARIOS.map(name => `PASS ${name}`).join('\n')
    + '\nRESULT scenarios=58 checks=92 scope=nested-receipt-decoder\n';
const initializationTrace = [
    "[0.031s][info][class,init] 100 Initializing 'dev/aster/charts/CompactionReceiptTest' (0x00000000)",
    "[0.032s][info][class,init] 101 Initializing 'dev/aster/charts/AsterEngine$CompactionReceipt'(no method) (0x00000000)",
    "[0.033s][info][class,init] 102 Initializing 'org/json/JSONException'(no method) (0x00000000)",
].join('\n');

test('Java compaction evidence distinguishes the actual decoder from compile-only host signatures', () => {
    assert.equal(JAVA_COMPACTION_BOUNDARY.productionDecoderRuntimeTested, true);
    assert.equal(JAVA_COMPACTION_BOUNDARY.productionDecoderMethodExecuted, 'AsterEngine.CompactionReceipt.changed');
    assert.equal(JAVA_COMPACTION_BOUNDARY.javaSourceLevel, 8);
    assert.equal(JAVA_COMPACTION_BOUNDARY.javaBytecodeTarget, 8);
    assert.equal(JAVA_COMPACTION_BOUNDARY.jsonExceptionSignatureExecuted, true);
    for (const key of ['javaSE8ApiCompatibilityVerified', 'androidSDKCompiled', 'androidEngineClassInitialized',
        'androidEngineHostExecuted', 'androidRuntimeExecuted', 'jniExecuted', 'jsonRuntimeExecuted',
        'ownerThreadBehaviorTested', 'observerNotificationsRuntimeTested', 'nativeCompactionExecuted',
        'performanceMeasured']) assert.equal(JAVA_COMPACTION_BOUNDARY[key], false, key);
    assert.deepEqual(JAVA_COMPACTION_PRODUCTION_SOURCES, [
        'native/android/java/dev/aster/charts/AsterEngine.java',
        'native/android/java/dev/aster/charts/AsterColumns.java',
        'native/android/java/dev/aster/charts/WorkspaceRestoreJob.java',
    ]);
    assert.equal(JAVA_COMPACTION_HARNESS, 'test/java-compaction-receipt/dev/aster/charts/CompactionReceiptTest.java');
});

test('Java compaction compiler uses warnings-as-errors and explicit isolated Java 8 inputs', () => {
    const sources = ['/repo/native/AsterEngine.java', '/repo/test/CompactionReceiptTest.java'];
    assert.deepEqual(javaCompactionCompilerArguments('/tmp/classes', '/tmp/empty', sources), [
        '-m', 'jdk.compiler/com.sun.tools.javac.Main', '-source', '8', '-target', '8',
        '-Xlint:all,-options', '-Werror', '-proc:none', '-implicit:none', '-encoding', 'UTF-8',
        '-classpath', '/tmp/empty', '-sourcepath', '/tmp/empty', '-d', '/tmp/classes', ...sources,
    ]);
});

test('Java compaction result requires the complete fixed scenario list and assertion count', () => {
    assert.deepEqual(JAVA_COMPACTION_EXPECTED, {scenarios: 58, checks: 92});
    assert.equal(JAVA_COMPACTION_SCENARIOS.length, 58);
    assert.equal(new Set(JAVA_COMPACTION_SCENARIOS).size, 58);
    assert.deepEqual(verifyJavaCompactionOutput(validOutput, ''), JAVA_COMPACTION_SCENARIOS);
    assert.deepEqual(verifyJavaCompactionOutput(validOutput.replaceAll('\n', '\r\n'), ''), JAVA_COMPACTION_SCENARIOS);
});

test('Java compaction result rejects incomplete, duplicate, unexpected or diagnostic-bearing evidence', () => {
    for (const output of [
        '', validOutput.replace('scenarios=58', 'scenarios=57'), validOutput.replace('checks=92', 'checks=91'),
        validOutput.replace('PASS integer-zero\n', ''),
        validOutput.replace('PASS long-zero', 'PASS integer-zero'),
        validOutput.replace('PASS integer-zero\nPASS long-zero', 'PASS long-zero\nPASS integer-zero'),
        validOutput.replace('PASS integer-zero', 'PASS unknown'),
        validOutput.replace('scope=nested-receipt-decoder', 'scope=android-runtime'),
        'Unexpected runtime output\n' + validOutput,
    ]) assert.throws(() => verifyJavaCompactionOutput(output, ''), Error);
    assert.throws(() => verifyJavaCompactionOutput(validOutput, 'unexpected runtime error'), /runtime diagnostics/);
});

test('Java compaction class-init trace verifies that only the nested decoder and exception signature execute', () => {
    assert.deepEqual(verifyJavaCompactionInitialization(initializationTrace), {
        initializedProductionClasses: ['dev/aster/charts/AsterEngine$CompactionReceipt'],
        initializedAndroidClasses: [], initializedJsonClasses: ['org/json/JSONException'],
    });
    // Verifying or loading the outer class is not the same as initializing it.
    assert.deepEqual(verifyJavaCompactionInitialization(initializationTrace
        + '\n[info][class,init] Start class verification for: dev.aster.charts.AsterEngine'),
    verifyJavaCompactionInitialization(initializationTrace));
});

test('Java compaction initialization guard fails closed for outer Engine, helpers, Android or JSON runtime', () => {
    assert.throws(() => verifyJavaCompactionInitialization(''), /did not observe/);
    assert.throws(() => verifyJavaCompactionInitialization(initializationTrace.replace('org/json/JSONException', 'unrelated/Exception')), /checked exception signature/);
    for (const forbidden of ['dev/aster/charts/AsterEngine', 'dev/aster/charts/AsterEngine$ScenePacket',
        'dev/aster/charts/AsterColumns', 'dev/aster/charts/WorkspaceRestoreJob', 'android/os/Looper',
        'android/os/Handler', 'org/json/JSONObject', 'org/json/JSONArray', 'org/json/JSONTokener']) {
        assert.throws(() => verifyJavaCompactionInitialization(initializationTrace
            + `\n[info][class,init] 103 Initializing '${forbidden}' (0x00000000)`), Error, forbidden);
    }
});

test('Java compaction harness covers boxed counts and malformed values without touching host runtime', async () => {
    const source = await readFile(new URL(`../${JAVA_COMPACTION_HARNESS}`, import.meta.url), 'utf8');
    const accepted = [...source.matchAll(/accepted\("([^"]+)"/g)].map(match => match[1]);
    const rejected = [...source.matchAll(/rejected\("([^"]+)"/g)].map(match => match[1]);
    assert.equal(accepted.length, 24);
    assert.equal(rejected.length, 34);
    assert.deepEqual([...accepted, ...rejected], JAVA_COMPACTION_SCENARIOS);
    assert.equal(accepted.length + rejected.length * 2, JAVA_COMPACTION_EXPECTED.checks);
    for (const type of ['Integer', 'Long', 'Double']) {
        assert.match(source, new RegExp(`accepted\\("${type.toLowerCase()}-zero", ${type}\\.valueOf\\([^)]*\\), false\\)`));
        assert.match(source, new RegExp(`accepted\\("${type.toLowerCase()}-upper-bound", ${type}\\.valueOf\\(4194304[^)]*\\), true\\)`));
    }
    assert.match(source, /checks\+\+;\s*if \(!condition\) throw new AssertionError/);
    assert.deepEqual([...source.matchAll(/^import ([^;]+);$/gm)].map(match => match[1]), ['org.json.JSONException']);
    assert.deepEqual([...source.matchAll(/\bAsterEngine\.(\w+)/g)].map(match => match[1]), ['CompactionReceipt', 'CompactionReceipt']);
    assert.doesNotMatch(source, /new\s+(?:AsterEngine|JSONObject|JSONArray|Thread)\b|Class\.forName|System\.loadLibrary/);
    assert.doesNotMatch(source, /\b(?:Handler|Looper|Executor|JSONObject|JSONArray|JSONTokener)\b/);
});

test('Java compaction runner keeps optional execution, source hashes and empty native lookup explicit', async () => {
    const source = await readFile(new URL('../scripts/check-java-compaction.mjs', import.meta.url), 'utf8');
    assert.match(source, /process\.argv\[1\].*=== fileURLToPath\(import\.meta\.url\)/);
    assert.match(source, /-Djava\.library\.path=\$\{empty\}/);
    assert.match(source, /-Xlog:class\+init=info:file=\$\{tracePath\}/);
    assert.match(source, /JSON\.stringify\(before\) !== JSON\.stringify\(after\)/);
    assert.match(source, /bytes\.readUInt16BE\(6\) !== 52/);
    assert.match(source, /const classInitializationTrace = await readFile\(tracePath, 'utf8'\)/);
    assert.match(source, /runtimeDiagnostics: \{stdout: runtime\.stdout, stderr: runtime\.stderr, classInitializationTrace\}/);
    assert.match(source, /finally\s*\{\s*await rm\(temporary, \{recursive: true, force: true\}\)/);
});
