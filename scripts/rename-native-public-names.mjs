// 일회성 기계적 이름 변경: 네이티브 SDK 공개 이름 Aster* → BaroChart*.
// 설계: docs/superpowers/specs/2026-11-01-native-sdk-commercial-design.md §5.1
// 계획: docs/superpowers/plans/2026-11-01-native-sdk-commercial.md Task 4
//
// 바꾸지 않는 것: 직렬화 스키마(aster.*), JS 브리지 전역(globalThis.Aster)과 native* 함수,
// 리소스 aster-core.js, 웹 React 호환 이름(AsterChart*), 검증 하네스 앱 이름, ASTER_* 환경 변수,
// 날짜가 붙은 과거 기록 문서와 측정 JSON.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';

/** git mv로 옮길 파일 쌍(원래 경로 → 새 경로) */
const MOVES=[
 ['native/AsterNative.swift','native/BaroChartEngine.swift'],
 ['native/AsterUIKit.swift','native/BaroChartUIView.swift'],
 ['native/AsterFrameRenderer.swift','native/BaroChartFrameRenderer.swift'],
 ['native/AsterColumns.swift','native/BaroChartColumns.swift'],
 ['native/android/java/dev/aster/charts/AsterEngine.java','native/android/java/kr/coden/barochart/BaroChartEngine.java'],
 ['native/android/java/dev/aster/charts/AsterChartView.java','native/android/java/kr/coden/barochart/BaroChartView.java'],
 ['native/android/java/dev/aster/charts/AsterColumns.java','native/android/java/kr/coden/barochart/BaroChartColumns.java'],
 ['native/android/java/dev/aster/charts/AsterBitmapCachePool.java','native/android/java/kr/coden/barochart/BaroChartBitmapCachePool.java'],
 ['native/android/java/dev/aster/charts/NativeJobBudget.java','native/android/java/kr/coden/barochart/NativeJobBudget.java'],
 ['native/android/java/dev/aster/charts/WorkspaceRestoreJob.java','native/android/java/kr/coden/barochart/WorkspaceRestoreJob.java'],
 ['native/android/java/dev/aster/charts/ParamsUpdateJob.java','native/android/java/kr/coden/barochart/ParamsUpdateJob.java'],
];

/** 네이티브 소스에 선언된 SDK 타입. 접두사 Aster → BaroChart(예외 2개는 SPECIAL에서 처리) */
const DECLARED=['AsterAsyncBuffer','AsterAsyncCheckpoint','AsterAsyncError','AsterAsyncJob','AsterAsyncKind','AsterAsyncMetrics','AsterAsyncPlan','AsterAsyncProgress','AsterAsyncRuntime','AsterBar','AsterBitmapCachePool','AsterCaptureBox','AsterCaptureReply','AsterColumns','AsterCommand','AsterContextRuntime','AsterCoreGraphicsRenderer','AsterEngine','AsterFrame','AsterFrameRenderer','AsterIngestionError','AsterNativeAdmission','AsterNativeAdmissionLease','AsterNativeCacheBudget','AsterParamsBox','AsterParamsCommitOutcome','AsterParamsError','AsterParamsJob','AsterParamsMetrics','AsterParamsPlan','AsterParamsRegistry','AsterParamsSourceRecord','AsterParamsStatus','AsterRuntimeRetirement','AsterScene','AsterWorkspaceCaptureBox','AsterWorkspaceCleanupStatus','AsterWorkspaceDelivery','AsterWorkspaceDescriptor','AsterWorkspaceError','AsterWorkspaceJob','AsterWorkspaceMetrics','AsterWorkspaceRegistry','AsterWorkspaceRuntime','AsterWorkspaceSourceRecord'];

/** 대상에서 뺄 경로 */
const EXCLUDED=[/^native\/Resources\//,/^docs\/measurements\//,/^docs\/superpowers\//,/^docs\/[A-Z-]*20\d{6}\.md$/,/^docs\/REVIEW-/,/^docs\/PUBLIC-VALIDATION\.md$/,/^HANDOFF\.md$/,/^test\/fixtures\/legacy\//,/^src\//,/^scripts\/rename-native-public-names\.mjs$/,/^assets\//,/\.(png|jpg|jks|aar|apk|bin)$/];

/** 경로·패키지·JNI·라이브러리·리소스 문자열 치환(순서가 중요: 긴 것부터) */
const LITERALS=[
 ['native/android/java/dev/aster/charts','native/android/java/kr/coden/barochart'],
 ['dev/aster/charts','kr/coden/barochart'],
 ['AsterNative.swift','BaroChartEngine.swift'],
 ['AsterUIKit.swift','BaroChartUIView.swift'],
 ['AsterFrameRenderer.swift','BaroChartFrameRenderer.swift'],
 ['AsterColumns.swift','BaroChartColumns.swift'],
 ['AsterChartView.java','BaroChartView.java'],
 ['Java_dev_aster_charts_AsterEngine_','Java_kr_coden_barochart_BaroChartEngine_'],
 ['Java_dev_aster_charts_AsterColumns_','Java_kr_coden_barochart_BaroChartColumns_'],
 ['dev_aster_charts','kr_coden_barochart'],
 ['dev.aster.charts','kr.coden.barochart'],
 ['libaster.so','libbarochart.so'],
 ['loadLibrary("aster")','loadLibrary("barochart")'],
 ['aster_sdk_version','barochart_sdk_version'],
];

/** 파일 목록: git이 추적하는 텍스트 파일 중 제외 규칙에 걸리지 않는 것 */
function targetFiles(){
 return execFileSync('git',['ls-files'],{encoding:'utf8'}).split('\n').filter(Boolean).filter(p=>!EXCLUDED.some(r=>r.test(p)));
}

/** AsterChartView 한 줄을 플랫폼 문맥으로 바꾼다. 판단할 수 없으면 null */
function chartViewLine(line,path){
 if(/\.(java|kt)$/.test(path)||/\.java|android|Android|Java\b|Kotlin|kotlin|JNI|AAR/.test(line))return line.replace(/\bAsterChartView\b/g,'BaroChartView');
 if(/\.swift$/.test(path)||/\.swift|UIKit|iOS|Swift|Apple|SwiftUI|CoreGraphics|UIView/.test(line))return line.replace(/\bAsterChartView\b/g,'BaroChartUIView');
 return null;
}

/** 한 파일의 내용을 바꾸고, 판단 못 한 AsterChartView 줄을 반환한다 */
function renameText(text,path){
 let next=text;
 for(const [from,to] of LITERALS)next=next.split(from).join(to);
 if(path==='native/android/library/CMakeLists.txt')next=next.replace(/\(aster(\s)/g,'(barochart$1').replace('project(aster_android C)','project(barochart_android C)');
 next=next.replace(/\bAsterError\b/g,'BaroChartLowLevelError').replace(/\bAsterNative\b/g,'BaroChart');
 for(const name of DECLARED)next=next.replace(new RegExp('\\b'+name+'\\b','g'),'BaroChart'+name.slice(5));
 const unresolved=[];
 next=next.split('\n').map((line,i)=>{if(!/\bAsterChartView\b/.test(line))return line;const changed=chartViewLine(line,path);if(changed===null){unresolved.push(`${path}:${i+1}`);return line;}return changed;}).join('\n');
 return {next,unresolved};
}

// 같은 패키지 접근이 필요한 Java 테스트 하네스도 새 패키지 디렉터리로 옮긴다
for(const path of execFileSync('git',['ls-files','test'],{encoding:'utf8'}).split('\n')){const match=/^(test\/java-[^/]+)\/dev\/aster\/charts\/(.+)$/.exec(path);if(match)MOVES.push([path,`${match[1]}/kr/coden/barochart/${match[2]}`]);}
for(const [from,to] of MOVES){execFileSync('mkdir',['-p',to.slice(0,to.lastIndexOf('/'))]);execFileSync('git',['mv',from,to]);}
let changedFiles=0;const unresolved=[];
for(const path of targetFiles()){
 let text;try{text=readFileSync(path,'utf8');}catch(error){throw new Error(`Cannot read ${path}: ${error.message}`);}
 const result=renameText(text,path);unresolved.push(...result.unresolved);
 if(result.next!==text){writeFileSync(path,result.next);changedFiles++;}
}
console.log(JSON.stringify({moved:MOVES.length,changedFiles,unresolvedChartView:unresolved},null,1));
