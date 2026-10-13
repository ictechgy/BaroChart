import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JAVA_HOST_BOUNDARY, JAVA_HOST_PRODUCTION_SOURCES, javaHostCompilerArguments} from '../scripts/check-java-host.mjs';

// Node-only command/fixture guards. These tests do not invoke a Java compiler.
test('Java host check keeps its non-Android compile-only evidence boundary explicit', () => {
    assert.equal(JAVA_HOST_BOUNDARY.javaSourceLevel, 8);
    assert.equal(JAVA_HOST_BOUNDARY.javaBytecodeTarget, 8);
    for (const name of ['javaSE8ApiCompatibilityVerified', 'androidSDKCompiled', 'androidRuntimeExecuted', 'jniExecuted', 'ownershipRuntimeTested']) {
        assert.equal(JAVA_HOST_BOUNDARY[name], false, name);
    }
    assert.deepEqual(JAVA_HOST_PRODUCTION_SOURCES, [
        'native/android/java/dev/aster/charts/AsterEngine.java',
        'native/android/java/dev/aster/charts/AsterColumns.java',
        'native/android/java/dev/aster/charts/WorkspaceRestoreJob.java',
    ]);
});

test('Java host command uses explicit source inputs and temporary-only output', () => {
    const inputs = ['/repo/native/AsterEngine.java', '/repo/test/JSONObject.java'];
    assert.deepEqual(javaHostCompilerArguments('/tmp/classes', '/tmp/empty', inputs), [
        '-m', 'jdk.compiler/com.sun.tools.javac.Main', '-source', '8', '-target', '8',
        '-Xlint:all,-options', '-Werror', '-proc:none', '-implicit:none', '-encoding', 'UTF-8',
        '-classpath', '/tmp/empty', '-sourcepath', '/tmp/empty', '-d', '/tmp/classes', ...inputs,
    ]);
});

test('Java host scheduling and JSON fixtures fail explicitly instead of simulating runtime success', async () => {
    for (const name of ['android/os/Handler.java', 'android/os/Looper.java', 'android/os/Debug.java',
        'org/json/JSONArray.java', 'org/json/JSONObject.java', 'org/json/JSONTokener.java']) {
        const source = await readFile(new URL(`./java-host-stubs/${name}`, import.meta.url), 'utf8');
        assert.match(source, /throw new UnsupportedOperationException\("Compile-only /, name);
        assert.doesNotMatch(source, /\breturn\b/, name);
    }
});
