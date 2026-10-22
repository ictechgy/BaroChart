# Android AAR와 Kotlin 소비 앱

Opt-in [unchanged batch overloads](NATIVE-BATCH-UNCHANGED.md) preserve default notifications and expose exact final-value deduplication.

Opt-in native bar selection and explicit value reads are available through four experimental methods; see [native data exploration](NATIVE-DATA-EXPLORATION.md). No automatic keyboard or platform accessibility wiring is included.

The thin `deleteDrawings` method forwards explicit IDs using the ordinary checked
command and existing mutation notification. See [atomic group deletion](DRAWING-DELETE.md)
for undo, failure and current platform-verification limits.

The new `translateDrawings` facade forwards explicit IDs and raw time/price deltas.
It validates the core `changed` count (0..128): zero skips host revision/notification,
positive changes notify once. See [drawing translation](DRAWING-TRANSLATION.md).
Java decoder execution/typechecking uses test-only signatures; Swift is statically
reviewed only. Neither is a new Android/JNI or Swift/JSC/device validation.

New compaction facade (real platform validation pending): `compactData` uses the explicit retained-window
restart contract in [DATA-COMPACTION.md](DATA-COMPACTION.md). No-op host notification
count is zero; actual removal notifies once. Platform compilation/runtime limits
for this newly added facade are stated there, separately from older results below.

0.2.12의 공개 Java facade는 `applyDataEvents(JSONArray)`와 configure/enqueue/
drain/pause/resume/cancel/stats/save/load 수집 메서드를 제공합니다.
`AsterEngine.IngestionException.code`로 명시적 큐 오류를 구분합니다. 같은
JSON 계약·owner-thread·호스트 실행 주기·순번·예산은
[INGESTION.md](INGESTION.md)를 따릅니다. JNI engine close의 기존 소유권을
유지하며 네트워크 공급자·스케줄러는 앱이 소유합니다.

0.2.11의 공개 Java 메서드는 `registerIndicatorModule(String,int) → JSONArray`, `saveStudies() → String`, `loadStudies(String) → JSONObject`, `indicatorValueAt(String,String,int[,JSONObject]) → JSONObject`입니다. query/save는 엔진 변경 알림을 발생시키지 않습니다. query의 알려지지 않은 `value/sourceIndex/sourceTime`은 `JSONObject.NULL`입니다. [SESSION-STUDIES.md](SESSION-STUDIES.md)와 [INDICATOR-MODULES.md](INDICATOR-MODULES.md)에 시간·저장·정적 모듈 계약을 설명합니다.

`examples/kotlin-study-consumer`는 실제 검증에 사용한 독립 소비 앱 source를 보존합니다. 생산 Java를 복사하지 않고 로컬 AAR만 의존합니다. 기존 `examples/kotlin-consumer`를 보존하고 runner에 `--studies`를 추가했습니다. 두 앱은 같은 검증 package ID를 쓰므로 같은 emulator에서 순차 실행하세요.

```sh
node scripts/test-kotlin-consumer.mjs --studies --build-only \
  --out /tmp/aster-kotlin-studies \
  --aar /tmp/aster-android-sdk/aster-charts.aar \
  --core native/Resources/aster-core.js
# 위 결과의 debug와 release APK를 각각 명시한 소유 emulator에서 실행
ASTER_ANDROID_SERIAL=emulator-5580 ASTER_ANDROID_ADB_PORT=5038 \
  node scripts/test-kotlin-consumer.mjs --studies \
  --apk /tmp/aster-kotlin-studies/aster-kotlin-debug.apk \
  --out /tmp/aster-kotlin-studies --core native/Resources/aster-core.js
# release는 --variant release 및 aster-kotlin-release.apk를 지정합니다.
```

최종 AAR SHA256은 `321f5f3b7aa79cc0269d19638ebe76d9896dbe03bf17b3ee2953dd42806b8505`, core resource SHA256은 `065ff6c12093e23a5cc5de0a01a4a7ff814ba6488934a8eea853cc0271b727e0`입니다. API36 arm64 실제 emulator의 debug·R8 release는 각각 **1776 assertions = 기존1083 + 새 study693**를 통과했습니다. 각 variant에서 기존 async3회와 module async3회, Activity2세대의 실제 HOME/복귀/recreate를 확인했습니다. 693은 고유 UX 시나리오 수가 아닙니다. 패키지 감사는14/14입니다. API26/다른ABI/물리기기와 실제 presentation FPS는 미검증입니다.

`native/android/library`는 Android Gradle library 모듈입니다. production Java
sourceSet에서 `AsterEngine`, `AsterColumns`, `AsterChartView`와 내부 bitmap pool을
컴파일하고, CMake/NDK로 기존 JNI·QuickJS 소스를 빌드합니다. 엔진 ABI나 async
worker 수명 코드를 이 패키징 작업에서 변경하지 않습니다.

AAR에는 다음 요소가 함께 들어갑니다.

| 요소 | AAR 경로/계약 |
|---|---|
| 공개 Java 클래스와 async 타입 | `classes.jar`, `dev.aster.charts` |
| 코어 자산 | `assets/aster-core.js` |
| JNI | `jni/arm64-v8a/libaster.so`, ELF64/16KiB load alignment |
| 최소 SDK | `AndroidManifest.xml`, minSDK26 |
| 공개 버전 리소스 | `R.string.aster_sdk_version`, `R.txt`/`public.txt` |
| 소비 앱 R8 규칙 | `proguard.txt`, Engine/Columns native 이름과 `zonedParts` 보존 |
| QuickJS MIT 라이선스 | `assets/licenses/QUICKJS-LICENSE.txt` |
| 제품 라이선스 | `assets/licenses/LICENSE.txt`, Apache-2.0 |

SDK에는 Java 데모 Activity나 검증 helper가 포함되지 않습니다. BaroChart는 Apache-2.0이며, QuickJS에는 해당 MIT 라이선스가 적용됩니다. 원문 라이선스와 고지를 함께 유지합니다. 최신 변경의 실제 Android SDK/JNI 검증 범위는 [공개 검증](PUBLIC-VALIDATION.md)을 확인하세요.

## 고정 빌드 도구와 로컬 산출물

검증에 사용한 조합은 Gradle8.14.5, AGP8.13.2, Kotlin2.4.10, JDK17,
Android SDK/build-tools36.0.0, NDK29.0.14033849, CMake3.22.1입니다. Kotlin
호환 범위는 [공식 Kotlin 문서](https://kotlinlang.org/docs/gradle-configure-project.html),
AGP 요구 사항은 [AGP8.13 공식 문서](https://developer.android.com/build/releases/agp-8-13-0-release-notes)에서 확인했습니다.

```sh
# 저장소 root. 선택한 core 자산은 먼저 root 작업에서 빌드/동결합니다.
node scripts/build-android-library.mjs \
  --out /tmp/aster-android-sdk \
  --core native/Resources/aster-core.js

ASTER_AUDIT_AAR=/tmp/aster-android-sdk/aster-charts.aar \
ASTER_AUDIT_CORE=native/Resources/aster-core.js \
  node --test native/android/library/package-audit.test.mjs

node scripts/test-kotlin-consumer.mjs --build-only \
  --out /tmp/aster-kotlin-consumer \
  --aar /tmp/aster-android-sdk/aster-charts.aar \
  --core native/Resources/aster-core.js
```

기본 산출물은 `/tmp/aster-android-sdk/aster-charts.aar`와
`/tmp/aster-kotlin-consumer/aster-kotlin-debug.apk`,
`aster-kotlin-release.apk`입니다. AAR은 서명되지 않는 library archive입니다.
release 소비 APK도 로컬 검증용 기존 debug key로 서명하며 R8/resource shrinking을
켜고 `run-as` 결과 회수를 위해 debuggable로 빌드합니다. 이 설정은 배포용 앱의
release signing 설정이 아닙니다.

스크립트는 `--offline`으로 실행하고 Gradle dependency cache를 작업 전용
`/tmp` Gradle home으로 복사합니다. 전역 Gradle 설정이나 사용자 init script는
읽어 적용하지 않습니다. 캐시가 불완전하면 build가 실패하며 자동 다운로드하지
않습니다. 다른 로컬 환경은 `ASTER_GRADLE`, `ASTER_GRADLE_JAVA_HOME`,
`ASTER_GRADLE_HOME`, `ASTER_GRADLE_CACHE`, `ANDROID_SDK_ROOT`,
`ASTER_ANDROID_DEBUG_KEYSTORE`를 지정할 수 있습니다. `ASTER_GRADLE`은
고정8.14.5 실행 파일이어야 합니다. dependency cache 재사용 방식은
[Gradle 공식 문서](https://docs.gradle.org/current/userguide/dependency_caching.html)의
상대 경로 cache 복사 규칙을 따릅니다.

## 다른 앱에서 사용

Android 앱 모듈은 로컬 AAR을 다음과 같이 의존할 수 있습니다.

```groovy
dependencies {
    implementation files('/absolute/path/aster-charts.aar')
}
```

Kotlin 코드에서 공개 Java API를 직접 import합니다.

```kotlin
import dev.aster.charts.AsterEngine
import dev.aster.charts.AsterChartView

val engine = AsterEngine(context, 0)
val view = AsterChartView(context, engine)
// 외부 OHLCV를 engine.setColumns(JSONObject) 또는 setData(JSONArray)로 전달합니다.
// Activity/View 소유 scope가 끝날 때 creating thread에서 engine.close()를 호출합니다.
```

`examples/kotlin-consumer`는 별도 `dev.aster.consumer` 앱입니다. 기본 경로는
`files(asterAar)`로 빌드한 AAR을 소비합니다. production Java나 demo Java를 앱에
복사하거나 app sourceSet에 추가하지 않습니다. 공개 클래스·메서드·리소스가
빠지면 실제 Kotlin compile 또는 패키지 감사에서 실패합니다.

같은 저장소 checkout을 library project로 의존하려면 다음 경로도 제공합니다.

```sh
node scripts/test-kotlin-consumer.mjs --build-only --project-dependency \
  --out /tmp/aster-kotlin-project-consumer \
  --aar /tmp/aster-android-sdk/aster-charts.aar \
  --core native/Resources/aster-core.js
```

settings에 `:aster` library를 포함하고 앱은 `implementation project(':aster')`를
사용합니다. runner는 실제 해당 project에서 생성한 AAR을 다시 감사하며 source
복사 경로를 사용하지 않습니다. 이 경로는 전체 저장소의 licensed native 소스와
동결된 core 자산이 필요합니다. Gradle library 모듈은 로컬 publishing task를
추가하지 않습니다.

## 실제 소비 앱 검증

소유 작업이 boot한 API36 arm64 에뮬레이터와 private adb port를 지정합니다.
runner는 에뮬레이터를 만들거나 boot/kill하지 않습니다.

```sh
ASTER_ANDROID_SERIAL=emulator-5580 ASTER_ANDROID_ADB_PORT=5038 \
  node scripts/test-kotlin-consumer.mjs \
  --apk /tmp/aster-kotlin-consumer/aster-kotlin-debug.apk \
  --out /tmp/aster-kotlin-consumer \
  --core native/Resources/aster-core.js

ASTER_ANDROID_SERIAL=emulator-5580 ASTER_ANDROID_ADB_PORT=5038 \
  node scripts/test-kotlin-consumer.mjs --variant release \
  --apk /tmp/aster-kotlin-consumer/aster-kotlin-release.apk \
  --out /tmp/aster-kotlin-consumer \
  --core native/Resources/aster-core.js
```

fixture는 외부512봉 OHLCV, 공개 inspect, 독립14봉 SMA 전체 벡터, drawing
add/edit/select/undo/redo/save, caller 배열 변경 이후 owned prepare의 snapshot,
외부 correction, cancel과 owner callback3회를 확인합니다. attached production
View의 Canvas 결과와 cache를 확인하고 실제 HOME/복귀·Activity recreate를
수행합니다. close 뒤 cache0·command 거부와 새 Activity의 source handle1개만
남는지 별도 JNI ledger로 확인합니다. Java reflection이나 package-private
테스트 hook으로 공개 API 누락을 우회하지 않습니다.

`aar-audit.json`, `consumer-build.json`, `consumer-<variant>-package.json`,
`consumer-<variant>-validation.json`은 선택한 core/AAR/APK/JNI hash와 도구·API/ABI,
소비 경로와 결과를 남깁니다. View의 public fontScale opt-in은 기본 off, enable/
disable getter와 caller base font 복원도 검사하며 OS fontScale 설정을 바꾸지
않습니다. 패키지 mutation 시험은 required component 누락,
공개 View class 누락, 잘못된 core와 JNI callback rule 누락을 거부하는지 확인합니다.

API26 런타임·다른 ABI·물리 기기·Play 배포/서명은 이 경로에서 검증하지
않았습니다. Canvas pixel 검사는 앱에서 호출한 offscreen raster 검증입니다.
실제 화면 presentation FPS, 입력 latency, 자연 OOM이나 장기 누수 없음의
증거로 확대하지 않습니다.

## 실행 기록

기준20720 core를 사용한 별도 release AAR 빌드와 debug·R8 축소 소비 APK
빌드와 Gradle project dependency 빌드는 실제 offline Gradle로 통과했습니다.
project dependency는 이 기준 자산의 컴파일 검증이며, 아래 최종 런타임 결과는
독립 앱의 로컬 AAR 소비 경로입니다. JNI `AsterColumns.writeSlice` 이름 보존
규칙 감사와 새 View fontScale 공개 API 소비는 기존 AAR에서 각각 red를 확인한
뒤 최종 AAR에서 green을 확인했습니다.

0.2.10 최종 core SHA256은
`4d601b4a413887ade500a3e9c5606c295aadd29291fe1670f853e4ed348e8df3`입니다.
`/tmp/aster-cycle10-sdk-release-final/aster-charts.aar`의 SHA256은
`f77ff5fb1d66d3696caa66f447bf8451fad1f7a006f338727cc65c48a4a1f748`이며,
최종 package 감사는 14/14 통과했습니다. 실제 CMake producer가 생성한 JNI
SHA256은 `2ec5488d936ecb1624bde8d04847c3f6e68f0868d6630019016cfef2e4476399`입니다.
이는 기존 직접 빌드 APK와 동일한 binary라는 주장이 아닙니다. AAR 감사에는
각 production Java source hash와 ELF load alignment도 기록합니다.

최종 View SHA256은
`d198cc4f041c016aed9750149cb0baf91207430f8c327f5ef88617f37aaddb52`입니다.
focus loss와 detach가 공개 native pointer 입력도 취소하도록 수정한 View를
포함해 AAR 감사와 동일 소비 앱 matrix를 다시 실행했습니다. 앞선 View16eec
검증 자료는 `/tmp/aster-cycle10-sdk-final`, `/tmp/aster-cycle10-kotlin-final`과
`/tmp/aster-cycle10-android-sdk-summary.json`에 보존했습니다.

`/tmp/aster-cycle10-kotlin-release-final`의 debug와 R8/resource-shrunk release APK는
API36 arm64 `emulator-5580`/private adb5038에서 각각 1083 checks를 통과했습니다.
두 실행 모두 async terminal 3회, Activity generation 2회와
`create → resume → pause → stop → resume → pause → stop → destroy → create → resume`
순서를 확인했습니다. 이전 engine close 후 attached View cache는0이며,
recreate 이후 새 engine만 JNI handle1개로 관찰한 다음 그 engine도 닫습니다.
이 ledger는 JNI 소유권 범위의 증거이며 Java GC 전체나 장기 누수를 측정하지
않습니다.

첫 HOME 검증은 launcher 전환이 끝나기 전에 복귀하여 fixture가 onStop을
기다리다 timeout했습니다. runner가 실제 `stop:1` marker를 확인한 뒤 복귀하게
수정했고, 재빌드한 두 variant에서 위 lifecycle을 확인했습니다. SDK 생산
코드는 이 fixture 수정에서 변경하지 않았습니다. 첫 실패와 진단은
`/tmp/aster-cycle10-kotlin-debug-first-lifecycle-timeout.json`과
`/tmp/aster-cycle10-kotlin-lifecycle-diagnostic.log`에 보존했습니다.

재현 증거는 `/tmp/aster-cycle10-sdk-release-final/aar-audit.json`,
`/tmp/aster-cycle10-sdk-release-final-audit.log`,
`/tmp/aster-cycle10-kotlin-release-final/consumer-build.json` 및 같은 폴더의
`consumer-debug-validation.json`, `consumer-release-validation.json`입니다.
최신 요약은 `/tmp/aster-cycle10-android-sdk-release-final-summary.json`에 있습니다. 이 검증은
공개 API, 실제 소비 앱 lifecycle과 offscreen rendering 범위이며 성능 비교
측정이 아닙니다.

## Workspace restore source slice (cloud checkpoint)

`AsterEngine.restoreWorkspaceAsync(document, binding, options, listener)` now has
Java source implementation, with an overload using default AsyncOptions. It
returns WorkspaceJob (`cancel`, `cleanupPending`, `pendingFailure`). See
[JAVA-WORKSPACE-RESTORE.md](JAVA-WORKSPACE-RESTORE.md) for ownership, registration,
source-stale and uncertain-cleanup contracts. The existing engine/view listeners
persist, but successful restore replaces the native runtime and internal store.

The production ownership state machine was executed with an independent fake Host
and real Java worker threads. The actual Engine and public consumer were checked
against compile-only Android/JSON signatures. **The new API has not been compiled
with Android SDK, linked/executed through JNI, packaged into a validated new AAR,
or run on a device.** Preserved AAR artifacts predate this method. The documented
native SDK build/runtime workflow above remains required before app deployment.

Portable batch style patches use `setDrawingsStyle` with a checked zero-change notification policy. See [Atomic drawing style patches](DRAWING-STYLE.md) for the four keys, one-undo budget, and current runtime validation limits.

## Entry-only asynchronous parameter source slice

`engine.setIndicatorParamsAsync(id, params, options, listener)` now returns
`ParamsJob` with `cancel()`, `cleanupPending()`, `commitOutcome()` and owner-thread
`retryCleanup()`. The overload without options uses default `AsyncOptions`.
Unlike workspace restoration, this keeps the original runtime/store and changes
only the indicator entry and its derived series caches. It requires a linked
portable definition and rejects a concurrent async job.

See [Native async parameter contract](NATIVE-ASYNC-PARAMS.md) for cooperative
cancellation, shared logical admission, unchanged/no-notify completion, lost-reply
status recovery and `indeterminate` completion after confirmed close. Do not
retry a mutation whose commit outcome remains unknown.

This source slice has cloud JVM fake-transport execution and compile-only Engine
consumer checks. **No Android SDK build, new AAR, JNI integration execution or
device validation has been performed for this API.** Existing native artifacts
predate it. Swift entry-only async parameter support is still pending.
