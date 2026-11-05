# BaroChart 네이티브 Rust 코어 설계 (선택 가능한 백엔드)

_작성 2026-11-02 · 기준 커밋 `b2cef94` · 브랜치 `feat/rust-core`_

관련 문서:
- 이식 지도(안정 표면): [`2026-11-02-rust-core-porting-map.md`](2026-11-02-rust-core-porting-map.md)
- 이식 지도(저수준 API 보충): [`2026-11-02-rust-core-porting-map-tier-a.md`](2026-11-02-rust-core-porting-map-tier-a.md). 범위 목록과 미결 항목(O1~O8)의 정본이다.
- 이전 프로그램(상용화) 설계: [`2026-11-01-native-sdk-commercial-design.md`](2026-11-01-native-sdk-commercial-design.md)

## 1. 의도

저장소 주인 요청: **네이티브 코어를 Rust로 다시 쓴다. 기존 JavaScript 경로는 없애지 않고, 백엔드를 고를 수 있게 한다.** 웹은 계속 JS 코어를 쓴다.

지금 네이티브 코어는 JS(`src/core` 46개 모듈, 번들 589 KB)다. iOS는 시스템 JavaScriptCore, Android는 동봉한 QuickJS에서 돈다. Rust 백엔드에서 기대하는 이득과 그 한계를 미리 적어 둔다. 숫자는 측정값이고, 이득 크기는 추정이다.

- **기대하는 이득**
  - 시작 시간이 줄어든다. iOS 시뮬레이터 측정에서 시작 65.6 ms 중 `setBars`가 52.8 ms였다.
  - 엔진 하나를 더 만들 때마다 드는 고정 메모리(약 11 MB)가 줄어든다.
  - 비동기 잡이 VM을 띄우는 비용이 없어진다.
  - Android에서는 QuickJS 인터프리터를 대신한다.
- **기대하지 않는 것**
  - iOS 팬 프레임은 크게 줄지 않을 수 있다. 팬 p50 1.94 ms 중 1.128 ms가 CoreGraphics 래스터다.
  - 두 플랫폼 모두 이미 예산 안이다. 팬 p95는 iPhone XR 6.5 ms, Galaxy 3.8 ms다.

이 설계는 9개 의견(Codex, Grok, Devin, GLM, DeepSeek, Qwen, Claude 설계안 3개)을 종합했다. 14개 묶음으로 나눠 읽은 코드 조사(이식 지도)를 근거로 삼았다. 누가 무엇을 말했는지는 §12에 있다.

## 2. 저장소 주인 결정 (2026-11-02)

| # | 질문 | 결정 |
|---|---|---|
| 1 | Rust 범위 | **저수준 API까지 전부.** 커스텀 JS 지표만 제외한다. 대상: 비동기 잡, 수집 큐, 데이터 탐색, compaction |
| 2 | 기본 백엔드 | **JS를 기본으로 둔다.** 게이트(§8.3)를 통과하면 플랫폼별 별도 마이너 릴리스에서 Rust로 바꾼다. **Android가 먼저다.** 오류가 나도 다른 백엔드로 자동 전환하지 않는다 |
| 3 | JS 오라클 정규화 | **공용 JS 코어에서 정규화한다.** Rust보다 먼저 별도 JS 릴리스로 낸다(§7.4) |
| 4 | 진행 방식 | 단계마다 PR을 만들고, CI와 리뷰를 통과하면 main에 머지한다. 레지스트리 업로드와 공개 태그는 하지 않는다(별도 승인) |

이전부터 유지하는 결정:
- 웹은 JS 코어를 쓴다.
- 기존 구조(JS 경로)를 없애지 않는다.

## 3. 목표 · 비목표 · 반목표

**목표**
- iOS와 Android에서 엔진을 만들 때 백엔드를 고를 수 있다. 값은 `javaScript` 또는 `rust`다.
- Rust 백엔드가 지금 플랫폼 코드가 부르는 브리지 계약 전체를 구현한다. 커스텀 JS 지표는 빼고, 저수준 API는 포함한다.
- 같은 입력이면 같은 기기의 JS 백엔드와 다음이 같다.
  - 바이트 단위로 같은 것: 문서, 오류, 사용자에게 보이는 문자열
  - 비트 단위로 같은 것: 숫자 결과
- 기존 플랫폼 테스트를 두 백엔드에서 모두 돌린다.
  - 대상: XCTest, Android 계측과 Compose 테스트, 회귀 러너 iOS 25개·Android 15개
- Rust 백엔드도 실기기 예산을 지킨다.
  - 시작 p50 ≤ 500 ms, 팬 p95 ≤ 16.7 ms
  - 크기는 ABI당 5,242,880 B 이하(2026-11-04 전체 코어 실측 후 소유자 승인)

**비목표**
- 웹용 Rust/WASM 배포. WASM 빌드는 동등성 하네스에만 쓴다.
- Rust 백엔드에서 커스텀 JS 지표 실행. 대상: `nativeRegisterIndicatorSource`, 빌드 때 링크한 커스텀 지표 모듈
- 새 차트 기능
- UniFFI 같은 생성 바인딩과, 그것을 위해 플랫폼 계층을 새로 쓰는 일
- 새 장면 전송 포맷. JSON과 이미 있는 packet v1을 쓴다.
- iOS 렌더러를 packet 방식으로 바꾸는 일. 조건부다(§11, M4에서 판단).

**반목표 (기술적으로 돌아가도 실패로 본다)**
- Rust 오류를 JS로 자동 전환해 덮는 것
- 출력값에 허용 오차를 넣는 것. 예: 좌표 양자화, 지표 1 ulp 허용
- 오라클 정규화(§7.4) 밖에서 JS 동작을 몰래 바꾸는 것
- JS 경로를 없애거나 기능을 줄이는 것
- 엔진 안에서 앱을 죽이는 실패(abort, 처리 안 된 패닉)
- 기기에서 이식형 수학 라이브러리(libm 크레이트, fdlibm 이식)를 쓰는 것. 같은 기기 JS와 비트가 갈린다.

## 4. 구조

### 4.1 이음새: 지금의 브리지 계약

백엔드를 바꿔 끼우는 지점은 플랫폼이 이미 쓰는 계약 바로 아래에 둔다.

> **전역 함수 이름 + 인자 → 값, 또는 `Name: message` 오류**

이 계약을 고른 이유는 저장소에서 확인했다.
- 코어가 호스트를 다시 부르는 곳은 시간대 하나뿐이다(`aster_jni.c:42-51`). Swift에는 시간대 콜백이 없고, iOS는 JSC 내장 `Intl`을 쓴다.
- 코어는 결정적이다. `src/core`와 브리지에 `Date.now`, `performance.now`, `Math.random`, 인자 없는 `new Date()`가 없다.
- 타입 API의 `restoreWorkspace`도 두 플랫폼 모두 저수준 워크스페이스 원본/대상 프로토콜을 거친다(`BaroChartEngine+Typed.swift:155`, `BaroChartEngine.java:1384`).
- 호스트는 결과에서 봉투 필드만 검사한다(`BaroChartEngine.swift:469-483`). 원본과 대상 사이에 넘기는 내부 페이로드는 들여다보지 않는다.

그래서 이 계약만 지키면 위 계층이 거의 그대로 돈다. 위 계층은 뷰, 렌더러, 타입 API, 비동기 잡 상태기계, SwiftUI·Compose 래퍼, 블랙박스 테스트다.

### 4.2 공통 C ABI

Rust는 `staticlib`으로 빌드한다. `cbindgen`으로 만든 헤더 하나를 두 플랫폼이 같이 쓴다. 정확한 시그니처는 M1 계획에서 정한다. 형태는 다음과 같다.

| 함수 | 역할 |
|---|---|
| `bc_engine_new(host, &engine, &err)` | 빈 런타임을 만든다. JS에서 번들을 평가하는 단계에 해당한다. 그 뒤 호스트가 `nativeInit`을 부른다. 복원·비동기 대상 엔진은 `nativeInit` 없이 이 상태로 쓴다 |
| `bc_call(engine, name, args, flags, &out)` | 상태값은 `OK`, `THROW`, `UNAVAILABLE`, `CLOSED`, `POISONED`, `BUSY` 중 하나다. `THROW`이면 본문이 `{name, message, code}`다 |
| `bc_supports(engine, name)` | 함수가 있는지 답한다. iOS 렌더러가 하던 `context.objectForKeyedSubscript("nativeRenderFrameJSON")` 검사(`BaroChartFrameRenderer.swift:67`)를 대신한다 |
| `bc_read_f64` / `bc_write_f64` | `Float64Array` 복사 프로토콜을 대신한다. 대상: `nativeAsyncBuffer`, `nativeAsyncTargetBuffer`, `nativeIndicatorBuffer`, 열 데이터 |
| `bc_packet(engine, mode, token, w, h, force, &meta, &numbers)` | packet v1이다. 숫자는 비트 단위로, 메타데이터는 바이트 단위로 JS와 같다 |
| `bc_memory_stats`, `bc_engine_free`, `bc_buf_free` | 진단과 해제 |

**버퍼 소유권:** Rust가 할당하고 호스트가 `bc_buf_free`로 돌려준다. 지금도 경계를 넘는 값은 모두 소유 복사다(`BaroChartEngine.swift:1197`, `aster_jni.c:70-71`). 같은 규칙이다.

**값 인코딩 (`flags`)**
- **표준 모드 (Android):** `JSON.stringify`와 같은 텍스트다. `undefined`는 `null`이 되고, `NaN`과 `±Infinity`도 `null`이 된다(`aster_jni.c:60`과 같음).
- **무손실 모드 (iOS, 추적 기록):** JSON 상위 집합이다. 이 모드에서만 `NaN`, `Infinity`, `-Infinity`, `-0`, `undefined` 토큰을 쓴다. iOS JS 백엔드는 지금 `JSValue`로 NaN을 그대로 받고, `isUndefined`와 `isNull`을 따로 본다(`BaroChartEngine.swift:1624-1628`). Rust 결과도 Swift에 같은 값으로 보여야 한다. 추적 파일(§7.3)도 같은 형식을 쓴다.
- 타입 배열은 JSON에 싣지 않는다. 복사 함수(`bc_read_f64`/`bc_write_f64`)로 따로 보낸다.
  - 예외: Android 범용 `invoke`로 `Float64Array`를 돌려받는 경우(예: `nativeIndicatorBuffer`)는 JS `JSON.stringify`와 같은 인덱스 키 객체(`{"0":…}`)로 쓴다(보충 지도 O6).

**호스트 콜백 (`BcHost`):** 어느 스레드에서 불려도 안전해야 한다.
- `zone_resolve(name)`: 정규 이름을 돌려주거나 실패한다.
- `zone_offset_seconds(zone, epoch_ms)`
- 선택: `log(level, message)`. 개발자 진단용이다.
- `+05:30` 같은 고정 오프셋 이름은 Rust가 직접 처리한다.

**패닉:**
- `panic = "unwind"`로 빌드하고 모든 export를 `catch_unwind`로 감싼다.
- 패닉이 나면 엔진을 poison한다. 이후 호출은 `POISONED`가 되고, 플랫폼은 이것을 `Error: Chart disposed`로 보여 준다. 그래서 기존 `engineClosed` 분류와 '엔진을 새로 만들라'는 안내를 그대로 쓴다.
- 패닉 원인은 개발자 진단(로그, `runtimeMetrics`)에 따로 남긴다.
- `panic = "abort"`는 쓰지 않는다. 이 설정에서는 `catch_unwind`가 동작하지 않는다. rustc 1.96에서 종료 코드 134로 확인했다. 기준선 크기 차이는 1,408 B뿐이다.

**동시 진입:** 엔진마다 원자 busy 가드를 둔다. 재진입과 동시 호출은 정의되지 않은 동작 대신 `BUSY` 오류가 된다.

### 4.3 iOS

- **내부 프로토콜 `BaroChartCoreRuntime`(AnyObject)**
  - 멤버: `supports(name)`, `invoke(name, args) throws -> BaroChartCoreValue`, `copyOut`/`copyIn`, `packet`
  - `BaroChartJSCoreRuntime`: 지금의 `asterInvoke`·`asterTypedBytes` 본문을 그대로 옮긴다.
  - `BaroChartRustCoreRuntime`: C ABI를 부른다.
  - 기존 private `BaroChartContextRuntime`의 retire/lease(`BaroChartEngine.swift:304`)는 그대로 쓴다.
- **`BaroChartCoreValue`:** `JSValue`와 이름이 같은 접근자를 가진 facade다. 접근자: `isUndefined`, `isNull`, `toDouble`, `toDictionary`, `forProperty` 등. 그래서 `asterInvoke` 호출부는 받는 타입만 바뀐다.
- **고칠 곳:**
  - `JSContext` 직접 사용
  - `asterTypedBytes`+`memcpy` → `copyOut`/`copyIn`
  - 렌더러 67행 → `supports`
  - 워커 생성 3곳(525·895·1222행 부근) → 백엔드 factory
- **비동기 대상 엔진은 항상 원본과 같은 백엔드로 만든다.**
- **Rust로 보내는 인자는 전용 인코더로 만든다.** 이유는 셋이다.
  - NaN과 ±Inf를 다룬다.
  - `CFBoolean`과 `NSNumber`를 구분한다.
  - 키 순서를 결정적으로 만든다. Swift `Dictionary` 순서는 프로세스마다 다르다.
- **`JSValue`를 반환하는 공개 API는 Rust에서도 동작한다(보충 지도 O1).** 대상: `call`, `command`, `addIndicator`, `setIndicatorParams`.
  - Rust 결과를 소유 스레드마다 하나 둔 값 전용 `JSContext`에서 `JSValue`로 만든다. 빈 컨텍스트는 약 0.77 MB다.
  - 값은 `JSON.parse`와 reviver로 만든다. 그래야 NaN, ±Inf, -0, `undefined`가 살아남는다. `JSValue(object:)`는 키 순서를 바꾸므로 쓰지 않는다.
  - 이렇게 하는 이유는 세 가지다. 문서화된 저수준 API이고(`docs/IOS-GUIDE.md:180`), 기존 XCTest가 쓰며, 주인 결정 1(저수준까지 전부)과 맞는다.
  - `context` 속성만 Rust에서 막는다. 명확한 메시지로 `preconditionFailure`를 내며, 지금 닫힌 엔진에서 하는 방식과 같다(`BaroChartEngine.swift:1364-1366`).
  - SDK 내부에서 `context`와 `JSValue`를 직접 쓰는 곳은 M0에서 모두 이음새 뒤로 옮긴다. `close()`가 `context`를 읽는 곳(1591-1592행)도 포함한다.
- **타입 `init(options:)`:** Rust를 고르면 번들 URL이 필요 없다.
- **시간대:** Foundation `TimeZone`으로 `@convention(c)` 콜백을 만든다. 이름 해석은 M0에서 고정한 문법(§7.4)을 따른다.
- **패키징:** XCFramework를 SwiftPM `binaryTarget`으로 붙인다. 슬라이스는 `ios-arm64`, 시뮬레이터, macOS(`examples/native` 하네스용)다. `Package.swift`가 tools 6.0이라 SwiftPM traits(6.1 필요)는 쓰지 않는다.

### 4.4 Android

- **JNI는 C(`aster_jni.c`)에 그대로 둔다.**
  - 백엔드와 무관한 검사(인자 크기, UTF-8 변환)는 분기 전에 둔다. 그래야 두 백엔드의 첫 오류가 같다.
  - `enter()`는 Rust 핸들에서 `JS_UpdateStackTop`을 건너뛴다.
  - `AsterHost`에 백엔드 태그와 Rust 엔진 포인터를 더한다. `createRust()`를 추가한다.
  - 기존 함수는 `enter()` 직후 태그를 보고 갈린다. 대상: `call`, `packet`, `free`, `readBuffer`, `writeBuffer`, `memory*`, `indicatorSlice`, `writeSlice`.
- **Rust 분기에서도 기존 헬퍼를 다시 쓴다.** 대상: `utf8_n`, `java_string_n`, `fail`.
  - 그러면 같은 `IllegalStateException("Name: message")`이 나가므로 `BaroChartException.classify`(84-107행)를 고칠 필요가 없다.
  - 문자열 변환도 두 백엔드에서 같아진다(UTF-8 변환, 단독 서로게이트는 `?`).
- **Rust staticlib은 같은 `libbarochart.so`에 정적 링크한다.**
  - CMake 옵션 `WITH_QUICKJS`/`WITH_RUST`로 세 가지 산출물(듀얼, JS 전용, Rust 전용)을 같은 스크립트에서 만든다.
  - ELF가 하나라 16 KB 정렬 검사(`scripts/check-elf-alignment.mjs`)를 그대로 쓴다.
  - Rust는 `JNIEnv`를 만지지 않는다.
- **Java 변경**
  - 공개 `EngineBackend` enum을 추가한다.
  - `create`를 직접 부르는 곳(61·989·1058·1170행 부근)을 `createRuntime()`으로 모은다.
  - Rust일 때는 asset을 읽지 않는다.
  - long handle만 보는 클래스는 그대로 둔다: `WorkspaceRestoreJob`, `ParamsUpdateJob`, `BaroChartView`, Compose.
- **시간대**
  - C 콜백이 static `zoneOffsetSeconds(long, String)`를 부른다. 이 메서드는 기존 `timezone()` 해석기(`BaroChartEngine.java:1222-1237`)를 쓴다.
  - JNI로 들어온 호출 안의 업콜은 `enter()`가 저장한 `JNIEnv`를 쓴다. 복원 검증 중 `validateSymbol`(`markets.mjs:31`)이 워커 스레드에서 시간대를 불러도 같다. `AttachCurrentThread`는 Rust가 직접 만든 스레드에서만 필요하다.
- 저수준 API는 이미 JSON/`JSONObject`를 돌려준다. 그래서 백엔드와 무관하게 그대로 쓴다.

### 4.5 장면 전송

- Rust는 다음을 모두 구현한다: `nativeSceneJSON`, `nativeRenderFrameJSON`(JSON), `nativeScenePacket`(packet v1).
- Android 뷰는 packet을 먼저 쓰고, 실패하면 JSON으로 넘어간다(`BaroChartView.java:231-234`).
- FlatBuffers나 새 스키마는 만들지 않는다. packet v1은 이미 소유 복사이고, 팬 p95가 예산 안이다.

### 4.6 비동기 잡과 저수준 프로토콜

플랫폼의 잡 클래스는 고치지 않는다. 이 클래스들은 취소, 예산, 시간 제한, stale 검사, 원자적 게시를 맡는다. Rust는 같은 함수 계열을 **봉투 호환**으로 구현한다.
- 대상 함수 계열: 워크스페이스 원본/대상, 비동기 data/prepare, 지표 params, 수집 큐, 데이터 탐색
- **봉투 호환의 뜻**
  - 호스트가 검사하는 필드는 JS와 정확히 같다. 예: `phase` 문자열, `ticket`, `metadataJSON` 길이 한도, 버퍼 slot 순서·길이, `finish`의 schema/version/ticket/revision.
  - 원본과 대상 사이에만 오가는 내부 페이로드는 Rust 형식이어도 된다. 원본과 대상은 항상 같은 백엔드다.
- 대체안: M1 스파이크에서 봉투 밖 가정이 나오면, 그 프로토콜만 prepare/commit 방식으로 바꾼다.
- **엔진 스레드 규칙:** 엔진은 `Send`이고 `Sync`가 아니다.
  - `Send`가 필요한 이유: 워커에서 만든 대상 엔진을 소유 스레드로 옮겨 게시한다(iOS 779행, Android 995·1207행 부근).
  - 소유 스레드 강제는 지금처럼 플랫폼이 맡고, Rust busy 가드가 한 겹 더 막는다.

### 4.7 오류 모델

- **Rust 오류:** `JsError { name, message, code }`
  - `name`: `TypeError`, `RangeError`, `SyntaxError`, `Error`, `IngestionError{code}`, `StaleSourceError`, `UnavailableError` 등
  - FFI로는 `{name, message, code}`를 넘긴다.
  - 플랫폼 글루가 이것을 `Name: message`로 만든다. 그러면 기존 분류기(`BaroChartError.swift:94-113`, `BaroChartException.java:84-107`)를 그대로 통과한다.
- **문구는 JS 원문 그대로다.** 분류 정규식이 보는 문구도 포함한다: `Chart disposed`, `: limit N`, `budget`, `exceeds`.
- **두 분류기에 `UnavailableError: ` 접두어 규칙을 한 줄씩 더한다.** iOS는 `.unavailable`, Android는 `UNAVAILABLE`이다.
- **오류 카탈로그는 자동으로 대조한다.** JS 소스의 `throw` 문구에서 카탈로그를 뽑아 CI에서 Rust 문구와 비교한다. 이식 지도 §4가 출발점이다.
- **OOM:** 할당 실패 시 엔진마다 동작이 다르다.
  - QuickJS: 계산된 805,306,368 B에서 `InternalError: out of memory`
  - JSC: `RangeError: Out of memory`
  - Rust: 기본 동작이 abort라 앱이 죽는다.
  - 그래서 Rust 엔진마다 `MemoryAccount`를 둔다. 한도는 Android 805,306,368 B, iOS는 무제한이다.
  - `RESOURCE_LIMITS`를 할당 전에 검사한다.
  - 데이터 크기에 비례하는 버퍼는 `try_reserve`로 잡고, 실패하면 같은 플랫폼 JS 백엔드와 같은 클래스의 오류를 낸다.
  - 자원 오류는 클래스만 비교한다.

## 5. 범위

### 5.1 Rust가 구현하는 것

- 이식 지도 §1.2의 브리지 함수(tier S, V, R)
- 저수준 보충 지도의 tier A 전체. 대상:
  - 수집 큐(`nativeDataIngestionCommand`, `nativeApplyUnchangedDataEvents`)
  - 비동기 data/prepare 잡(`nativeAsync*`, `nativePrepare*`, `nativeDataAsyncBegin`)
  - 지표 params 잡(`nativeParams*` 17개)
  - 데이터 탐색(`nativeDataExploration`, `dataAt`)
  - compaction(`compactData`)
  - `nativePreflightWorkspace`, `nativeIndicatorBuffer`
- `nativeCommand` op 65개 전부(`api.mjs:65`)
- SDK가 부르는 전역 66개 가운데 `nativeRegisterIndicatorSource`를 뺀 65개 전부. `nativeAccessibility`(러너가 `call()`로 부름)도 포함한다.
- **레거시 헬퍼 15개를 JS 동작 그대로 이식한다.** 공개 `call()`/`invoke()`로 닿고, 예제와 러너가 부르기 때문이다.
  - 대상: `nativeSetData`, `nativeDataEvent`, `nativeIndicator`, `nativeView`, `nativeFit`, `nativeAddPanel`, `nativeSetPanel`, `nativeAddSeries`, `nativeRemoveSeries`, `nativeTheme`, `nativeInspect`, `nativeTool`, `nativeWheel`, `nativeLoad`, `nativeEcho`
  - `nativeTheme`은 검증 없이 테마를 순서 보존 값 맵으로 둔다(보충 지도 O3).
- 벤치마크 헬퍼 `nativeBenchmarkEvent`, `nativeBenchmarkDigest`
- 기본 링크 신뢰 모듈 `aster.volume-direction`(`pressure`). 이식 지도 D10을 채택한다.
  - 이유: `trusted-studies.mjs`가 `CORE_MODULES`에 있어, 이 모듈을 쓰는 저장 문서가 있을 수 있다.

### 5.2 Rust가 `UnavailableError`로 거절하는 것

모두 차트 상태를 바꾸기 전에 거절한다.
- **`nativeRegisterIndicatorSource`:** 어느 진입점에서든 `UnavailableError: Indicator source registration requires the javaScript backend`를 낸다. code는 `JAVASCRIPT_BACKEND_REQUIRED`다.
  - 이유: 소스를 `Function()`으로 평가한다(`api.mjs:247-251`). JS 엔진이 있어야 한다.
- **링크 가능한 커스텀 모듈 서술자를 담은 `aster.studies`·`aster.workspace` 문서:** `UnavailableError: Indicator module requires the javaScript backend: <name>`(같은 code)을 낸다(보충 지도 O2).
  - 내는 곳: `loadStudies`, `nativePreflightWorkspace`, `nativeWorkspaceSourceBegin`, `nativeWorkspaceTargetCreate`
  - preflight 영수증 형식은 바꾸지 않는다.
  - 복원은 차트를 바꾸지 않고 거절한다. 지표를 조용히 빼지 않는다.
- **빌드 때 링크한 커스텀 지표 모듈은 Rust에 자리가 없다.**
  - `registerIndicatorModule`에 그 id를 주면 표준 JS 번들과 같은 `UnsupportedIndicatorError`를 낸다.
  - `addIndicator`는 `Unknown indicator: <name>`을 낸다.
- Swift `context` 속성(§4.3)

### 5.3 이식하지 않는 것

- **셀프테스트와 데모:** `UnavailableError: <name> is not available in the Rust backend`를 낸다. 골든 값은 오라클로 쓴다.
  - 셀프테스트: `nativeSelfTest`, `nativeExtendedSelfTest`, `nativeHardeningSelfTest`, `nativePublicationOrderSelfTest`, `nativeStudyVerification`, `nativeAxesSelfTest`
  - 데모: `nativeAnalysisDemo`, `nativeAnalysisReload`, `nativeComparisonDemo`, `nativeComparisonReadout`, `nativeComparisonAction`
- **테스트 전용 수명 함수:** 같은 오류를 낸다. 대상: `nativeAsyncUI`, `nativeWorkspaceSourceBuffer`, `nativeWorkspaceSourceDispose`, `nativeWorkspaceTargetDispose`, `nativeParamsTargetDispose`
- 어느 브리지 함수에서도 닿지 않는 원시 `globalThis.Aster` 함수(`resampleOHLCV`, `BarReplay` 등)
- 전역 100개에 없는 이름은 플랫폼 JS 동작을 따른다. Android는 `TypeError: not a function`, iOS는 `Missing function: <name>`이다.
- 웹 전용 모듈과 JS 객체 모델 방어 코드(accessor 거부, Proxy 재진입 등). Rust 소유권 구조에서는 도달할 수 없으므로 메시지 표만 유지한다.

최종 목록과 근거는 보충 지도 §2가 정본이다.

### 5.4 선택 API

- **Swift**
  - `public enum BaroChartBackend { case javaScript, rust }`
  - `BaroChartEngine.defaultBackend`: 정적 값, 메인 스레드에서 바꾼다.
  - `BaroChartEngine(options:backend:)`
  - `engine.backend`
- **Java**
  - `public enum EngineBackend { JAVASCRIPT, RUST }`
  - `BaroChartEngine.create(context, options, backend)`
  - `setDefaultBackend`/`getDefaultBackend`
  - `engine.backend()`
- **규칙**
  - 기존 생성자는 `defaultBackend`를 따른다. 그래서 기존 테스트를 본문 수정 없이 두 백엔드로 돌릴 수 있다.
  - 백엔드는 엔진 수명 동안 바뀌지 않는다.
  - 자동 폴백은 없다.
  - 잘못된 값은 명확한 오류로 실패한다.
  - 비동기 대상은 원본과 같은 백엔드다.
  - 엔진마다 다른 백엔드를 써도 된다. 같은 프로세스에서 두 백엔드를 나란히 돌려야 섀도 비교와 앱 단위 롤백이 된다.
- SwiftUI `BaroChartView`와 Compose `BaroChart`는 엔진 인스턴스를 받으므로 바꾸지 않는다.

### 5.5 산출물과 크기

- 기본은 두 백엔드를 함께 싣는 산출물이다.
- 2026-11-04 전체 코어 실측 후 소유자는 듀얼 산출물 유지와 **5 MiB(5,242,880 B)/ABI** 예산을 승인했다. 현재 출하 `s`/unwind 구성의 합계와 소스 SHA는 [최신 실측 보고서](../../measurements/2026-11-04-rust-core-size.md)를 따른다. 아래 M1 이전 기준선 표의 3 MiB 여유 계산은 역사적 수치다. 시작·팬 성능 기준은 그대로 유지한다.
- **Android 현재 크기와 Rust 여유**

  | ABI | 현재 | 예산 3,145,728 B 대비 Rust 여유 |
  |---|---|---|
  | arm64 | 1,794,796 B | 1,350,932 B |
  | x86_64 | 1,854,276 B | 1,291,452 B |

- Rust 크기는 M1에서 잰다.
  - 유일한 실측값: std, ryu-js, `catch_unwind`만 넣은 arm64 cdylib이 310,632 B다.
  - 전체 코어 크기 추정은 0.5~2.5 MB로 갈린다.
  - 이식 줄 수 추정은 약 37,850줄이다. 안정 표면 27,850줄에 tier A 약 10,000줄을 더한 값이다.
- 예산을 넘으면 주인에게 산출물 분리(듀얼 + Rust 전용 린)를 묻는다. 제외는 CMake·Gradle·SwiftPM 수준에서 한다. Cargo feature로는 QuickJS C 코드나 JS asset을 뺄 수 없다.
- iOS 현재 크기는 1,014,885 B다. JSC는 시스템 프레임워크라 Rust 크기만 더해진다.

## 6. 동등성 기준

### 6.1 오라클

- 기준은 **같은 플랫폼의 JS 백엔드**다. iOS는 JSC, Android는 QuickJS다.
- WASM 하네스에서는 Node(V8)의 JS 번들을 기준으로 쓴다. 이때 엔진마다 다른 수학 함수는 V8 것을 Rust에 주입한다(§6.3).

### 6.2 합격선

- **바이트 동일:** 저장 문서(`aster.drawings`, `aster.workspace`, `aster.studies`, `aster.ingestion`), 오류 `name`·`message`·`code`, 사용자에게 보이는 문자열(축·크로스헤어 라벨, 접근성 텍스트), JSON 결과 텍스트
- **비트 동일:** `Object.is` 기준이고 NaN만 정규화한다. 대상: 지표 출력, 크로스헤어 값, view/visibleRange, packet 숫자
- **실패 시 상태:** JS에서 원자적인 실패는 Rust에서도 상태를 바꾸지 않는다.
- **장면:** 렌더러가 실제로 읽는 투영(commands, background, stats)을 비트 단위로 비교한다. `nativeSceneJSON` 전체의 바이트 일치는 추적 지표로 두고, 기본값 전환 전까지 100%로 만든다. Android `scene()`이 `JSONObject`를 앱에 그대로 넘기기 때문이다.
- **프레임 캐시:** Rust가 `baseChanged`/`drawingsChanged`를 JS보다 자주 내는 것은 허용한다. 느려질 뿐이다. 덜 내면 실패다. 낡은 픽셀이 남는다.
- **기기에서는 허용 오차가 없다.** 어긋나면 그 필드만 근거와 함께 허용 목록에 올리고, 주인 승인을 받는다.

### 6.3 엔진마다 다른 수학 함수 (log, exp, hypot)

- **실측 (2026-11-02, macOS 26.7.2)**
  - 입력 20만 쌍 가운데 libm `hypot`과 Kahan 스케일 합이 다른 것이 64,337건이었다.
  - JSC `Math.hypot`은 20만 건 모두 libm과 비트가 같았다.
  - V8은 64,337건 모두 Kahan 쪽이었다.
  - 사용한 프로브: 같은 입력을 C(`hypot`, Kahan 구현)와 `jsc`/`node`로 계산해 비트를 비교했다.
- **QuickJS**는 소스상 libm을 직접 부른다(`quickjs.c:46816-46833, 47182-47185`).
- **결정**
  - 기기에서 Rust는 플랫폼 libm(std `f64::hypot`/`exp`/`ln`)을 쓴다. 그러면 같은 기기의 JS 백엔드와 비트가 같아진다.
  - WASM 하네스에서는 V8의 `Math.log`/`exp`/`hypot`을 import로 주입한다. 그러면 남는 차이는 로직 차이다.
  - iPhone과 Galaxy 실기기 확인은 M4에서 한다.
  - 제스처로 만든 `view.from/to`는 플랫폼 libm에 따라 달라진다. 그래서 골든은 아키텍처별로 만들고 비교한다.

### 6.4 JS 의미 함정 (Rust 커널 `barochart-js`가 맡는다)

- **`Number#toString`·`JSON.stringify`:** ryu-js를 쓴다(버전 고정).
  - V8과 대조해 불일치 0건이었다(24만 건, 30만 건).
  - 예외: QuickJS 2026-06-04(Android 오라클)는 정규수 2의 거듭제곱 54개 지수(부호 포함 108값)에서 최단이 아닌 17자리를 쓴다(`2**-24` → `5.9604644775390625e-8`, V8·JSC는 `5.960464477539063e-8`, 2026-11-02 실측). §6.1에 따라 커널은 Android 빌드에서 이 규칙을 따른다(`NumberDialect::QuickJs`). 대조 하네스가 ±2^n 전부를 세 엔진과 대조한다.
  - Rust std 최단 자릿수는 동률에서 30만 건 중 80건이 다르다.
  - 지수 표기 경계와 `-0 → "0"`은 JS 규칙대로 둔다.
- **`toFixed`/`toPrecision`/`toExponential`:** 정확한 십진 전개 뒤, 동률이면 0에서 먼 쪽으로 반올림한다.
  - 예: `0.125.toFixed(2)` = `"0.13"`, `2.5.toFixed(0)` = `"3"`, `(-0).toFixed(2)` = `"0.00"`
  - Rust `{:.N}`은 짝수 쪽으로 반올림하고 `-0.00`을 낸다.
- **`Math.round`/`min`/`max`/`sign`:** JS 의미 그대로 구현한다.
  - `Math.round(-2.5)` = `-2`, `Math.round(-0.5)` = `-0`
  - `Math.max(NaN, 1)` = `NaN`
  - `Math.sign(0)` = `0`
  - `floor(x+0.5)` 같은 지름길은 쓰지 않는다.
- **문자열:** 길이와 slice는 UTF-16 코드 단위로 센다. 내부 문자열은 단독 서로게이트를 담을 수 있는 WTF-16이다. 공백 판정은 JS 표를 쓴다: U+FEFF는 공백이고 U+0085는 공백이 아니다.
- **JSON 입력**
  - 숫자 읽기도 같은 기기의 방언을 따른다. V8·JSC는 정확히 반올림하고, QuickJS 2026-06-04는 십진 가수의 첫 38자리 뒤를 버린다(`js_atod`). 예: `9007199254740993` 뒤에 0을 300개와 `1e-301`을 붙인 JSON 수는 V8·JSC에서 `9007199254740994`, QuickJS에서 `9007199254740992`다. 커널의 `parse_json`·`parse_json_utf16`은 `NumberDialect::PLATFORM`을 쓰고 `_with`로 명시할 수도 있다(M1a 외부 리뷰 X3, 2026-11-03).
  - 중복 키는 마지막 값이 이기고, 위치는 처음 나온 자리를 유지한다.
  - `1e400`은 `Infinity`가 된다.
  - `-0`을 보존한다.
  - `__proto__`는 평범한 키다.
  - 객체 키 순서: 배열 인덱스 키를 오름차순으로 먼저, 나머지는 삽입 순서다.
- **합산 순서:** JS 식 모양 그대로 옮긴다. 대상: `roll`, `smaRoll` 리베이스, VWMA 보정 합, Welford, dyadic RangeIndex, 256 체크포인트. 금지: iterator `sum`, 재결합, `mul_add`, SIMD, fast-math.
- **JSON.stringify 길이가 동작을 정한다.** undo 이력 가중치와 문서 한도가 이 길이로 정해진다. 그래서 포맷이 다르면 바이트만이 아니라 동작이 갈린다.
- **CI 금지 규칙:** 이식한 코드에서 다음을 grep으로 막는다: `format!("{:.N}")`류 정밀도 포맷, `f64::min`/`max`/`round`/`signum`, `mul_add`, `str::trim`, `serde_json`.

### 6.5 하네스 (역할을 나눠 넷 다 쓴다)

1. **이음새 추적 (주력)**
   - 형식: JSONL, 무손실 모드. 한 줄이 `(name, args) → 결과 또는 {name, message, code}` 하나다. 시간대 콜백 입출력과 f64 전송 해시도 함께 기록한다.
   - 수집처:
     - Node 테스트 가운데 `node:vm`으로 번들을 쓰는 것
     - iOS XCTest와 러너: `RecordingCoreRuntime`
     - Android 계측: 추적 빌드
   - 재생은 `cargo test`로 한다.
   - 이음새 리팩터링 전후의 JS 추적이 같으면, 리팩터링이 동작을 바꾸지 않았다는 증명이 된다(M0).
2. **실시간 차분:** Rust를 `wasm32`로 빌드해 Node에서 `node:vm` 번들과 나란히 돌린다.
   - 시드 고정 생성기로 무작위 입력을 만든다. 새 npm 의존성은 넣지 않는다.
   - 꼭 넣을 입력: 정정, prepend, NaN, 극값, undo 폭주, 128/129 UTF-16 길이 id, 서로게이트, 256 체크포인트 경계
   - 실패한 경우는 축소해 회귀 추적으로 고정한다.
3. **섀도 모드:** 디버그·CI 빌드의 `ShadowCoreRuntime`이 모든 호출을 JS(주)와 Rust(그림자)에 보낸다. 첫 불일치에서 추적을 덤프한다.
4. **플랫폼 스위트:** 두 백엔드로 각각 돌린다.
   - JS 전용 API(커스텀 JS 지표, 원시 JS 접근)는 unavailable 기대표로 확인한다.
   - `evaluateScript`를 쓰는 화이트박스 하네스는 JS 전용으로 두고, 시나리오를 추적으로 옮긴다.
   - `parity.swift`는 core(두 백엔드)와 advanced(JS 전용)로 나눈다.

**골든 문서**
- 레거시 픽스처를 다시 저장한 바이트가 같아야 한다.
- 백엔드 사이 왕복: JS로 저장 → Rust로 복원 → 다시 저장한 바이트가 같아야 한다. 반대 방향도 같다.

### 6.6 표류 방지

- `src/core`나 `examples/native/*bridge*.mjs`를 바꾸는 PR에는 Rust 동등성 체크(추적 재생, 시드 고정 차분)를 CI에서 돌린다.
- 지금은 **경고만** 한다. M2에서 병합 차단으로 올릴지 주인에게 묻는다.
- 의도한 변경이면 추적을 다시 승인한다.
- 두 백엔드가 같은 core contract 버전을 보고하게 한다.
- 골든과 판정 기준은 주인 승인 없이 바꾸지 않는다.

## 7. Rust 크레이트와 하네스

### 7.1 워크스페이스 `rust/`

| 크레이트 | 역할 |
|---|---|
| `barochart-js` | JS 의미 커널: `jsnum`, `jsmath`, `jsstr`(WTF-16), `jsdate`, `json`(`JsValue`, 순서 보존 객체, 손으로 쓴 파서·writer, 무손실 모드). **가장 먼저 만든다** |
| `barochart-core` | `src/core`와 브리지를 1:1로 옮긴 코드다. 모듈 이름과 순서를 `CORE_MODULES`에 맞춘다. 함수마다 `// js: src/core/indicators.mjs:21` 같은 출처 주석을 단다. JS 모듈 전역 상태는 모두 `Engine` 안에 둔다(static·thread_local 금지). 바이트 계산은 `u64`로 한다. `#![forbid(unsafe_code)]` |
| `barochart-bridge` | 함수 표 `static FUNCTIONS: &[(&str, Handler)]` 하나가 `supports()`의 유일한 근거다 |
| `barochart-ffi` | `staticlib`과 cbindgen 헤더. `catch_unwind`, poison, busy 가드, 핸들 검증, 버퍼 소유권을 맡는다. `unsafe`는 이 크레이트에만 둔다 |
| `barochart-wasm` (개발 전용) | 하네스용 원시 export |
| `tools/trace-replay`, `tools/conformance` (개발 전용) | 추적 재생, 코퍼스 대조 |

### 7.2 의존성과 빌드 설정

- **런타임 의존성은 `ryu-js`(고정)뿐이다.** 순서 보존 맵은 직접 만들거나 `indexmap`을 쓴다(삭제는 `shift_remove`만).
- **쓰지 않는 것:** `serde`/`serde_json`, `regex`, `chrono`·`chrono-tz`·`jiff`, `tokio`, `anyhow`, `uniffi`, `jni`, 기기용 `libm` 크레이트
  - 입력에도 serde를 쓰지 않는다. 검증 오류 문구가 JS와 바이트 단위로 같아야 하기 때문이다.
  - serde 기본값은 JS와 다르게 처리하는 것이 많다: 모르는 필드 수락, 중복 필드, null과 누락, 재귀 128, `1e400`, 단독 서로게이트.
- **`no_std`는 쓰지 않는다.**
- **빌드 프로필:**
  - `lto = "fat"`, `codegen-units = 1`, `panic = "unwind"`
  - strip하고 심볼은 따로 보관한다.
  - opt-level은 `s`로 시작한다. M1에서 `s`와 `3`의 크기·속도를 같이 잰다.
- **툴체인:** `rust-toolchain.toml`로 고정한다. 대상: `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `aarch64-apple-darwin`, `aarch64-linux-android`, `x86_64-linux-android`, `wasm32-unknown-unknown`
  - 이 Mac은 Homebrew rustc가 rustup을 가린다. 빌드 스크립트는 `$HOME/.cargo/bin`을 PATH 앞에 둔다.

### 7.3 추적 형식

- **JSONL, 무손실 JSON 상위 집합(§4.2).** 한 줄의 필드:
  - `fn`: 함수 이름
  - `args`
  - `ok` 또는 `err{name, message, code}`
  - 필요하면 `tz`(시간대 콜백 입출력)와 `f64`(전송 버퍼 해시)
- 추적은 백엔드와 무관하다. 같은 추적을 JS 번들(Node `node:vm`, JSC, QuickJS)과 Rust 모두에 재생한다.

### 7.4 JS 오라클 정규화 (M0, 주인 승인)

이것을 먼저 고치지 않으면 Rust 버그와 JS 비결정성을 구분할 수 없다.

1. **영속 레코드의 키 순서 고정**
   - 현상: iOS 타입 API로 같은 드로잉을 저장해도 실행마다 문서 바이트가 다르다(4회 실행, 4회 모두 다른 해시).
   - 원인: `drawings.mjs`의 `add`가 `{id, panel, locked, style, ...input, id}` 형태라 입력 키 순서가 문서에 남는다. 여기에 Swift `Dictionary` 순서가 프로세스마다 다르다.
   - 조치: 입력 키 순서가 남는 곳을 정규화한다.
     - 문서: 드로잉(레코드, 스타일, 앵커), 지표 params, 심볼, 복원된 view
     - 반환값: `inspect()`, preflight `dataset`, 장면 레이아웃
     - 시리즈, 패널, 축, 테마, dataset은 이미 코드의 `*_KEYS` 순서로 쓰이므로 그대로 둔다.
   - 영향: 웹에서 비표준 키 순서로 만든 문서는 다시 저장할 때 바이트가 바뀐다. 의미는 같다.
2. **시간대 계약 고정**
   - 비유한 시각은 호스트를 부르기 전에 거절한다. 지금 Android는 NaN을 1970년으로 바꾼다.
   - 지원 연도는 1000~9999다. 지금은 999년을 iOS가 `999`, Android가 `0999`로 쓴다.
   - 받는 이름의 문법을 고정한다.
   - 오류 문구는 코어가 정한다. 지금은 iOS가 `invalid time zone: X`, Android가 `Invalid timezone/date`로 다르다.
3. **복원·params 게시 엔진의 체크포인트 예산 (이식 지도 D2)**
   - 현상: 같은 데이터·지표가 새 차트에서는 되고, 복원한 뒤에는 `Native checkpoint total byte limit`로 실패한다.
   - 조치: 워크스페이스 복원과 params 비동기 게시 모두, 게시할 때 일반 맵으로 바꾼다.
   - 성격: 버그 수정이다. 정규화와 같은 릴리스로 낸다.

4. **깊은 JSON 제한 (M0c, 보충 지도 O5, 내 판단)**
   - 조치:
     - 코어에서 `JSON.parse`를 그대로 부르는 세 곳(`drawings.mjs:39`, 브리지 B:5·B:6) 앞에 반복형 깊이 검사를 둔다(32).
     - 두 플랫폼의 호스트 인자에도 깊이 검사를 둔다(64).
     - 깊이는 가장 바깥 배열·객체가 1이다. 호스트 인자는 전달용 인자 배열도 포함하며, 문자열 안 괄호와 Swift Optional 포장은 깊이를 늘리지 않는다. 한도와 같은 깊이는 허용한다.
     - 오류는 `RangeError: Drawing document depth limit`, `RangeError: Native data event document depth limit`, `RangeError: Native prepare document depth limit`, 호스트는 `SyntaxError: Native argument depth limit`다. Swift·Android에서 모두 잘못된 인수 코드다.
     - Swift는 값으로 브리징하는 배열·딕셔너리만 순회한다. 기존 JSValue·JSExport VM 참조의 속성은 읽지 않아 getter 부작용을 추가하지 않는다. Java는 JSONArray/JSONObject·컬렉션·배열을 직렬화 전에 검사하고, JNI도 실제 UTF-8 텍스트를 검사한다. 참조 컨테이너는 부분 트리 높이를 메모해 공유·순환을 처리한다.
   - 정상 입력은 깊이 5 안팎이라 영향이 없다.
   - 이유 1: QuickJS는 깊은 입력에서 스택이 넘친다. V8·JSC는 반복 파싱이라 다른 오류 클래스를 낸다. 이 차이를 없앤다.
   - 이유 2: Rust의 재귀 해제와 순회가 앱을 죽이지 않게 한다.

**릴리스:** 1~3을 Rust 코드보다 먼저 낸다.
- CHANGELOG의 `0.3.0` 항목에 넣는다.
- Rust 백엔드는 다음 버전(`0.4.0-dev`) 항목에 쓴다.
- 태그와 npm·Maven 게시는 별도 승인이다.

## 8. 단계 (각 단계는 계획서 → 구현 → 리뷰 → PR → 머지)

### 8.1 마일스톤

| 단계 | 내용 | 검증 |
|---|---|---|
| **M0** JS만 수정 | (a) §7.4 정규화와 D2 수정 (b) 이음새: iOS `BaroChartCoreRuntime`(JS 구현만, `close()` 포함 내부 `context` 사용 제거), Android `EngineBackend`·`createRuntime()`(JS만) (c) 추적 기록기 세 가지와 Node 재생기 (d) M0c 깊은 JSON 제한(§7.4-4) | 기존 스위트 전부 green. 이음새 리팩터링 전후 JS 추적 바이트 동일. iOS 타입 API 저장 문서가 프로세스 10회에서 같은 해시 |
| **M1** 뼈대 | `barochart-js` 커널. 빈 엔진 C ABI. 패키징(XCFramework, CMake 정적 링크, 16 KB 정렬). Android JNI 태그 분기. WASM 하네스 골격. 크기 측정(unwind/abort, `s`/`3`). 워크스페이스 봉투 스파이크 | 숫자 포맷 코퍼스 1천만 건 V8 일치. 동률 코퍼스, JSON 왕복 퍼즈. 배포 리허설과 ELF 정렬 검사. 빈 Rust 엔진으로 닫힌 엔진·다른 스레드 표 green. 크기 외삽 결과 |
| **M2** 데이터·문서 | contracts, BarStore·RangeIndex, DataEvent 6종, markets(시간대 콜백), ingestion 세션, 드로잉 저장소·undo/redo·`aster.drawings`, 워크스페이스 동기 저장·preflight | 골든 바이트, 백엔드 사이 왕복, 이력 트리밍 일치, 오류 카탈로그 일치, 전체 시간대 전이 대조(1970~2037) |
| **M3** 지표 | IndicatorEngine(256 체크포인트, dirty, 수렴), 내장 35종, `aster.volume-direction`, 체크포인트 컨테이너 | 스트리밍 추적에서 모든 출력 f64 비트 동일(1만 append, 임의 깊이 정정, prepend, reset) |
| **M4** 레이아웃·장면 | model(스케일, 레이아웃), labels, scene, packet v1, frame 모드(보수적 무효화), 접근성 텍스트 | 렌더러 투영·packet 비트 동일. 실기기 스크린샷 차분. 실기기 초월함수 비트 확인. 첫 기기 A/B와 단계별 분해(iOS packet 렌더러 판단) |
| **M5** 상호작용 | 포인터·핀치·휠·키·호버, 그리기 도구, 자석·스냅, 실제 프레임 캐시 무효화 | 회귀 러너 추적 재생. 두 백엔드 플랫폼 스위트 green. 섀도 불일치 0 |
| **M6** 저수준 전부·수명·성능 | `ChartAPI` 나머지 op, 수집 큐, 비동기 data/prepare/params, 데이터 탐색, compaction, 워크스페이스 원본/대상 봉투, 커스텀 모듈 문서 거절(§5.2), 레거시·벤치마크 헬퍼, iOS 값 전용 `JSContext`(§4.3), close·poison(정리 화이트리스트), 공개 선택 API·문서 | 기존 잡 테스트 무수정 green. 30분 soak, 생성·해제 500회. 실기기 시작·팬 예산. 크기 예산 |
| **M7** 기본값 전환 | §8.3 게이트를 통과하면 Android부터 플랫폼별로 기본값을 Rust로 바꾼다. JS는 1.x 내내 고를 수 있다 | 게이트 재측정 |

M0의 JS 정규화와 D2 수정은 첫 PR로 따로 낸다. 같은 PR로 묶으면 웹 동작 변경과 이음새 리팩터링이 섞여 리뷰가 어렵다.

진행 기록(2026-11-03): M0a는 #21, M0b 이음새·추적은 #22, M1a 의미 커널은 #23으로 머지됐다([M0b 판정 및 검증 근거](../../measurements/2026-11-03-rust-m0b-external-review.md), [M1a 근거](../../measurements/2026-11-03-rust-m1a-external-review.md)). M0c는 §7.4-4의 깊이 제한을 도입한다. 단계별 플랫폼 검증·리뷰·CI 상태는 진행 원장과 HANDOFF에 남긴다. 중단된 추적의 앞부분을 전체 동등성으로 취급하지 않는다.

### 8.2 단계마다 하는 일

1. 그 단계의 구현 계획서(`docs/superpowers/plans/2026-11-02-rust-core-mN-*.md`)를 쓴다.
2. 워크플로로 구현한다. 커밋 전에 lint와 타입 체크를 통과시킨다.
3. 리뷰한다.
   - Claude 다관점 리뷰: 정확성, 동등성, 보안, 성능
   - GLM·DeepSeek·Qwen 외부 리뷰
   - 중요한 결정에는 Codex·Grok·Devin 의견도 받는다.
4. 수정한 뒤 PR을 만든다. CI가 통과하면 머지한다.

### 8.3 기본값 전환 게이트 (플랫폼별)

- 추적 코퍼스 100% 일치. `nativeSceneJSON` 전체 바이트 포함
- 두 백엔드에서 플랫폼 스위트 green
  - XCTest, 계측, Compose, 회귀 러너
  - JS 전용 항목은 unavailable 기대표로 확인한다.
- 실기기 시작 p50 ≤ 500 ms, 팬 p95 ≤ 16.7 ms
- 크기 ≤ 5,242,880 B/ABI(2026-11-04 소유자 승인; 듀얼 구성의 `.so + classes.jar + JS 자산`)
- 30분 soak와 생성·해제 500회 통과

## 9. 위험

| # | 위험 | 대응 |
|---|---|---|
| 1 | 오라클 비결정성. iOS 키 순서, 플랫폼별 시간대 형식, 엔진별 `Date.parse`, V8 수학 함수 | M0 정규화. 세 엔진 삼각측량. 하네스에 원시 함수 주입 |
| 2 | 지표 비트 동등성(정정·prepend와 얽힌 계산 경로) | 글자 그대로 옮기기. M3에서 화면 없이 비트 비교. 임의 깊이 정정 퍼즈 |
| 3 | 포맷 차이가 동작 차이로 번짐(stringify 길이 → undo 깊이·문서 한도) | writer 하나만 쓴다. 코퍼스 퍼즈. CI 금지 규칙 |
| 4 | 기기 초월함수 미확인(iPhone arm64 libm, Android bionic) | M4에서 실기기 확인. 어긋나는 필드만 허용 목록 |
| 5 | iOS 시간대 데이터 경로가 JSC ICU에서 Foundation `TimeZone`으로 바뀜 | M0 문법 고정. M2에서 전체 zone 전이 대조 |
| 6 | Android 크기(여유 약 1.29 MiB) | M1 실측. 넘치면 분리를 주인에게 묻는다 |
| 7 | 패키징·릴리스 파이프라인(binaryTarget 체크섬, CMake 정적 링크, CI 툴체인) | M1에서 빈 함수로 리허설 |
| 8 | 봉투 호환의 숨은 가정 | M1 스파이크. 실패하면 그 프로토콜만 prepare/commit |
| 9 | 이중 유지보수 표류(웹이 JS를 계속 바꿈) | 추적 재생·차분 CI(§6.6). core contract 버전 |
| 10 | 호스트 앱 크래시(패닉, OOM) | `catch_unwind`와 poison. 사전 한도 검사, `try_reserve` |
| 11 | 성능 기대치 과장 | M4 기기 분해로 기대치를 고정한다. 같은 전송 조건에서만 A/B |
| 12 | 화이트박스 러너는 Rust를 검증하지 못함 | 시나리오를 추적으로 옮긴다(M5까지) |
| 13 | 저수준 비동기 프로토콜의 규모와 명세 공백(데이터 탐색 등) | 보충 지도로 먼저 명세한다. M6에 일정 여유를 둔다 |
| 14 | 워커 스레드 업콜(복원 검증 중 시간대) | Android는 `enter()`가 저장한 `JNIEnv`, iOS는 `Sendable` 콜백. 워커 경로 테스트 |
| 15 | stale 판정의 동등성(params 지문, 워크스페이스 `sourceRefs`, 비동기 설정 키, `nativeSize` identity) | JS가 객체를 바꾸는 자리마다 세대 카운터를 올린다. 측정한 stale 행렬을 재생한다(보충 지도 §3.1.3, §3.2.3, §3.4.3) |
| 16 | POISONED와 close 뒤 정리(iOS admission 슬롯 누수, `close()` 실패) | 정리 화이트리스트와 params 원장. busy 가드 해제는 `catch_unwind` 밖에서. 실패하지 않는 `bc_engine_free`. 패닉 주입 수락 테스트(보충 지도 §3.8) |
| 17 | JS 내부 배치에서 나오는 호스트 가시 숫자(`plan.totalBytes`, `retainedBytes`, 진행 total, 청크 크기) | JS 버퍼 배치와 코덱 텍스트를 그대로 따른다. plan을 바이트 단위로 비교한다 |

## 10. 이식 지도 결정 항목(D1~D12) 정리

| # | 결정 |
|---|---|
| D1 | tier A 전부 구현(주인 결정 1). 커스텀 JS 지표만 `UnavailableError` |
| D2 | JS에서 먼저 고친다(§7.4-3). 워크스페이스 복원과 params 게시 모두 |
| D3 | `fit()`에서 `L+F<10`이면 `follow=false`가 된다. 동등성을 위해 그대로 재현하고, 알려진 특이점으로 기록한다 |
| D4 | `layout.geometryKey`의 프로세스 전역 serial은 차분 비교에서 정규화한다 |
| D5 | 기기에서는 플랫폼 libm을 쓰고, 하네스에는 V8 원시 함수를 주입한다(§6.3) |
| D6 | 호스트 오프셋 콜백을 쓰고, Rust가 proleptic 그레고리력으로 날짜 부분을 계산한다. M0에서 연도 범위를 고정한 뒤에만 유효하다 |
| D7 | 내부 문자열은 WTF-16이다 |
| D8 | 엔진마다 다른 메시지(JSON `SyntaxError` 문구 등)는 이름만 비교한다 |
| D9 | 알려진 특이점은 고치기로 정한 것 말고는 그대로 재현한다 |
| D10 | `pressure` 모듈을 이식한다 |
| D11 | 값 모델이 비유한 수를 표현한다. iOS 무손실 인코딩 |
| D12 | 엔진을 만들 때 백엔드를 고르고 바꾸지 않는다. 두 백엔드를 함께 싣는다. 크기는 실측 뒤 판단한다. 자동 폴백은 없다 |

## 11. 내가 정한 것 (주인 확인 전, 되돌리기 쉬움)

- **산출물:** 두 백엔드를 함께 싣는다. 예산을 넘으면 그때 주인에게 묻는다.
- **원시 JS API(보충 지도 O1에 따라 바꿈):** `JSValue`를 반환하는 API는 Rust에서도 값 전용 `JSContext`로 동작한다. `context` 속성만 막는다.
  - 처음에는 막고 공통 API를 새로 만들려 했다.
  - 바꾼 이유: 문서화된 API이고, 기존 테스트가 쓰며, 주인 결정 1과 맞지 않았다.
- **보충 지도 O2~O8**
  - O2: preflight는 커스텀 모듈 문서에서 `UnavailableError`를 던진다.
  - O3: `nativeTheme`은 원래 동작 그대로 옮긴다.
  - O4: 체크포인트 수정은 M0 Task 3에 이미 들어 있다.
  - O5: 깊은 JSON 제한을 M0c로 넣는다(§7.4-4).
  - O6: Android `Float64Array` 결과는 인덱스 키 JSON으로 보낸다.
  - O7: Java 진단 문구는 백엔드별로 다르게 둔다.
  - O8: 셀프테스트와 데모는 이식하지 않는다.
- **레거시 헬퍼:** 15개와 벤치마크 헬퍼 2개를 이식한다. 처음 설계 §5.3에서는 뺐었다.
- **iOS packet 렌더러:** M4 기기 분해에서 전송과 디코드가 프레임의 10%를 넘을 때만 넣는다.
- **표류 CI:** M2까지 경고만 한다.
- **기기 단계별 분해:** M0에서 M4로 옮긴다. 첫 A/B와 같은 계측을 쓰려는 것이다. 대가는 기대치 고정이 늦어지는 것이다.
- **장면 투영 정의:** M0에서 M4로 옮긴다. 장면을 이식하는 단계에서 정한다.
- **iOS 시간대 콜백:** Foundation `TimeZone`을 쓴다. JSC `Intl`과 tzdata 버전이 다를 수 있어 M2에서 전수 대조한다. 어긋나면 그때 방안을 정한다.

## 12. 상담 기록 (요약)

- **공통 결론(9개 의견):** 브리지 계약을 그대로 구현한다(A). iOS는 런타임 프로토콜을 쓰고 JSContext shim은 쓰지 않는다. UniFFI는 쓰지 않는다. JS 경로를 탈출구이자 오라클로 유지한다.
- **Codex:** 좁은 C ABI와 불투명 핸들. 렌더러가 `engine.context`를 직접 본다는 지적(확인). 기존 소유 복사 전송 재사용. 생성 시 불변 옵션. Cargo feature로는 산출물 제외가 보장되지 않는다는 지적. 체크포인트 인코딩 지적(확인).
- **Grok:** packet v1이 zero-copy가 아니라는 확인. 이 트리에 Swift `zonedParts`가 없다는 지적(확인). 문서 바이트 동일을 지표보다 먼저 확인. 오류: sqrt에 ulp 허용을 제안했다. sqrt는 정확히 반올림되므로 필요 없다.
- **Devin:** JSContext shim은 '양쪽의 최악'이라는 판단. 3층 패리티(추적·골든·스위트). 숫자 포맷이 최대 위험. 기각: Rust 기본과 자동 폴백. 오류: JS `toFixed`가 짝수 쪽 반올림이라고 했다. 실제로는 0에서 먼 쪽이다.
- **GLM:** 범위 (i)를 강하게 지지했다. 커스텀 지표는 2.x에서 선언형이나 WASM으로 하자는 방향. 두 백엔드를 싣고 실행 중 선택. 포맷 함정 목록이 정확했다. 기각: libm 크레이트 고정과 1 ulp 허용, `no_std`, `panic=abort`.
- **DeepSeek:** ryu-js 권고, 합산 순서 고정. 기각: 빌드 시 하나만 싣기, 구조 비교, chrono-tz 번들, JS 제거 단계(주인 결정과 충돌).
- **Qwen:** 저장소를 직접 읽고 줄 번호를 인용했다. 내부 런타임 승격과 CoreValue facade. JNI를 두 백엔드 디스패처로. packet v1이 이미 있다는 확인. `Math.round(-0.5)=-0` 같은 함정. 기각: 출하 빌드에서 .so 분리, fdlibm 고정, 출력 양자화. 오류: 소문자 변환이 JS와 다르다고 했지만 같았다.
- **Claude 3안:** 다음 세 가지를 냈다.
  - 최소 변경안: 봉투 호환, JSValue facade
  - 성능안: 기기 분해 수치, 크기 기준선
  - 정합성안: 오라클 비결정성 실측, 플랫폼 libm, 정규화
- **이번에 추가로 확인한 사실:** 포팅 지도는 JSC `hypot`이 Kahan 방식이라고 적었다. 실측해 보니 JSC는 libm과 같았다(§6.3). 지도의 해당 문장은 고쳤다.
