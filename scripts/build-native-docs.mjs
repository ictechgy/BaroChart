// 네이티브 SDK API 레퍼런스를 만든다: iOS는 DocC 아카이브, Android는 Javadoc HTML.
//   node scripts/build-native-docs.mjs [--ios-only|--android-only]
// 결과는 artifacts/docs/ 아래에 두고, 각 도구의 경고 수를 artifacts/docs/report.json에 남긴다.
// 경고가 하나라도 있으면 종료 코드 1로 끝난다(문서 주석 품질 게이트).
import {spawnSync} from 'node:child_process';
import {cp,mkdir,readdir,rm,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const out=join(root,'artifacts/docs');
const only=process.argv.includes('--ios-only')?'ios':process.argv.includes('--android-only')?'android':null;

/** 명령을 실행하고 출력 전체를 돌려준다. 실패하면 출력 끝부분과 함께 예외를 던진다 */
function run(command,args){
 const result=spawnSync(command,args,{cwd:root,encoding:'utf8',maxBuffer:256*1024*1024});
 const output=(result.stdout??'')+(result.stderr??'');
 if(result.status!==0)throw new Error(`${command} ${args.slice(0,2).join(' ')} failed (exit ${result.status}). Output tail:\n${output.slice(-4000)}`);
 return output;
}
/** 출력에서 경고 줄만 중복 없이 모은다 */
function warningLines(output){return [...new Set(output.split('\n').filter(line=>/\bwarning:/.test(line)).map(line=>line.trim()))];}

/** DocC: SwiftPM 패키지 스킴을 iOS용으로 docbuild하고 .doccarchive를 복사한다 */
async function buildDocC(){
 const derived=join(out,'docc-derived-data');
 const output=run('xcodebuild',['docbuild','-scheme','BaroChart','-destination','generic/platform=iOS','-derivedDataPath',derived]);
 const products=join(derived,'Build/Products');
 let archive=null;
 for(const dir of await readdir(products))for(const name of await readdir(join(products,dir)))if(name==='BaroChart.doccarchive')archive=join(products,dir,name);
 if(!archive)throw new Error('xcodebuild docbuild finished but BaroChart.doccarchive was not produced; check the scheme name and DocC support in this Xcode');
 await rm(join(out,'BaroChart.doccarchive'),{recursive:true,force:true});
 await cp(archive,join(out,'BaroChart.doccarchive'),{recursive:true});
 await rm(derived,{recursive:true,force:true});
 return {archive:'artifacts/docs/BaroChart.doccarchive',warnings:warningLines(output)};
}

/** Javadoc: 공개 Java API를 android.jar 위에서 -Xdoclint로 검사하며 HTML을 만든다 */
async function buildJavadoc(){
 const sdk=process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk');
 const sourceDir=join(root,'native/android/java/kr/coden/barochart');
 const sources=(await readdir(sourceDir)).filter(name=>name.endsWith('.java')).map(name=>join(sourceDir,name));
 const javadoc=join(process.env.ASTER_GRADLE_JAVA_HOME??'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home','bin/javadoc');
 const target=join(out,'javadoc');
 await rm(target,{recursive:true,force:true});
 // missing 그룹까지 포함한다: 공개 API의 모든 선언에 문서 주석이 있어야 한다(-Xmaxwarns로 100개 상한 없이 전부 센다)
 const output=run(javadoc,['-quiet','-Xmaxwarns','10000','-Xdoclint:all','-public','-encoding','UTF-8','-d',target,
  '-classpath',join(sdk,'platforms/android-36/android.jar'),'-sourcepath',join(root,'native/android/annotation-stubs'),
  '-windowtitle','BaroChart for Android','-doctitle','BaroChart for Android API',...sources]);
 return {html:'artifacts/docs/javadoc/index.html',warnings:warningLines(output)};
}

await mkdir(out,{recursive:true});
const report={};
if(only!=='android')report.docc=await buildDocC();
if(only!=='ios')report.javadoc=await buildJavadoc();
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
const total=Object.values(report).reduce((sum,part)=>sum+part.warnings.length,0);
for(const [tool,part] of Object.entries(report)){console.log(`${tool}: ${part.warnings.length} warnings`);for(const line of part.warnings.slice(0,40))console.log('  '+line);}
if(total>0){console.error(`Documentation warnings: ${total}. Fix the doc comments listed above, then rerun.`);process.exit(1);}
