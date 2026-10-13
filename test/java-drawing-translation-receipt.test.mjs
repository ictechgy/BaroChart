import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JAVA_DRAWING_TRANSLATION_BOUNDARY, JAVA_DRAWING_TRANSLATION_EXPECTED, JAVA_DRAWING_TRANSLATION_HARNESS,
    JAVA_DRAWING_TRANSLATION_PRODUCTION_SOURCES, JAVA_DRAWING_TRANSLATION_SCENARIOS,
    javaDrawingTranslationCompilerArguments, verifyJavaDrawingTranslationOutput,
    verifyJavaDrawingTranslationInitialization} from '../scripts/check-java-drawing-translation.mjs';

// Node-only source/runner contract tests. npm test never compiles or executes Java.
const validOutput = JAVA_DRAWING_TRANSLATION_SCENARIOS.map(name => `PASS ${name}`).join('\n')
    + '\nRESULT scenarios=65 checks=103 scope=drawing-translation-receipt-decoder\n';
const initializationTrace = [
    "[0.031s][info][class,init] 100 Initializing 'dev/aster/charts/DrawingTranslationReceiptTest' (0x00000000)",
    "[0.032s][info][class,init] 101 Initializing 'dev/aster/charts/AsterEngine$DrawingTranslationReceipt'(no method) (0x00000000)",
    "[0.033s][info][class,init] 102 Initializing 'org/json/JSONException'(no method) (0x00000000)",
    "[0.034s][info][class,init] 103 Initializing 'org/json/JSONObject' (0x00000000)",
].join('\n');

test('Java drawing translation evidence distinguishes the actual decoder from compile-only host signatures', () => {
    assert.equal(JAVA_DRAWING_TRANSLATION_BOUNDARY.productionDecoderRuntimeTested, true);
    assert.equal(JAVA_DRAWING_TRANSLATION_BOUNDARY.productionDecoderMethodExecuted, 'AsterEngine.DrawingTranslationReceipt.changed');
    assert.equal(JAVA_DRAWING_TRANSLATION_BOUNDARY.javaSourceLevel, 8);
    assert.equal(JAVA_DRAWING_TRANSLATION_BOUNDARY.javaBytecodeTarget, 8);
    assert.equal(JAVA_DRAWING_TRANSLATION_BOUNDARY.jsonExceptionSignatureExecuted, true);
    assert.equal(JAVA_DRAWING_TRANSLATION_BOUNDARY.jsonNullSentinelSignatureExecuted, true);
    for (const key of ['javaSE8ApiCompatibilityVerified', 'androidSDKCompiled', 'androidEngineClassInitialized',
        'androidEngineHostExecuted', 'androidRuntimeExecuted', 'jniExecuted', 'jsonRuntimeExecuted',
        'jsonContainerMethodsExecuted', 'ownerThreadBehaviorTested', 'observerNotificationsRuntimeTested', 'nativeDrawingTranslationExecuted',
        'performanceMeasured']) assert.equal(JAVA_DRAWING_TRANSLATION_BOUNDARY[key], false, key);
    assert.deepEqual(JAVA_DRAWING_TRANSLATION_PRODUCTION_SOURCES, [
        'native/android/java/dev/aster/charts/AsterEngine.java',
        'native/android/java/dev/aster/charts/AsterColumns.java',
        'native/android/java/dev/aster/charts/WorkspaceRestoreJob.java',
    ]);
    assert.equal(JAVA_DRAWING_TRANSLATION_HARNESS, 'test/java-drawing-translation-receipt/dev/aster/charts/DrawingTranslationReceiptTest.java');
});

test('Java drawing translation compiler uses warnings-as-errors and explicit isolated Java 8 inputs', () => {
    const sources = ['/repo/native/AsterEngine.java', '/repo/test/DrawingTranslationReceiptTest.java'];
    assert.deepEqual(javaDrawingTranslationCompilerArguments('/tmp/classes', '/tmp/empty', sources), [
        '-m', 'jdk.compiler/com.sun.tools.javac.Main', '-source', '8', '-target', '8',
        '-Xlint:all,-options', '-Werror', '-proc:none', '-implicit:none', '-encoding', 'UTF-8',
        '-classpath', '/tmp/empty', '-sourcepath', '/tmp/empty', '-d', '/tmp/classes', ...sources,
    ]);
});

test('Java drawing translation result requires the complete fixed scenario list and assertion count', () => {
    assert.deepEqual(JAVA_DRAWING_TRANSLATION_EXPECTED, {scenarios: 65, checks: 103});
    assert.equal(JAVA_DRAWING_TRANSLATION_SCENARIOS.length, 65);
    assert.equal(new Set(JAVA_DRAWING_TRANSLATION_SCENARIOS).size, 65);
    assert.deepEqual(verifyJavaDrawingTranslationOutput(validOutput, ''), JAVA_DRAWING_TRANSLATION_SCENARIOS);
    assert.deepEqual(verifyJavaDrawingTranslationOutput(validOutput.replaceAll('\n', '\r\n'), ''), JAVA_DRAWING_TRANSLATION_SCENARIOS);
});

test('Java drawing translation result rejects incomplete, duplicate, unexpected or diagnostic-bearing evidence', () => {
    for (const output of [
        '', validOutput.replace('scenarios=65', 'scenarios=64'), validOutput.replace('checks=103', 'checks=102'),
        validOutput.replace('PASS integer-zero\n', ''),
        validOutput.replace('PASS long-zero', 'PASS integer-zero'),
        validOutput.replace('PASS integer-zero\nPASS long-zero', 'PASS long-zero\nPASS integer-zero'),
        validOutput.replace('PASS integer-zero', 'PASS unknown'),
        validOutput.replace('scope=drawing-translation-receipt-decoder', 'scope=android-runtime'),
        'Unexpected runtime output\n' + validOutput,
    ]) assert.throws(() => verifyJavaDrawingTranslationOutput(output, ''), Error);
    assert.throws(() => verifyJavaDrawingTranslationOutput(validOutput, 'unexpected runtime error'), /runtime diagnostics/);
});

test('Java drawing translation class-init trace verifies that only the nested decoder and exception/NULL signatures initialize', () => {
    assert.deepEqual(verifyJavaDrawingTranslationInitialization(initializationTrace), {
        initializedProductionClasses: ['dev/aster/charts/AsterEngine$DrawingTranslationReceipt'],
        initializedAndroidClasses: [], initializedJsonClasses: ['org/json/JSONException', 'org/json/JSONObject'],
    });
    // Verifying or loading the outer class is not the same as initializing it.
    assert.deepEqual(verifyJavaDrawingTranslationInitialization(initializationTrace
        + '\n[info][class,init] Start class verification for: dev.aster.charts.AsterEngine'),
    verifyJavaDrawingTranslationInitialization(initializationTrace));
});

test('Java drawing translation initialization guard fails closed for outer Engine, helpers, Android or JSON runtime', () => {
    assert.throws(() => verifyJavaDrawingTranslationInitialization(''), /did not observe/);
    assert.throws(() => verifyJavaDrawingTranslationInitialization(initializationTrace.replace('org/json/JSONException', 'unrelated/Exception')), /checked exception and NULL placeholder signatures/);
    for (const forbidden of ['dev/aster/charts/AsterEngine', 'dev/aster/charts/AsterEngine$ScenePacket',
        'dev/aster/charts/AsterColumns', 'dev/aster/charts/WorkspaceRestoreJob', 'android/os/Looper',
        'android/os/Handler', 'dev/aster/charts/AsterEngine$CompactionReceipt', 'org/json/JSONArray', 'org/json/JSONTokener']) {
        assert.throws(() => verifyJavaDrawingTranslationInitialization(initializationTrace
            + `\n[info][class,init] 103 Initializing '${forbidden}' (0x00000000)`), Error, forbidden);
    }
});

test('Java drawing translation harness covers boxed counts and malformed values without touching host runtime', async () => {
    const source = await readFile(new URL(`../${JAVA_DRAWING_TRANSLATION_HARNESS}`, import.meta.url), 'utf8');
    const accepted = [...source.matchAll(/accepted\("([^"]+)"/g)].map(match => match[1]);
    const rejected = [...source.matchAll(/rejected\("([^"]+)"/g)].map(match => match[1]);
    assert.equal(accepted.length, 27);
    assert.equal(rejected.length, 38);
    assert.deepEqual([...accepted, ...rejected], JAVA_DRAWING_TRANSLATION_SCENARIOS);
    assert.equal(accepted.length + rejected.length * 2, JAVA_DRAWING_TRANSLATION_EXPECTED.checks);
    for (const type of ['Integer', 'Long', 'Double']) {
        assert.match(source, new RegExp(`accepted\\("${type.toLowerCase()}-zero", ${type}\\.valueOf\\([^)]*\\), false\\)`));
        assert.match(source, new RegExp(`accepted\\("${type.toLowerCase()}-upper-bound", ${type}\\.valueOf\\(128[^)]*\\), true\\)`));
    }
    assert.match(source, /checks\+\+;\s*if \(!condition\) throw new AssertionError/);
    assert.deepEqual([...source.matchAll(/^import ([^;]+);$/gm)].map(match => match[1]), ['org.json.JSONException', 'org.json.JSONObject']);
    assert.deepEqual([...source.matchAll(/\bAsterEngine\.(\w+)/g)].map(match => match[1]), ['DrawingTranslationReceipt', 'DrawingTranslationReceipt']);
    assert.doesNotMatch(source, /new\s+(?:AsterEngine|JSONObject|JSONArray|Thread)\b|Class\.forName|System\.loadLibrary/);
    assert.doesNotMatch(source, /\b(?:Handler|Looper|Executor|JSONArray|JSONTokener)\b/);
    assert.match(source, /rejected\("json-null-sentinel", JSONObject\.NULL, numeric\)/);
    assert.equal((source.match(/JSONObject\./g) || []).length, 1);
});

test('Java drawing translation runner keeps optional execution, source hashes and empty native lookup explicit', async () => {
    const source = await readFile(new URL('../scripts/check-java-drawing-translation.mjs', import.meta.url), 'utf8');
    assert.match(source, /process\.argv\[1\].*=== fileURLToPath\(import\.meta\.url\)/);
    assert.match(source, /-Djava\.library\.path=\$\{empty\}/);
    assert.match(source, /-Xlog:class\+init=info:file=\$\{tracePath\}/);
    assert.match(source, /JSON\.stringify\(before\) !== JSON\.stringify\(after\)/);
    assert.match(source, /bytes\.readUInt16BE\(6\) !== 52/);
    assert.match(source, /const classInitializationTrace = await readFile\(tracePath, 'utf8'\)/);
    assert.match(source, /runtimeDiagnostics: \{stdout: runtime\.stdout, stderr: runtime\.stderr, classInitializationTrace\}/);
    assert.match(source, /finally\s*\{\s*await rm\(temporary, \{recursive: true, force: true\}\)/);
});
