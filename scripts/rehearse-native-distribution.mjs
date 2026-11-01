// 네이티브 SDK 배포 리허설: 레지스트리 없이 로컬 산출물만으로 저장소 밖 소비자 앱이 릴리스 빌드되는지 확인한다.
//   Android: 두 모듈을 artifacts/maven-local에 게시 → POM·AAR 검증 → 저장소 밖 Compose 앱이 로컬 Maven으로 assembleRelease(R8)
//   iOS: 저장소를 임시 경로로 git clone → 임시 태그 → 저장소 밖 SwiftUI 앱이 그 git URL·정확한 태그로 시뮬레이터 빌드
// 원본 저장소에는 태그를 만들지 않으며, 레지스트리 업로드·공개 태그 푸시는 하지 않는다.
// 사용법: node scripts/rehearse-native-distribution.mjs   (커밋된 HEAD 기준으로 iOS를 리허설한다)
import {spawnSync} from 'node:child_process';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const mavenRepo=join(root,'artifacts/maven-local');
const javaHome=process.env.ASTER_GRADLE_JAVA_HOME??'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';
const sdk=process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk');

/** 명령을 실행하고 실패하면 출력 끝부분과 함께 던진다 */
function run(command,args,options={}){
 const result=spawnSync(command,args,{encoding:'utf8',maxBuffer:64*1024*1024,...options,env:{...process.env,JAVA_HOME:javaHome,ANDROID_HOME:sdk,...options.env}});
 if(result.status!==0)throw new Error(`${command} ${args.slice(0,3).join(' ')} failed (${result.status}): ${(result.stderr+result.stdout).slice(-3000)}`);
 return result.stdout;
}

function gradle(){
 const found=spawnSync('sh',['-c','ls ~/.gradle/wrapper/dists/gradle-8.14.5-bin/*/gradle-8.14.5/bin/gradle'],{encoding:'utf8'}).stdout.trim().split('\n')[0];
 return process.env.ASTER_GRADLE??found;
}

function requireThat(condition,message){if(!condition)throw new Error('Distribution rehearsal: '+message);}

/** 두 Android 모듈을 로컬 Maven에 게시하고 POM·AAR을 검증한다 */
async function publishAndroid(){
 await rm(mavenRepo,{recursive:true,force:true});
 run(gradle(),['--console=plain','-p',join(root,'native/android/library'),`-PasterBuildDir=${join(root,'artifacts/publish-build/build')}`,`-PbarochartLocalRepo=${mavenRepo}`,'publishReleasePublicationToLocalRepository',':barochart-compose:publishReleasePublicationToLocalRepository']);
 const base=join(mavenRepo,'kr/coden');
 const corePom=await readFile(join(base,`barochart-android/${version}/barochart-android-${version}.pom`),'utf8');
 const composePom=await readFile(join(base,`barochart-compose/${version}/barochart-compose-${version}.pom`),'utf8');
 for(const pom of [corePom,composePom]){
  requireThat(pom.includes('<groupId>kr.coden</groupId>'),'POM groupId kr.coden');
  requireThat(pom.includes('Apache License, Version 2.0')&&pom.includes('<url>https://github.com/ictechgy/BaroChart</url>'),'POM license and url');
  requireThat(pom.includes('<connection>scm:git:https://github.com/ictechgy/BaroChart.git</connection>'),'POM scm');
 }
 requireThat(!corePom.includes('<dependency>'),'core AAR has no runtime dependencies');
 requireThat(/<artifactId>barochart-android<\/artifactId>\s*<version>[^<]+<\/version>/.test(composePom),'compose depends on barochart-android');
 const aar=join(base,`barochart-android/${version}/barochart-android-${version}.aar`);
 const entries=run('unzip',['-Z1',aar]).split('\n');
 for(const entry of ['assets/licenses/QUICKJS-LICENSE.txt','assets/licenses/NOTICE.txt','assets/licenses/LICENSE.txt','jni/arm64-v8a/libbarochart.so','jni/x86_64/libbarochart.so','assets/aster-core.js'])
  requireThat(entries.includes(entry),'AAR contains '+entry);
 const size=path=>Number(run('stat',['-f','%z',path]).trim());
 return {corePom:'ok',composePom:'ok',coreAarBytes:size(aar),composeAarBytes:size(join(base,`barochart-compose/${version}/barochart-compose-${version}.aar`))};
}

/** 저장소 밖으로 복사한 Compose 샘플을 로컬 Maven 의존으로 릴리스 빌드한다 */
async function buildAndroidConsumer(work){
 const app=join(work,'compose-consumer');
 await cp(join(root,'examples/compose-sample'),app,{recursive:true,filter:path=>!/\/(build|\.gradle|\.kotlin)(\/|$)/.test(path)});
 run(gradle(),['--console=plain','-p',app,'-PbarochartUseMaven=true',`-PbarochartMavenRepo=${mavenRepo}`,`-PbarochartVersion=${version}`,`-PsampleBuildRoot=${join(work,'compose-build')}`,':app:assembleRelease']);
 const apk=join(work,'compose-build/app/outputs/apk/release/app-release.apk');
 return {apkBytes:Number(run('stat',['-f','%z',apk]).trim()),source:'local Maven only (no composite build)'};
}

/** 임시 clone·임시 태그로 SwiftPM 소비를 리허설한다 */
async function buildIOSConsumer(work){
 const clone=join(work,'barochart-clone'),tag=`${version}.rehearsal`;
 run('git',['clone','--quiet','--no-hardlinks',root,clone]);
 run('git',['-C',clone,'tag',tag]);
 const checkoutKiB=Number(run('du',['-sk',clone]).split('\t')[0]),gitKiB=Number(run('du',['-sk',join(clone,'.git')]).split('\t')[0]);
 const app=join(work,'swiftui-consumer');
 await cp(join(root,'examples/swiftui-sample'),app,{recursive:true,filter:path=>!path.includes('.xcodeproj')});
 const spec=(await readFile(join(app,'project.yml'),'utf8')).replace(/  BaroChart:\n    path: \.\.\/\.\.\n/,`  BaroChart:\n    url: file://${clone}\n    exactVersion: ${tag}\n`);
 requireThat(spec.includes('exactVersion'),'project.yml package reference rewritten to the git URL');
 await writeFile(join(app,'project.yml'),spec);
 run('xcodegen',['generate','--spec',join(app,'project.yml'),'--project',app],{cwd:app});
 run('xcodebuild',['build','-project',join(app,'BaroChartSample.xcodeproj'),'-scheme','BaroChartSample','-destination','generic/platform=iOS Simulator','-derivedDataPath',join(work,'swiftui-dd'),'-clonedSourcePackagesDirPath',join(work,'spm'),'CODE_SIGNING_ALLOWED=NO'],{cwd:app});
 return {tag,checkoutKiB,gitHistoryKiB:gitKiB,source:'git URL + exact tag (no local path)'};
}

const work=await mkdtemp(join(tmpdir(),'barochart-distribution-'));
try{
 const report={schema:'barochart.native-distribution-rehearsal',version:1,date:new Date().toISOString().slice(0,10),sdkVersion:version};
 report.android=await publishAndroid();
 report.androidConsumer=await buildAndroidConsumer(work);
 report.iosConsumer=await buildIOSConsumer(work);
 report.notPerformed=['Maven Central upload or signing','public git tag push','physical device install'];
 await mkdir(join(root,'docs/measurements'),{recursive:true});
 await writeFile(join(root,'docs/measurements/native-distribution-rehearsal.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}finally{
 await rm(work,{recursive:true,force:true});
}
