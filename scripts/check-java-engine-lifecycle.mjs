// Explicit optional runtime check. Importing this module and npm test never start Java or clang.
// Production AsterEngine executes with a test-only host JNI stub and primitive Android/JSON fixtures.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,extname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const harnessClass='dev.aster.charts.EngineLifecycleHarness';
export const JAVA_ENGINE_LIFECYCLE_PRODUCTION_SOURCES=Object.freeze([
    'native/android/java/dev/aster/charts/AsterEngine.java',
    'native/android/java/dev/aster/charts/AsterColumns.java',
    'native/android/java/dev/aster/charts/WorkspaceRestoreJob.java',
    'native/android/java/dev/aster/charts/NativeJobBudget.java',
    'native/android/java/dev/aster/charts/ParamsUpdateJob.java',
]);
export const JAVA_ENGINE_LIFECYCLE_EXPECTED=Object.freeze({scenarios:5,checks:26});
export const JAVA_ENGINE_LIFECYCLE_SCENARIOS=Object.freeze([
    'asset-close-precedes-handle-acquisition','constructor-error-releases-handle','constructor-cleanup-failure-suppressed',
    'close-reentrant-command-rejected','close-owned-cleanup-allowed',
]);
export const JAVA_ENGINE_LIFECYCLE_BOUNDARY=Object.freeze({
    evidence:'Production Java facade lifecycle executed against a counter/fault-injection host JNI stub',
    productionJavaFacadeExecuted:true,productionConstructorExecuted:true,productionParamsCloseExecuted:true,
    hostJNIStubExecuted:true,jsonFixtureExecuted:true,androidFixtureExecuted:true,
    productionAndroidJNIExecuted:false,productionNativeRuntimeExecuted:false,androidRuntimeExecuted:false,
    androidSDKCompiled:false,fullJSONRuntimeExecuted:false,physicalAndroidDeviceExecuted:false,
    javaSourceLevel:8,javaBytecodeTarget:8,javaSE8ApiCompatibilityVerified:false,
});

async function filesIn(directory,suffix){const result=[];for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isSymbolicLink())throw new Error(`Unexpected lifecycle fixture symlink: ${path}`);if(entry.isDirectory())result.push(...await filesIn(path,suffix));else if(entry.isFile()&&path.endsWith(suffix))result.push(path);}return result.sort();}
function run(command,args,label,timeout=60000){const result=spawnSync(command,args,{cwd:root,encoding:'utf8',timeout,maxBuffer:4*1024*1024});if(result.error||result.status!==0)throw new Error(`${label} failed (${result.error?.message??result.signal??result.status}).\n${result.stdout??''}${result.stderr??''}`);return {stdout:result.stdout,stderr:result.stderr};}
async function hashes(paths){const entries=[];for(const path of paths)entries.push([relative(root,path).split('\\').join('/'),createHash('sha256').update(await readFile(path)).digest('hex')]);return Object.fromEntries(entries);}
export function javaEngineLifecycleCompilerArguments(classes,empty,sources){return ['-m','jdk.compiler/com.sun.tools.javac.Main','-source','8','-target','8','-Xlint:all,-options','-Werror','-proc:none','-implicit:none','-encoding','UTF-8','-classpath',empty,'-sourcepath',empty,'-d',classes,...sources];}
export function verifyJavaEngineLifecycleOutput(stdout,stderr){if(stderr.trim())throw new Error(`Unexpected lifecycle runtime diagnostics:\n${stderr}`);const lines=stdout.trim().split(/\r?\n/);const summary=/^RESULT scenarios=(\d+) checks=(\d+) scope=production-java-facade-host-jni-stub$/.exec(lines.pop()??'');if(!summary||Number(summary[1])!==JAVA_ENGINE_LIFECYCLE_EXPECTED.scenarios||Number(summary[2])!==JAVA_ENGINE_LIFECYCLE_EXPECTED.checks)throw new Error(`Lifecycle scenario/check counts differ: ${stdout}`);const expected=JAVA_ENGINE_LIFECYCLE_SCENARIOS.map(name=>`PASS ${name}`);if(JSON.stringify(lines)!==JSON.stringify(expected))throw new Error(`Lifecycle scenarios differ: ${stdout}`);return [...JAVA_ENGINE_LIFECYCLE_SCENARIOS];}
async function javaHome(java){const result=run(java,['-XshowSettings:properties','-version'],'Java home query',15000);const match=/^\s*java\.home\s*=\s*(.+)$/m.exec(result.stdout+result.stderr);if(!match)throw new Error('Cannot determine java.home');return match[1].trim();}

export async function checkJavaEngineLifecycle({java=process.env.ASTER_JAVA??'java',clang=process.env.ASTER_CLANG??'clang'}={}){
    const temporary=await mkdtemp(join(tmpdir(),'aster-java-engine-lifecycle-'));
    try{
        const classes=join(temporary,'classes'),empty=join(temporary,'empty'),library=join(temporary,'lib');await mkdir(classes);await mkdir(empty);await mkdir(library);
        const fixtureRoot=join(root,'test/java-engine-lifecycle');
        const javaFixtures=await filesIn(fixtureRoot,'.java');
        const nativeFixture=join(fixtureRoot,'native/aster_lifecycle_stub.c');
        const runnerPath=fileURLToPath(import.meta.url);
        const sources=[...JAVA_ENGINE_LIFECYCLE_PRODUCTION_SOURCES.map(path=>join(root,path)),...javaFixtures];
        const inputs=[...sources,nativeFixture,runnerPath];const before=await hashes(inputs);
        const javaVersion=run(java,['-version'],'Java version',15000);const compiler=run(java,['-m','jdk.compiler/com.sun.tools.javac.Main','-version'],'Java compiler version',15000);
        const home=process.env.ASTER_JAVA_HOME??await javaHome(java);const include=join(home,'include');const platform=process.platform==='darwin'?'darwin':'linux';
        const libraryName=process.platform==='darwin'?'libaster.dylib':'libaster.so';
        const nativeArgs=[process.platform==='darwin'?'-dynamiclib':'-shared','-fPIC','-std=c11','-Wall','-Wextra','-Werror',`-I${include}`,`-I${join(include,platform)}`,nativeFixture,'-o',join(library,libraryName)];
        const nativeCompiler=run(clang,nativeArgs,'Host JNI stub compilation');
        const compilerDiagnostics=run(java,javaEngineLifecycleCompilerArguments(classes,empty,sources),'Java lifecycle compilation');
        const compiled=await filesIn(classes,'.class');for(const path of compiled){const bytes=await readFile(path);if(bytes.readUInt32BE(0)!==0xcafebabe||bytes.readUInt16BE(6)!==52)throw new Error(`Expected Java 8 bytecode: ${path}`);}
        const runtime=run(java,['-ea',`-Djava.library.path=${library}`,'-cp',classes,harnessClass],'Java lifecycle runtime',15000);
        const passedScenarios=verifyJavaEngineLifecycleOutput(runtime.stdout,runtime.stderr);
        const after=await hashes(inputs);if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('A lifecycle input changed during the check; rerun against a stable checkpoint.');
        const runnerKey=relative(root,runnerPath).split('\\').join('/'),nativeKey=relative(root,nativeFixture).split('\\').join('/');const runnerSHA256=before[runnerKey],nativeStubSHA256=before[nativeKey];delete before[runnerKey];delete before[nativeKey];
        return {schema:'aster.java-engine-lifecycle',version:1,...JAVA_ENGINE_LIFECYCLE_BOUNDARY,
            javaVersion:(javaVersion.stdout+javaVersion.stderr).trim(),compiler:(compiler.stdout+compiler.stderr).trim(),
            nativeCompiler:clang,nativeLibraryExtension:extname(libraryName),productionSourcesExecuted:[JAVA_ENGINE_LIFECYCLE_PRODUCTION_SOURCES[0],JAVA_ENGINE_LIFECYCLE_PRODUCTION_SOURCES[3],JAVA_ENGINE_LIFECYCLE_PRODUCTION_SOURCES[4]],
            productionSourcesCompiled:[...JAVA_ENGINE_LIFECYCLE_PRODUCTION_SOURCES],fixtureSources:javaFixtures.map(path=>relative(root,path).split('\\').join('/')),
            sourceSHA256:before,runnerSHA256,nativeStubSHA256,...JAVA_ENGINE_LIFECYCLE_EXPECTED,passedScenarios,
            generatedClassCount:compiled.length,allGeneratedClassesJava8Bytecode:true,compilerDiagnostics,nativeCompilerDiagnostics:nativeCompiler,
            runtime,warningsAsErrors:true,suppressedLintCategories:['options'],timeoutsMillis:{version:15000,compile:60000,runtime:15000},temporaryOutputRemoved:true};
    }finally{await rm(temporary,{recursive:true,force:true});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    if(process.argv.length!==2)throw new Error('Usage: node scripts/check-java-engine-lifecycle.mjs (optional ASTER_JAVA, ASTER_JAVA_HOME, ASTER_CLANG)');
    console.log(JSON.stringify(await checkJavaEngineLifecycle(),null,2));
}
