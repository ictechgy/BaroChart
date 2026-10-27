import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JAVA_ENGINE_LIFECYCLE_BOUNDARY,JAVA_ENGINE_LIFECYCLE_EXPECTED,JAVA_ENGINE_LIFECYCLE_PRODUCTION_SOURCES,JAVA_ENGINE_LIFECYCLE_SCENARIOS,javaEngineLifecycleCompilerArguments,verifyJavaEngineLifecycleOutput} from '../scripts/check-java-engine-lifecycle.mjs';

// Node-only runner/fixture guards. These tests never start Java or compile JNI.
test('Java engine lifecycle evidence has an explicit host-stub boundary',()=>{
    assert.equal(JAVA_ENGINE_LIFECYCLE_BOUNDARY.productionJavaFacadeExecuted,true);
    assert.equal(JAVA_ENGINE_LIFECYCLE_BOUNDARY.hostJNIStubExecuted,true);
    for(const name of ['productionAndroidJNIExecuted','productionNativeRuntimeExecuted','androidRuntimeExecuted','androidSDKCompiled','fullJSONRuntimeExecuted','physicalAndroidDeviceExecuted','javaSE8ApiCompatibilityVerified'])assert.equal(JAVA_ENGINE_LIFECYCLE_BOUNDARY[name],false,name);
    assert.equal(JAVA_ENGINE_LIFECYCLE_EXPECTED.scenarios,JAVA_ENGINE_LIFECYCLE_SCENARIOS.length);
    assert.equal(JAVA_ENGINE_LIFECYCLE_PRODUCTION_SOURCES[0],'native/android/java/dev/aster/charts/AsterEngine.java');
});

test('Java engine lifecycle compiler is strict, explicit and Java 8 targeted',()=>{
    assert.deepEqual(javaEngineLifecycleCompilerArguments('/tmp/classes','/tmp/empty',['/repo/AsterEngine.java']),['-m','jdk.compiler/com.sun.tools.javac.Main','-source','8','-target','8','-Xlint:all,-options','-Werror','-proc:none','-implicit:none','-encoding','UTF-8','-classpath','/tmp/empty','-sourcepath','/tmp/empty','-d','/tmp/classes','/repo/AsterEngine.java']);
});

test('Java engine lifecycle output requires every bounded runtime scenario',()=>{
    const stdout=JAVA_ENGINE_LIFECYCLE_SCENARIOS.map(name=>`PASS ${name}`).join('\n')+`\nRESULT scenarios=${JAVA_ENGINE_LIFECYCLE_EXPECTED.scenarios} checks=${JAVA_ENGINE_LIFECYCLE_EXPECTED.checks} scope=production-java-facade-host-jni-stub\n`;
    assert.deepEqual(verifyJavaEngineLifecycleOutput(stdout,''),JAVA_ENGINE_LIFECYCLE_SCENARIOS);
    assert.throws(()=>verifyJavaEngineLifecycleOutput(stdout.replace('checks=26','checks=25'),''));
    assert.throws(()=>verifyJavaEngineLifecycleOutput(stdout,'unexpected native diagnostic'));
});

test('Java engine lifecycle harness uses production facade and a native counter fixture',async()=>{
    const harness=await readFile(new URL('./java-engine-lifecycle/dev/aster/charts/EngineLifecycleHarness.java',import.meta.url),'utf8');
    const native=await readFile(new URL('./java-engine-lifecycle/native/aster_lifecycle_stub.c',import.meta.url),'utf8');
    assert.match(harness,/new AsterEngine\(/);assert.match(harness,/setIndicatorParamsAsync\(/);assert.match(harness,/engine\.command\("inspect"\)/);assert.match(harness,/engine\.releaseFrameCache\("fixture-frame"\)/);
    assert.match(native,/Java_dev_aster_charts_AsterEngine_create/);assert.match(native,/Java_dev_aster_charts_AsterEngine_free/);assert.match(native,/fixture free failure/);
});

test('Java engine source orders constructor cleanup and distinguishes normal from close cleanup entry',async()=>{
    const source=await readFile(new URL('../native/android/java/dev/aster/charts/AsterEngine.java',import.meta.url),'utf8');
    assert.match(source,/catch\(JSONException\|RuntimeException\|Error error\)\{long released=handle;handle=0;try\{free\(released\);\}catch\(Throwable cleanup\)\{if\(cleanup!=error\)error\.addSuppressed\(cleanup\);\}throw error;\}/);
    assert.match(source,/if\(handle==0\)throw new IllegalStateException\([^;]+;if\(closing\)throw new IllegalStateException\("Engine closing"\)/);
    assert.match(source,/void releaseFrameCache\(String token\) throws JSONException \{checkCleanup\(\);invokeHandle\(handle,"nativeReleaseFrameCache",token\);\}/);
});
