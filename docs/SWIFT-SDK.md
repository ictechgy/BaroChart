# SwiftPM SDK 소비 경로

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

현재 0.2.13 클라우드 소스에는 `restoreWorkspaceAsync`와 명시적 pending cleanup
조회·재시도 API가 추가되어 있습니다. 이 변경은 Swift/JSC 컴파일·실행 전이며
아래 과거 SDK 실측을 최신 검증으로 적용할 수 없습니다. workspace 전용 close
수명 변경, creator cleanup ACK 및 필수 Apple 검증은
[SWIFT-WORKSPACE-RESTORE.md](SWIFT-WORKSPACE-RESTORE.md)를 보세요.

0.2.12는 `applyDataEvents` 및 configure/enqueue/drain/pause/resume/cancel/stats/
save/load 수집 메서드를 같은 공개 이름으로 제공합니다. 인수는 기존 dictionary
계약이며 `AsterIngestionError.code`로 명시적 큐 오류를 구분합니다.
[INGESTION.md](INGESTION.md)의 호스트 실행 주기·순번·예산·저장 계약을 따릅니다.
원래 owner에서 close하면 보유한 원시 context가 남아 있어도 새 수집 ring과
대기 payload의 논리 소유권은 해제합니다. 즉각적인 VM/RSS 반환 주장은 아닙니다.

0.2.11은 `registerIndicatorModule(_:version:) → [String]`, `saveStudies() → String`, `loadStudies(_:) → [String:Any]`, `indicatorValueAt(_:output:index:options:) → [String:Any]`를 공개 Swift API로 제공합니다. query의 `value/sourceIndex/sourceTime`은 알려지지 않은 값에 `NSNull`을 사용합니다. raw/plot 위치와 `asOfIndex` 의미는 [SESSION-STUDIES.md](SESSION-STUDIES.md), 정적 모듈과 새 ID를 병합하는 저장 계약은 [INDICATOR-MODULES.md](INDICATOR-MODULES.md)를 참고하세요. 종료한 엔진에 `observeChanges`를 다시 등록하면 `engineClosed`를 반환하며 closure를 보관하지 않습니다.

`examples/swift-study-consumer`는 기존 소비 fixture와 별도인 실제 SwiftPM executable입니다. 기본 SDK resource와 개발자가 정적으로 만든 로컬 module resource에서 공개 타입·독립 수치·저장 roundtrip·격리된 JavaScriptCore async correction·종료 후 구독 거부를 각각 10개 검사로 확인했습니다. 실제 실행은 macOS arm64이며 iOS의 해당 named SDK와 데모 검증은 별도 simulator 기록입니다.

```sh
ASTER_NATIVE_PACKAGE_PATH="$PWD" swift run \
  --package-path examples/swift-study-consumer \
  --scratch-path /tmp/aster-study-consumer -c release StudyConsumer
node scripts/build-native.mjs --bundle-only \
  --indicator-module examples/indicators/local-volume-balance.mjs \
  --output /tmp/aster-custom-core.js
ASTER_NATIVE_PACKAGE_PATH="$PWD" swift run \
  --package-path examples/swift-study-consumer \
  --scratch-path /tmp/aster-study-consumer -c release \
  StudyConsumer /tmp/aster-custom-core.js
```

`Package.swift`의 로컬 library product는 `AsterNative`입니다. 최소 선언은 macOS 13 / iOS 17, manifest는 Swift tools 6.0, 라이브러리는 Swift language mode 5입니다. 실제 검증은 설치된 Swift 6.4 / Xcode 27과 arm64 Mac / iOS 27 Simulator에서 수행합니다. 최소 OS 선언은 해당 모든 OS·기기의 실행 인증이 아닙니다.

## 독립 소비자

`examples/swift-consumer/Package.swift`는 별도 executable package이며 로컬 product dependency를 사용합니다. `Sources/AsterSDKProbe/main.swift`는 `import AsterNative`만으로 SDK를 소비합니다. 라이브러리 Swift 파일이나 기존 데모 검증 함수를 앱 source target에 넣지 않습니다.

```sh
# 저장소의 SDK를 로컬 경로 의존성으로 사용
swift run --package-path examples/swift-consumer \
  --scratch-path /tmp/aster-sdk-manual AsterSDKProbe

# 별도 /tmp 소비자·캐시로 macOS + 새 iOS 앱/XCUI 검증
node scripts/test-swift-consumer.mjs --mode all
```

다른 SDK 경로에는 `ASTER_NATIVE_PACKAGE_PATH=/absolute/path/to/sdk`로 executable package를 실행하거나 runner의 `--sdk`를 사용합니다. runner는 소비자 예제만 새 `/tmp` 폴더로 복사하고 product dependency가 지정한 SDK를 SwiftPM으로 빌드합니다. `--output`으로 결과 경로, `--mode mac|ios|all`로 범위를 선택합니다. 별도 `--baseline-core`는 구버전 bundle/기존 API만 검증하며 신규 `dispose/isDisposed`·label metadata 검증을 생략합니다. 새 기능 성공으로 계산하지 않습니다.

새 앱은 `examples/swift-consumer/iOS/AsterSDKConsumer.xcodeproj`입니다. Xcode에서 열면 `../../../`의 로컬 Swift package product를 의존합니다. runner는 격리한 프로젝트의 package 경로만 절대 SDK 경로로 바꿉니다. 설치된 iOS runtime을 사용하여 새 전용 시뮬레이터에 build/install/launch, XCUI 버튼·차트 drag, 결과 수집, 종료·기기 삭제를 수행합니다. `ASTER_IOS_RUNTIME` / `ASTER_IOS_DEVICE`로 설치된 runtime/type을 지정할 수 있습니다. 계정·배포·프로비저닝 업데이트·tool/runtime 다운로드를 요청하지 않습니다. 시뮬레이터용 `CODE_SIGNING_ALLOWED=NO`이며 실기기 앱 서명은 별도입니다.

## 리소스와 엔진

SDK target은 `native/Resources/aster-core.js`를 SwiftPM resource로 복사합니다. `AsterEngine()` / `AsterEngine(count:options:)`는 SDK 내부 `Bundle.module`에서 이 파일을 찾습니다. 앱이 JS URL을 넘기거나 Bundle.main에 같은 파일을 따로 복사하지 않아도 됩니다. `Bundle.module`은 해당 SDK target의 내부 accessor이므로 앱에서 직접 조회하지 않습니다. 별도 trusted resource를 사용하는 기존 `init(bundleURL:count:options:)`는 명시적 대체 경로입니다.

```swift
import AsterNative
import UIKit

// main/UI 소유 스레드
let options: [String: Any] = [
    "panels": [["id": "price", "weight": 1]],
    "series": [["id": "price", "type": "candles", "panel": "price"]],
]
let engine = try AsterEngine(count: 0, options: options)
let chart = AsterChartView(engine: engine)
try engine.addIndicator("ema20", "ema", ["period": 20])
let emaSeries: [String: Any] = [
    "id": "ema-line", "type": "line", "panel": "price",
    "indicator": "ema20", "output": "value",
]
try engine.addSeries(emaSeries)
// 호스트 view hierarchy에 chart를 추가하고 크기/constraints를 지정합니다.
```

데이터 count 기본값은 0입니다. options를 생략한 native convenience는 빈 데이터에 가격·거래량·EMA 기본 구성을 제공합니다. 실제 호스트 구성을 명확히 하려면 위처럼 panels/series를 지정하고 지표를 별도로 추가하세요. count > 0의 생성 데이터와 `prepareSeededAsync`는 합성 convenience입니다. 실데이터 공급·거래소 시간표·수정주가·통화 환전·네트워크 연결은 호스트의 책임입니다.

작은 데이터는 `setData([AsterBar])`, `setColumns([String:[Double]])`와 `applyDataEvent([String:Any])`로 주입합니다. 패널·축·시리즈·도형 옵션은 이름 있는 메서드가 공통 JSON 계약에 전달하는 `[String:Any]`입니다. 저장된 숫자와 time/price anchors는 Double이며 시각은 안전한 정수 UTC 밀리초여야 합니다. CoreGraphics에는 마지막 화면 좌표를 전달합니다.

## 선택형 async

```swift
let columns = try AsterColumns(
    time: time, open: open, high: high,
    low: low, close: close, volume: volume
)
let job = try engine.prepareColumnsAsync(columns, visibleBars: 200) { [weak chart] result in
    // main/UI owner callback. result.get()의 오류를 처리합니다.
    guard let chart = chart, !chart.isDisposed else { return }
    switch result {
    case .success: chart.setNeedsDisplay()
    case .failure(let error): print(error)
    }
}
// 호스트가 필요할 때 job.cancel(); 취소 요청은 어떤 thread에서도 가능합니다.
```

엔진 생성·동기 API·close는 동일한 원래 소유 스레드에서 호출합니다. UIKit view와 opt-in async는 main/UI 소유 엔진을 사용합니다. SDK는 Sendable 모델/Swift actor로 선언하지 않으며 다른 queue에서 `engine`을 호출하는 통합을 지원하지 않습니다. `prepareColumnsAsync`와 `applyDataEventAsync`의 progress/completion은 main에서 전달되고 실패·취소·stale 결과는 원본을 유지합니다. `AsterColumns`는 immutable Array 값과 COW storage를 유지하며 unsafe aliased pointer/동시 비동기 배열 변경은 지원 계약 밖입니다. 두 async 작업을 동시에 시작하면 busy 오류입니다. 전체 복사·JS 검증/계산 비용과 취소 경계는 [PREPARE-CONTRACT.md](PREPARE-CONTRACT.md)를 참고하세요.

성공한 async handoff는 `engine.context`를 교체합니다. 캐시한 raw JSContext/JSValue를 이후 작업에 사용하지 마세요. public 값/메서드를 다시 조회하세요. 실제 formulas·시간/가격 모델은 bundle의 공유 ECMAScript core이며 Swift만으로 다시 구현한 금융 계산 엔진은 아닙니다.

## 뷰와 엔진 소유권

`AsterChartView(engine:)`는 호스트가 소유한 엔진을 보관하지만 닫지 않습니다. `dispose()`는 반복 가능한 영구 view 종료이고 `isDisposed`로 확인합니다. 입력/observer/notification/frame resources와 onInteraction callback을 정리합니다. dispose 뒤 그 view를 다시 활성화하지 않습니다. `removeFromSuperview` / window detach는 영구 dispose와 다른 가역 경로이며, 재사용 여부와 UIKit 동작은 [NATIVE.md](NATIVE.md)의 현 버전 검증 범위에 따릅니다.

권장 종료 순서는 호스트 스트림·작업 중단, `job.cancel()` 필요 시 요청, main에서 `chart.dispose()`, hierarchy 제거·view 참조 해제, 원래 owner에서 `try engine.close()`, engine 참조 해제입니다. 다른 view가 같은 엔진을 사용하면 그 소유자가 엔진을 계속 보관해야 합니다. 엔진 close는 반복 가능하며 이후 데이터/scene 호출은 engineClosed를 반환합니다. close된 engine의 nonoptional raw context는 객체를 보관하는 동안 남을 수 있으므로 즉시 모든 VM/RSS 메모리가 반환된다는 보장은 아닙니다.

## Scene 값과 플랫폼 경계

`scene(width:height:) → AsterScene`와 `AsterCoreGraphicsRenderer.render`는 macOS CoreGraphics 소비 경로입니다. iOS는 public `AsterChartView`의 UIKit renderer를 사용합니다. macOS package에 UIKit view나 AppKit view adapter를 제공한다고 해석하지 마세요.

`AsterCommand`의 새 라벨 값은 optional `role`, `fullText`, `labelBounds`, `panelId`, `axisId`입니다. role은 price-tick/time-tick/panel-title/axis-title/crosshair-price 등 core 라벨 의미이고 fullText는 생략 표시 전 전체 문자열입니다. labelBounds는 `[x,y,width,height]` portable 추정이며 OS font의 실제 glyph extents가 아닙니다. 이전 bundle에는 이 값이 없어 nil로 디코딩됩니다. 데이터·anchors를 display text로 재구성하지 마세요.

이 SwiftPM 제품은 OS JavaScriptCore + CoreGraphics/CoreText + iOS UIKit 경로입니다. WKWebView·브라우저·React Native·Flutter adapter가 아니며 그 프레임워크용 package/module은 제공하지 않습니다. upstream Swift package dependency는 없습니다. Apple OS framework는 필요하며 framework binaries/Swift/Xcode SDK는 소스 archive에 재배포하지 않습니다. Android QuickJS 코드와 선택적 비교 benchmark 라이브러리는 이 Swift target에서 제외됩니다.

## 실제 검증 기록

보존 baseline `479b870`의 resource SHA256은 `20720b9b7c8bfb91e209cf9b32b9ed2aa6a3d24e15fb23880822419b753b3a53`입니다. 별도 SDK snapshot·별도 SwiftPM consumer에서 warnings-as-errors macOS build, 공개 API/외부512/async/CG11 검사와 빌드 산출물의 JS 파일을 잠시 옮긴 missing-resource rejection이 통과했습니다. 새 iOS 프로젝트도 baseline product로 실제 build/install/launch/XCUI14 검사가 통과했습니다. 새 전용 iOS27 iPhone17Pro 시뮬레이터는 삭제했습니다.

baseline 증거: `/tmp/aster-cycle10-swift-baseline/matrix`의 mac logs/report와 `/tmp/aster-cycle10-swift-baseline/ios-green/report.json`, `ios.xcresult`, `ios-consumer.png`. 첫 소비 앱 selector/weak-variable compile 실패는 별도 logs에 보존했고 앱 테스트 코드를 고쳤습니다. SDK 기본 리소스 구현 오류로 계산하지 않습니다. baseline 성공이 신규 explicit view disposal/label metadata의 성공을 뜻하지 않습니다.

새 API 테스트를 baseline SDK에 적용한 `/tmp/aster-cycle10-swift-baseline/{mac-api-red,ios-api-red2}`는 각각 AsterCommand.role와 AsterChartView.dispose/isDisposed 부재로 compile 실패했습니다. 이는 신규 API 소비 기대값의 red이며 구버전 기본 SDK 사용 실패가 아닙니다. iOS red는 build 단계에서 끝나 시뮬레이터를 생성하지 않았습니다. 앞선 ios-api-red에는 전역 compilation condition이 SDK의 SWIFT_PACKAGE를 제거한 harness 오류도 포함되어 있습니다. flag를 소비 앱 target에만 적용한 red2에서는 기본 생성자 오류가 없으며 SDK 리소스 조건을 보존합니다.

이전 `/tmp/aster-cycle10-swift-final`의 macOS12 / iOS15 검사와 callback17회 결과는 **pre-final**로 보존합니다. 해당 core `21cba9a0…` / UIKit `c3200a98…` 뒤에 core observer 순서 및 UIKit dispose 재진입 수정이 추가되었으므로 현 SDK의 최종 근거로 사용하지 않습니다.

중간 `/tmp/aster-cycle10-swift-after-reentry`의 macOS12 / iOS15 검사와 callback15회 결과도 **pre-final**로 보존합니다. 해당 UIKit `5b57c669…` 뒤에 두 포인터 DOWN batch 안의 callback dispose/접근성 취소 guard가 추가됐습니다.

이전 `/tmp/aster-cycle10-swift-final-complete`의 UIKit `1f6f4910…` / macOS12 / iOS15 검사도 **pre-final**로 보존합니다. 이후 접근성 cancel의 기존 Escape selection/crosshair 정리 의미를 보존하는 최소 수정이 추가됐습니다.

최종 SDK는 `node scripts/test-swift-consumer.mjs --mode all --output /tmp/aster-cycle10-swift-release-final`로 같은 소비 fixture를 다시 검증했습니다. macOS **12 검사와 missing-resource rejection**, 실제 iOS app build/install/launch 및 XCUI **15 검사**가 통과했습니다. iOS 실제 simulator drag에서 onInteraction callback16회를 관측했고, dispose/isDisposed·반복 dispose·weak view 해제·borrowed engine 사용·owner close를 확인했습니다. SDK 6개 파일의 실행 전후 SHA256이 정확히 일치했습니다. library target의 SwiftPM resource를 macOS `.bundle/Contents/Resources/aster-core.js`, iOS app 내부의 SDK `.bundle/aster-core.js`에서 확인했고 앱의 별도 resource 복사는 없습니다. 소비 앱은 기존 source 그대로 사용하며 dispose/cancel 중 두 포인터 batch 재진입과 Escape selection/crosshair 의미의 회귀는 별도 UIKit 검증 범위입니다.

| 동결 값 | SHA256 |
|---|---|
| core resource | `4d601b4a413887ade500a3e9c5606c295aadd29291fe1670f853e4ed348e8df3` |
| UIKit source | `29b1cbd0f86afcbbb1ed00d52c69a6610cbf5d1225c8d4f7e50ad93f0dace3fd` |
| public native facade | `77f49e48e7be8c905896c8b59cdde9b072be44c7a82a13ecaa943ffbeb6775a5` |

결과는 최종 보고서 (not included in this source distribution), `/tmp/aster-cycle10-swift-release-final/logs/`, `ios.xcresult`, `ios-attachments/manifest.json`입니다. async correction 후 실제 UIKit 차트 (not included in this source distribution)를 XCUI attachment로 내보내 시각 확인했습니다. generic simulator 앱 binary는 x86_64/arm64 두 아키텍처로 빌드했고 실제 실행은 arm64 iOS27 iPhone17Pro simulator였습니다. 해당 작업 소유 기기 `109A85BD-AE38-4575-B51E-7B6A629CDD8D`의 shutdown/delete는 성공했습니다. terminate는 app-already-stopped(code3)를 반환했습니다. 정리 후 읽기 전용 확인 (not included in this source distribution)에서 해당 UUID가 없고 이 output 경로/UUID의 build·app process도 없음을 확인했습니다. 기존 기기를 정리 대상으로 사용하지 않았습니다.

검증은 기능·실제 simulator input·view weak release·owner cleanup 경계입니다. SwiftPM 배포 서비스·실기기·최소 OS 실제 실행·Swift6 strict concurrency mode·physical FPS·장시간 누수 부재를 인증하지 않습니다. source bundle 전후 hash가 다르면 runner는 검증 중 SDK가 바뀐 것으로 실패합니다.

BaroChart는 Apache-2.0입니다. npm의 private 플래그는 실수로 registry에 게시하는 것을 막습니다. 최신 Swift 변경은 실제 컴파일·JSC 실행 검증이 남아 있으며 [공개 검증](PUBLIC-VALIDATION.md)을 확인하세요. Apple framework 조건과 Swift/Xcode 개발 도구 조건은 해당 플랫폼에 따릅니다. 코드 출처·QuickJS MIT·선택적 comparator의 분리는 [LICENSING.md](LICENSING.md)에 있습니다.

Portable batch style patches use `setDrawingsStyle` with a checked zero-change notification policy. See [Atomic drawing style patches](DRAWING-STYLE.md) for the four keys, one-undo budget, and current runtime validation limits.
