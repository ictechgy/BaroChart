# BaroChart 네이티브 SDK 상용화 설계

_작성 2026-11-01 · 기준 커밋 `1460646` · 브랜치 `feature/native-sdk-commercial`_

## 1. 의도

BaroChart를 **다른 앱 개발자가 iOS·Android 앱에 넣어 상용 서비스에 쓸 수 있는 SDK**로 만든다.
지금 저장소에는 기능이 충분하다. 지표 35종, 드로잉 16종, 작업공간 저장/복원, 스트리밍이 있다.
상용 SDK로 채택될 때 먼저 걸리는 것은 기능 수가 아니다. 다음 세 가지다.

1. **붙는가:** 실제 빌드·실행 검증이 있고 크래시가 없어야 한다.
2. **깨지면 누가 아는가:** 오류가 숨겨지지 않고, API가 컴파일 타임에 잘못된 사용을 막아야 한다.
3. **얼마를 쓰는가:** 시작 시간, 프레임, 메모리, 앱 크기를 실측해서 공개해야 한다.

Codex·Devin·Grok 세 모델에 따로 상담했고, 셋 모두 가장 큰 위험으로 같은 것을 꼽았다.
Linux 클라우드에서 작성만 되고 실제 Swift/JSC·Android/JNI에서 한 번도 실행되지 않은 네이티브 코드다.
2026-11-01에 iOS 시뮬레이터용 `xcodebuild`를 해 봤고, 경고 없이 컴파일은 통과했다.
실행 검증과 Android 빌드는 아직 하지 않았다.

## 2. 목표 · 비목표 · 반목표

**목표**
- iOS·Android에서 실제 빌드·실행 검증을 통과한 SDK.
- 공개 이름은 BaroChart로 통일한다.
- 핵심 경로는 타입 있는 API로 제공한다.
- 오류 계약은 두 플랫폼에서 일관되게 맞춘다.
- SwiftUI·Jetpack Compose용 얇은 래퍼를 둔다. UIKit·Android View도 계속 지원한다.
- 외부 레지스트리 없이 로컬 의존성만으로 빈 앱에 설치되는 배포 리허설을 마친다.
  - iOS: SwiftPM git 태그
  - Android: 로컬 Maven 저장소
- 시뮬레이터·에뮬레이터와 **실기기(iPhone·Android 폰)** 에서 성능·안정성 수치를 기록한다.
- 앱 개발자가 15분 안에 첫 차트를 띄우는 문서와 샘플 앱.

**비목표 (이번 범위 밖)**
- 새로운 차트 기능 추가.
- 웹 npm 배포, React 변경.
- React Native·Flutter 어댑터.
- 선언형 차트 DSL.
- XCFramework 바이너리 배포, SwiftPM 전용 저장소 분리.
- Android `armeabi-v7a`.
- 실제 레지스트리 배포(Maven Central 업로드, 공개 릴리스 태그 푸시). **저장소 주인이 따로 승인한다.**

**반목표 (기술적으로 돌아가도 실패로 본다)**
- 직렬화 스키마 이름(`aster.*`)이나 저장 문서 형식을 바꿔서 기존 작업공간·드로잉 저장본을 깨는 것.
- 실측 없이 성능을 주장하는 것. 시뮬레이터 수치를 실기기 수치처럼 쓰는 것.
- 오류를 삼키는 것. 빈 catch를 두거나 상태 필드에만 조용히 남기는 것.
- 이미 검증된 동작을 퇴행시키는 것. 수명주기, 백그라운드 처리, 메모리 예산, Dynamic Type/fontScale, 기본 접근성 동작이 여기에 해당한다.

## 3. 결정된 것

### 저장소 주인이 결정 (2026-11-01)

| 항목 | 결정 |
|---|---|
| 대상 | iOS·Android 앱, 다른 개발자에게 SDK로 제공 |
| 이름 | 지금 `Aster*` → `BaroChart*`로 완전히 바꾼다. 별칭은 두지 않는다. 직렬화 `aster.*`는 유지한다 |
| API | 핵심만 타입 있는 API로 만들고, 고급 기능은 기존 딕셔너리/JSON 저수준 API로 남긴다 |
| 래퍼 | SwiftUI·Compose 얇은 래퍼를 1.0에 포함한다 |
| 실기기 | iPhone·Android 폰 모두 측정에 쓸 수 있다 |
| Android 이름 | Java 패키지 `kr.coden.barochart`, Maven groupId `kr.coden` (coden.kr DNS 검증) |
| 버전 | 웹·iOS·Android가 `package.json` 버전 하나를 공유한다. git 태그는 `X.Y.Z` 하나로 세 플랫폼을 함께 가리킨다 |
| 문서 언어 | 공개 API 문서 주석(DocC·Javadoc)과 오류 메시지는 영어. 가이드와 README는 영어·한국어 두 벌. 내부 구현 주석은 한국어 |
| iOS 최소 버전 | iOS 17 유지. 실행 검증할 수 없는 iOS 16 지원은 주장하지 않는다 |

### 세 모델 합의를 따른 것

| 항목 | 결정 | 상담 결과 |
|---|---|---|
| 최소 OS | Android minSdk 26 유지. iOS는 세 모델이 16을 권했지만 저장소 주인이 17 유지를 결정 | 만장일치(Android) |
| ABI | Android `arm64-v8a` + `x86_64` | 만장일치 |
| 배포 경로 | iOS는 모노레포 루트 SwiftPM + git 태그, Android는 Maven Central | 만장일치 |
| 번들 | JS 번들 최소화와 시작 시간 실측은 필수다. QuickJS 바이트코드 사전 컴파일은 시작 예산을 넘을 때만 한다 | 만장일치 |

## 4. 제약

- 코어 JS는 npm 런타임 의존성 0을 유지한다.
  - 빌드 도구(TypeScript, 최소화 도구)는 CI처럼 임시 경로에 버전 고정으로 설치한다.
- 생성 번들 `native/Resources/aster-core.js`는 직접 고치지 않는다.
  - `node scripts/build-native.mjs --bundle-only --output native/Resources/aster-core.js`로 다시 만든다.
- Android 코어 AAR은 Java 8 바이트코드를 유지한다. Kotlin 런타임 의존성을 넣지 않는다.
  - Compose 래퍼만 별도 아티팩트로 Kotlin을 쓴다.
- Swift는 tools 6.0과 language mode 5를 유지한다.
- 검증 Node는 `/Users/jinhongan/.nvm/versions/node/v22.20.0/bin/node`다.
  - TypeScript는 5.9.3을 임시 경로에 설치한다. CI와 같다.
- Android 빌드 도구는 공식 저장소(Google Maven, Maven Central, Gradle 배포판)에서 받는다.
  - 대상: Gradle 8.14.x, AGP 8.13.2, Kotlin 플러그인
  - 저장 위치: 격리된 Gradle home(`artifacts/` 아래, git 무시)
  - 착수 전 디스크 여유를 재고 5 GiB 이상을 확보한다.
- `.env`, 키스토어, 인증 파일은 읽지 않는다.
  - iPhone 실기기 서명에는 저장소 주인의 Apple 개발 팀이 필요하다. 필요한 시점에 요청한다.
- `main`에 직접 커밋하지 않는다. 단계마다 PR을 만들고 CI를 통과시킨 뒤 머지한다.

## 5. 설계

### 5.1 공개 이름 체계

| 대상 | 지금 | 바꾼 뒤 |
|---|---|---|
| SwiftPM 패키지 / 제품 / 모듈 | `AsterNative` | `BaroChart` |
| Swift 엔진 | `AsterEngine` | `BaroChartEngine` |
| UIKit 뷰 | `AsterChartView` | `BaroChartUIView` |
| SwiftUI 뷰 | (없음) | `BaroChartView` |
| Swift 값·오류 타입 | `AsterBar`, `AsterError`, `AsterAsync*`, `AsterWorkspace*`, `AsterParams*`, `AsterColumns`, `AsterFrameRenderer` 등 | 같은 규칙으로 `BaroChart*` |
| Android Java 패키지 | `dev.aster.charts` | `kr.coden.barochart` (Compose는 `kr.coden.barochart.compose`) |
| Android 엔진 / 뷰 | `AsterEngine`, `AsterChartView` | `BaroChartEngine`, `BaroChartView` |
| Compose | (없음) | `BaroChart(...)` 컴포저블, 별도 아티팩트 |
| Maven 아티팩트 | (없음) | `kr.coden:barochart-android`, `kr.coden:barochart-compose` |
| JNI 심볼 | `Java_dev_aster_charts_*` | 새 패키지·클래스에 맞춰 다시 만든다 |

규칙은 이렇다.
- 앱 개발자에게 보이는 모듈, 타입, 패키지, 아티팩트, 문서 예제만 바꾼다.
- 바꾸지 않는 것:
  - 직렬화 스키마 문자열(`aster.*`)
  - 저장 문서 필드
  - 코어 JS 내부 브리지 함수 이름(`native*`)
  - 내부 리소스 파일 이름(`aster-core.js`)
- 소스 파일 이름은 주 타입에 맞춘다. 예: `AsterNative.swift` → `BaroChartEngine.swift`
  - 그 파일 경로를 읽는 정적 테스트·스크립트도 같은 커밋에서 고친다.
- 이름 변경은 **기계적 치환만 담은 단독 커밋**으로 한다. 동작 변경과 섞지 않는다.
  - 참조 파일은 약 215개다.

### 5.2 플랫폼 호환

**iOS**
- 최소 iOS 17을 유지한다. 지금 쓰는 iOS 17 API(`registerForTraitChanges`)는 그대로 둔다.
- 시뮬레이터와 실기기 아키텍처 모두 `-warnings-as-errors` 빌드를 통과시킨다.
- macOS 13 선언은 테스트용으로 유지한다.

**Android**
- `abiFilters 'arm64-v8a', 'x86_64'`로 바꾼다.
- 두 ABI의 `.so` 모두 ELF LOAD 세그먼트 정렬이 16 KiB 이상인지 빌드 산출물에서 검사한다.
  - `ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES`는 이미 켜져 있다.
- 이 Mac은 arm64라서 x86_64 에뮬레이터를 돌릴 수 없다. x86_64 `.so`의 실행 검증은 GitHub Actions Ubuntu 러너(KVM)의 x86_64 에뮬레이터 스모크 잡으로 한다 (내 판단).

### 5.3 오류 계약과 스레드 규칙

**적용 범위 (내 판단)**
- 통일된 오류 계약은 **타입 있는 API와 뷰·래퍼**에 적용한다.
- 저수준 딕셔너리/JSON API는 지금 오류 타입을 유지하고, 던지는 오류를 문서에 명시한다.
  - Swift는 `AsterError`·`AsterAsyncError` 계열을 이름만 바꾼다.
  - Android는 `IllegalStateException`·`IllegalArgumentException`·`JSONException`·`IngestionException`을 그대로 둔다.
- 타입 API는 저수준 오류를 받아 `BaroChartError` / `BaroChartException`으로 바꿔서 전달한다.
  - 원래 오류는 `underlying`/`getCause()`로 보존한다.

**Swift**
- 타입 API의 throwing 메서드는 모두 `BaroChartError` 하나만 던진다.
  - 내용: 원인 코드(`code`), 사람이 읽는 메시지, 해결 방향
  - 코드 종류: 닫힌 엔진, 잘못된 스레드, 잘못된 인수, JS 실행 실패, 장면 오류, 예산 초과, 작업 취소, 정리 대기(`cleanupPending`)
- 비동기 작업(작업공간 복원·파라미터 변경)도 같은 타입을 던진다. 그래야 앱이 catch 패턴 하나로 처리할 수 있다.
- 그리기·터치 중 실패처럼 던질 수 없는 경로는 뷰의 `onError` 콜백으로 전달한다.
  - `lastError`는 진단용 읽기 전용 값으로만 남긴다.

**Android**
- `BaroChartException extends RuntimeException`에 `getCode()`(enum)를 둔다. 코드 종류는 Swift와 같다.
- 지금 `AsterChartView`의 공개 메서드 4곳(`fire`, `setCrosshairSnap`, `setDrawingMagnet`, `setTool`)은 예외를 `lastError` 문자열에 넣고 삼킨다.
  - 이 메서드들은 **던지게** 바꾼다.
  - 그리기·터치 중 실패는 `OnChartErrorListener`로 전달한다.
  - 공개 가변 필드 `lastError`는 없애고 진단용 getter로 바꾼다.
- 빈 catch는 금지한다. 정적 검사 스크립트로 새 빈 catch가 0건인지 확인한다.

**스레드 규칙 (내 판단)**
- **뷰·래퍼:** 메인 스레드 전용이다.
  - UIKit·Android View 관례대로 잘못된 스레드는 지금처럼 즉시 실패시킨다(`precondition` / `IllegalStateException`).
  - Swift 뷰 타입에는 `@MainActor`를 붙여 컴파일 타임에 막는다.
- **엔진 타입 API:** 엔진을 만든 소유 스레드에서만 호출한다.
  - 지금 백그라운드 소유 엔진을 지원하므로 엔진 전체에 `@MainActor`는 붙이지 않는다.
  - 잘못된 스레드에서 부르면 크래시 대신 `wrongThread` 코드로 **던진다**.
  - 뷰에 붙인 엔진은 메인 스레드 소유여야 한다는 점을 문서에 적는다.
- Swift 6 엄격 동시성으로 컴파일하는 소비자 앱에서 진단이 0건인지 샘플 앱으로 확인한다.

**semver 보장 범위 (내 판단)**
- 1.0의 호환 보장 대상은 타입 API, 뷰·래퍼, 오류 타입이다.
- 저수준 API는 공개로 남기되 "고급 · 1.x 안에서 바뀔 수 있음"으로 표시한다.
  - Swift는 문서 주석과 DocC에 표시하고, Android는 문서와 `@RequiresOptIn` 대신 Javadoc에 표시한다.
  - 1.0 전에는 저수준 API의 이름만 바꾸고 시그니처는 다듬지 않는다.

### 5.4 타입 있는 핵심 API

두 플랫폼이 **같은 개념과 이름**을 쓴다. Swift는 enum·struct·`throws`를 쓰고, Android는 enum·불변 값 클래스·빌더를 쓴다.
Android 공개 API에는 nullability를 표기해서 Kotlin에서 플랫폼 타입(`!`)이 생기지 않게 한다.

| 영역 | 타입 있는 API (최소 집합) |
|---|---|
| 수명주기 | 엔진 생성(옵션 값 타입), `close()`, 뷰 `dispose()`, 상태 조회(`isClosed`) |
| 데이터 | `Bar`(UTC ms 시간 + OHLCV), `setBars`, `DataEvent` 적용 |
| 시리즈 | `SeriesType`: `candles`·`ohlc`·`line`·`area`·`histogram`. `Series` 값으로 add/update/remove. 패널·색·두께·지표 출력 연결 |
| 지표 | `IndicatorKind` 35종 enum. `IndicatorParams`(숫자·정수·문자열·불리언 값 맵). add/setParams/remove. 값 읽기 결과 타입. SMA·EMA·RSI·MACD·Bollinger·VWAP는 편의 생성자 제공 |
| 드로잉 | `DrawingTool` 16종 enum + 선택 도구. 시간·가격 점 목록과 스타일 값 타입. add/edit/delete(복수)/select. undo/redo. 저장/불러오기(문자열 문서) |
| 테마·심볼 | `Theme` 값 타입(`.dark`·`.light` 프리셋 + 주요 색·글꼴). `SymbolInfo`(id·거래소·시간대·통화·소수점·호가 단위) |
| 뷰포트 | `fit()`, 보이는 범위 조회/설정 |
| 작업공간 | `DatasetBinding` 값 타입. `saveWorkspace`, 비동기 복원(Swift는 `async throws`, Android는 콜백 + 취소 핸들) |
| 이벤트 | 크로스헤어 값(`CrosshairValues`), 상호작용 콜백, 오류 콜백 |

`DataEvent`는 코어 `applyDataEvent`의 종류를 그대로 옮긴다.
- `reset(bars)`
- `append(bar)`
- `update(bar)`: 현재 봉만 해당
- `correction(bar)`
- `prepend(bars)`
- `batch(events)`

**열거값과 코어의 일치 검사:** 지표 35종, 드로잉 16종, 시리즈 5종 enum 원시값이 코어 레지스트리와 같은지 테스트로 검사한다.
- 코어 쪽: `builtinIndicators`, `DRAWING_TYPES`, 모델의 시리즈 타입 목록
- 코어에 항목이 추가됐는데 enum이 따라가지 않으면 테스트가 실패해야 한다.

**저수준 탈출구:** 기존 딕셔너리/`JSONObject` 메서드는 같은 엔진에 공개로 남긴다.
- 문서에는 "고급·저수준"으로 표시한다.
- 타입 API는 내부적으로 이 저수준 메서드를 호출한다. 동작을 이중으로 구현하지 않는다.

### 5.5 UI 래퍼와 샘플 앱

**SwiftUI `BaroChartView`**
- `UIViewRepresentable`로 `BaroChartUIView`를 감싼다.
- 엔진은 앱이 소유하고 주입한다.
- 뷰가 사라지면 `dispose()`만 하고 엔진은 닫지 않는다.
- 상호작용·오류 콜백은 이니셜라이저 클로저로 받는다.

**Compose `BaroChart(engine, modifier, onInteraction, onError)`**
- `AndroidView`로 감싼다.
- 해제는 `onRelease`에서 뷰만 정리한다.
- 별도 Gradle 모듈과 아티팩트(`barochart-compose`)로 분리한다. 코어 AAR에 Kotlin·Compose 의존성이 들어가지 않게 하기 위해서다.

**샘플 앱 2개**
- SwiftUI 앱과 Compose 앱을 하나씩 만든다.
- 둘 다 타입 API만으로 다음 흐름을 보여 준다. 딕셔너리는 쓰지 않는다.
  1. 캔들 + EMA + 거래량 + RSI 패널
  2. 수평선 드로잉
  3. 1초 간격 스트리밍
  4. 작업공간 저장/복원
  5. 다크/라이트 전환
  6. 오류 표시
- 기존 `examples/swift-consumer`, `examples/kotlin-consumer`와 데모 앱은 새 이름으로 옮긴다. 검증용 프로브 역할은 유지한다.

### 5.6 배포·패키징

**iOS**
- `Package.swift`의 이름·제품·타깃을 `BaroChart`로 바꾼다.
- `PrivacyInfo.xcprivacy`를 리소스로 넣는다.
  - 근거: SDK가 `ProcessInfo.systemUptime`을 쓴다. 이는 Required Reason API의 시스템 부팅 시간 범주이고, 사유는 `35F9.1`(경과 시간 측정)이다.
  - 추적 없음, 수집 데이터 없음으로 선언한다.
- 소비자가 git URL로 패키지를 받을 때의 체크아웃 크기를 측정해 문서에 남긴다.

**Android**
- `maven-publish`로 다음 산출물을 만든다.
  - `barochart-android`: AAR, POM, sources jar, javadoc jar
  - `barochart-compose`
- 로컬 파일 Maven 저장소에 게시해서 리허설한다.
- 서명과 Central 업로드 설정은 문서와 설정 자리만 마련한다. **실행하지 않는다.**

**리허설 완료 기준:** 저장소 밖 빈 앱 두 개가 로컬 의존성만으로 릴리스 빌드되고 차트를 표시한다.
- iOS: 로컬 git 태그를 의존성으로 쓰는 SwiftUI 앱
- Android: 로컬 Maven을 쓰는 Compose 앱, R8 적용

**라이선스:** NOTICE와 QuickJS MIT 고지가 AAR(기존 방식)과 문서에 포함되는지 산출물에서 확인한다.

**버전:** `package.json`의 `version` 하나가 단일 원천이다.
- Android 빌드(`asterVersion` 기본값 등)와 SwiftPM 태그는 이 값을 따른다. 지금 어긋난 AAR 기본값 `0.2.10`도 바로잡는다.
- 작업 중에는 `0.3.0-dev`를 쓴다. 모든 게이트를 통과하면 `1.0.0-rc.1` 후보로 올린다.
- 태그는 `X.Y.Z`(접두사 없이) 하나로 세 플랫폼을 함께 가리킨다.
- 공개 태그 푸시와 레지스트리 게시는 승인 뒤에만 한다.

### 5.7 번들과 시작 성능

1. 먼저 측정한다. 대상은 지금 번들(588,470 B)의 엔진 생성 → 번들 평가 → 첫 장면 시간이다.
   - iOS 시뮬레이터·실기기, Android 에뮬레이터·실기기에서 각각 잰다.
2. 버전 고정된 최소화 도구(임시 경로 설치)로 축소 번들을 만들고 같은 측정을 반복한다.
   - 크기나 시작 시간이 의미 있게 줄면 축소 번들을 SDK 리소스로 쓴다.
   - 원본 번들과 같은 기능 테스트를 통과해야 한다.
3. QuickJS 바이트코드 사전 컴파일은 아래 예산의 시작 시간 목표를 실기기에서 넘길 때만 착수한다.

### 5.8 검증 게이트 (= 완료 기준)

| 게이트 | 완료 기준 |
|---|---|
| G1 빌드 | 아래 빌드가 모두 경고 0으로 통과한다 |
| G2 기존 런타임 테스트 | 기존 iOS 시뮬레이터·Android 에뮬레이터 실행 스크립트(`scripts/test-ios*.mjs`, `scripts/test-android*.mjs`, 소비자 runner)를 다시 실행한다. 실패는 고친다. 못 고친 실패는 원인과 함께 "남은 실패"로 기록한다 |
| G3 새 API 테스트 | 타입 API의 모든 공개 메서드와 오류 경로를 실제 런타임에서 테스트한다. iOS는 시뮬레이터 XCTest, Android는 에뮬레이터 계측 테스트나 기존 runner 방식을 쓴다. enum·코어 일치 테스트도 포함한다 |
| G4 샘플·리허설 | §5.5 샘플 앱과 §5.6 리허설이 시뮬레이터·에뮬레이터와 실기기에서 동작한다 |
| G5 안정성 | 시뮬레이터·에뮬레이터 30분 스트리밍 soak에서 크래시 0. 워밍업 뒤 메모리는 평탄하다. 엔진·뷰 생성/해제 500회 뒤 누수가 없다 |
| G6 실기기 성능 | iPhone·Android 폰에서 아래 지표를 기록한다. 예산 미달은 숨기지 않고 기록한다 |
| G7 접근성 | XCUI `performAccessibilityAudit`와 Android Accessibility Test Framework 검사 통과. VoiceOver·TalkBack 실기기 수동 체크리스트를 쓰고, 저장소 주인 확인이 필요한 항목은 표시한다 |
| G8 회귀 | Node `npm test`, `npm run check`, `check:types`, `check:package`, `check:security:offline`과 기존 Chrome CI 검사가 그대로 통과한다 |

**G1 빌드 대상**
- iOS 시뮬레이터 + 실기기 아키텍처, 배포 대상 17
- macOS `swift build`
- Android AAR debug/release, 두 ABI, Java `-Werror`
- Compose 모듈
- Kotlin 소비자 R8 릴리스

**G5 메모리 평탄 기준**
- 10분 구간마다 RSS 증가가 5% 이내여야 한다.

**G6 측정 지표와 잠정 예산** (내 판단, 첫 실측 뒤 근거와 함께 조정 가능)

| 지표 | 잠정 예산 |
|---|---|
| 엔진 생성부터 첫 프레임까지 p50 | 500 ms 이하 |
| 1만 봉에서 팬·핀치 프레임 시간 p95 | 16.7 ms 이하 |
| 앱 크기 증가 | ABI당 3 MB 이하 |
| 1만 봉 상주 메모리 | 기록만 한다 |

**CI:** PR마다 다음 빌드 검사를 GitHub Actions에 추가한다.
- macOS 러너: iOS 시뮬레이터 빌드 + `swift build`
- Ubuntu 러너: Android AAR + Compose + Kotlin 소비자 빌드

에뮬레이터·시뮬레이터 실행 테스트와 실기기 측정은 로컬에서 하고 결과 파일을 남긴다.

### 5.9 문서

- README의 네이티브 절을 다시 쓴다. 지원 매트릭스, 설치, 15분 퀵스타트를 넣는다.
- `docs/IOS-GUIDE.md`, `docs/ANDROID-GUIDE.md`를 새로 만든다.
  - 설치, 수명주기·스레드 규칙, 오류 처리, SwiftUI/Compose, 저수준 API 안내를 담는다.
  - 기존 `SWIFT-SDK.md`, `ANDROID-SDK.md`는 상세 계약 문서로 남기고 링크한다.
- API 레퍼런스를 만든다. Swift는 DocC, Android는 Javadoc이다. 레퍼런스와 오류 메시지는 영어로 쓴다.
- 가이드(`IOS-GUIDE`, `ANDROID-GUIDE`, 마이그레이션)와 README 네이티브 절은 영어·한국어 두 벌로 쓴다.
- 루트에 `CHANGELOG.md`, `SECURITY.md`(취약점 신고 경로), `docs/MIGRATING-FROM-ASTER.md`를 둔다.
- 개인정보 매니페스트 설명과 측정 결과 문서 `docs/measurements/native-sdk-*.json`도 만든다.

## 6. 단계 (PR 단위)

| PR | 내용 | 끝나는 조건 |
|---|---|---|
| 1 | **기준선 실행:** 이름을 그대로 둔 채 iOS·Android 빌드와 기존 런타임 테스트를 실행하고 깨진 것을 고친다 | G1(현재 이름), G2 |
| 2 | **이름 변경**(기계적 커밋) + x86_64 + 개인정보 매니페스트 + 버전 단일화 | G1, G2 재통과, G8 |
| 3 | **오류 계약** | 오류 경로 테스트, 빈 catch 0 |
| 4 | **Swift 타입 API** + 테스트 | G3(iOS) |
| 5 | **Android 타입 API** + 테스트 | G3(Android) |
| 6 | **SwiftUI·Compose 래퍼** + 샘플 앱 | G4(시뮬레이터·에뮬레이터) |
| 7 | **패키징:** 로컬 Maven·SwiftPM 태그 리허설, 번들 최소화, CI 빌드 잡 | G4 리허설, CI 통과 |
| 8 | **측정·문서:** soak, 실기기 성능, 접근성, 가이드·레퍼런스·CHANGELOG·SECURITY | G5, G6, G7, 문서 |

PR 1은 이름 변경보다 반드시 먼저 한다. 깨진 동작과 이름 변경이 섞이면 원인을 가를 수 없기 때문이다.
실기기 단계에 이르면 기기 연결과 iPhone 서명 팀을 저장소 주인에게 요청한다.

## 7. 빌더에게 맡기는 것

- 타입 API의 세부 형태. 예: 매개변수 레이블, 빌더 메서드 이름, `Theme`에 노출할 색 항목의 정확한 목록. §5.4의 범위와 두 플랫폼 개념 일치만 지키면 된다.
- 각 지표의 편의 생성자 매개변수 기본값. 코어 기본값을 따른다.
- 최소화 도구 선택과 버전, 측정 하네스 구현 방식.
- 테스트 프레임워크 세부. iOS는 XCTest 구성, Android는 계측 테스트 또는 기존 runner 확장 중에서 고른다.
- 문서 구조의 세부 목차.

## 8. 열린 질문

없음. 2026-11-01에 저장소 주인이 Android 이름, 버전 체계, 문서 언어, iOS 최소 버전을 정했다(§3).
