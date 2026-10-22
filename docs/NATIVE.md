# 네이티브 경로와 재현

현재 0.2.10 SDK 소비 방법은 [SWIFT-SDK.md](SWIFT-SDK.md)와 [ANDROID-SDK.md](ANDROID-SDK.md), 실제 모바일 UX·접근성·성능·자원 범위는 CYCLE10-VALIDATION.md (not included in this source distribution)에 있습니다. 아래 0.2.7의 독립 가격축·바인딩 도형·비교 데모와 Android bitmap cache 실행 범위는 CYCLE7-VALIDATION.md (not included in this source distribution)를 보세요. API는 [INDEPENDENT-AXES.md](INDEPENDENT-AXES.md), Android 예산·수명·실제 시스템 입력 측정은 [ANDROID-HOVER.md](ANDROID-HOVER.md)에 있습니다. 0.2.6 기록 (not included in this source distribution)과 아래 이전 결과는 해당 버전의 검증입니다.

코어는 같은 ECMAScript 소스입니다. Apple은 OS JavaScriptCore에서, Android는 NDK로 컴파일한 QuickJS에서 실행합니다. 렌더러는 JSON 장면을 CoreGraphics 또는 Android Canvas/Skia에 제출합니다. 웹페이지·WKWebView·Android WebView를 사용하지 않습니다. 웹 Canvas/WebGL2를 WebView에 넣는 것은 별도 통합 경로이며 이번 네이티브 검증으로 계산하지 않습니다.

SwiftPM과 Android 빌드는 저장소의 `native/Resources/aster-core.js`를 기본으로
포함합니다. 코어나 bridge 변경 후에는 다음 명령으로 이 생성 파일도 갱신하세요.
이 명령은 JavaScript만 생성하며 Swift/Android SDK를 컴파일하지 않습니다.

```sh
node scripts/build-native.mjs --bundle-only --output native/Resources/aster-core.js
node --test test/native-resource-freshness.test.mjs
```

일반 Node 테스트에서도 생성 결과와 저장된 파일의 바이트 일치를 검사합니다.
VM/독립 QuickJS 검사 통과는 실제 JavaScriptCore, JNI, SDK 또는 기기 검증이 아닙니다.

## Apple

설치된 Swift 6.4/Xcode, iOS 27 SDK/runtime, macOS arm64를 사용했습니다. Swift Package는 macOS13/iOS17 target입니다. 지원 OS 선언은 모든 버전의 실행 검증을 뜻하지 않습니다.

```sh
npm run build:native
./artifacts/aster-native
npm run test:native:ui
npm run build:ios
npm run test:ios
npm run test:axes:ios
```

iOS runner는 새 전용 iPhone17Pro 시뮬레이터를 만들고 설치·실행·결과 수집 후 그 기기만 삭제합니다. `ASTER_IOS_RUNTIME`, `ASTER_IOS_DEVICE`로 설치된 runtime/type을 지정할 수 있습니다. iOS27 SDK 요구에 따라 데모는 UISceneDelegate 수명주기를 사용합니다. 실제 UIKit 창/스냅샷/JavaScriptCore/DST/Redo와 지표 실행을 검증했고, 이전 기록에서는 자동 UITouch 주입·실기기 서명/실행을 검증하지 않았습니다. 최신 XCTest 입력 근거는 0.2.10 보고서에 구분하며 실기기는 여전히 미검증입니다. 터치 전달 코드는 UIKit View에 구현되어 있습니다.

Swift Package로 `AsterNative`를 추가하고 `AsterEngine()` 및 `AsterChartView(engine:)`를 사용합니다. `setData([AsterBar])`, `applyDataEvent`, `command`, 지표·시리즈·도형·테마 메서드와 `scene(width:height:)`, 저장·로드를 제공합니다. 한 엔진은 한 소유 스레드에서 호출합니다. OS framework binary는 소스 ZIP에 포함하지 않습니다.

## Android

검증 환경: Android SDK platform/build-tools36, NDK29.0.14033849, Homebrew OpenJDK26, API36 arm64 emulator, density2.625. API26 minimum으로 컴파일했고 **arm64-v8a만** 빌드했습니다. 다른 ABI, API26 실제 실행, 물리 기기, 16KB-page 이미지 별도 실행은 미검증입니다. SDK·NDK·JDK·system image가 이미 설치되어 있었으며 다운로드/계정/약관 수락을 자동 수행하지 않았습니다. QuickJS 소스는 공식 배포처에서 받아 MIT LICENSE와 provenance/hash를 동봉했습니다.

```sh
npm run build:native # 공유 core JS 생성
npm run build:android
# 선택한 테스트 에뮬레이터/기기의 adb serial을 명시:
ASTER_ANDROID_SERIAL=emulator-5580 npm run test:android
```

`ANDROID_SDK_ROOT` 또는 `ANDROID_HOME`, `ASTER_NDK`, `ASTER_JDK`로 도구 경로를 변경합니다. 기본 경로/버전은 현재 Mac 설치에 맞춰져 있습니다. APK는 `artifacts/android/aster-native.apk`이며 로컬 debug key만 사용합니다. Key/APK/NDK binaries/build cache는 소스 ZIP에서 제외합니다. runner는 선택한 기기에 `dev.aster.charts.demo`를 설치하고 그 앱의 검증 파일만 읽습니다. 실기기 serial을 지정해 실행해도 별도 검증 보고 없이 지원 완료로 간주하지 마세요.

재사용 파일: `native/android/java/dev/aster/charts/{AsterEngine,AsterChartView,AsterBitmapCachePool}.java`, `aster_jni.c`, `quickjs/`. 앱 빌드 시스템에서 JNI library를 연결하고 `aster-core.js`를 assets에 넣으세요. Compose adapter와 공개 Maven 배포는 제공하지 않습니다. 로컬 Gradle library/AAR 및 독립 Kotlin 소비 앱은 [ANDROID-SDK.md](ANDROID-SDK.md)에 있습니다. `new AsterEngine(context,0)`에 데이터를 주입하고 `new AsterChartView(context,engine)`을 사용할 수 있습니다. `setData(JSONArray)`, `applyDataEvent(JSONObject)`, `command`, 지표·시리즈·도형·테마 메서드와 저장·로드를 제공합니다. close는 소유 스레드에서 호출하며 여러 번 호출해도 안전합니다.

QuickJS의 일반 Intl 구현은 제공하지 않습니다. 코어의 timezone `DateTimeFormat.formatToParts` 호출만 Java `java.time.ZoneId`로 연결합니다. NY DST 반복/존재하지 않는 시각, tiny Float64·UTC, JNI 유니코드/숫자 왕복과 JS 예외 복구를 실제 Android에서 검사했습니다. 휴장표·공급자 데이터는 호스트가 주입합니다.

## 공통 facade와 제한

0.2.1의 공통 API, 플랫폼별 인수 형식, 초기화 옵션, 자동 재그리기와 남은 격차는 [API-PARITY.md](API-PARITY.md)에 정확히 정리했습니다. Swift/Java의 이름 있는 메서드와 `command`는 같은 `ChartAPI`를 실행합니다. 웹 `chart.api`와 같은 명령을 사용하며, native view는 성공한 변경을 observer로 받아 다시 그립니다. reads/거부된 변경은 재그리기를 예약하지 않습니다.

기존 `call`/`invoke` 및 `nativeIndicator` 자동 plot 행동은 유지합니다. 새 API에서는 지표 등록과 plot을 분리하고 출력·패널을 명시합니다. trusted JS factory source를 native에서도 등록할 수 있습니다. count initializer의 데모 기본 구성을 원하지 않으면 options로 panels/series를 명시하세요.

JSON bridge는 zero-copy가 아닙니다. 원본·지표·anchors는 Float64이고 Android Canvas의 Float은 변환된 화면 좌표에만 사용합니다. native font 크기·bold·italic·family를 지원하며, 폰트 대체와 AA가 OS마다 다릅니다. portable 색을 RGBA hex로 변환합니다. native compositor present/FPS와 장시간 lifecycle은 측정하지 않았습니다. iOS/Android benchmark는 저장1만/10만 봉 중 최근201봉, 1200×700/DPR1 오프스크린입니다.

0.2.2는 observer/JNI 입력·오류 경계와 semantic 상태/keyboard 경로를 강화했습니다. Android 데모의 대기 검증/redraw 작업은 private Handler가 소유하고 Activity 종료 시 취소합니다. 실제 recreate 회귀는 `ASTER_ANDROID_SERIAL=... ASTER_TEST_RECREATE=1 npm run test:android`로 실행하며 generation≥2를 확인합니다. 이것은 물리 키보드·전체 lifecycle·Activity 상태 저장 검증과 별개입니다. trusted `registerIndicatorSource`는 이름 있는 메서드만 사용하고 JSON `command`에서 호출하지 않습니다.

## 0.2.3 선택형 background 계산

0.2.3 당시의 API와 비용 기록입니다.0.2.4에서도 같은 public correction API를 유지하지만 큰 UI/history는 분할 전송하며 old monolithic UI checkpoint 경로를 host가 사용하지 않습니다. 계산 후 UI capture 시점까지의 변경은 반영하고, 분할 전송 중 UI가 바뀌면 stale로 거부합니다. 현재 한도·owner·정리 규칙은 [PREPARE-CONTRACT.md](PREPARE-CONTRACT.md)를 따릅니다.

기존 동기 메서드는 유지합니다. Apple `applyDataEventAsync(_:timeout:progress:completion:)`는 `AsterAsyncJob.cancel()`과 `Result<AsterAsyncMetrics,Error>`를 제공합니다. Android `applyDataEventAsync(JSONObject,AsyncOptions,AsyncListener)`는 `AsyncJob.cancel()`과 owner Handler의 결과를 제공합니다. main/UI 소유 engine에서만 이 opt-in API를 사용합니다. 별도 JSC VM/QuickJS runtime에서 계산하고, 계산 스레드 종료 후 prepared context를 owner로 전달합니다. Apple은 동시에 두 작업을 거부하고 Android는 이전 작업을 supersede합니다.

예시:

```swift
let job = try engine.applyDataEventAsync(event, progress: { progress in
    print(progress.phase, progress.done, progress.total)
}) { result in print(result) }
// job.cancel()
```

```java
AsterEngine.AsyncJob job = engine.applyDataEventAsync(event,
    new AsterEngine.AsyncOptions(30000, 4096),
    new AsterEngine.AsyncListener() {
        public void onComplete(AsterEngine.AsyncResult result) { /* UI owner */ }
    });
// job.cancel();
```

원본을 수정하지 않는 snapshot/validation 후 성공한 context만 전달합니다. 데이터·factory·시리즈 binding 변경, 취소, timeout, close, 실패는 결과를 버립니다. 뷰·스타일·도형 이력 등은 마지막 UI 상태를 반영합니다. 복사는 최대2MiB 한 chunk씩 backpressure를 적용하고 진행·완료를 owner queue/Handler로 전달합니다. custom indicator factory와 임의 formatter callback의 native async 이전은 지원하지 않습니다. 해당 기능은 기존 동기 경로에서 사용하세요. 활성 drawing gesture는 결과를 설치하지 않습니다. raw `context` escape hatch를 캐시한 Apple 사용자는 async 성공 뒤 `engine.context`를 다시 조회해야 합니다. 직접 typed 배열을 변경하면서 revision 통지를 생략하는 사용은 지원 계약에 포함하지 않습니다.

이 API는 UI blocking을 줄이기 위해 복사와 추가 VM 메모리를 사용합니다. 총 wall time·copied bytes·checkpoint serialization·UI serialization·sampled process peak를 구분해서 보고합니다. snapshot은512MiB typed-byte 제한이며, UI/checkpoint JSON은8Mi UTF-16 code-unit 제한을 적용합니다. host UI UTF-8 문자열 상한32MiB는 해당 code-unit 한도를 넘기지 않습니다. 단일 큰 checkpoint의 parse 또는 series index rebuild는 중간 취소가 불가능하므로 취소 지연의 엄격한 상한을 보장하지 않습니다. 상세 계약은 [ASYNC-CONTRACT.md](ASYNC-CONTRACT.md)를 보세요.

## 0.2.4 선택형 초기 준비

빈 engine에 panel·builtin indicator·series를 먼저 설정하고, `prepareColumnsAsync`로 실제 OHLCV를 준비할 수 있습니다. `prepareSeededAsync`는 합성 demo/benchmark convenience입니다. 기존 source 출력/checkpoint를 복사하지 않고 새 columns만 최대2MiB 조각으로 전달합니다. 생성·검증·트리·지표·출력 index를 worker에서 진행하고 성공한 context만 전달합니다.

```swift
// owner main thread; 필요한 panel/지표/series는 작은 빈 모델에서 설정합니다.
let engine = try AsterEngine(count:0,options:["panels":[["id":"price"]],
    "series":[["id":"price","type":"candles","panel":"price"]]])
let columns = try AsterColumns(time:time,open:open,high:high,low:low,close:close,volume:volume)
let job = try engine.prepareColumnsAsync(columns,progress:{ progress in
    print(progress.phase)
},completion:{ result in /* owner main queue; 성공/오류 처리 */ })
// 취소는 어떤 thread에서도 요청할 수 있습니다.
job.cancel()
```

```java
// 큰 입력의 copyOf는 calling thread에서 복사하므로 UI 밖에서 준비합니다.
AsterColumns columns=AsterColumns.copyOf(time,open,high,low,close,volume);
// 이미 owner main thread에 만든 engine에서 시작합니다.
AsterEngine.AsyncJob job=engine.prepareColumnsAsync(columns,200,
    new AsterEngine.AsyncOptions(30000,4096),new AsterEngine.AsyncListener(){
        @Override public void onComplete(AsterEngine.AsyncResult result) { /* main Handler */ }
    });
job.cancel();
```

Swift immutable Array 값은 COW로 보관하며 이후 안전한 caller mutation은 분리됩니다. 외부 unsafe 포인터/동시 unsynchronized mutation은 지원하지 않습니다. Java는 private 배열6개를 복사하고 `copyMillis/ownedBytes`로 비용을 드러냅니다. Java seed int는 unsigned32 bit 패턴입니다. 준비 결과는 follow=true일 때 마지막 visibleBars(기본200), follow=false일 때 최신 source viewport를 보존합니다. source data/factory/시리즈 binding 변경, close/cancel/timeout/오류는 원본을 유지합니다. Apple busy / Android supersede와 main-owner 조건을 공유합니다.

계산에 사용된 custom factory와 borrowed general-series values의 async 이전은 거부합니다. registry에 등록만 된 unused factory는 새 VM에 옮기지 않습니다. 기존 trusted `registerIndicatorSource`는 동기 이름 있는 API에만 남고 신규 source-string eval 전송은 없습니다. 임의 formatter는 거부하고 `setSymbol`의 고정 formatter만 복원합니다. 같은 symbol이 있어도 이후 custom callback으로 덮어쓰면 거부합니다.

큰 도형/Undo/Redo 이력은 최대2048 새 점의 UI chunk로 source에서 전송하고 worker에서 검증합니다. 전송 중 UI가 달라지면 stale입니다. 성공 context의 scene 작성·동기 save/inspect는 별도 비용입니다. Apple close는 owner에서 반복 가능하며 active job·전용 creation run loop·observer를 정리합니다. nonoptional raw context는 닫힌 engine 보관 동안 남으므로 전체 VM 메모리 즉시 반환을 뜻하지 않습니다. 세부 계약은 [PREPARE-CONTRACT.md](PREPARE-CONTRACT.md), 실행 증거는 PREPARE-VALIDATION.md (not included in this source distribution)를 보세요.

비동기 context 전달 후 내부 geometryKey의 context별 store identity는 달라질 수 있습니다. 시간 revision·좌표·범위·벡터·도형 내용은 보존합니다. Android exact fixture는 식별자 하나만 유효한 정수로 확인해 정규화하고 나머지 geometryKey를 비교합니다.
