// Rust/Android SDK size measurement. Builds only under ignored artifacts/rust-size.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {arch, homedir, platform, release, tmpdir} from 'node:os';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {checkElfAlignment} from '../check-elf-alignment.mjs';
import {rustupBinDirectory} from './cargo.mjs';

export const SIZE_BUDGET=5_242_880;
const PREVIOUS_SIZE_BUDGET=3_145_728;
export const PORT_SCOPE=Object.freeze({
 stableRustLinesEstimate:27_850,
 tierANetNewRustLinesEstimate:10_000,
 totalRustLinesEstimate:37_850,
 kind:'reader-estimate-not-measurement',
});
export const PROFILES=Object.freeze([
 Object.freeze({id:'opt-s-panic-unwind',optLevel:'s',panic:'unwind',shipping:true}),
 Object.freeze({id:'opt-3-panic-unwind',optLevel:'3',panic:'unwind',shipping:false}),
 Object.freeze({id:'opt-s-panic-abort',optLevel:'s',panic:'abort',shipping:false}),
 Object.freeze({id:'opt-3-panic-abort',optLevel:'3',panic:'abort',shipping:false}),
]);
export const ANDROID_ABIS=Object.freeze([
 Object.freeze({abi:'arm64-v8a',target:'aarch64-linux-android',linker:'aarch64-linux-android26-clang'}),
 Object.freeze({abi:'x86_64',target:'x86_64-linux-android',linker:'x86_64-linux-android26-clang'}),
]);
export const ANDROID_CONFIGURATIONS=Object.freeze([
 Object.freeze({id:'dual',rust:true,quickjs:true}),
 Object.freeze({id:'rustOnly',rust:true,quickjs:false}),
 Object.freeze({id:'jsOnly',rust:false,quickjs:true}),
]);

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const CARGO_SCRIPT=join(ROOT,'scripts/rust/cargo.mjs');
const DEFAULT_OUT=join(ROOT,'artifacts/rust-size');
const DEFAULT_REPORT=join(ROOT,'docs/measurements/rust-core-size.json');
const RUST_CRATES=['barochart-js','barochart-core','barochart-bridge','barochart-ffi'];

/** Actual scaffold and an independent design-prior scenario. Neither is a full-port bound. */
export function scenarioForecast({jsOnlyBytes,dualScaffoldBytes,designPriorRustBytes=2_621_440,budgetBytes=SIZE_BUDGET}){
 const measured=Math.max(0,dualScaffoldBytes-jsOnlyBytes);
 const scenario=designPriorRustBytes;
 return {
  method:'actual measured scaffold plus an independent 2.5 MiB design-prior scenario; the scenario is not a bound or probability interval',
  assumptions:[
   'Measured scaffold contribution is the current linked delta, not a prediction of remaining work.',
   'The 2.5 MiB value is the high scenario named by design §5.5; a full port may be smaller or larger.',
   'The 37,850-line reader estimate describes scope and carries no byte-growth law.',
  ],
  rustContributionBytes:{measuredScaffold:measured,designPriorScenario:scenario},
  dualBytes:{measuredScaffold:dualScaffoldBytes,designPriorScenario:jsOnlyBytes+scenario},
  budget:{bytes:budgetBytes,actualExceeds:dualScaffoldBytes>budgetBytes,designPriorScenarioExceeds:jsOnlyBytes+scenario>budgetBytes},
 };
}

/** Required by the old plan as a diagnostic only; fixed runtime overhead makes it unreliable. */
export function naiveLocDiagnostic({linkedRustDeltaBytes,compiledScaffoldRustLines,totalScopeLines,jsOnlyBytes,budgetBytes=SIZE_BUDGET}){
 if(!Number.isSafeInteger(compiledScaffoldRustLines)||compiledScaffoldRustLines<=0||!Number.isSafeInteger(totalScopeLines)||totalScopeLines<=0){
  throw new RangeError('LOC diagnostics require positive safe integer source and scope line counts');
 }
 const ratio=linkedRustDeltaBytes/compiledScaffoldRustLines;
 const projectedRustBytes=Math.round(ratio*totalScopeLines),projectedDualBytes=jsOnlyBytes+projectedRustBytes;
 return {
  formula:'linked Rust scaffold delta / physical .rs lines under src/ in the four linked shipping crates (tests and tools excluded; all cfg branches included) × authoritative estimated total Rust lines',
  numerator:{linkedRustDeltaBytes},denominator:{shippingCrateSrcPhysicalLinesAllCfgBranches:compiledScaffoldRustLines,crates:[...RUST_CRATES]},scopeLinesEstimate:totalScopeLines,
  bytesPerCompiledScaffoldLine:ratio,projectedRustBytes,projectedDualBytes,exceedsBudget:projectedDualBytes>budgetBytes,
  warning:'Naive diagnostic only: fixed std/allocator/FFI overhead dominates the scaffold, while future chart logic and tables do not scale linearly. Do not use as a growth law.',
  useForDecision:false,
 };
}

/**
 * Original Android SDK size contract: one ABI's native .so plus the packaged
 * classes.jar and QuickJS core asset when QuickJS is enabled. APK compression,
 * R8 shrinking, and install/runtime overhead are intentionally excluded.
 */
export function androidSdkSize({abi,nativeSo,classesJar,coreAsset=null,quickjs=true,profile,configuration,budgetBytes=SIZE_BUDGET,sourceSha256,packagingSha256}){
 if(!abi||!profile||!configuration)throw new TypeError('Android SDK size requires ABI, profile, and configuration provenance');
 if(!nativeSo||!Number.isSafeInteger(nativeSo.bytes)||nativeSo.bytes<=0||typeof nativeSo.sha256!=='string')throw new TypeError('Android SDK size requires a native .so artifact');
 if(!classesJar||!Number.isSafeInteger(classesJar.bytes)||classesJar.bytes<=0||typeof classesJar.sha256!=='string')throw new TypeError('Android SDK size requires a classes.jar artifact');
 if(quickjs&&(!coreAsset||!Number.isSafeInteger(coreAsset.bytes)||coreAsset.bytes<=0||typeof coreAsset.sha256!=='string'))throw new TypeError('QuickJS Android SDK size requires a core asset artifact');
 const entries={['jni/'+abi+'/libbarochart.so']:{...nativeSo},'classes.jar':{...classesJar}};
 if(quickjs)entries['assets/aster-core.js']={...coreAsset};
 const bytes=Object.values(entries).reduce((sum,item)=>sum+item.bytes,0);
 return {
  definition:'per-ABI release AAR entries: native .so + classes.jar + assets/aster-core.js when QuickJS is included; uncompressed bytes',
  entries,bytes,
  provenance:{kind:'fresh-java-only-packaging-plus-native-matrix',abi,profile,configuration,quickjs,sourceSha256,packagingSha256},
  budget:{bytes:budgetBytes,exceeds:bytes>budgetBytes,remaining:budgetBytes-bytes},
 };
}

/** Parses Apple's `size -m` segment report. */
export function parseAppleSize(output,fileBytes){
 const match=/^Segment __TEXT:\s*(\d+)\s*$/m.exec(output);
 if(!match)throw new Error('Apple size output is missing Segment __TEXT');
 return {fileBytes,textSegmentBytes:Number(match[1])};
}

/** Replaces checkout/NDK/home prefixes so durable reports contain no user-specific path. */
export function portablePath(path,root=ROOT,ndk=null){
 if(!isAbsolute(path))return path;
 const absolute=resolve(path),pairs=[[resolve(root),'$REPO']];
 if(ndk)pairs.push([resolve(ndk),'$NDK']);
 pairs.push([resolve(homedir()),'$HOME']);pairs.sort((a,b)=>b[0].length-a[0].length);
 for(const [prefix,label] of pairs)if(absolute===prefix||absolute.startsWith(prefix+sep))return label+(absolute===prefix?'':'/'+relative(prefix,absolute).split(sep).join('/'));
 return path;
}

/** Validates matrix completeness, packaging provenance, and privacy of a durable report. */
export function validateReport(report,{sourceSha256=null,androidPackagingSha256=null,coreAssetSha256=null}={}){
 if(report?.schema!=='barochart.rust-core-size'||report.version!==1||report.budgetBytes!==SIZE_BUDGET)throw new Error('invalid size report header');
 if(report.ownerBudgetDecision?.date!=='2026-11-04'||report.ownerBudgetDecision.previousBudgetBytes!==PREVIOUS_SIZE_BUDGET||report.ownerBudgetDecision.currentBudgetBytes!==SIZE_BUDGET||report.ownerBudgetDecision.noBinaryRebuild!==true||report.ownerBudgetDecision.defaultBackend!=='JavaScript pending device gates')throw new Error('missing owner budget decision');
 if(report.source?.sha256==null||report.source?.androidPackagingSha256==null||report.source?.coreAssetSha256==null||report.source?.scope?.totalRustLinesEstimate!==37_850)throw new Error('missing source provenance');
 if(sourceSha256!==null&&report.source.sha256!==sourceSha256)throw new Error('report source changed during measurement');
 if(androidPackagingSha256!==null&&report.source.androidPackagingSha256!==androidPackagingSha256)throw new Error('report Android packaging source changed during measurement');
 if(coreAssetSha256!==null&&report.source.coreAssetSha256!==coreAssetSha256)throw new Error('report core asset changed during measurement');
 const profiles=PROFILES.map(item=>item.id),abis=ANDROID_ABIS.map(item=>item.abi);
 if(JSON.stringify(report.android?.profiles)!==JSON.stringify(profiles)||JSON.stringify(report.android?.abis)!==JSON.stringify(abis))throw new Error('missing Android ABI/profile matrix');
 for(const abi of abis)for(const profile of profiles){
  const row=report.android?.artifacts?.[abi]?.[profile];
  for(const kind of ['dual','rustOnly','jsOnly'])if(!(row?.[kind]?.bytes>0)||typeof row[kind].sha256!=='string')throw new Error(`missing Android artifact ${abi}/${profile}/${kind}`);
  const packagingRows={dual:row?.packaged,rustOnly:row?.rustOnlyPackaged,jsOnly:row?.jsOnlyPackaged};
  for(const configuration of ANDROID_CONFIGURATIONS){
   const packaging=packagingRows[configuration.id];
   if(!(packaging?.bytes>0)||typeof packaging.provenance?.sourceSha256!=='string'||typeof packaging.provenance?.packagingSha256!=='string'||packaging.provenance.abi!==abi||packaging.provenance.profile!==profile||packaging.provenance.configuration!==configuration.id||packaging.provenance.quickjs!==configuration.quickjs)throw new Error(`missing Android package provenance ${abi}/${profile}/${configuration.id}`);
   const nativeEntry=packaging.entries?.['jni/'+abi+'/libbarochart.so'],classesEntry=packaging.entries?.['classes.jar'];
   for(const [name,entry] of [['jni/'+abi+'/libbarochart.so',nativeEntry],['classes.jar',classesEntry]])if(!(entry?.bytes>0)||typeof entry.sha256!=='string'||typeof entry.provenance?.kind!=='string')throw new Error(`missing Android package entry ${abi}/${profile}/${configuration.id}/${name}`);
   if(nativeEntry.bytes!==row[configuration.id].bytes||nativeEntry.sha256!==row[configuration.id].sha256)throw new Error(`inconsistent Android native package entry ${abi}/${profile}/${configuration.id}`);
   if(classesEntry.provenance.configuration!==configuration.id||classesEntry.provenance.profile!==profile||typeof classesEntry.provenance.packagingSha256!=='string')throw new Error(`missing classes.jar provenance ${abi}/${profile}/${configuration.id}`);
   const coreEntry=packaging.entries?.['assets/aster-core.js'];
   if(configuration.quickjs&&(!(coreEntry?.bytes>0)||typeof coreEntry.sha256!=='string'||typeof coreEntry.provenance?.kind!=='string'||coreEntry.provenance.configuration!==configuration.id))throw new Error(`missing Android core asset ${abi}/${profile}/${configuration.id}`);
   const entryBytes=Object.values(packaging.entries).reduce((sum,entry)=>sum+entry.bytes,0);
   if(packaging.bytes!==entryBytes)throw new Error(`inconsistent Android package total ${abi}/${profile}/${configuration.id}`);
   if(!Number.isInteger(packaging.budget?.bytes)||typeof packaging.budget.exceeds!=='boolean'||packaging.budget.bytes!==SIZE_BUDGET||packaging.budget.remaining!==SIZE_BUDGET-packaging.bytes||packaging.budget.exceeds!==(packaging.bytes>SIZE_BUDGET))throw new Error(`missing Android package budget ${abi}/${profile}/${configuration.id}`);
  }
 }
 for(const kind of ['baseline','rustReferenced'])if(!(report.ios?.[kind]?.fileBytes>0)||!(report.ios?.[kind]?.textSegmentBytes>0)||typeof report.ios[kind].sha256!=='string')throw new Error(`missing iOS ${kind}`);
 if(!Number.isInteger(report.ios?.delta?.fileBytes)||!Number.isInteger(report.ios?.delta?.textSegmentBytes))throw new Error('missing iOS link delta');
 if(!Array.isArray(report.commands)||!report.commands.length)throw new Error('missing reproducible commands');
 if(!abis.every(abi=>report.forecast&&abi in report.forecast))throw new Error('missing historical forecast diagnostics');
 if(/(?:\/Users\/|\/home\/[^$]|[A-Za-z]:\\Users\\)/.test(JSON.stringify(report)))throw new Error('report contains an absolute user path');
 return true;
}

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

function parseArgs(argv){
 const values=new Map(),flags=new Set();
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];if(!arg.startsWith('--'))throw new Error(`unexpected argument ${arg}`);
  if(arg==='--help'){flags.add(arg);continue;}
  if(i+1>=argv.length||argv[i+1].startsWith('--'))throw new Error(`${arg} requires a value`);
  values.set(arg,argv[++i]);
 }
 return {value:(name,fallback)=>values.get(name)??fallback,has:name=>flags.has(name)};
}

function run(command,args,{cwd=ROOT,env=process.env,commands=null,portableCommand=null,stdio='pipe'}={}){
 if(commands)commands.push(portableCommand??[command,...args]);
 const result=spawnSync(command,args,{cwd,env,encoding:'utf8',maxBuffer:256<<20,stdio:stdio==='inherit'?'inherit':['ignore','pipe','pipe']});
 if(result.error||result.status!==0)throw new Error(`${command} ${args.join(' ')} failed (${result.error?.message??`exit ${result.status}`}):\n${(result.stderr??'').slice(-6000)}\n${(result.stdout??'').slice(-3000)}`);
 return result.stdout??'';
}

async function filesBelow(directory,predicate=()=>true){
 const out=[];for(const entry of await readdir(directory,{withFileTypes:true})){
  const path=join(directory,entry.name);if(entry.isDirectory())out.push(...await filesBelow(path,predicate));else if(predicate(path))out.push(path);
 }return out;
}

async function discoverGradle(explicit=null){
 const candidates=[];
 if(explicit)candidates.push(resolve(explicit));
 if(process.env.ASTER_GRADLE)candidates.push(resolve(process.env.ASTER_GRADLE));
 const wrapperRoot=join(homedir(),'.gradle/wrapper/dists/gradle-8.14.5-bin');
 try{
  for(const distribution of await readdir(wrapperRoot,{withFileTypes:true}))if(distribution.isDirectory())candidates.push(join(wrapperRoot,distribution.name,'gradle-8.14.5/bin/gradle'));
 }catch(error){if(error.code!=='ENOENT')throw error;}
 const gradle=candidates.find(path=>existsSync(path));
 if(!gradle)throw new Error('missing Gradle 8.14.5 executable; pass --gradle or ASTER_GRADLE');
 return gradle;
}

async function hashFileSet(files){
 const hash=createHash('sha256');for(const file of [...files].sort()){hash.update(relative(ROOT,file).split(sep).join('/'));hash.update('\0');hash.update(await readFile(file));hash.update('\0');}return hash.digest('hex');
}

export async function measurementSourceProvenance(){
 const rust=[];for(const name of RUST_CRATES)rust.push(...await filesBelow(join(ROOT,'rust/crates',name),path=>path.endsWith(`Cargo.toml`)||path.endsWith('.rs')&&path.includes(`${sep}src${sep}`)));
 rust.push(join(ROOT,'rust/Cargo.toml'),join(ROOT,'rust/Cargo.lock'),join(ROOT,'rust/rust-toolchain.toml'));
 const android=[join(ROOT,'native/android/aster_jni.c'),join(ROOT,'native/android/library/CMakeLists.txt'),join(ROOT,'native/android/library/barochart.map'),join(ROOT,'rust/include/barochart_core.h'),...await filesBelow(join(ROOT,'native/android/quickjs'),path=>/\.[ch]$/.test(path))];
 const packaging=[join(ROOT,'native/android/library/build.gradle'),...await filesBelow(join(ROOT,'native/android/java'),path=>path.endsWith('.java'))];
 const coreAsset=join(ROOT,'native/Resources/aster-core.js');
 let lines=0;for(const file of rust.filter(path=>path.endsWith('.rs'))){const text=await readFile(file,'utf8');lines+=text.split('\n').length-(text.endsWith('\n')?1:0);}
 return {
  sha256:await hashFileSet([...new Set([...rust,...android])]),rustSha256:await hashFileSet(rust),androidLinkSha256:await hashFileSet(android),
  androidPackagingSha256:await hashFileSet(packaging),coreAssetSha256:sha256(await readFile(coreAsset)),currentScaffoldRustPhysicalLines:lines,scope:PORT_SCOPE,
  evidence:{design:'docs/superpowers/specs/2026-11-02-rust-core-design.md §5.5',tierA:'docs/superpowers/specs/2026-11-02-rust-core-porting-map-tier-a.md §7.1'},
 };
}

function minimalEnvironment(extra={}){
 return {PATH:process.env.PATH,CARGO_HOME:process.env.CARGO_HOME??join(homedir(),'.cargo'),RUSTUP_HOME:process.env.RUSTUP_HOME??join(homedir(),'.rustup'),TMPDIR:process.env.TMPDIR??tmpdir(),JAVA_HOME:process.env.ASTER_GRADLE_JAVA_HOME??'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',ANDROID_HOME:process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk'),CARGO_BUILD_JOBS:'2',CARGO_INCREMENTAL:'0',CARGO_NET_OFFLINE:'true',...extra};
}

async function artifact(path,metadata={}){const bytes=await readFile(path);return {bytes:bytes.length,sha256:sha256(bytes),...metadata};}
async function fresh(directory){await rm(directory,{recursive:true,force:true});await mkdir(directory,{recursive:true});}
const firstLine=text=>text.trim().split('\n')[0];

async function discoverTools(args){
 const sdk=resolve(args.value('--android-sdk',process.env.ANDROID_SDK_ROOT??process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk')));
 const ndk=resolve(args.value('--ndk',process.env.ANDROID_NDK_HOME??join(sdk,'ndk/29.0.14033849')));
 const host=platform()==='darwin'?'darwin-x86_64':'linux-x86_64';
 const llvmBin=join(ndk,'toolchains/llvm/prebuilt',host,'bin');
 const cmake=resolve(args.value('--cmake',join(sdk,'cmake/3.22.1/bin/cmake')));
 const ninja=resolve(args.value('--ninja',join(sdk,'cmake/3.22.1/bin/ninja')));
 const node=resolve(args.value('--node',process.execPath));
 const strip=resolve(args.value('--llvm-strip',join(llvmBin,'llvm-strip')));
 const gradle=await discoverGradle(args.value('--gradle',null));
 for(const [name,path] of Object.entries({ndk,cmake,ninja,node,strip,gradle}))if(!existsSync(path))throw new Error(`missing ${name}: ${path}`);
 return {sdk,ndk,llvmBin,cmake,ninja,node,strip,gradle,xcrun:args.value('--xcrun','xcrun')};
}

function cargoEnvironment(tools,targetDir,profile,linkerVariable=null,linker=null){
 const extra={
  CARGO_TARGET_DIR:targetDir,
  CARGO_PROFILE_RELEASE_OPT_LEVEL:profile.optLevel,
  CARGO_PROFILE_RELEASE_PANIC:profile.panic,
 };
 if(linkerVariable)extra[linkerVariable]=linker;
 return minimalEnvironment(extra);
}

function cargoBuild(tools,targetDir,profile,target,linker,commands){
 const variable=`CARGO_TARGET_${target.toUpperCase().replaceAll('-','_')}_LINKER`;
 const env=cargoEnvironment(tools,targetDir,profile,variable,join(tools.llvmBin,linker));
 run(tools.node,[CARGO_SCRIPT,'build','--locked','--release','-p','barochart-ffi','--target',target],{
  env,commands,portableCommand:['env',`CARGO_TARGET_DIR=$OUT/rust-target/${profile.id}`,`CARGO_PROFILE_RELEASE_OPT_LEVEL=${profile.optLevel}`,`CARGO_PROFILE_RELEASE_PANIC=${profile.panic}`,'CARGO_BUILD_JOBS=2','CARGO_INCREMENTAL=0','CARGO_NET_OFFLINE=true',`${variable}=$NDK/toolchains/llvm/prebuilt/$NDK_HOST/bin/${linker}`,'$NODE','scripts/rust/cargo.mjs','build','--locked','--release','-p','barochart-ffi','--target',target],stdio:'inherit',
 });
}

async function buildAndroidShared({tools,out,profile,abi,configuration,rustTargetDir,commands,source}){
 const withQuickjs=configuration==='dual',withRust=true;
 const build=join(out,'build/android',profile.id,configuration,abi.abi);
 await fresh(build);
 const args=[
  '-S',join(ROOT,'native/android/library'),'-B',build,'-G','Ninja',
  `-DCMAKE_TOOLCHAIN_FILE=${join(tools.ndk,'build/cmake/android.toolchain.cmake')}`,
  `-DCMAKE_MAKE_PROGRAM=${tools.ninja}`,
  `-DANDROID_NDK=${tools.ndk}`,`-DANDROID_ABI=${abi.abi}`,'-DANDROID_PLATFORM=android-26',
  '-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON','-DCMAKE_BUILD_TYPE=Release',
  `-DWITH_QUICKJS=${withQuickjs?'ON':'OFF'}`,`-DWITH_RUST=${withRust?'ON':'OFF'}`,`-DBAROCHART_RUST_LIB=${rustTargetDir}`,
 ];
 run(tools.cmake,args,{commands,portableCommand:['$CMAKE','-S','native/android/library','-B',`$OUT/build/android/${profile.id}/${configuration}/${abi.abi}`,'-G','Ninja','-DCMAKE_TOOLCHAIN_FILE=$NDK/build/cmake/android.toolchain.cmake','-DCMAKE_MAKE_PROGRAM=$NINJA','-DANDROID_NDK=$NDK',`-DANDROID_ABI=${abi.abi}`,'-DANDROID_PLATFORM=android-26','-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON','-DCMAKE_BUILD_TYPE=Release',`-DWITH_QUICKJS=${withQuickjs?'ON':'OFF'}`,'-DWITH_RUST=ON',`-DBAROCHART_RUST_LIB=$OUT/rust-target/${profile.id}`]});
 run(tools.cmake,['--build',build,'--target','barochart','--','-j2'],{commands,portableCommand:['$CMAKE','--build',`$OUT/build/android/${profile.id}/${configuration}/${abi.abi}`,'--target','barochart','--','-j2'],stdio:'inherit'});
 const raw=join(build,'libbarochart.so');if(!existsSync(raw))throw new Error(`CMake did not produce ${raw}`);
 const destination=join(out,'artifacts/android',abi.abi,profile.id,configuration,'libbarochart.so');await mkdir(dirname(destination),{recursive:true});
 run(tools.strip,['--strip-unneeded','-o',destination,raw],{commands,portableCommand:['$LLVM_STRIP','--strip-unneeded','-o',`$OUT/artifacts/android/${abi.abi}/${profile.id}/${configuration}/libbarochart.so`,`$OUT/build/android/${profile.id}/${configuration}/${abi.abi}/libbarochart.so`]});
 const alignment=checkElfAlignment(await readFile(destination));if(!alignment.ok)throw new Error(`${abi.abi}/${profile.id}/${configuration} is not 16 KiB aligned`);
 return artifact(destination,{path:portablePath(destination,ROOT,tools.ndk),provenance:{kind:'fresh-isolated-build',sourceSha256:source.sha256,profile:profile.id},loadAlignments:alignment.segments.map(item=>item.align)});
}

async function buildAndroidJsOnly({tools,out,abi,commands,source}){
 const profile=PROFILES[0],build=join(out,'build/android/js-only',abi.abi);await fresh(build);
 const args=['-S',join(ROOT,'native/android/library'),'-B',build,'-G','Ninja',`-DCMAKE_TOOLCHAIN_FILE=${join(tools.ndk,'build/cmake/android.toolchain.cmake')}`,`-DCMAKE_MAKE_PROGRAM=${tools.ninja}`,`-DANDROID_NDK=${tools.ndk}`,`-DANDROID_ABI=${abi.abi}`,'-DANDROID_PLATFORM=android-26','-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON','-DCMAKE_BUILD_TYPE=Release','-DWITH_QUICKJS=ON','-DWITH_RUST=OFF'];
 run(tools.cmake,args,{commands,portableCommand:['$CMAKE','-S','native/android/library','-B',`$OUT/build/android/js-only/${abi.abi}`,'-G','Ninja','-DCMAKE_TOOLCHAIN_FILE=$NDK/build/cmake/android.toolchain.cmake','-DCMAKE_MAKE_PROGRAM=$NINJA','-DANDROID_NDK=$NDK',`-DANDROID_ABI=${abi.abi}`,'-DANDROID_PLATFORM=android-26','-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON','-DCMAKE_BUILD_TYPE=Release','-DWITH_QUICKJS=ON','-DWITH_RUST=OFF']});
 run(tools.cmake,['--build',build,'--target','barochart','--','-j2'],{commands,portableCommand:['$CMAKE','--build',`$OUT/build/android/js-only/${abi.abi}`,'--target','barochart','--','-j2'],stdio:'inherit'});
 const raw=join(build,'libbarochart.so'),destination=join(out,'artifacts/android',abi.abi,'js-only/libbarochart.so');await mkdir(dirname(destination),{recursive:true});
 run(tools.strip,['--strip-unneeded','-o',destination,raw],{commands,portableCommand:['$LLVM_STRIP','--strip-unneeded','-o',`$OUT/artifacts/android/${abi.abi}/js-only/libbarochart.so`,`$OUT/build/android/js-only/${abi.abi}/libbarochart.so`]});
 const alignment=checkElfAlignment(await readFile(destination));if(!alignment.ok)throw new Error(`${abi.abi}/js-only is not 16 KiB aligned`);
 return artifact(destination,{path:portablePath(destination,ROOT,tools.ndk),provenance:{kind:'fresh-isolated-build',sourceSha256:source.sha256,profileIndependent:true},loadAlignments:alignment.segments.map(item=>item.align)});
}

async function prepareAndroidJavaOnly({tools,out,profile,configuration,commands,source}){
 const build=join(out,'build/android-java',profile.id,configuration.id);await fresh(build);
 const core=join(ROOT,'native/Resources/aster-core.js');
 const args=['--offline','--no-daemon','--console=plain','--max-workers=2','-p',join(ROOT,'native/android/library'),`-PbarochartNode=${tools.node}`,`-PasterBuildDir=${build}`,`-PasterCoreFile=${core}`,`-PbarochartRust=${configuration.rust}`,`-PbarochartQuickjs=${configuration.quickjs}`,':syncReleaseLibJars','-x','cargoBuildArm64','-x','cargoBuildX8664'];
 run(tools.gradle,args,{env:minimalEnvironment({ANDROID_HOME:tools.sdk,ANDROID_SDK_ROOT:tools.sdk}),commands,portableCommand:['$GRADLE','--offline','--no-daemon','--console=plain','--max-workers=2','-p','native/android/library',`-PasterBuildDir=$OUT/build/android-java/${profile.id}/${configuration.id}`,'-PbarochartNode=$NODE','-PasterCoreFile=$REPO/native/Resources/aster-core.js',`-PbarochartRust=${configuration.rust}`,`-PbarochartQuickjs=${configuration.quickjs}`,':syncReleaseLibJars','-x','cargoBuildArm64','-x','cargoBuildX8664']});
 const classesPath=join(build,'intermediates/aar_main_jar/release/syncReleaseLibJars/classes.jar');
 if(!existsSync(classesPath))throw new Error(`Gradle did not produce ${classesPath}`);
 const classesJar=await artifact(classesPath,{path:portablePath(classesPath,ROOT,tools.ndk),provenance:{kind:'fresh-java-only-gradle',sourceSha256:source.sha256,packagingSha256:source.androidPackagingSha256,profile:profile.id,configuration:configuration.id}});
 const coreAsset=await artifact(core,{path:'$REPO/native/Resources/aster-core.js',provenance:{kind:'source-asset',sourceSha256:source.sha256,assetSha256:source.coreAssetSha256,configuration:configuration.id,quickjs:configuration.quickjs}});
 return {classesJar,coreAsset,command:commands.at(-1)};
}

async function buildIos({tools,out,commands,source}){
 if(platform()!=='darwin')throw new Error('iOS link measurement requires macOS and Xcode');
 const profile=PROFILES[0],targetDir=join(out,'rust-target/ios',profile.id);await fresh(targetDir);
 run(tools.node,[CARGO_SCRIPT,'build','--locked','--release','-p','barochart-ffi','--target','aarch64-apple-ios'],{
  env:cargoEnvironment(tools,targetDir,profile),commands,portableCommand:['env',`CARGO_TARGET_DIR=$OUT/rust-target/ios/${profile.id}`,'CARGO_PROFILE_RELEASE_OPT_LEVEL=s','CARGO_PROFILE_RELEASE_PANIC=unwind','CARGO_BUILD_JOBS=2','CARGO_INCREMENTAL=0','CARGO_NET_OFFLINE=true','$NODE','scripts/rust/cargo.mjs','build','--locked','--release','-p','barochart-ffi','--target','aarch64-apple-ios'],stdio:'inherit',
 });
 const archive=join(targetDir,'aarch64-apple-ios/release/libbarochart_ffi.a'),directory=join(out,'artifacts/ios');await mkdir(directory,{recursive:true});
 const baselineSource=join(directory,'baseline.c'),rustSource=join(directory,'rust-reference.c');
 await writeFile(baselineSource,'int main(void) { return 0; }\n');
 await writeFile(rustSource,`#include <stddef.h>
#include <stdint.h>
#include "barochart_core.h"
static int32_t zone_resolve(void *context, const uint8_t *name, size_t len, BcBuf *out) { (void)context; (void)name; (void)len; (void)out; return 1; }
static int32_t zone_offset(void *context, const uint8_t *zone, size_t len, double epoch_ms, int32_t *out) { (void)context; (void)zone; (void)len; (void)epoch_ms; (void)out; return 1; }
int main(void) {
  BcHost host = { NULL, zone_resolve, zone_offset, NULL, NULL };
  BcEngine *engine = NULL; BcBuf error = {0}, result = {0};
  if (bc_engine_new(&host, &engine, &error) == BC_OK) {
    const uint8_t name[] = "nativeInit", args[] = "[]";
    (void)bc_call(engine, name, sizeof(name) - 1, args, sizeof(args) - 1, 0, &result);
  }
  bc_buf_free(result); bc_buf_free(error); bc_engine_free(engine); return 0;
}
`);
 const sdk=run(tools.xcrun,['--sdk','iphoneos','--show-sdk-path']).trim(),baseline=join(directory,'baseline'),referenced=join(directory,'rust-referenced');
 const common=['--sdk','iphoneos','clang','-target','arm64-apple-ios15.0','-isysroot',sdk,'-Os','-fno-ident','-Wl,-dead_strip','-Wl,-no_adhoc_codesign'];
 run(tools.xcrun,[...common,baselineSource,'-o',baseline],{commands,portableCommand:['$XCRUN','--sdk','iphoneos','clang','-target','arm64-apple-ios15.0','-isysroot','$IPHONEOS_SDK','-Os','-fno-ident','-Wl,-dead_strip','-Wl,-no_adhoc_codesign','$OUT/artifacts/ios/baseline.c','-o','$OUT/artifacts/ios/baseline']});
 run(tools.xcrun,[...common,'-I',join(ROOT,'rust/include'),rustSource,archive,'-o',referenced],{commands,portableCommand:['$XCRUN','--sdk','iphoneos','clang','-target','arm64-apple-ios15.0','-isysroot','$IPHONEOS_SDK','-Os','-fno-ident','-Wl,-dead_strip','-Wl,-no_adhoc_codesign','-I','rust/include','$OUT/artifacts/ios/rust-reference.c',`$OUT/rust-target/ios/${profile.id}/aarch64-apple-ios/release/libbarochart_ffi.a`,'-o','$OUT/artifacts/ios/rust-referenced']});
 for(const binary of [baseline,referenced])run(tools.xcrun,['strip','-S','-x',binary],{commands,portableCommand:['$XCRUN','strip','-S','-x',portablePath(binary,ROOT,tools.ndk)]});
 const baselineSize=parseAppleSize(run(tools.xcrun,['size','-m',baseline],{commands,portableCommand:['$XCRUN','size','-m','$OUT/artifacts/ios/baseline']}),(await stat(baseline)).size),referencedSize=parseAppleSize(run(tools.xcrun,['size','-m',referenced],{commands,portableCommand:['$XCRUN','size','-m','$OUT/artifacts/ios/rust-referenced']}),(await stat(referenced)).size);
 const baselineArtifact=await artifact(baseline,{...baselineSize,path:portablePath(baseline,ROOT,tools.ndk)}),referencedArtifact=await artifact(referenced,{...referencedSize,path:portablePath(referenced,ROOT,tools.ndk)});
 return {
  qualification:'unsigned arm64 iOS link-only executable; not an IPA, install size, or App Store thinning measurement',
  target:'arm64-apple-ios15.0',profile:profile.id,archive:await artifact(archive,{path:portablePath(archive,ROOT,tools.ndk)}),
  baseline:baselineArtifact,rustReferenced:referencedArtifact,
  delta:{fileBytes:referencedArtifact.fileBytes-baselineArtifact.fileBytes,textSegmentBytes:referencedArtifact.textSegmentBytes-baselineArtifact.textSegmentBytes},
  sourceSha256:source.sha256,
 };
}

async function measure(options){
 const out=resolve(options.value('--out',DEFAULT_OUT)),reportPath=resolve(options.value('--report',DEFAULT_REPORT));
 if([resolve('/'),resolve(homedir()),resolve(ROOT)].includes(out))throw new Error(`unsafe --out ${out}`);
 const tools=await discoverTools(options),commands=[],source=await measurementSourceProvenance();
 await mkdir(out,{recursive:true});await fresh(join(out,'build'));await fresh(join(out,'artifacts'));await fresh(join(out,'rust-target'));
 const toolsMetadata={
  node:process.version,gradle:firstLine(run(tools.gradle,['--version'],{env:minimalEnvironment({ANDROID_HOME:tools.sdk,ANDROID_SDK_ROOT:tools.sdk})})),
  cargo:firstLine(run(tools.node,[CARGO_SCRIPT,'--version'],{env:minimalEnvironment()})),
  rustc:firstLine(run(join(rustupBinDirectory(process.env),'rustc'),['-vV'],{cwd:join(ROOT,'rust'),env:minimalEnvironment()})),
  cmake:firstLine(run(tools.cmake,['--version'])),ninja:firstLine(run(tools.ninja,['--version'])),
  ndk:(await readFile(join(tools.ndk,'source.properties'),'utf8')).split('\n').find(line=>line.startsWith('Pkg.Revision'))?.split('=').at(1)?.trim(),
  appleClang:firstLine(run(tools.xcrun,['--sdk','iphoneos','clang','--version'])),
  host:`${platform()} ${release()} ${arch()}`,
 };

 const javaOnly={};for(const profile of PROFILES){javaOnly[profile.id]={};for(const configuration of ANDROID_CONFIGURATIONS)javaOnly[profile.id][configuration.id]=await prepareAndroidJavaOnly({tools,out,profile,configuration,commands,source});}
 const jsOnly={};for(const abi of ANDROID_ABIS)jsOnly[abi.abi]=await buildAndroidJsOnly({tools,out,abi,commands,source});
 const matrix=Object.fromEntries(ANDROID_ABIS.map(item=>[item.abi,{}]));
 for(const profile of PROFILES){
  const targetDir=join(out,'rust-target/android',profile.id);await fresh(targetDir);
  for(const abi of ANDROID_ABIS)cargoBuild(tools,targetDir,profile,abi.target,abi.linker,commands);
  for(const abi of ANDROID_ABIS){
   const dual=await buildAndroidShared({tools,out,profile,abi,configuration:'dual',rustTargetDir:targetDir,commands,source});
   const rustOnly=await buildAndroidShared({tools,out,profile,abi,configuration:'rust-only',rustTargetDir:targetDir,commands,source});
   const staticlib=await artifact(join(targetDir,abi.target,'release/libbarochart_ffi.a'),{path:`$OUT/rust-target/android/${profile.id}/${abi.target}/release/libbarochart_ffi.a`});
   const packageArtifacts={dual:dual,rustOnly:rustOnly,jsOnly:jsOnly[abi.abi]};
   const packaged=androidSdkSize({abi:abi.abi,nativeSo:packageArtifacts.dual,classesJar:javaOnly[profile.id].dual.classesJar,coreAsset:javaOnly[profile.id].dual.coreAsset,quickjs:true,profile:profile.id,configuration:'dual',sourceSha256:source.sha256,packagingSha256:source.androidPackagingSha256});
   matrix[abi.abi][profile.id]={
    targetProfile:{optLevel:profile.optLevel,panic:profile.panic,lto:'fat',codegenUnits:1,shipping:profile.shipping,qualification:profile.panic==='abort'?'comparison only; shipping requires unwind for catch_unwind':'shipping panic mode'},
    jsOnly:{...jsOnly[abi.abi],sharedAcrossRustProfiles:true},dual,rustOnly,rustStaticlib:staticlib,
    linkedRustDeltaBytes:dual.bytes-jsOnly[abi.abi].bytes,
    nativeSoBudget:{bytes:SIZE_BUDGET,exceeds:dual.bytes>SIZE_BUDGET,remaining:SIZE_BUDGET-dual.bytes},
    packaged,
   };
   for(const configuration of ANDROID_CONFIGURATIONS){
    const native=packageArtifacts[configuration.id],java=javaOnly[profile.id][configuration.id];
    matrix[abi.abi][profile.id][configuration.id==='dual'?'packaged':`${configuration.id}Packaged`]=androidSdkSize({abi:abi.abi,nativeSo:native,classesJar:java.classesJar,coreAsset:java.coreAsset,quickjs:configuration.quickjs,profile:profile.id,configuration:configuration.id,sourceSha256:source.sha256,packagingSha256:source.androidPackagingSha256});
   }
  }
 }

 const ios=await buildIos({tools,out,commands,source}),sourceAfter=await measurementSourceProvenance(),forecast={},naive={};
 if(sourceAfter.sha256!==source.sha256||sourceAfter.androidPackagingSha256!==source.androidPackagingSha256||sourceAfter.coreAssetSha256!==source.coreAssetSha256)throw new Error('Source changed during measurement; repeat against a frozen build');
 for(const abi of ANDROID_ABIS){
  const shipping=matrix[abi.abi][PROFILES[0].id];
  forecast[abi.abi]=scenarioForecast({jsOnlyBytes:shipping.jsOnly.bytes,dualScaffoldBytes:shipping.dual.bytes,budgetBytes:SIZE_BUDGET});
  naive[abi.abi]=naiveLocDiagnostic({linkedRustDeltaBytes:shipping.linkedRustDeltaBytes,compiledScaffoldRustLines:source.currentScaffoldRustPhysicalLines,totalScopeLines:PORT_SCOPE.totalRustLinesEstimate,jsOnlyBytes:shipping.jsOnly.bytes,budgetBytes:SIZE_BUDGET});
 }
 const commit=run('git',['rev-parse','HEAD']).trim();
 const report={
  schema:'barochart.rust-core-size',version:1,generatedAt:new Date().toISOString(),budgetBytes:SIZE_BUDGET,
  qualification:'Current-source Android SDK size measurement. Shipping per-ABI package bytes are native .so + classes.jar + aster-core.js when QuickJS is included; native .so bytes and historical diagnostics are separate and do not approve a full-port artifact choice.',
  source:{...source,commit},tools:toolsMetadata,
  methodology:{
   freshIsolatedBuilds:true,reusedHistoricArtifacts:false,reuseReason:'Existing Task8 artifacts had no durable build-time source/profile hash, so every measured artifact was rebuilt in the isolated output.',
   android:'Release CMake link followed by llvm-strip --strip-unneeded; native .so bytes are retained as a separate diagnostic.',
   androidSdk:'Original Android SDK metric: per-ABI native .so + uncompressed classes.jar + uncompressed assets/aster-core.js when QuickJS is included; APK compression, R8 shrinking, and install/runtime overhead are excluded.',
   androidJavaOnly:'Each profile/configuration classes.jar was freshly compiled with offline Gradle :syncReleaseLibJars in an isolated asterBuildDir; cargoBuildArm64/cargoBuildX8664 and native publication tasks were explicitly excluded.',
   ios:'Unsigned arm64 iOS executable link with identical -Os/dead_strip flags, measured with file stat and Apple size -m __TEXT.',
   abort:'Comparison only. panic=abort invalidates the shipping catch_unwind recovery contract.',
  },
  commandPlaceholders:{'$REPO':'repository root','$OUT':portablePath(out,ROOT,tools.ndk),'$NODE':'configured Node 22 executable','$NDK':'configured Android NDK root','$NDK_HOST':platform()==='darwin'?'darwin-x86_64':'linux-x86_64','$CMAKE':'configured CMake 3.22.1 executable','$NINJA':'configured Ninja executable','$LLVM_STRIP':'NDK llvm-strip','$XCRUN':'Xcode xcrun','$IPHONEOS_SDK':'xcrun --sdk iphoneos --show-sdk-path'},
  commands:commands.map(command=>command.map(item=>portablePath(String(item),ROOT,tools.ndk))),
  android:{abis:ANDROID_ABIS.map(item=>item.abi),profiles:PROFILES.map(item=>item.id),artifacts:matrix},
  ios,forecast,naiveLocDiagnostic:naive,
  ownerBudgetDecision:{date:'2026-11-04',previousBudgetBytes:PREVIOUS_SIZE_BUDGET,currentBudgetBytes:SIZE_BUDGET,decision:'Keep the dual artifact and raise the Android SDK size budget to 5 MiB.',noBinaryRebuild:true,appliesTo:'The threshold-only approval required no binary change; measurement builds are recorded separately.',defaultBackend:'JavaScript pending device gates'},
  conclusions:{
   actualShippingPackageWithinBudget:Object.values(matrix).every(byProfile=>!byProfile[PROFILES[0].id].packaged.budget.exceeds),
   shippingPackageOverBudget:Object.values(matrix).some(byProfile=>byProfile[PROFILES[0].id].packaged.budget.exceeds),
   artifactDecision:'Owner-approved policy: keep the dual artifact and use the 5 MiB Android SDK size budget. Current-source build provenance is recorded above; the default remains JavaScript pending device gates.',
  },
 };
 validateReport(report,{sourceSha256:source.sha256,androidPackagingSha256:source.androidPackagingSha256,coreAssetSha256:source.coreAssetSha256});await mkdir(dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({report:portablePath(reportPath,ROOT,tools.ndk),sourceSha256:source.sha256,budgetBytes:SIZE_BUDGET,actualWithinBudget:report.conclusions.actualShippingPackageWithinBudget,packageOverBudget:report.conclusions.shippingPackageOverBudget,iosDelta:ios.delta}));
 return report;
}

async function main(){
 const args=parseArgs(process.argv.slice(2));
 if(args.has('--help')){
  console.log('Usage: node scripts/rust/measure-size.mjs [--out DIR] [--report FILE] [--android-sdk DIR] [--ndk DIR] [--cmake FILE] [--ninja FILE] [--gradle FILE] [--node FILE] [--llvm-strip FILE] [--xcrun FILE]');return;
 }
 await measure(args);
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await main();
