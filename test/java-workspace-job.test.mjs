import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JAVA_WORKSPACE_JOB_BOUNDARY, JAVA_WORKSPACE_JOB_EXPECTED, JAVA_WORKSPACE_JOB_SOURCES,
    javaWorkspaceJobCompilerArguments, verifyWorkspaceJobOutput, verifyUnavailableOwnerOutput} from '../scripts/check-java-workspace-job.mjs';

// Node-only contract tests. These never compile or execute Java during npm test.
test('Java workspace ownership evidence is scoped to the production helper with an independent host', () => {
    assert.equal(JAVA_WORKSPACE_JOB_BOUNDARY.productionOwnershipRuntimeTested, true);
    assert.equal(JAVA_WORKSPACE_JOB_BOUNDARY.realWorkerThreads, true);
    for (const key of ['javaSE8ApiCompatibilityVerified', 'androidSDKCompiled', 'androidEngineHostExecuted',
        'androidRuntimeExecuted', 'jniExecuted', 'nativeAllocatorExecuted', 'jsonRuntimeExecuted',
        'performanceMeasured', 'unavailableOwnerCleanupSupported']) assert.equal(JAVA_WORKSPACE_JOB_BOUNDARY[key], false, key);
    assert.deepEqual(JAVA_WORKSPACE_JOB_SOURCES, [
        'native/android/java/dev/aster/charts/WorkspaceRestoreJob.java',
        'test/java-workspace-job/dev/aster/charts/WorkspaceRestoreJobHarness.java',
    ]);
});

test('Java workspace compiler uses only explicit source and isolated output paths', () => {
    const inputs = ['/repo/native/WorkspaceRestoreJob.java', '/repo/test/WorkspaceRestoreJobHarness.java'];
    assert.deepEqual(javaWorkspaceJobCompilerArguments('/tmp/classes', '/tmp/empty', inputs), [
        '-m', 'jdk.compiler/com.sun.tools.javac.Main', '-source', '8', '-target', '8',
        '-Xlint:all,-options', '-Werror', '-proc:none', '-implicit:none', '-encoding', 'UTF-8',
        '-classpath', '/tmp/empty', '-sourcepath', '/tmp/empty', '-d', '/tmp/classes', ...inputs,
    ]);
});

test('Java workspace runner requires exact unique scenario and assertion counts', () => {
    const expected = {scenarios: 2, checks: 7};
    assert.deepEqual(verifyWorkspaceJobOutput('PASS first\nPASS second\nRESULT scenarios=2 checks=7 owner=main worker=real-thread\n', '', expected), ['first', 'second']);
    assert.throws(() => verifyWorkspaceJobOutput('PASS first\nPASS first\nRESULT scenarios=2 checks=7 owner=main worker=real-thread\n', '', expected));
    assert.throws(() => verifyWorkspaceJobOutput('PASS first\nRESULT scenarios=1 checks=7 owner=main worker=real-thread\n', '', expected));
    assert.throws(() => verifyWorkspaceJobOutput('PASS first\nPASS second\nRESULT scenarios=2 checks=6 owner=main worker=real-thread\n', '', expected));
    assert.throws(() => verifyWorkspaceJobOutput('PASS first\nPASS second\nRESULT scenarios=2 checks=7 owner=main worker=real-thread\n', 'Exception in worker', expected));
    assert.deepEqual(JAVA_WORKSPACE_JOB_EXPECTED, {scenarios: 108, checks: 1635, unavailableOwnerScenarios: 1, unavailableOwnerChecks: 9});
});

test('Java workspace owner-unavailable result explicitly refuses a false terminal cleanup claim', () => {
    verifyUnavailableOwnerOutput('UNAVAILABLE_OWNER scenarios=1 checks=9 terminal=false sourceRelease=false budgetRelease=false targetFreed=true\n', '');
    assert.throws(() => verifyUnavailableOwnerOutput('UNAVAILABLE_OWNER scenarios=1 checks=9 terminal=true sourceRelease=true budgetRelease=true targetFreed=true\n', ''));
});

test('Java workspace harness has no Android, JSON or JNI runtime fixture imports', async () => {
    const source = await readFile(new URL('./java-workspace-job/dev/aster/charts/WorkspaceRestoreJobHarness.java', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^import\s+(?:android\.|org\.json\.)/m);
    assert.doesNotMatch(source, /System\.loadLibrary|native\s+\w+\s*\(/);
    assert.match(source, /implements WorkspaceRestoreJob\.Host/);
    assert.match(source, /ArrayBlockingQueue<Runnable>\(128\)/);
    assert.match(source, /Thread\.currentThread\(\) != queue\.owner/);
    assert.match(source, /Callback-free atomic compare\/swap/);
});


test('Android adapter initial enqueue delegates to the executable production ownership helper', async () => {
    const source = await readFile(new URL('../native/android/java/dev/aster/charts/AsterEngine.java', import.meta.url), 'utf8');
    assert.match(source, /activeWorkspace\s*=\s*result\s*;\s*state\.enqueueInitial\(\)\s*;\s*return result/);
    assert.equal(JAVA_WORKSPACE_JOB_BOUNDARY.adapterInitialEnqueueMethodExecuted, 'WorkspaceRestoreJob.enqueueInitial');
    assert.equal(JAVA_WORKSPACE_JOB_BOUNDARY.androidEngineHostExecuted, false);
});
