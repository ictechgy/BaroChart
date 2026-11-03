# Rust 코어 M1c 워크스페이스 봉투 스파이크

**실행일:** 2026-11-04
**기준:** M1b `2e7899b43842962f69504d3218eeaba6b86d1758` 위 로컬 `spike/rust-m1c-envelope`; 폐기형 실험 소스는 미공개 로컬 커밋 `6707464b7f2f03eb8824a2b6e30f00548cb45b3e`로 보존했다.
**결론:** 테스트한 워크스페이스 복원 경로에서는 설계 §4.6의 **봉투 호환을 유지한다**. Swift/Java host 복원 알고리즘이나 validator를 바꿀 필요가 없었고, 이 프로토콜을 prepare/commit으로 대체할 근거도 나오지 않았다. 필요한 최소 이음새는 Rust가 실제 f64 source/target 데이터를 받는 FFI 경로와 Swift Rust runtime의 f64 override였다.

이 결론은 M1c 가짜 데이터 스파이크에 한정된다. 실제 워크스페이스 문서, 지표, checkpoint, ingestion, 전체 오류 순서나 Android production JNI/device를 구현·검증했다는 뜻이 아니다.

이 보고서만 main에 제안하며 실험 feature·harness·가짜 엔진 코드는 머지하거나 배포하지 않는다. 아래 명령은 보존한 로컬 spike checkout에서 실행한 절차다. 일반 main checkout에 이 실험 스크립트가 있다는 뜻이 아니며 공개 재현 패키지도 배포하지 않았다. 명령 재현 시 Node 22.20.0을 PATH 앞에 두고 JAVA_HOME은 실제 JDK 21 경로로 설정한다.

Root 검토자는 host 파일의 HEAD 동일 해시를 직접 확인하고 Swift 6개 및 Java 6개 시나리오를 다시 실행했다. 별도 프로필/외부 네트워크/물리 기기를 사용하지 않았다.

## 검증한 경계

기존 host 상태 머신은 수정하지 않았다.

| Host | 실행한 원본 | 현재 파일 SHA-256 | `HEAD` 파일 SHA-256 | 결과 |
|---|---|---:|---:|---|
| Swift | `BaroChartWorkspaceJob` in `native/BaroChartEngine.swift` | `9ba464a1e35b23af829ba6fba229bde65c6b5512212ef57d7c035f3da089eed0` | 동일 | 실제 Rust engine/XCFramework로 실행 |
| Java | `native/android/java/kr/coden/barochart/WorkspaceRestoreJob.java` | `835ad901fdbe1347fd7640c434ee70a61eb9467a506c1c97b060e6f1107b4897` | 동일 | macOS JVM에서 실제 클래스 + Rust ABI로 실행 |
| Java budget | `native/android/java/kr/coden/barochart/NativeJobBudget.java` | `553cc9dbd5c35553a790d30283f1e6ebc7c0ec8a21c2a156212b8bf6ffc1ad7e` | 동일 | 실제 정적 admission ledger 실행 |

Swift는 Apple Swift 6.4 도구에서 프로젝트의 Swift 5 language mode로, Java는 Temurin 21.0.12.1에서 `-source 8 -target 8 -Xlint:all,-options -Werror`로 실행했다. Rust는 1.98.1, Node wrapper는 절대 경로의 Node 22.20.0, Cargo는 `--locked --offline -j2`였다.

스파이크 feature가 노출한 bridge 함수는 Task 10의 다음 **11개뿐**이다.

1. `nativeWorkspaceSourceBegin`
2. `nativeWorkspaceSourceStep`
3. `nativeWorkspaceSourceCheck`
4. `nativeWorkspaceSourceFinish`
5. `nativeWorkspaceSourceAbort`
6. `nativeAsyncBuffer`
7. `nativeWorkspaceTargetCreate`
8. `nativeAsyncTargetBuffer`
9. `nativeAsyncStart`
10. `nativeAsyncStep`
11. `nativeWorkspaceTargetFinish`

기존 `nativeInit` 외 다른 차트/비동기 함수를 stub으로 보태지 않았다. feature가 꺼진 기본 빌드의 함수 표와 동작은 그대로다.

## RED: 현재 M1b가 그대로는 통과하지 않는 이유

먼저 ordinary M1b XCFramework를 만들고 spike Swift test를 켰다.

```sh
node scripts/rust/build-xcframework.mjs
BAROCHART_RUST_XCFRAMEWORK=$PWD/artifacts/rust/BaroChartCoreRust.xcframework \
  swift test --scratch-path artifacts/envelope-spike/red-swift \
  -Xswiftc -DBAROCHART_ENVELOPE_SPIKE \
  --filter RustEnvelopeSpikeTests/testFFITransportOverridesTypedViewDefaultsAndWritesRealTargetSlices
```

현재 `BaroChartRustCoreRuntime`가 protocol 기본 구현을 쓰므로 f64 read가 `bc_read_f64`에 들어가지 않고 JSON/JS typed-view 경로로 떨어졌다. 관찰된 첫 실패는 다음과 같았다.

```text
UnavailableError: __bcReadF64ForTest is not available in the Rust backend yet
Executed 1 test, with 1 failure
```

정상 restore acceptance test도 ordinary M1b에서 RED였다.

```sh
BAROCHART_RUST_XCFRAMEWORK=$PWD/artifacts/rust/BaroChartCoreRust.xcframework \
  swift test --scratch-path artifacts/envelope-spike/red-swift \
  -Xswiftc -DBAROCHART_ENVELOPE_SPIKE \
  --filter RustEnvelopeSpikeTests/testNormalRestoreCopiesTenThousandBarsAndPublishesBeforeObserverAndCompletion
```

관찰 결과는 `cleanupPending(registration: 1)`, 0 observer, revision 0이었다. Begin이 아직 unavailable이고, 실패 정리의 Abort도 unavailable이라 원래 실패가 cleanup-pending 결과로 바뀐 것이다. 이는 host 알고리즘 문제가 아니라 두 이음새가 아직 없는 M1b 기준선이다.

별도로 기존 Java ownership harness는 변경 전후 모두 통과했다.

```sh
ASTER_JAVA="$JAVA_HOME/bin/java" \
  node scripts/check-java-workspace-job.mjs
```

결과는 **108 scenarios / 1,635 checks**, 실제 worker thread, zero failure였다. 이 검사는 독립 fake Host에 대한 기존 ownership 기준선이고 Rust payload 증거는 아래 별도 harness가 담당한다.

## GREEN: 폐기형 Rust 봉투

feature `envelope-spike`에서만 엔진별로 source/target 세션을 보관했다. source는 다음 여섯 열의 결정적 값 10,000개를 만든다.

- `time = 1_700_000_000_000 + i × 60_000`
- `open = 1_000 + i`
- `high = 1_007 + i`
- `low = 995 + i`
- `close = 1_002 + i`
- `volume = i % 97 + 1`

총 전송량은 `10,000 × 6 × 8 = 480,000` bytes다. target은 여섯 열을 모두 받은 뒤 60,000개 f64 값을 bitwise로 다시 검사해야 `nativeAsyncStart`가 성공한다. 따라서 host가 단순히 성공 receipt만 왕복한 것은 아니다.

source가 만든 metadata는 `BAROCHART-RUST-ENVELOPE-SPIKE::|…`로 시작하는 **JSON이 아닌 문자열**이다. Swift와 Java host는 크기와 전달만 담당하고 내용을 파싱하지 않았다. target Rust만 이 payload를 해석했다.

Rust FFI focused test:

```sh
node scripts/rust/cargo.mjs \
  test --locked --offline -j2 -p barochart-ffi --features envelope-spike \
  --test envelope_spike
```

결과: **1 passed**. 11개 이름의 `bc_supports`, `nativeAsyncFinish` 미지원, 여섯 열 read/write, payload bit 일치, start/step/finish, source finish, Abort idempotence를 확인했다.

Swift 실제 host:

```sh
node scripts/rust/build-envelope-spike-xcframework.mjs
BAROCHART_RUST_XCFRAMEWORK=$PWD/artifacts/envelope-spike/rust/BaroChartEnvelopeSpike.xcframework \
  swift test --scratch-path artifacts/envelope-spike/green-swift-final \
  -Xswiftc -DBAROCHART_ENVELOPE_SPIKE \
  --filter RustEnvelopeSpikeTests
```

결과: **6 passed / 0 failed**. 별도 transport test는 read와 write에서 NaN payload와 `-0` 비트도 보존했다. 같은 feature 산출물에서 기존 `RustRuntimeTests` 13개도 통과했다.

Java 실제 host + 얇은 macOS JNI:

```sh
ASTER_JAVA_HOME="$JAVA_HOME" \
  node scripts/rust/check-envelope-spike-java.mjs
```

결과: **6 scenarios / 0 failure**, 실제 worker thread. 각 host/봉투 invariant는 실패 즉시 프로세스를 끝내며, 비동기 coalescing에 따라 호출 횟수가 달라지는 assertion 수를 고정된 품질 수치로 보고하지 않는다. 이 harness는 production `WorkspaceRestoreJob.java`와 `NativeJobBudget.java`를 그대로 컴파일하고, 얇은 test JNI가 `bc_call`/`bc_read_f64`/`bc_write_f64`/engine create/free만 전달한다.

## 시나리오 결과

| 시나리오 | Swift `BaroChartWorkspaceJob` | Java `WorkspaceRestoreJob` |
|---|---|---|
| 정상 | 480,000 bytes, logical 1,048,576 B, 성공 | 같은 byte/logical 값, 성공 |
| 취소 | 첫 capture progress에서 취소, 게시 없음, 원본 runtime 호출 가능, 다음 정상 restore 성공 | 첫 capture progress에서 취소, `cancelled`, 게시 없음, 원본 runtime 호출 가능 |
| timeout | target 첫 step의 test-only 20 ms 지연과 5 ms deadline, 게시 없음, revision 0 | 20 ms 지연과 1 ms deadline, `timedOut`, 게시 없음 |
| stale | 한 source read 뒤 Rust source check가 `StaleSourceError`, 게시 없음, 다음 정상 restore 성공 | 첫 capture progress에서 host revision 변경, `stale`, 게시 없음 |
| 논리 예산 | 600 MiB 작업을 유지하면서 200 MiB 작업 입장: 두 번째 `busy`; 첫 작업과 예산 해제 뒤 다음 restore 성공 | 같은 600+200 MiB: 두 번째 `Native inflight byte limit`; entry/exit budget `{0,0}` |
| 게시 | source/target finish 뒤 runtime swap, reservation 해제 뒤 observer, observer에서 새 target `nativeInit` 호출, completion은 observer 뒤 | finish 둘 뒤 compare/swap, reservation 해제 뒤 observer, completion은 observer 뒤 |

`budget`은 RSS 측정이 아니라 기존 host의 논리 admission ledger 검증이다. `timeout` 지연도 결정적 실패 경로를 만들기 위한 test-only 동작이며 성능 측정이 아니다.

## 드러난 host 가정

1. **내부 payload는 실제로 불투명하다.** Host가 검사한 것은 metadata 문자열 길이, 여섯 buffer의 slot/동일 길이, `plan.totalBytes`, progress/finish 봉투뿐이었다. 비-JSON metadata를 수정 없이 전달했다.
2. **source와 target은 같은 backend여야 한다.** Rust target만 Rust metadata를 이해했고, host는 변환하지 않았다. 현재 factory가 source backend를 기억해 같은 backend target을 만드는 규칙과 맞는다.
3. **f64 이음새는 필수다.** Swift protocol 기본 구현은 JS typed view를 요구하므로 Rust runtime에는 `bc_read_f64`/`bc_write_f64` override가 필요하다. 현재 generic `bc_write_f64`도 source slice를 bridge handler에 전달하지 않으므로 real target write dispatch가 필요하다.
4. **host 알고리즘은 바꿀 필요가 없다.** admission의 비동기 재호출, owner-only source, worker-only target, chunk copy, target compute, main handoff, stale/cancel/timeout 검사, 원자 게시 순서를 그대로 받아들였다.
5. **오류 정리 함수도 초기 기능 표에 들어가야 한다.** Begin이 실패한 경우에도 host는 preallocated registration으로 `nativeWorkspaceSourceAbort`를 호출한다. Abort가 없으면 Swift에서 원래 오류가 `cleanupPending`으로 바뀐다.
6. **target progress는 기존 인코딩을 지켜야 한다.** `nativeAsyncStep`은 host whitelist에 든 phase와 `complete == (phase == 'workspace-ready')`, `done <= total`을 제공했다. Java/Swift 현 경로가 받는 JSON 문자열 형태도 유지했다.
7. **finish receipt와 게시 순서는 외부 계약이다.** target finish의 schema/version/status/hostPublished/plan, source finish의 schema/version/ticket/revision을 host가 검사한 뒤에만 swap한다. 예산과 busy 예약은 observer reentry 전에 풀린다.
8. **target은 순차적으로 thread handoff 가능해야 한다.** 두 host 모두 worker에서 target을 만든 뒤 worker 종료를 확인하고 owner에 게시했다. 동시 공유는 하지 않았다(`Send`, not `Sync`).

## 필요한 최소 adapter 변화

실제 M6 구현에서 이 spike로 확인한 최소 변화는 다음뿐이다.

- `barochart-bridge`/core가 11개 이름의 실제 workspace 상태와 봉투를 구현한다.
- `bc_read_f64(nativeAsyncBuffer, …)`가 source 소유 조각을 복사하고, `bc_write_f64(nativeAsyncTargetBuffer, …)`가 전달받은 실제 source slice를 target에 쓴다.
- Swift `BaroChartRustCoreRuntime`가 f64 read/write를 C ABI로 직접 override한다. 현재 M1c 코드는 `BAROCHART_ENVELOPE_SPIKE`로만 켜진다.
- Android production `aster_jni.c`에는 이미 Rust backend의 `readBuffer → bc_read_f64`와 `writeBuffer → bc_write_f64` 분기가 있다. 이 스파이크는 그 production JNI를 실행하지 않았으므로 배선 존재와 런타임 검증을 구분한다.

`BaroChartWorkspaceJob`, `WorkspaceRestoreJob`, 두 host validator, 공개 API에는 최소 변경이 없었다. 따라서 현재 증거로는 prepare/commit 대체안을 선택하지 않는다.

## 한계와 남은 M6 검증

- 가짜 source/target은 실제 chart, workspace document, binding, indicator, checkpoint, drawing, ingestion을 구현하지 않는다. payload가 불투명하다는 구조 가정만 검증한다.
- 실제 spec의 validation 순서·오류 문구·byte accounting·post-publish chart state는 M6 conformance 대상이다.
- Swift는 arm64 macOS local XCFramework만 실행했다. iOS simulator와 물리 iPhone은 사용하지 않았다.
- Java는 macOS JVM에서 production job class를 실행했다. Android runtime, production `BaroChartEngine` anonymous Host, `aster_jni.c`, org.json, CMake/ELF, emulator는 실행하지 않았다. 물리 Android 기기는 사용하지 않았다.
- WASM, panic/EH poison, OOM, timezone callback, 실제 성능/RSS는 이 스파이크 범위 밖이다.
- test-only timeout/예산 지연은 feature가 꺼진 산출물에 없다. spike code와 harness는 머지 대상이 아니며, 이 보고서만 별도 문서 변경 후보이다.

## 구조 검증

기본 M1b와 feature 빌드를 모두 검사했다.

```sh
node scripts/rust/cargo.mjs \
  test --locked --offline -j2 -p barochart-ffi
node scripts/rust/cargo.mjs \
  test --locked --offline -j2 -p barochart-ffi --features envelope-spike
node scripts/rust/cargo.mjs \
  clippy --locked --offline -j2 -p barochart-ffi --all-targets -- -D warnings
node scripts/rust/cargo.mjs \
  clippy --locked --offline -j2 -p barochart-ffi --features envelope-spike --all-targets -- -D warnings
node scripts/rust/cargo.mjs fmt --all -- --check
```

default ABI tests, feature tests, clippy와 rustfmt가 모두 통과했다. Swift library의 feature release build도 `-warnings-as-errors`로 통과했고, feature를 끈 ordinary XCFramework에서 기존 `RustRuntimeTests` 13개가 통과했다. 기존 전체 Swift test compile에는 이 spike와 무관한 `TypedEngineTests.swift`의 Swift 6 Sendable warning이 남아 있어, test 전체를 warnings-as-errors로 통과했다고 주장하지 않는다.
