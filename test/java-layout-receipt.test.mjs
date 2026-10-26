import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JAVA_LAYOUT_BOUNDARY, JAVA_LAYOUT_EXPECTED, JAVA_LAYOUT_HARNESS,
    JAVA_LAYOUT_JSON_FIXTURE, JAVA_LAYOUT_PRODUCTION_SOURCES, JAVA_LAYOUT_SCENARIOS,
    javaLayoutCompilerArguments, verifyJavaLayoutOutput,
    verifyJavaLayoutInitialization} from '../scripts/check-java-layout-notifications.mjs';

// Node-only source/runner contract tests. npm test never compiles or executes Java.
const validOutput = JAVA_LAYOUT_SCENARIOS.map(name => `PASS ${name}`).join('\n')
    + '\nRESULT scenarios=19 checks=32 scope=layout-notification-receipt-decoder\n';
const initializationTrace = [
    "[0.031s][info][class,init] 100 Initializing 'dev/aster/charts/LayoutReceiptTest' (0x00000000)",
    "[0.032s][info][class,init] 101 Initializing 'dev/aster/charts/AsterEngine$LayoutReceipt'(no method) (0x00000000)",
    "[0.033s][info][class,init] 102 Initializing 'org/json/JSONException'(no method) (0x00000000)",
    "[0.034s][info][class,init] 103 Initializing 'org/json/JSONObject' (0x00000000)",
].join('\n');

test('Java layout evidence names the nested decoder and excludes Android/JNI claims', () => {
    assert.equal(JAVA_LAYOUT_BOUNDARY.productionDecoderRuntimeTested, true);
    assert.deepEqual(JAVA_LAYOUT_BOUNDARY.productionDecoderMethodsExecuted, [
        'AsterEngine.LayoutReceipt.panelOrder', 'AsterEngine.LayoutReceipt.indicatorPlacement',
    ]);
    assert.equal(JAVA_LAYOUT_BOUNDARY.javaSourceLevel, 8);
    assert.equal(JAVA_LAYOUT_BOUNDARY.javaBytecodeTarget, 8);
    for (const key of ['javaSE8ApiCompatibilityVerified', 'androidSDKCompiled', 'androidEngineClassInitialized',
        'androidEngineHostExecuted', 'androidRuntimeExecuted', 'jniExecuted', 'jsonRuntimeExecuted',
        'ownerThreadBehaviorTested', 'observerNotificationsRuntimeTested', 'nativeLayoutCommandsExecuted',
        'performanceMeasured']) assert.equal(JAVA_LAYOUT_BOUNDARY[key], false, key);
    assert.equal(JAVA_LAYOUT_BOUNDARY.jsonFixtureExecuted, true);
    assert.deepEqual(JAVA_LAYOUT_PRODUCTION_SOURCES, [
        'native/android/java/dev/aster/charts/AsterEngine.java',
        'native/android/java/dev/aster/charts/AsterColumns.java',
        'native/android/java/dev/aster/charts/WorkspaceRestoreJob.java',
        'native/android/java/dev/aster/charts/NativeJobBudget.java',
        'native/android/java/dev/aster/charts/ParamsUpdateJob.java',
    ]);
    assert.equal(JAVA_LAYOUT_HARNESS, 'test/java-layout-receipt/dev/aster/charts/LayoutReceiptTest.java');
    assert.equal(JAVA_LAYOUT_JSON_FIXTURE, 'test/java-layout-receipt/org/json/JSONObject.java');
});

test('Java layout compiler uses warnings-as-errors and isolated Java 8 inputs', () => {
    const sources = ['/repo/native/AsterEngine.java', '/repo/test/LayoutReceiptTest.java'];
    assert.deepEqual(javaLayoutCompilerArguments('/tmp/classes', '/tmp/empty', sources), [
        '-m', 'jdk.compiler/com.sun.tools.javac.Main', '-source', '8', '-target', '8',
        '-Xlint:all,-options', '-Werror', '-proc:none', '-implicit:none', '-encoding', 'UTF-8',
        '-classpath', '/tmp/empty', '-sourcepath', '/tmp/empty', '-d', '/tmp/classes', ...sources,
    ]);
});

test('Java layout result requires every accepted and rejected receipt scenario', () => {
    assert.deepEqual(JAVA_LAYOUT_EXPECTED, {scenarios: 19, checks: 32});
    assert.equal(JAVA_LAYOUT_SCENARIOS.length, 19);
    assert.equal(new Set(JAVA_LAYOUT_SCENARIOS).size, 19);
    assert.deepEqual(verifyJavaLayoutOutput(validOutput, ''), JAVA_LAYOUT_SCENARIOS);
    assert.deepEqual(verifyJavaLayoutOutput(validOutput.replaceAll('\n', '\r\n'), ''), JAVA_LAYOUT_SCENARIOS);
    for (const output of [
        '', validOutput.replace('scenarios=19', 'scenarios=18'), validOutput.replace('checks=32', 'checks=31'),
        validOutput.replace('PASS panel-order-false\n', ''), validOutput.replace('PASS placement-upper-bound', 'PASS unknown'),
        validOutput.replace('scope=layout-notification-receipt-decoder', 'scope=android-runtime'),
        'Unexpected runtime output\n' + validOutput,
    ]) assert.throws(() => verifyJavaLayoutOutput(output, ''), Error);
    assert.throws(() => verifyJavaLayoutOutput(validOutput, 'unexpected runtime error'), /runtime diagnostics/);
});

test('Java layout class-init guard allows only the nested decoder and fixture JSON classes', () => {
    assert.deepEqual(verifyJavaLayoutInitialization(initializationTrace), {
        initializedProductionClasses: ['dev/aster/charts/AsterEngine$LayoutReceipt'],
        initializedAndroidClasses: [], initializedJsonClasses: ['org/json/JSONException', 'org/json/JSONObject'],
    });
    assert.deepEqual(verifyJavaLayoutInitialization(initializationTrace
        + '\n[info][class,init] Start class verification for: dev.aster.charts.AsterEngine'),
    verifyJavaLayoutInitialization(initializationTrace));
    assert.throws(() => verifyJavaLayoutInitialization(''), /did not observe/);
    for (const forbidden of ['dev/aster/charts/AsterEngine', 'dev/aster/charts/AsterEngine$CompactionReceipt',
        'dev/aster/charts/AsterColumns', 'android/os/Looper', 'org/json/JSONArray']) {
        assert.throws(() => verifyJavaLayoutInitialization(initializationTrace
            + `\n[info][class,init] 104 Initializing '${forbidden}' (0x00000000)`), Error, forbidden);
    }
});

test('Java layout harness has strict booleans and 256 inclusive, 257 rejecting count cases', async () => {
    const source = await readFile(new URL(`../${JAVA_LAYOUT_HARNESS}`, import.meta.url), 'utf8');
    assert.match(source, /acceptedPanelOrder\("panel-order-false", Boolean\.FALSE, false\)/);
    assert.match(source, /acceptedPanelOrder\("panel-order-true", Boolean\.TRUE, true\)/);
    assert.match(source, /acceptedPlacement\("placement-upper-bound", placement\(Integer\.valueOf\(256\)\), true\)/);
    assert.match(source, /rejectedPlacement\("placement-upper-bound-plus-one", placement\(Integer\.valueOf\(257\)\), range\)/);
    assert.match(source, /rejectedPanelOrder\("panel-order-number", Integer\.valueOf\(1\), panelType\)/);
    assert.doesNotMatch(source, /new\s+AsterEngine|System\.loadLibrary|Class\.forName/);
    assert.deepEqual([...source.matchAll(/^import ([^;]+);$/gm)].map(match => match[1]), ['org.json.JSONException', 'org.json.JSONObject']);
    assert.deepEqual([...source.matchAll(/\bAsterEngine\.(\w+)/g)].map(match => match[1]), [
        'LayoutReceipt', 'LayoutReceipt', 'LayoutReceipt', 'LayoutReceipt',
    ]);
});

test('Java layout runner keeps optional execution, hashes and cleanup explicit', async () => {
    const source = await readFile(new URL('../scripts/check-java-layout-notifications.mjs', import.meta.url), 'utf8');
    assert.match(source, /process\.argv\[1\].*=== fileURLToPath\(import\.meta\.url\)/);
    assert.match(source, /-Djava\.library\.path=\$\{empty\}/);
    assert.match(source, /-Xlog:class\+init=info:file=\$\{tracePath\}/);
    assert.match(source, /JSON\.stringify\(before\) !== JSON\.stringify\(after\)/);
    assert.match(source, /bytes\.readUInt16BE\(6\) !== 52/);
    assert.match(source, /const classInitializationTrace = await readFile\(tracePath, 'utf8'\)/);
    assert.match(source, /runtimeDiagnostics: \{stdout: runtime\.stdout, stderr: runtime\.stderr, classInitializationTrace\}/);
    assert.match(source, /finally\s*\{\s*await rm\(temporary, \{recursive: true, force: true\}\)/);
});
