# BaroChart 네이티브 SDK 상용화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** iOS·Android 앱 개발자가 그대로 가져다 쓸 수 있도록 BaroChart 네이티브 SDK를 만든다. 실제 런타임 검증, BaroChart 이름, 타입 있는 핵심 API, SwiftUI·Compose 래퍼, 배포 리허설, 실측 수치를 갖춘다.

**Architecture:** 기존 JS 코어와 네이티브 호스트 구조는 그대로 둔다. iOS는 JavaScriptCore + CoreGraphics, Android는 QuickJS + JNI + Canvas다. 그 위에 세 계층을 얹는다.
- **타입 API 계층:** Swift extension 파일 하나, Android 타입 클래스 묶음. 내부적으로 기존 저수준 메서드를 호출하고, 오류를 `BaroChartError`/`BaroChartException` 하나로 바꾼다.
- **UI 래퍼:** SwiftUI는 `UIViewRepresentable`, Compose는 별도 아티팩트의 `AndroidView`.
- **패키징:** SwiftPM 루트 패키지와 Maven publish.

**Tech Stack:**
- iOS: Swift 6.x 툴체인(tools 6.0, language mode 5), JavaScriptCore, UIKit/SwiftUI, XCTest, Xcode 27 + iOS 27 Simulator
- Android: Java 8 바이트코드, JNI(C), QuickJS(vendored), AGP 8.13.2, Gradle 8.14.5, NDK 29.0.14033849, Kotlin 2.4.10 + Compose(별도 모듈), AndroidX Test
- 공통: Node 22.20.0, TypeScript 5.9.3

**Spec:** `docs/superpowers/specs/2026-11-01-native-sdk-commercial-design.md` (실행자는 이 계획과 함께 반드시 읽는다)

## Global Constraints

- 직렬화 스키마 문자열은 바꾸지 않는다. 대상: `aster.workspace`, `aster.drawings`, `aster.*`
- 코어 JS 브리지 함수(`native*`)와 리소스 파일 이름 `aster-core.js`도 그대로 둔다.
- `native/Resources/aster-core.js`는 직접 고치지 않는다. 다시 만드는 명령: `node scripts/build-native.mjs --bundle-only --output native/Resources/aster-core.js`
- 코어 JS의 npm 런타임 의존성 0을 유지한다. 빌드 도구는 버전을 고정해 임시 경로에 설치한다.
- Android 코어 AAR은 Java 8 바이트코드로 빌드하고 `-Werror`를 유지하며 Kotlin 의존성을 넣지 않는다. Kotlin은 Compose 모듈에만 쓴다.
- Swift: tools 6.0, language mode 5, iOS 17 / macOS 13 최소.
- Android: minSdk 26, compileSdk 36, ABI는 `arm64-v8a`와 `x86_64`.
- 이름:
  - Swift 모듈·제품·패키지: `BaroChart`
  - Android 패키지: `kr.coden.barochart`, Compose는 `kr.coden.barochart.compose`
  - Maven: `kr.coden:barochart-android`, `kr.coden:barochart-compose`
- 버전 단일 원천은 `package.json`의 `version`이다. 작업 중에는 `0.3.0-dev`를 쓴다.
- 문서 언어:
  - 공개 API 문서 주석과 오류 메시지는 영어
  - 가이드와 README는 영어·한국어
  - 내부 구현 주석은 한국어
- 빈 catch를 금지한다. 오류는 원인과 해결 방향을 담는다.
- 검증 Node: `/Users/jinhongan/.nvm/versions/node/v22.20.0/bin/node`. 아래 명령의 `node`는 이 경로를 뜻한다.
- `main`에 직접 커밋하지 않는다. PR마다 브랜치를 만들고 CI를 통과시킨 뒤 머지한다.
- Conventional Commits 형식에 본문은 한국어로 쓴다.
- 레지스트리 업로드와 공개 태그 푸시는 하지 않는다. 저장소 주인의 별도 승인 사항이다.
- `.env`, 키스토어, 인증 파일은 읽지 않는다.

## Review Focus

1. **닫힌 엔진에 타입 API 호출:** 크래시 없이 `engineClosed`로 던져야 한다. Task 9·11 테스트에 고정한다.
2. **메인 소유 엔진을 백그라운드 스레드에서 호출:** `precondition` 크래시 대신 `wrongThread`로 던져야 한다. Task 9·11 테스트에 고정한다.
3. **잘못된 데이터 이벤트:** 마지막 봉과 시간이 다른 `update`, 시간순이 아닌 `reset`, NaN 가격은 `invalidArgument`와 원인 메시지를 내야 한다. 엔진 상태는 바뀌지 않아야 한다. Task 9·11 테스트에 고정한다.
4. **SwiftUI·Compose 재구성:** 같은 엔진으로 래퍼가 다시 만들어지면 이전 뷰만 정리하고 엔진은 열린 채 새 뷰가 그려야 한다. Task 12·13 테스트에 고정한다.
5. **이름 변경 이전의 저장본:** `aster.workspace` 문서와 `aster.drawings` 문서를 새 SDK가 그대로 읽어야 한다. Task 4 테스트에 고정한다.

---

## PR 1 — 기준선: 현재 이름 그대로 빌드·실행 검증

브랜치: `fix/native-baseline-20261101` (`main` 기준). 설계 문서 브랜치 `feature/native-sdk-commercial`은 PR 1에 함께 포함한다.

### Task 1: 툴체인 준비

**Files:**
- Create: `docs/NATIVE-TOOLCHAIN.md`. 검증에 쓴 도구 버전, 경로, 디스크 측정값을 영어로 기록한다.

**Interfaces:**
- Produces: 환경 변수 규약. 이후 모든 태스크가 쓴다.
  - `ASTER_GRADLE`: Gradle 8.14.5 실행 파일
  - `ASTER_GRADLE_JAVA_HOME`: `/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`
  - `ASTER_ANDROID_SERIAL`: 전용 에뮬레이터 serial
  - `TSC_PATH`: TypeScript 5.9.3의 `lib/tsc.js`
  - `ASTER_JAVA`: `/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java`

- [ ] **Step 1: 디스크 여유를 잰다**

  Run: `df -h /System/Volumes/Data`
  Expected: Avail ≥ 5 GiB. 미달이면 중단하고 보고한다.

- [ ] **Step 2: TypeScript 5.9.3을 설치한다**

  설치 위치는 `artifacts/toolchain/typescript-5.9.3`이다. 명령은 CI의 설치 명령과 같다.
  Run:
  ```bash
  npm install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund \
    --prefix artifacts/toolchain/typescript-5.9.3 typescript@5.9.3
  ```
  Expected: `node artifacts/toolchain/typescript-5.9.3/node_modules/typescript/lib/tsc.js -v` → `Version 5.9.3`

- [ ] **Step 3: Gradle 8.14.5 wrapper를 부트스트랩한다**

  Homebrew Gradle 9.x로는 AGP 8.x 프로젝트에서 `gradle wrapper`조차 실패한다. 그래서 빈 프로젝트에서 wrapper만 만든다.
  Run:
  ```bash
  mkdir -p artifacts/toolchain/gradle-bootstrap && cd artifacts/toolchain/gradle-bootstrap
  touch settings.gradle
  gradle wrapper --gradle-version 8.14.5
  ./gradlew --version
  ```
  Expected: `Gradle 8.14.5`. 배포판 경로는 `~/.gradle/wrapper/dists/gradle-8.14.5-bin/*/gradle-8.14.5/bin/gradle`이다. `scripts/build-android-library.mjs`가 자동으로 찾는 위치와 같다.

- [ ] **Step 4: Gradle 의존성 캐시를 온라인으로 한 번 채운다**

  Run:
  ```bash
  JAVA_HOME=$ASTER_GRADLE_JAVA_HOME <gradle-8.14.5> -p native/android/library assembleRelease
  ```
  Expected: BUILD SUCCESSFUL. `~/.gradle/caches/modules-2`가 생기고, 빌드 스크립트의 격리 캐시 복사가 동작한다.

- [ ] **Step 5: 전용 AVD를 만들고 부팅한다**

  다른 프로젝트의 `lifeshot_*` AVD는 쓰지 않는다.
  Run:
  ```bash
  avdmanager create avd -n barochart-api36 \
    -k "system-images;android-36;google_apis_ps16k;arm64-v8a" -d pixel_8
  emulator -avd barochart-api36 -no-snapshot-save -no-boot-anim &
  adb wait-for-device
  ```
  Expected: `adb devices`에 `emulator-5554 device`가 보인다. 이 serial을 `ASTER_ANDROID_SERIAL`로 쓴다.

- [ ] **Step 6: 위 버전과 경로를 `docs/NATIVE-TOOLCHAIN.md`에 기록하고 커밋한다**

  ```bash
  git add docs/NATIVE-TOOLCHAIN.md
  git commit -m "docs: 네이티브 검증 툴체인 기록"
  ```

### Task 2: iOS·macOS 기준선 실행과 수리

**Files:**
- Modify: 실패 원인에 따라 `native/*.swift`, `examples/ios/*`, `examples/native/*.swift`, `scripts/*ios*.mjs`, `scripts/build-native.mjs`. 원인 없는 수정은 금지한다.
- Create: `docs/measurements/native-baseline-20261101.json`. 실행마다 명령, 종료 코드, 통과 수, 실패 원인을 남긴다.

**Interfaces:**
- Produces: "기존 iOS/macOS 실행 스크립트 전부 통과"라는 기준선. 이후 PR이 같은 명령으로 재검증한다.

- [ ] **Step 1: macOS 네이티브 실행 파일을 빌드한다**

  Run: `node scripts/build-native.mjs`
  Expected: `artifacts/aster-native`가 생긴다.

- [ ] **Step 2: macOS 네이티브 self-test를 모두 실행한다**

  대상: `test:native`, `test:api:native`, `test:native:async`, `test:native:prepare`, `test:native:soak`, `test:native:frames`, `test:axes:native`, `test:native:publication`, `test:native:studies`
  Run: `npm run <script>`
  Expected: 각각 exit 0. 실패하면 Step 6으로 간다.

- [ ] **Step 3: iOS 데모를 빌드하고 시뮬레이터 검증을 실행한다**

  Run: `node scripts/build-ios.mjs && node scripts/test-ios.mjs`
  Expected: exit 0, 보고서의 checks가 모두 통과.

- [ ] **Step 4: 나머지 iOS runner를 차례로 실행한다**

  대상:
  - `test:ios:async`, `test:ios:prepare`, `test:axes:ios`
  - `build:ios:ingestion` + `test:ios:ingestion`
  - `build:ios:mobile-ux` + `test:ios:mobile-ux`
  - `build:apple:transactions` + `test:apple:transactions`
  - `test:sdk:swift`(`--mode all`), `test:sdk:closed`, `test:native:cache:recovery`

  Expected: 각각 exit 0.

- [ ] **Step 5: 최신 비동기 API의 SwiftPM 소비자 실행을 확인한다**

  Swift 쪽 새 API(`setIndicatorParamsAsync`, `restoreWorkspaceAsync`, `compactData`, `translateDrawings`, `deleteDrawings`)가 기존 runner에서 실행되는지 확인한다.
  실행되지 않는 API는 `examples/swift-study-consumer` 패턴으로 최소 실행 검사를 만든다.
  - 파일: `examples/swift-consumer/Sources/AsterSDKProbe/RecentAPIProbe.swift`
  - 각 API를 정상 1회 + 실패 경로 1회 호출한다.

  Run: `swift run --package-path examples/swift-consumer --scratch-path artifacts/swift-consumer AsterSDKProbe`
  Expected: probe 출력의 recent-API 검사가 모두 pass.

- [ ] **Step 6: 실패마다 원인을 고친다**

  먼저 실패를 재현하는 최소 명령을 기록한다. 그다음 원인을 고치고 같은 명령으로 GREEN을 확인한다.
  고칠 수 없는 실패(예: 도구 버전 차이)는 원인과 함께 측정 JSON에 `retainedFailures`로 남긴다.

- [ ] **Step 7: 측정 JSON을 쓰고 커밋한다**

  ```bash
  git add docs/measurements/native-baseline-20261101.json <고친 파일>
  git commit -m "fix: iOS·macOS 네이티브 기준선 실행 실패 수정"
  ```

### Task 3: Android 기준선 실행과 수리

**Files:**
- Modify: 실패 원인에 따라 `native/android/**`, `examples/android/**`, `examples/kotlin-*/**`, `scripts/*android*.mjs`
- Modify: `docs/measurements/native-baseline-20261101.json`의 android 섹션

- [ ] **Step 1: AAR을 빌드하고 감사한다**

  Run: `node scripts/build-android-library.mjs`
  Expected: AAR 산출과 감사 보고 통과(`native/android/library/package-audit.test.mjs` 기준).

- [ ] **Step 2: 데모 APK를 빌드하고 에뮬레이터 검증을 실행한다**

  Run: `node scripts/build-android.mjs && ASTER_ANDROID_SERIAL=emulator-5554 node scripts/test-android.mjs`
  Expected: exit 0. 출력이 `nativeChecks:13`이고 extended 6개가 통과.

- [ ] **Step 3: 나머지 Android runner를 차례로 실행한다**

  대상:
  - `test:android:async`, `test:android:prepare`, `test:android:hover`, `test:android:retention`
  - `build:android:ingestion` + `test:android:ingestion`
  - `build:android:mobile-ux` + `test:android:mobile-ux`
  - `test:sdk:kotlin`, `node scripts/test-kotlin-ingestion-consumer.mjs`

  Expected: 각각 exit 0.

- [ ] **Step 4: Java 쪽 새 API를 실제 JNI로 실행한다**

  대상 API: `setIndicatorParamsAsync`, `restoreWorkspaceAsync`, `compactData`, `translateDrawings`, `deleteDrawings`
  - 파일: `examples/android/RecentAPIVerification.java`
  - 내용: 정상 1회 + 실패 경로 1회씩 실행하고 `files/recent-api.json`에 기록한다.
  - `DemoActivity`의 self-test 흐름에서 호출한다. `scripts/test-android.mjs`가 이 보고서도 읽고 전부 pass를 요구하게 고친다.

  Expected: `recent-api.json`의 `passed` = 전체 검사 수, `failed` = 0.

- [ ] **Step 5: 실패마다 원인을 고친다** (Task 2 Step 6과 같은 규칙)

- [ ] **Step 6: 커밋하고 PR 1을 연다**

  ```bash
  git commit -m "fix: Android 네이티브 기준선 실행 실패 수정"
  ```
  PR 본문에는 실행표(명령, 결과)와 남은 실패를 넣는다. CI가 통과하면 머지한다.

---

## PR 2 — 이름 변경, ABI, 개인정보 매니페스트, 버전 단일화

브랜치: `refactor/barochart-native-names`

### Task 4: 공개 이름 일괄 변경 (기계적 커밋)

**Files:**
- Rename: `native/AsterNative.swift` → `native/BaroChartEngine.swift`
- Rename: `native/AsterUIKit.swift` → `native/BaroChartUIView.swift`
- Rename: `native/AsterFrameRenderer.swift` → `native/BaroChartFrameRenderer.swift`
- Rename: `native/AsterColumns.swift` → `native/BaroChartColumns.swift`
- Rename: `native/android/java/dev/aster/charts/*` → `native/android/java/kr/coden/barochart/*`. `AsterEngine.java` → `BaroChartEngine.java`, `AsterChartView.java` → `BaroChartView.java`, `AsterColumns.java` → `BaroChartColumns.java`, `AsterBitmapCachePool.java` → `BaroChartBitmapCachePool.java`. 나머지 파일은 이름을 유지한다.
- Modify: `Package.swift`, `native/android/aster_jni.c`, `native/android/library/{build.gradle,CMakeLists.txt,src/main/res/values/public.xml,consumer-rules.pro}`, 참조하는 `scripts/**`, `test/**`, `examples/**`, 공개 문서(README.md, README.ko.md, docs/SWIFT-SDK.md, docs/ANDROID-SDK.md, docs/NATIVE*.md, docs/API*.md)
- 바꾸지 않음: 날짜가 붙은 과거 기록 문서(`docs/REVIEW-*`, `docs/QUALITY-AUDIT-*`, `docs/EIGHT-MODEL-*`, `docs/measurements/*`), `HANDOFF.md`
- Test: `test/public-branding.test.mjs` 수정, `test/legacy-documents-compat.test.mjs` 신규

**Interfaces:**
- Produces: 이후 모든 태스크가 쓰는 이름.

| 지금 | 바꾼 뒤 |
|---|---|
| SwiftPM `name`/product/target `AsterNative` | `BaroChart` |
| Swift `Aster` 접두 타입 전부 | `BaroChart` 접두. 예: `AsterEngine` → `BaroChartEngine`, `AsterBar` → `BaroChartBar`, `AsterNativeCacheBudget` → `BaroChartNativeCacheBudget` |
| Swift `AsterChartView` | `BaroChartUIView` (예외) |
| Swift `AsterError` (enum) | `BaroChartLowLevelError` (예외: Task 6의 새 `BaroChartError`와 충돌 방지) |
| Java 패키지 `dev.aster.charts` | `kr.coden.barochart` |
| Java `AsterEngine`/`AsterChartView`/`AsterColumns`/`AsterBitmapCachePool` | `BaroChartEngine`/`BaroChartView`/`BaroChartColumns`/`BaroChartBitmapCachePool` |
| JNI `Java_dev_aster_charts_AsterEngine_*`, `..._AsterColumns_writeSlice` | `Java_kr_coden_barochart_BaroChartEngine_*`, `Java_kr_coden_barochart_BaroChartColumns_writeSlice` |
| `System.loadLibrary("aster")`, CMake `add_library(aster` | `"barochart"`, `add_library(barochart` |
| AGP `namespace 'dev.aster.charts'` | `'kr.coden.barochart'` |
| 공개 리소스 `aster_sdk_version` | `barochart_sdk_version` |
| 앱 ID `dev.aster.charts.demo`, `dev.aster.charts.validation` 등 `dev.aster.*` | `kr.coden.barochart.demo`, `kr.coden.barochart.validation` 등 `kr.coden.barochart.*` |

내부 식별자는 유지한다: `ASTER_*` 환경 변수, Gradle 속성 `aster*`, JS `native*` 함수, `aster-core.js`, `aster.*` 스키마.

- [ ] **Step 1: 이전 저장본 호환 테스트를 먼저 쓴다**

  `test/legacy-documents-compat.test.mjs`:
  ```js
  test('pre-rename aster.workspace document restores unchanged', ...)
  // 픽스처: test/fixtures/legacy/aster-workspace-v1.json
  // 현재 main에서 saveWorkspace로 생성해 커밋한다.
  // 기대값: readWorkspaceDocument(doc).schema === 'aster.workspace'
  //        drawings.schema === 'aster.drawings', 복원 후 다시 저장하면 원문과 바이트 동일

  test('pre-rename aster.drawings document loads unchanged', ...)
  // 픽스처: test/fixtures/legacy/aster-drawings.json
  // 기대값: loadDrawings 뒤 saveDrawings === 원문
  ```
  Run: `node --test test/legacy-documents-compat.test.mjs`
  Expected: PASS. 이름 변경 전에도 통과해야 한다. 변경 뒤 퇴행을 잡기 위한 테스트다.

- [ ] **Step 2: `test/public-branding.test.mjs`의 기대값을 새 이름으로 바꾼다**

  - `Package.swift` → `/name: "BaroChart"/`
  - `native/android/java/kr/coden/barochart/BaroChartEngine.java` → `/package kr\.coden\.barochart/`
  - `src/core/workspace.mjs` → `/aster\.workspace/` (유지)
  - 추가 검사: `native/` 아래 공개 Swift·Java 선언에 `Aster` 접두 타입이 0개

  Run: `node --test test/public-branding.test.mjs`
  Expected: FAIL. 아직 바꾸지 않았기 때문이다.

- [ ] **Step 3: `git mv`와 치환 스크립트로 바꾼다**

  - 치환 스크립트: `scripts/rename-native-public-names.mjs`. 일회성이고 커밋한다.
  - 위 표를 순서대로 적용한다. 긴 이름부터 치환해야 부분 일치가 생기지 않는다.
  - 대상은 위 Files 목록뿐이다.
  - 실행 뒤 남은 참조 확인:
    `git grep -nE "AsterNative|AsterEngine|AsterChartView|dev\.aster|dev_aster|AsterColumns|AsterBar\b"`
    결과에 과거 기록 문서만 남아야 한다.

- [ ] **Step 4: `test/public-branding.test.mjs`를 실행한다**

  Expected: PASS

- [ ] **Step 5: 회귀 전체를 실행한다**

  Node:
  ```bash
  npm test && npm run check \
    && TSC_PATH=... npm run check:types \
    && TSC_PATH=... npm run check:package \
    && npm run check:security:offline
  ```
  Expected: 모두 통과. Node 테스트 수는 기준선 수 + 신규 수다.

  Native: Task 2·3의 모든 runner를 같은 명령으로 다시 실행한다.
  Expected: 기준선과 같은 통과 수.

- [ ] **Step 6: 기계적 변경만 담아 커밋한다**

  ```bash
  git commit -m "refactor: 네이티브 공개 이름을 BaroChart로 변경"
  ```

### Task 5: x86_64 ABI, 16 KiB 정렬 검사, 개인정보 매니페스트, 버전 단일화

**Files:**
- Modify: `native/android/library/build.gradle` (`abiFilters 'arm64-v8a', 'x86_64'`; `sdkVersion` 기본값을 `package.json` 값으로 읽기)
- Modify: `scripts/build-android-library.mjs`. `--version` 기본값은 이미 `package.json`이다. 감사에 두 ABI 존재와 ELF 정렬 검사를 추가한다.
- Create: `scripts/check-elf-alignment.mjs`. ELF64 program header를 직접 파싱해서 모든 `PT_LOAD`의 `p_align ≥ 16384`인지 본다.
- Create: `native/Resources/PrivacyInfo.xcprivacy`
- Modify: `Package.swift` (`resources`에 `.copy("Resources/PrivacyInfo.xcprivacy")` 추가)
- Modify: `package.json` (`"version": "0.3.0-dev"`)
- Test: `test/elf-alignment.test.mjs`, `test/privacy-manifest.test.mjs`, `test/version-single-source.test.mjs`

**Interfaces:**
- Produces: `checkElfAlignment(bytes: Uint8Array) → {ok: boolean, segments: {align: number}[]}` (`scripts/check-elf-alignment.mjs`의 export)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

  - `elf-alignment.test.mjs`
    - 합성 ELF64 헤더 두 개로 판정을 검사한다. `p_align` 0x4000은 ok=true, 0x1000은 ok=false.
  - `privacy-manifest.test.mjs`
    - plist를 텍스트로 파싱한다.
    - `NSPrivacyTracking` = false
    - `NSPrivacyCollectedDataTypes` = 빈 배열
    - `NSPrivacyAccessedAPITypes`에 `NSPrivacyAccessedAPICategorySystemBootTime` 항목이 있고 이유는 `["35F9.1"]`
    - `Package.swift` resources에 포함
  - `version-single-source.test.mjs`
    - `package.json` version이 `0.3.0-dev`
    - `build.gradle`에 하드코딩된 `'0.2.10'`이 없음

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

  Run: `node --test test/elf-alignment.test.mjs test/privacy-manifest.test.mjs test/version-single-source.test.mjs`
  Expected: FAIL

- [ ] **Step 3: 위 파일들을 구현한다**

  `build.gradle`의 기본 버전은 `new groovy.json.JsonSlurper().parse(file('../../../package.json')).version`으로 읽는다.

- [ ] **Step 4: 테스트를 다시 실행한다**

  Run: Step 2 명령 + `node scripts/build-android-library.mjs`
  Expected: PASS. 감사 보고에 `abis: ["arm64-v8a","x86_64"]`, 두 `.so` 모두 정렬 ok.

- [ ] **Step 5: iOS 빌드를 확인한다**

  Run:
  ```bash
  xcodebuild -scheme BaroChart -destination 'generic/platform=iOS' \
    -derivedDataPath artifacts/dd build OTHER_SWIFT_FLAGS=-warnings-as-errors
  ```
  같은 명령을 `generic/platform=iOS Simulator`로도 실행한다.
  Expected: 둘 다 BUILD SUCCEEDED, 경고 0. `BaroChart_BaroChart.bundle` 안에 `PrivacyInfo.xcprivacy`가 있다.

- [ ] **Step 6: 커밋하고 PR 2를 연다. CI 통과 후 머지한다**

  ```bash
  git commit -m "feat: x86_64 ABI·개인정보 매니페스트·버전 단일화"
  ```

---

## PR 3 — 오류 계약

브랜치: `feat/native-error-contract`

### Task 6: Swift `BaroChartError`와 뷰 오류 콜백

**Files:**
- Create: `native/BaroChartError.swift`
- Modify: `native/BaroChartUIView.swift` (`onError` 추가, `lastError` 대입 지점마다 `onError` 호출)
- Create: `Tests/BaroChartTests/BaroChartErrorTests.swift`
- Modify: `Package.swift` (`.testTarget(name: "BaroChartTests", dependencies: ["BaroChart"], path: "Tests/BaroChartTests")`)

**Interfaces:**
- Produces:
  ```swift
  public struct BaroChartError: Error, CustomStringConvertible, Sendable {
      public enum Code: String, Sendable, CaseIterable {
          case engineClosed, wrongThread, invalidArgument, javaScript,
               invalidScene, budgetExceeded, cancelled, cleanupPending, unavailable
      }
      public let code: Code
      public let message: String      // 영어, 원인
      public let recovery: String     // 영어, 해결 방향
      public let underlying: (any Error)?  // Sendable 아님 → @unchecked 대신 String으로 보관해도 됨(빌더 선택)
      public var description: String { get }  // "\(code): \(message) — \(recovery)"
  }
  extension BaroChartError {
      /// 저수준 오류를 타입 API 오류로 바꾼다
      static func wrap(_ error: any Error) -> BaroChartError
      /// body가 던지는 모든 오류를 wrap해서 다시 던진다
      static func mapping<T>(_ body: () throws -> T) throws -> T
  }
  // BaroChartUIView
  @MainActor public var onError: ((BaroChartError) -> Void)?
  ```
- `wrap`의 대응표:

| 저수준 오류 | Code |
|---|---|
| `BaroChartAsyncError.engineClosed` | `.engineClosed` |
| `.mainOwnerRequired`, `BaroChartLowLevelError.wrongThread` | `.wrongThread` |
| JS `TypeError`/`RangeError` 메시지 | `.invalidArgument` |
| 기타 JS 예외 | `.javaScript` |
| `BaroChartLowLevelError.invalidScene` | `.invalidScene` |
| `BaroChartLowLevelError.unavailableContext` | `.unavailable` |
| 예산 초과 메시지 | `.budgetExceeded` |
| 작업 취소 | `.cancelled` |
| `cleanupPending` | `.cleanupPending` |

  저수준 enum은 Task 4에서 `BaroChartLowLevelError`로 이름이 바뀐다.

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`BaroChartErrorTests.swift`)

  - `testWrapMapsClosedEngine`: 엔진 생성 → `close()` → `BaroChartError.mapping { try engine.fit() }`가 code `.engineClosed`를 던진다.
  - `testWrapMapsJavaScriptTypeError`: `mapping { try engine.addSeries(["id":"x","type":"bogus"]) }` → `.invalidArgument`. message에 `Unknown series type`이 들어 있다.
  - `testDescriptionHasRecovery`: 모든 `Code.allCases`에 대해 `recovery`가 비어 있지 않다.

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

  Run: `swift test --package-path . --scratch-path artifacts/swift-test --filter BaroChartErrorTests`
  Expected: FAIL (`BaroChartError` 미정의)

- [ ] **Step 3: `BaroChartError.swift`를 구현하고 `BaroChartUIView`에 `onError`를 연결한다**

- [ ] **Step 4: 테스트를 다시 실행한다**

  Run: Step 2 명령
  Expected: PASS

- [ ] **Step 5: 커밋한다**

  ```bash
  git commit -m "feat: Swift BaroChartError와 뷰 오류 콜백 추가"
  ```

### Task 7: Android `BaroChartException`, 뷰 리스너, 빈 catch 검사

**Files:**
- Create: `native/android/java/kr/coden/barochart/BaroChartException.java`
- Create: `native/android/java/kr/coden/barochart/OnChartErrorListener.java`
- Modify: `native/android/java/kr/coden/barochart/BaroChartView.java`
  - `fire`, `setCrosshairSnap`, `setDrawingMagnet`, `setTool`은 삼키지 않고 `BaroChartException`을 던진다.
  - 그리기·터치 경로는 listener로 전달한다.
  - 공개 필드 `lastError`를 없애고 `public String getLastErrorMessage()`로 바꾼다.
- Create: `scripts/check-empty-catch.mjs`. Java·Swift·C 소스에서 본문이 비었거나 주석만 있는 catch를 찾는다.
- Test: `test/empty-catch.test.mjs`
- Test: `native/android/library/src/androidTest/java/kr/coden/barochart/ErrorContractTest.java` (AndroidX Test)
- Modify: `native/android/library/build.gradle`
  - `testInstrumentationRunner 'androidx.test.runner.AndroidJUnitRunner'`
  - `androidTestImplementation 'androidx.test:runner'`, `'androidx.test.ext:junit'`. 버전은 Google Maven 최신 안정판으로 고정한다.

**Interfaces:**
- Produces:
  ```java
  public final class BaroChartException extends RuntimeException {
      public enum Code { ENGINE_CLOSED, WRONG_THREAD, INVALID_ARGUMENT, JAVASCRIPT,
                         INVALID_SCENE, BUDGET_EXCEEDED, CANCELLED, CLEANUP_PENDING, UNAVAILABLE }
      public BaroChartException(Code code, String message, String recovery, Throwable cause)
      public Code getCode()
      public String getRecovery()
      static BaroChartException wrap(Throwable error)  // package-private, Swift wrap과 같은 대응표
  }
  public interface OnChartErrorListener { void onChartError(BaroChartException error); }
  // BaroChartView
  public void setOnChartErrorListener(OnChartErrorListener listener)  // null 허용
  public String getLastErrorMessage()
  ```

- [ ] **Step 1: 실패하는 테스트를 쓴다**

  - `test/empty-catch.test.mjs`
    - `catch(Exception e){}`, `catch {}`, `catch (e) { /* x */ }` 샘플은 검출한다.
    - 로그를 남기거나 다시 던지는 catch는 통과시킨다.
    - 마지막에 실제 `native/**`, `src/**` 스캔 결과가 0건인지 확인한다.
  - `ErrorContractTest.java`
    - `setToolUnknownThrowsInvalidArgument`: `view.setTool("bogus")`가 `BaroChartException`을 던지고 code는 `INVALID_ARGUMENT`.
    - `closedEngineFitThrowsEngineClosed`
    - `drawFailureReachesListener`: 엔진을 닫은 뒤 `view.draw(canvas)`를 부르면 listener가 1회 호출된다. 앱은 죽지 않는다.

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

  Run:
  ```bash
  node --test test/empty-catch.test.mjs
  <gradle> -p native/android/library connectedDebugAndroidTest   # ANDROID_SERIAL=emulator-5554
  ```
  Expected: FAIL

- [ ] **Step 3: 구현한다**

  기존 소스에서 빈 catch가 검출되면 원인별로 처리한다.
  - 로깅: `android.util.Log.w("BaroChart", ...)` / `os_log`
  - 전파
  - 이유를 담은 명시적 무시: 주석이 아니라 카운터나 진단 값으로 남긴다.

- [ ] **Step 4: 테스트를 다시 실행한다**

  Run: Step 2 명령
  Expected: PASS. Task 3 Android runner도 재통과.

- [ ] **Step 5: 커밋하고 PR 3을 연다. CI 통과 후 머지한다**

  ```bash
  git commit -m "feat: Android BaroChartException과 오류 리스너, 빈 catch 검사"
  ```

---

## PR 4 — Swift 타입 API

브랜치: `feat/swift-typed-api`

### Task 8: Swift 값 타입과 코어 일치 테스트

**Files:**
- Create: `native/BaroChartTypes.swift`
- Create: `Tests/BaroChartTests/TypesParityTests.swift`
- Create: `scripts/export-native-vocabulary.mjs`
  - 코어의 `builtinIndicators` 키, `DRAWING_TYPES`, 시리즈 타입 5종, `THEME_KEYS`, `DARK_THEME`, `LIGHT_THEME`을 `Tests/BaroChartTests/Resources/vocabulary.json`과 `native/android/library/src/androidTest/assets/vocabulary.json`으로 내보낸다.
- Test: `test/native-vocabulary.test.mjs`. 내보낸 JSON이 코어 현재 값과 같은지 본다. 코어가 바뀌면 재생성을 강제한다.

**Interfaces:**
- Produces (모두 `public`, `Sendable`, `Equatable`):
  ```swift
  // BaroChartBar는 Task 4에서 이름만 바뀐 기존 타입(time/open/high/low/close/volume: Double, Codable)
  public indirect enum BaroChartDataEvent { case reset([BaroChartBar]), append(BaroChartBar), update(BaroChartBar),
                                           correction(BaroChartBar), prepend([BaroChartBar]), batch([BaroChartDataEvent]) }
  public enum BaroChartSeriesType: String, CaseIterable { case candles, ohlc, line, area, histogram }
  public enum BaroChartPriceSource: String, CaseIterable { case open, high, low, close, volume }
  public struct BaroChartSeries {
      public var id: String; public var type: BaroChartSeriesType; public var panel: String = "price"
      public var source: BaroChartPriceSource?; public var indicator: String?; public var output: String?
      public var color: String?; public var width: Double?; public var visible: Bool?; public var label: String?
      public init(id: String, type: BaroChartSeriesType, panel: String = "price", source: BaroChartPriceSource? = nil,
                  indicator: String? = nil, output: String? = nil, color: String? = nil, width: Double? = nil,
                  visible: Bool? = nil, label: String? = nil)
  }
  public enum BaroChartIndicatorKind: String, CaseIterable { /* 코어 35종 원시값 그대로: sma, vwma, ema, … parabolicSAR */ }
  public enum BaroChartParamValue: Equatable, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
                                   ExpressibleByStringLiteral, ExpressibleByBooleanLiteral {
      case number(Double), text(String), flag(Bool)
  }
  public struct BaroChartIndicator {
      public var kind: BaroChartIndicatorKind; public var params: [String: BaroChartParamValue]
      public init(_ kind: BaroChartIndicatorKind, params: [String: BaroChartParamValue] = [:])
      public static func sma(period: Int) -> Self; public static func ema(period: Int) -> Self
      public static func rsi(period: Int) -> Self
      public static func macd(fast: Int, slow: Int, signal: Int) -> Self
      public static func bollinger(period: Int, multiplier: Double) -> Self
      public static func vwap() -> Self
  }
  public enum BaroChartDrawingTool: String, CaseIterable { case select; /* + 코어 16종 원시값 그대로 */ }
  public struct BaroChartPoint { public var time: Double; public var price: Double; public init(time: Double, price: Double) }
  public struct BaroChartDrawingStyle { public var color: String?; public var fill: String?; public var width: Double?; public var font: String?; public init(...) }
  public struct BaroChartDrawing {
      public var id: String?; public var tool: BaroChartDrawingTool; public var points: [BaroChartPoint]
      public var panel: String = "price"; public var style: BaroChartDrawingStyle?; public var text: String?
      public var locked: Bool?; public var visible: Bool?
      public init(...)   // tool == .select면 생성 시가 아니라 addDrawing에서 invalidArgument
  }
  public struct BaroChartTheme {
      public var background, grid, text, up, down, crosshair: String; public var font: String
      public static let dark: BaroChartTheme   // 코어 DARK_THEME 값
      public static let light: BaroChartTheme  // 코어 LIGHT_THEME 값
  }
  public enum BaroChartAdjustment: String, CaseIterable { case raw, split, totalReturn = "total-return" }
  public struct BaroChartSymbol { public var id, exchange, timezone, currency, volumeUnit: String; public var priceDecimals: Int
                                  public var tickSize: Double; public var adjustment: BaroChartAdjustment; public init(...) }
  public struct BaroChartDatasetBinding { public var key, revision, adjustmentVersion, priceUnit: String
                                          public var adjustment: BaroChartAdjustment; public init(...) }
  public struct BaroChartVisibleRange { public var from: Double; public var to: Double }  // 봉 인덱스 좌표(코어 view 그대로)
  public struct BaroChartIndicatorValue { public var value: Double?; public var sourceIndex: Int?; public var sourceTime: Double? }
  public struct BaroChartCrosshairValues {
      public struct SeriesValue { public var id: String; public var label: String; public var panel: String; public var value: Double? }
      public var index: Int; public var time: Double; public var bar: BaroChartBar?; public var series: [SeriesValue]
  }
  // 내부: 저수준 딕셔너리 변환
  extension BaroChartDataEvent { var lowLevel: [String: Any] { get } }   // kind 키: reset/append/update/correction/prepend/batch
  extension BaroChartSeries { var lowLevel: [String: Any] { get } }      // nil 필드는 키를 넣지 않음
  // BaroChartIndicator, BaroChartDrawing, BaroChartTheme, BaroChartSymbol, BaroChartDatasetBinding도 같은 규칙
  ```

- [ ] **Step 1: 어휘 내보내기 스크립트와 Node 일치 테스트를 쓴다**

  Run: `node scripts/export-native-vocabulary.mjs && node --test test/native-vocabulary.test.mjs`
  Expected: PASS

- [ ] **Step 2: 실패하는 `TypesParityTests`를 쓴다**

  - `testIndicatorKindsMatchCore`: `Set(BaroChartIndicatorKind.allCases.map(\.rawValue))` == vocabulary.indicators (35)
  - `testDrawingToolsMatchCore`: `allCases`에서 `.select`를 뺀 값 == vocabulary.drawings (16)
  - `testSeriesTypesMatchCore`: 5종
  - `testThemePresetsMatchCore`: `.dark`·`.light`의 7개 필드 == DARK_THEME/LIGHT_THEME
  - `testLowLevelOmitsNilFields`: `BaroChartSeries(id:"e",type:.line).lowLevel` == `["id":"e","type":"line","panel":"price"]`
  - `testDataEventKinds`: 6 케이스 각각의 `lowLevel["kind"]`

- [ ] **Step 3: 테스트를 실행해 실패를 확인한다**

  Run: `swift test --scratch-path artifacts/swift-test --filter TypesParityTests`
  Expected: FAIL

- [ ] **Step 4: `BaroChartTypes.swift`를 구현한다**

- [ ] **Step 5: 테스트를 다시 실행한다**

  Run: Step 3 명령
  Expected: PASS

- [ ] **Step 6: 커밋한다**

  ```bash
  git commit -m "feat: Swift 타입 API 값 타입과 코어 일치 검사"
  ```

### Task 9: Swift 타입 엔진 메서드

**Files:**
- Create: `native/BaroChartEngine+Typed.swift`
- Modify: `native/BaroChartEngine.swift`. 아래 "편입 메서드"의 본문을 `BaroChartError.mapping { }`으로 감싼다.
- Create: `Tests/BaroChartTests/TypedEngineTests.swift`

**Interfaces:**
- Consumes: Task 8 타입, Task 6 `BaroChartError.mapping`
- Produces (`extension BaroChartEngine`, 모두 `throws`이고 `BaroChartError`만 던진다):
  ```swift
  func setBars(_ bars: [BaroChartBar]) throws
  func apply(_ event: BaroChartDataEvent) throws
  func addSeries(_ series: BaroChartSeries) throws
  func updateSeries(_ series: BaroChartSeries) throws          // id 기준, id/type 외 non-nil 필드만 patch
  func addIndicator(_ indicator: BaroChartIndicator, id: String) throws
  func setIndicatorParams(id: String, _ params: [String: BaroChartParamValue]) throws
  func indicatorValue(id: String, output: String? = nil, index: Int) throws -> BaroChartIndicatorValue
  func setTool(_ tool: BaroChartDrawingTool) throws
  @discardableResult func addDrawing(_ drawing: BaroChartDrawing) throws -> String
  func updateDrawing(id: String, _ drawing: BaroChartDrawing) throws
  @discardableResult func deleteDrawings(ids: [String]) throws -> Int
  func setTheme(_ theme: BaroChartTheme) throws
  func setSymbol(_ symbol: BaroChartSymbol) throws
  func visibleRange() throws -> BaroChartVisibleRange           // command("inspect")의 view
  func setVisibleRange(_ range: BaroChartVisibleRange) throws   // command("setVisibleRange", [from, to])
  func saveWorkspace(binding: BaroChartDatasetBinding) throws -> String
  func restoreWorkspace(_ document: String, binding: BaroChartDatasetBinding) async throws  // restoreWorkspaceAsync 감쌈, 취소 시 .cancelled
  func crosshairValues(width: Double, height: Double) throws -> BaroChartCrosshairValues?
  var isClosed: Bool { get }
  ```
- **편입 메서드:** 기존에 딕셔너리를 받지 않는 메서드는 타입 API로 편입한다. 시그니처는 그대로 두고 던지는 오류만 `BaroChartError`로 바꾼다.
  - 대상: `close()`, `fit()`, `undo()`, `redo()`, `removeSeries(_:)`, `removeIndicator(_:)`, `selectDrawing(_:)`, `saveDrawings()`, `loadDrawings(_:)`
  - 이 메서드들을 쓰는 기존 Swift 검증 앱의 catch 패턴은 같은 커밋에서 고친다.
- **스레드:** 타입 API 진입마다 `checkOwner()`를 확인한다. 기존 `precondition` 대신 `.wrongThread`를 던진다. 저수준 메서드의 `precondition`은 그대로 둔다.

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`TypedEngineTests.swift`, macOS JSC 실제 실행)

  - `testCandlesEmaFlow`
    - 4봉 `setBars` → `addSeries(candles)` → `addIndicator(.ema(period:3), id:"ema3")` → `addSeries(line, indicator:"ema3")` → `fit()`
    - `indicatorValue(id:"ema3", index:3).value`가 README 예제의 EMA(3) 값과 1e-9 이내로 같다. 기대값은 같은 데이터를 Node 코어로 계산해 테스트에 상수로 넣는다.
  - `testUpdateMustTargetLastBar` (Review Focus 3)
    - `apply(.update(bar with earlier time))` → `.invalidArgument`
    - 직전 `saveDrawings()`와 봉 수가 그대로다.
  - `testResetRejectsUnsortedAndNaN` (Review Focus 3)
  - `testClosedEngineThrows` (Review Focus 1)
    - `close()` 후 `setBars`, `addSeries`, `fit`, `isClosed`에 대해 앞의 셋은 `.engineClosed`를 던지고 `isClosed`는 true다.
  - `testWrongThreadThrows` (Review Focus 2)
    - 메인 스레드에서 만든 엔진을 `DispatchQueue.global().sync`에서 `setBars` → `.wrongThread`, 프로세스 생존.
  - `testDrawingRoundTrip`
    - `addDrawing(horizontal, 1점)` → `saveDrawings()`에 `aster.drawings` 스키마 포함
    - `deleteDrawings(ids:[id])` == 1
    - `undo()` 후 다시 1개
  - `testSelectToolCannotBeDrawn`: `addDrawing(tool:.select)` → `.invalidArgument`
  - `testThemeAndRange`
    - `setTheme(.light)` 후 `inspect`의 theme == LIGHT_THEME
    - `setVisibleRange(.init(from:0,to:3))` 후 `visibleRange()`의 `to - from` == 3
  - `testWorkspaceRoundTrip`
    - `saveWorkspace(binding:)` → 새 엔진에 같은 봉 → `await restoreWorkspace` → 저장 문서가 같다.
  - `testRestoreCancellation`: 복원 Task를 즉시 cancel → `.cancelled`, 엔진은 사용 가능.

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

  Run: `swift test --scratch-path artifacts/swift-test --filter TypedEngineTests`
  Expected: FAIL

- [ ] **Step 3: 구현한다**

  각 메서드는 `BaroChartError.mapping { try <저수준 호출>(값.lowLevel) }` 형태로 10줄 이내를 목표로 한다.

- [ ] **Step 4: 테스트를 다시 실행한다**

  Run: Step 2 명령, 그리고 iOS 시뮬레이터에서도:
  ```bash
  xcodebuild test -scheme BaroChart \
    -destination 'platform=iOS Simulator,name=<전용 시뮬레이터>' \
    -derivedDataPath artifacts/dd-test
  ```
  Expected: macOS·iOS 시뮬레이터 모두 PASS. Task 2 runner도 재통과.

- [ ] **Step 5: 커밋하고 PR 4를 연다. CI 통과 후 머지한다**

  ```bash
  git commit -m "feat: Swift 타입 있는 엔진 API"
  ```

---

## PR 5 — Android 타입 API

브랜치: `feat/android-typed-api`

### Task 10: Android 값 타입

**Files:**
- Create (`native/android/java/kr/coden/barochart/`): `Bar.java`, `DataEvent.java`, `SeriesType.java`, `PriceSource.java`, `Series.java`, `IndicatorKind.java`, `ParamValue.java`, `Indicator.java`, `DrawingTool.java`, `ChartPoint.java`, `DrawingStyle.java`, `Drawing.java`, `Theme.java`, `Adjustment.java`, `Symbol.java`, `DatasetBinding.java`, `VisibleRange.java`, `IndicatorValue.java`, `CrosshairValues.java`
- Create: `native/android/java/kr/coden/barochart/LowLevelJson.java`. package-private이며 값 타입을 `JSONObject`/`JSONArray`로 바꾼다. 메서드 하나에 타입 하나다.
- Test: `native/android/library/src/androidTest/java/kr/coden/barochart/TypesParityTest.java`

**Interfaces:**
- Produces: Swift Task 8과 같은 개념과 필드 이름.
  - 클래스는 모두 `public final`이고 필드는 `public final`이다. 선택 필드는 `@Nullable`(`androidx.annotation`, `compileOnly`)이다.
  - 인자가 많은 타입(`Series`, `Drawing`, `Symbol`)은 `public static Builder builder(...)`를 둔다. 필수 인자는 `builder` 매개변수, 선택 인자는 setter다.
  - `DataEvent`: `public static DataEvent reset(List<Bar>)`, `append(Bar)`, `update(Bar)`, `correction(Bar)`, `prepend(List<Bar>)`, `batch(List<DataEvent>)`
  - enum 원시값은 `public String wireName()`이다. 예: `Adjustment.TOTAL_RETURN.wireName() == "total-return"`
  - `Theme.DARK`, `Theme.LIGHT` 상수
  - `Indicator.sma(int)`, `ema(int)`, `rsi(int)`, `macd(int,int,int)`, `bollinger(int,double)`, `vwap()`

- [ ] **Step 1: 실패하는 `TypesParityTest`를 쓴다**

  Task 8 Step 2와 같은 6개 단언이다. vocabulary.json은 androidTest assets에서 읽는다.

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

  Run: `<gradle> -p native/android/library connectedDebugAndroidTest --tests '*TypesParityTest'`
  Expected: FAIL

- [ ] **Step 3: 구현한다**

- [ ] **Step 4: 테스트를 다시 실행한다**

  Run: Step 2 명령
  Expected: PASS

- [ ] **Step 5: 커밋한다**

  ```bash
  git commit -m "feat: Android 타입 API 값 타입과 코어 일치 검사"
  ```

### Task 11: Android 타입 엔진 메서드

**Files:**
- Modify: `native/android/java/kr/coden/barochart/BaroChartEngine.java`
  - 타입 메서드를 추가한다. 본문은 `LowLevelJson` 변환 + 저수준 호출 + `BaroChartException.wrap`이다.
  - 편입 메서드는 `throws JSONException`을 없애고 `BaroChartException`을 던진다.
- Create: `native/android/java/kr/coden/barochart/RestoreHandle.java` (`cancel()`, `isDone()`)
- Create: `native/android/java/kr/coden/barochart/RestoreCallback.java` (`onComplete(@Nullable BaroChartException error)`, 메인 스레드에서 호출)
- Test: `native/android/library/src/androidTest/java/kr/coden/barochart/TypedEngineTest.java`

**Interfaces:**
- Consumes: Task 10 타입, Task 7 `BaroChartException.wrap`
- Produces (`BaroChartEngine`의 public 메서드, 이름은 Swift Task 9와 같다):
  ```java
  void setBars(List<Bar> bars); void apply(DataEvent event);
  void addSeries(Series series); void updateSeries(Series series);
  void addIndicator(Indicator indicator, String id); void setIndicatorParams(String id, Map<String, ParamValue> params);
  IndicatorValue indicatorValue(String id, @Nullable String output, int index);
  void setTool(DrawingTool tool); String addDrawing(Drawing drawing); void updateDrawing(String id, Drawing drawing);
  int deleteDrawings(List<String> ids);   // 저수준 deleteDrawings(JSONArray)와 매개변수 타입이 달라 오버로드 충돌 없음
  void setTheme(Theme theme); void setSymbol(Symbol symbol);
  VisibleRange visibleRange(); void setVisibleRange(VisibleRange range);
  String saveWorkspace(DatasetBinding binding);
  RestoreHandle restoreWorkspace(String document, DatasetBinding binding, RestoreCallback callback);
  @Nullable CrosshairValues crosshairValues(double width, double height);
  boolean isClosed();
  ```
- 편입 메서드: `fit()`, `undo()`, `redo()`, `removeSeries(String)`, `removeIndicator(String)`, `selectDrawing(String)`, `saveDrawings()`, `loadDrawings(String)`. `close()`는 이미 unchecked다.
- 스레드: 타입 메서드 진입 시 소유 스레드 검사가 실패하면 `WRONG_THREAD`를 던진다.

- [ ] **Step 1: 실패하는 `TypedEngineTest`를 쓴다**

  Swift `TypedEngineTests`의 10개 테스트와 같은 시나리오·기대값이다. EMA 기대값 상수도 공유한다.
  `testWrongThreadThrows`는 `Executors.newSingleThreadExecutor().submit(...).get()`으로 확인한다.

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

  Run: `<gradle> -p native/android/library connectedDebugAndroidTest --tests '*TypedEngineTest'`
  Expected: FAIL

- [ ] **Step 3: 구현한다**

  편입 메서드의 checked 예외 제거로 깨지는 기존 Java 검증 코드(`examples/android/*`, `test/java-*` fixture)를 같은 커밋에서 고친다.

- [ ] **Step 4: 테스트를 다시 실행한다**

  Run: Step 2 명령 + Task 3 runner + `npm test`(Java 정적·fixture 테스트 포함)
  Expected: PASS

- [ ] **Step 5: 커밋하고 PR 5를 연다. CI 통과 후 머지한다**

  ```bash
  git commit -m "feat: Android 타입 있는 엔진 API"
  ```

---

## PR 6 — SwiftUI·Compose 래퍼와 샘플 앱

브랜치: `feat/swiftui-compose-wrappers`

### Task 12: SwiftUI `BaroChartView`와 SwiftUI 샘플 앱

**Files:**
- Create: `native/BaroChartSwiftUI.swift` (`#if canImport(SwiftUI) && canImport(UIKit)`)
- Create: `examples/swiftui-sample/` (Xcode 프로젝트, 로컬 패키지 의존)
  - `BaroChartSample.xcodeproj`
  - `Sources/SampleApp.swift`, `Sources/ChartScreen.swift`, `Sources/ChartModel.swift`
- Create: `examples/swiftui-sample/UITests/SampleUITests.swift`
- Create: `Tests/BaroChartTests/SwiftUIWrapperTests.swift` (iOS 시뮬레이터 전용, `#if canImport(UIKit)`)
- Create: `scripts/test-swiftui-sample.mjs`. 전용 시뮬레이터 생성 → build/test → 기기 삭제. `scripts/test-swift-consumer.mjs`의 시뮬레이터 수명 패턴을 재사용한다.

**Interfaces:**
- Consumes: Task 9 타입 API, Task 6 `onError`
- Produces:
  ```swift
  @MainActor public struct BaroChartView: UIViewRepresentable {
      public init(engine: BaroChartEngine,
                  onInteraction: (() -> Void)? = nil,
                  onError: ((BaroChartError) -> Void)? = nil)
      // makeUIView: BaroChartUIView(engine:) 생성
      // updateUIView: 콜백 갱신, 엔진 동일성이 바뀌면 이전 뷰 dispose 후 교체
      // dismantleUIView: uiView.dispose()만 호출, 엔진은 닫지 않음
  }
  ```
- 샘플 앱 화면 흐름(§5.5): 다음을 타입 API만으로 구현한다. 딕셔너리 리터럴은 쓰지 않는다.
  - 캔들 + EMA(20) + 거래량 히스토그램 + RSI(14) 패널
  - 수평선 버튼
  - 1초 타이머로 `apply(.update/.append)`
  - 작업공간 저장/복원 버튼
  - 다크/라이트 토글
  - 오류 배너

- [ ] **Step 1: 실패하는 래퍼 테스트를 쓴다** (`SwiftUIWrapperTests.swift`, `UIHostingController` 사용)

  - `testDismantleDisposesViewNotEngine` (Review Focus 4)
    - 호스팅 뷰를 window에서 제거하고 해제한다.
    - `BaroChartUIView.isDisposed == true`, `engine.isClosed == false`
  - `testRecreatedWrapperRendersSameEngine` (Review Focus 4)
    - 같은 엔진으로 두 번째 호스팅을 만들고 레이아웃을 강제한다.
    - 새 `BaroChartUIView.renderedRevision > 0`
  - `testOnErrorDelivered`: 엔진 close 뒤 `setNeedsDisplay`와 레이아웃 → `onError`가 `.engineClosed`로 1회 호출된다.

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

  Run: `xcodebuild test -scheme BaroChart -destination 'platform=iOS Simulator,name=<전용>' -only-testing:BaroChartTests/SwiftUIWrapperTests`
  Expected: FAIL

- [ ] **Step 3: `BaroChartSwiftUI.swift`와 샘플 앱을 구현한다**

  - 샘플은 Swift 6 language mode와 strict concurrency complete로 빌드한다.
  - `SampleUITests`: 앱 실행 → 차트 존재(accessibility label "Financial chart") → 수평선 추가 → 저장 → 복원 → 다크/라이트 토글 → 오류 배너가 없음.

- [ ] **Step 4: 테스트를 다시 실행한다**

  Run: Step 2 명령 + `node scripts/test-swiftui-sample.mjs`
  Expected: PASS. 샘플 빌드의 동시성 진단 0.

- [ ] **Step 5: 커밋한다**

  ```bash
  git commit -m "feat: SwiftUI BaroChartView와 샘플 앱"
  ```

### Task 13: Compose `BaroChart`와 Compose 샘플 앱

**Files:**
- Create: `native/android/compose/` Gradle 모듈
  - `build.gradle`: `com.android.library`, `org.jetbrains.kotlin.android` 2.4.10, `org.jetbrains.kotlin.plugin.compose` 2.4.10, Compose BOM 최신 안정판 고정, `namespace 'kr.coden.barochart.compose'`
  - `src/main/kotlin/kr/coden/barochart/compose/BaroChart.kt`
- Modify: `native/android/library/settings.gradle`. 루트를 라이브러리 + compose 두 모듈 구조로 바꾼다. 기존 `scripts/build-android-library.mjs` 경로가 깨지지 않게 그 스크립트도 고친다.
- Create: `examples/compose-sample/` (앱 모듈, 라이브러리·compose를 project 의존 또는 로컬 Maven 의존)
- Test: `native/android/compose/src/androidTest/kotlin/kr/coden/barochart/compose/BaroChartComposeTest.kt` (`androidx.compose.ui:ui-test-junit4`)

**Interfaces:**
- Consumes: Task 11 타입 API, Task 7 listener
- Produces:
  ```kotlin
  @Composable
  fun BaroChart(
      engine: BaroChartEngine,
      modifier: Modifier = Modifier,
      onInteraction: (() -> Unit)? = null,
      onError: ((BaroChartException) -> Unit)? = null,
  )
  // AndroidView(factory = { BaroChartView(it, engine) }, update = { 리스너 갱신 }, onRelease = { 뷰 정리, 엔진은 닫지 않음 })
  ```
  Android `BaroChartView`에 `setOnInteractionListener(Runnable)`이 없으면 이 태스크에서 추가한다(Java, null 허용).
- 샘플 앱 화면 흐름은 Task 12와 같다.

- [ ] **Step 1: 실패하는 Compose 테스트를 쓴다**

  - `releaseDisposesViewNotEngine` (Review Focus 4): `setContent { if (shown) BaroChart(engine) }` → `shown=false` → `engine.isClosed() == false`. 뷰는 detach되고 리스너가 해제된다.
  - `recompositionKeepsRendering`: 같은 엔진으로 키를 바꿔 재구성 → 새 뷰의 `renderedRevision > 0`
  - `onErrorDelivered`: 엔진 close 뒤 invalidate → `onError(ENGINE_CLOSED)` 1회

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

  Run: `<gradle> -p native/android/library :compose:connectedDebugAndroidTest`
  Expected: FAIL

- [ ] **Step 3: 모듈과 샘플 앱을 구현한다**

  샘플 계측 테스트 `SampleFlowTest`는 Task 12 `SampleUITests`와 같은 흐름을 확인한다.

- [ ] **Step 4: 테스트를 다시 실행한다**

  Run: Step 2 명령 + 샘플 `connectedDebugAndroidTest` + 샘플 `assembleRelease`(R8)
  Expected: PASS

- [ ] **Step 5: 커밋하고 PR 6을 연다. CI 통과 후 머지한다**

  ```bash
  git commit -m "feat: Compose BaroChart와 샘플 앱"
  ```

---

## PR 7 — 패키징, 번들, CI

브랜치: `feat/native-packaging`

### Task 14: 로컬 Maven 게시와 SwiftPM 태그 리허설

**Files:**
- Modify: `native/android/library/build.gradle`, `native/android/compose/build.gradle`
  - `maven-publish`, `singleVariant('release') { withSourcesJar(); withJavadocJar() }`
  - POM: name, description, url `https://github.com/ictechgy/BaroChart`, Apache-2.0 라이선스, developer, scm
  - 서명 블록은 `signing.keyId` 속성이 있을 때만 활성화한다. 값은 설정하지 않는다.
- Create: `scripts/rehearse-native-distribution.mjs`
  - Android:
    1. `publishReleasePublicationToLocalRepository`를 `artifacts/maven-local`에 실행한다.
    2. `examples/compose-sample`을 저장소 밖 임시 경로로 복사하고, `artifacts/maven-local`과 `google()`, `mavenCentral()`만 쓰도록 의존을 바꾼다.
    3. `assembleRelease`를 실행한다.
  - iOS:
    1. 저장소를 임시 경로로 `git clone --local`한다.
    2. 임시 태그 `0.3.0-dev.rehearsal`을 만든다. 원본 저장소에는 태그를 만들지 않는다.
    3. `examples/swiftui-sample`을 복사하고 패키지 의존을 그 로컬 git URL + 정확한 태그로 바꾼다.
    4. 시뮬레이터용으로 빌드한다.
    5. 체크아웃 크기(`du -sk`)를 기록한다.
- Create: `docs/measurements/native-distribution-rehearsal.json`
- Test: `test/maven-pom.test.mjs`. 생성된 POM XML에서 groupId `kr.coden`, artifactId 두 개, 라이선스, scm을 확인한다.

- [ ] **Step 1: 실패하는 `maven-pom.test.mjs`를 쓴다**

  POM 경로는 `artifacts/maven-local/kr/coden/barochart-android/0.3.0-dev/*.pom`이다.

- [ ] **Step 2: 테스트를 실행해 실패를 확인한다**

  Run: `node --test test/maven-pom.test.mjs`
  Expected: FAIL (POM 없음)

- [ ] **Step 3: 게시 설정과 리허설 스크립트를 구현한다**

- [ ] **Step 4: 리허설과 테스트를 실행한다**

  Run: `node scripts/rehearse-native-distribution.mjs && node --test test/maven-pom.test.mjs`
  Expected: 두 소비자 모두 릴리스 빌드 성공. JSON에 체크아웃 크기와 AAR 크기가 기록되고 테스트 PASS. AAR 안에 `licenses/QUICKJS-LICENSE.txt`와 `NOTICE.txt`가 있다.

- [ ] **Step 5: 커밋한다**

  ```bash
  git commit -m "feat: 로컬 Maven·SwiftPM 배포 리허설"
  ```

### Task 15: 번들 최소화 (측정 근거)

**Files:**
- Create: `scripts/measure-native-startup.mjs`
  - iOS 시뮬레이터와 Android 에뮬레이터에서 `엔진 생성 → 번들 평가 → 첫 scene` 시간을 원본과 축소 번들로 각각 30회 잰다.
  - p50/p95를 출력한다.
- Modify: `scripts/build-native.mjs`
  - `--minify` 옵션: esbuild를 `artifacts/toolchain/esbuild-<고정버전>`에 설치하고 `--minify-whitespace --minify-syntax`만 적용한다. 식별자 축소는 하지 않는다. 브리지 함수 이름 보존이 필요하기 때문이다.
- Create: `docs/measurements/native-startup.json`
- Test: `test/minified-bundle-parity.test.mjs`. 축소 번들을 Node VM에 로드하고, 원본과 같은 브리지 함수 목록과 README 예제 EMA 값을 확인한다.

- [ ] **Step 1: 원본 번들 시작 시간을 측정한다**

  Run: `node scripts/measure-native-startup.mjs --bundle native/Resources/aster-core.js`
  Expected: JSON에 iOS·Android p50/p95가 기록된다.

- [ ] **Step 2: 실패하는 parity 테스트를 쓰고 실행한다**

  Run: `node --test test/minified-bundle-parity.test.mjs`
  Expected: FAIL (축소 번들 없음)

- [ ] **Step 3: `--minify`를 구현하고 축소 번들을 만든다**

  축소 번들도 같은 측정을 반복한다.

- [ ] **Step 4: 채택 여부를 결정한다**

  크기 30% 이상 감소 **또는** 시작 p50 10% 이상 감소면 채택한다. 채택하면 `native/Resources/aster-core.js`를 축소본으로 교체하고 Task 2·3 runner와 Task 9·11 테스트를 재통과시킨다.
  미채택이면 측정값과 함께 미채택 이유를 기록한다.
  Expected: 결정과 근거 수치가 `native-startup.json`에 있다.

- [ ] **Step 5: 커밋한다**

  ```bash
  git commit -m "perf: 네이티브 번들 최소화 측정과 적용"
  ```
  미채택이면 메시지를 `chore: 네이티브 번들 최소화 측정 기록`으로 한다.

### Task 16: CI 빌드 잡

**Files:**
- Modify: `.github/workflows/verify.yml`. 잡 3개를 추가하고 액션은 모두 commit SHA로 고정한다.
  - `ios-build` (`macos-latest`)
    - `swift build`
    - `swift test` (macOS JSC)
    - `xcodebuild` iOS 시뮬레이터 빌드
  - `android-build` (`ubuntu-latest`)
    - JDK 17 + Android SDK
    - AAR(두 ABI)·compose·샘플 `assembleRelease`
    - ELF 정렬 검사
  - `android-x86-smoke` (`ubuntu-latest`, KVM)
    - x86_64 API 34+ 에뮬레이터 부팅
    - `connectedDebugAndroidTest --tests '*TypedEngineTest'`
    - 에뮬레이터 실행은 `reactivecircus/android-emulator-runner`를 SHA로 고정해 쓴다. 공식 릴리스 링크를 주석에 남긴다.

- [ ] **Step 1: 워크플로를 작성하고 PR을 연다**

- [ ] **Step 2: CI 결과를 확인한다**

  Run: `gh pr checks <PR#> --watch`
  Expected: 기존 잡과 새 잡 3개가 모두 success. 판정은 pull_request 실행 기준이다(취소된 push 실행은 무시).

- [ ] **Step 3: 커밋한다. PR 7을 CI 통과 후 머지한다**

  ```bash
  git commit -m "ci: iOS·Android 빌드와 x86_64 에뮬레이터 스모크 잡"
  ```

---

## PR 8 — 측정과 문서

브랜치: `docs/native-sdk-measurements`

### Task 17: soak과 생성/해제 반복 (시뮬레이터·에뮬레이터)

**Files:**
- Create: `examples/swiftui-sample/UITests/SoakUITests.swift`
- Create: `examples/compose-sample/src/androidTest/.../SoakTest.kt`
- Create: `scripts/run-native-soak.mjs`
  - 30분 동안 100 ms 간격으로 `apply(.update)`를 보내고 1 s 간격으로 `append`한다.
  - 1분마다 RSS를 샘플링한다. iOS는 `task_info` phys_footprint, Android는 `Debug.getPss`.
  - 이어서 엔진·뷰 생성/해제를 500회 반복하고 반복 전후 메모리를 비교한다.
- Create: `docs/measurements/native-soak.json`

- [ ] **Step 1: soak을 실행한다**

  Run: `node scripts/run-native-soak.mjs --platform ios && node scripts/run-native-soak.mjs --platform android`
  Expected (G5):
  - 크래시 0
  - 워밍업 5분 뒤 10분 구간마다 RSS 증가 ≤ 5%
  - 500회 반복 뒤 메모리 증가 ≤ 5%

  미달하면 원인을 조사하고 고친 뒤 재실행한다. superpowers:systematic-debugging을 따른다.

- [ ] **Step 2: 커밋한다**

  ```bash
  git commit -m "test: 네이티브 soak·생성해제 반복 측정"
  ```

### Task 18: 실기기 성능 측정

**Files:**
- Create: `scripts/measure-native-device.mjs`
  - iOS: `xcodebuild test`로 샘플 UITest `PerformanceUITests`를 실기기에서 실행한다. `XCTOSSignpostMetric`와 커스텀 signpost로 첫 프레임과 팬·핀치 프레임 시간을 잰다.
  - Android: `adb` 실기기에서 샘플 `PerformanceTest`(계측)를 실행한다. `FrameMetrics`로 프레임 시간을 잰다.
  - 앱 크기 증가: 라이브러리를 빼고 빌드한 샘플 대비 차이. iOS는 App Thinning Size Report, Android는 APK 크기와 ABI별 `.so` 크기.
- Create: `examples/swiftui-sample/UITests/PerformanceUITests.swift`, `examples/compose-sample/src/androidTest/.../PerformanceTest.kt`
- Create: `docs/measurements/native-device-performance.json`. 기기 모델, OS, 빌드 구성(release)을 포함한다.

- [ ] **Step 1: 저장소 주인에게 요청한다**

  - iPhone과 Android 폰을 USB로 연결해 달라고 한다. Android는 개발자 옵션 + USB 디버깅을 켜야 한다.
  - Xcode에 등록된 Apple 개발 팀 ID를 받는다. 서명은 `-allowProvisioningUpdates`로 자동 관리한다.
  - 기기 목록 조회는 `xcrun xctrace list devices`와 `adb devices`로 한다. `devicectl list devices`는 dyld 캐시를 다시 만들 수 있으므로 쓰지 않는다.

- [ ] **Step 2: 측정을 실행한다**

  Run: `node scripts/measure-native-device.mjs --platform ios --team <TEAM_ID>` 및 `--platform android --serial <SERIAL>`
  Expected: 측정 JSON 기록. 1만 봉 기준 지표는 아래와 같고, 예산 미달은 `budgetMisses`에 그대로 남긴다.

  | 지표 | 잠정 예산 |
  |---|---|
  | 엔진 생성부터 첫 프레임까지 p50 | ≤ 500 ms |
  | 팬·핀치 프레임 p95 | ≤ 16.7 ms |
  | 앱 크기 증가 | ABI당 ≤ 3 MB |
  | 상주 메모리 | 기록만 |

- [ ] **Step 3: 시작 시간 예산을 넘으면 별도 태스크를 연다**

  QuickJS 바이트코드 사전 컴파일 검토를 별도 태스크로 추가한다. 이번 계획 범위 밖이며 저장소 주인에게 보고한다.

- [ ] **Step 4: 커밋한다**

  ```bash
  git commit -m "test: 실기기 성능 측정 기록"
  ```

### Task 19: 접근성 검사

**Files:**
- Create: `examples/swiftui-sample/UITests/AccessibilityUITests.swift`. `try app.performAccessibilityAudit()`를 차트 화면에서 실행한다.
- Create: `examples/compose-sample/src/androidTest/.../AccessibilityTest.kt`. `AccessibilityChecks.enable()`(Espresso ATF)로 차트 화면 상호작용을 검사한다.
- Create: `docs/NATIVE-ACCESSIBILITY-CHECKLIST.md` (영어). VoiceOver·TalkBack 실기기 수동 항목을 담는다.
  - 차트 라벨 읽기
  - 위/아래 스와이프 확대·축소
  - 사용자 지정 동작(팬·드로잉 선택·취소)
  - 큰 글씨 대응
  - 저장소 주인 확인이 필요한 항목은 `[owner]`로 표시한다.

- [ ] **Step 1: 자동 검사를 실행한다**

  Run: 위 두 테스트를 시뮬레이터·에뮬레이터에서 실행한다.
  Expected: 위반 0. 위반이 있으면 고치고 재실행한다.

- [ ] **Step 2: 커밋한다**

  ```bash
  git commit -m "test: 네이티브 접근성 자동 검사와 수동 체크리스트"
  ```

### Task 20: 개발자 문서

**Files:**
- Create: `docs/IOS-GUIDE.md`, `docs/IOS-GUIDE.ko.md`, `docs/ANDROID-GUIDE.md`, `docs/ANDROID-GUIDE.ko.md`
  - 설치(SwiftPM URL + 버전 / Gradle 좌표)
  - 15분 퀵스타트(SwiftUI·Compose)
  - UIKit·View 사용
  - 수명주기·스레드 규칙(§5.3)
  - 오류 처리
  - 저수준 API("Advanced · may change within 1.x")
  - 개인정보 매니페스트
  - 지원 매트릭스와 측정 결과 링크
- Create: `docs/MIGRATING-FROM-ASTER.md`, `docs/MIGRATING-FROM-ASTER.ko.md`. Task 4 표와 저장본 호환 보장을 담는다.
- Create: `CHANGELOG.md` (Keep a Changelog 형식, `0.3.0-dev` 항목)
- Create: `SECURITY.md`. 신고 경로는 GitHub Security Advisories의 "Report a vulnerability"다. 지원 버전과 응답 목표를 적는다.
- Modify: `README.md`, `README.ko.md` 네이티브 절(지원 매트릭스·설치·가이드 링크). 웹 절은 그대로 둔다.
- Modify: 공개 Swift·Java 타입 API 문서 주석(영어)
- Create: `scripts/build-native-docs.mjs`
  - DocC: `xcodebuild docbuild -scheme BaroChart`
  - Javadoc: Gradle `javadocJar` 산출
  - 결과는 `artifacts/docs/`에 둔다.
- Test: `test/native-docs.test.mjs`
  - 가이드 4개 존재
  - 가이드의 코드 블록이 쓰는 타입 API 이름이 실제 소스 선언에 있다(이름 목록 대조)
  - 영어·한국어 가이드의 제목 구조가 같다

- [ ] **Step 1: 실패하는 `native-docs.test.mjs`를 쓰고 실행한다**

  Run: `node --test test/native-docs.test.mjs`
  Expected: FAIL

- [ ] **Step 2: 문서와 문서 주석을 작성한다**

- [ ] **Step 3: 테스트와 레퍼런스 생성을 실행한다**

  Run: `node --test test/native-docs.test.mjs && node scripts/build-native-docs.mjs`
  Expected: PASS. DocC 경고 0, Javadoc `-Xdoclint` 경고 0.

- [ ] **Step 4: 회귀 전체를 실행한다**

  Run: Node 회귀 전체 + Task 9·11 테스트
  Expected: 통과

- [ ] **Step 5: 커밋하고 PR 8을 연다. CI 통과 후 머지한다**

  ```bash
  git commit -m "docs: 네이티브 SDK 가이드·마이그레이션·CHANGELOG·SECURITY"
  ```

---

## 마무리

- [ ] `HANDOFF.md`를 갱신한다. 완료한 PR, 남은 실패와 예산 미달, 승인 대기 항목(Maven Central 업로드, 공개 태그 `1.0.0-rc.1`)을 적는다.
- [ ] 모든 게이트 G1~G8의 결과를 하나의 표로 저장소 주인에게 보고한다.
