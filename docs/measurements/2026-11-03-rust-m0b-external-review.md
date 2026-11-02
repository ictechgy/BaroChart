# M0b 외부 리뷰 판정

판정일: 2026-11-03 KST. 대상: `e0ab2f9..aa11296`, `feat/rust-m0b-core-seam`.

SDK 기본 실행 경로에서 Critical·Important로 확정한 항목은 없다. 구현 수정 없이 PR 검토를 진행할 수 있다. 추적 도구의 실제 한계와 검증 공백은 아래에 별도로 남긴다. 이 판정은 Rust 동등성이나 M0 전체 완료를 뜻하지 않는다.

## 입력과 방법

- 이미 받은 GLM 5개, DeepSeek 5개, Qwen 3개 답변의 지적 114건을 읽었다. 원본은 로컬 `barochart-reviews/m0b/<model>/answer-<part>.md`에 보관되어 있다.
- Qwen part 04는 비어 있고 part 05는 없다. 해당 두 조각은 GLM·DeepSeek의 답변만 판정했다. 새 외부 요청은 하지 않았다.
- Claude 전용 `external-review.workflow.js`를 실행하지 않았다. `skipRelays: true`와 같은 범위의 로컬 판정 절차(추출 → 중복 확인 → 문맥 확인·반박 실험 → 심각도 판정)를 Codex가 직접 수행했다.
- [설계](../superpowers/specs/2026-11-02-rust-core-design.md) §2·§6·§8, [M0 계획](../superpowers/plans/2026-11-02-rust-core-m0.md) Task 5~8, M0·M1 진행 원장의 기존 Ruling을 기준으로 삼았다.
- Critical·Important는 SDK 사용자에게 미치는 현재 영향으로 판단했다. 테스트 도구 한계의 실재 여부와 SDK 기본 경로의 회귀 여부를 구분했다. 아래의 보류 항목은 해결되었다고 주장하지 않는다.

## 지적별 추적표

G = GLM, D = DeepSeek, Q = Qwen. `G1.2`는 GLM part 01의 지적 2번이다. 각 셀은 원문의 지적 번호 → 아래 판정 ID다. K는 기존 결정·기록과 중복, R은 현재 결함으로 확정하지 못함, M은 P3 도구 개선·한계로 보류다.

| 답변 | 건수 | 원문 지적 번호 → 판정 |
|---|---:|---|
| G1 | 10 | 1:K1, 2:R1, 3:R3, 4:M1, 5:R1, 6:M2, 7:M3, 8:R5, 9:R5, 10:R3 |
| G2 | 7 | 1:R2, 2:R3, 3:R2, 4:K1, 5:R5, 6:M4, 7:R3 |
| G3 | 8 | 1:K1, 2:M5, 3:M6, 4:M7, 5:M8, 6:M8, 7:M9, 8:R8 |
| G4 | 9 | 1:R4, 2:M10, 3:M10, 4:M11, 5:M10, 6:M10, 7:K2, 8:M12, 9:M9 |
| G5 | 6 | 1:M11, 2:M9, 3:R8, 4:R8, 5:M9, 6:M9 |
| D1 | 5 | 1:R1, 2:R1, 3:M1, 4:M9, 5:M3 |
| D2 | 7 | 1:R7, 2:R2, 3:K1, 4:R1, 5:R7, 6:R1, 7:R8 |
| D3 | 2 | 1:M8, 2:R8 |
| D4 | 3 | 1:K2, 2:R8, 3:R8 |
| D5 | 2 | 1:R8, 2:R8 |
| Q1 | 22 | 1:K1, 2:R1, 3:R8, 4:R6, 5:R6, 6:R3, 7:M1, 8:M9, 9:R3, 10:R1, 11:R3, 12:R3, 13:R8, 14:R5, 15:M7, 16:M9, 17:M2, 18:R8, 19:R3, 20:R2, 21:R1, 22:M9 |
| Q2 | 20 | 1:R2, 2:R2, 3:K1, 4:R7, 5:R3, 6:K3, 7:R6, 8:R5, 9:R2, 10:R2, 11:R8, 12:R5, 13:M13, 14:M7, 15:M13, 16:M8, 17:R8, 18:M9, 19:R2, 20:R8 |
| Q3 | 13 | 1:M14, 2:M14, 3:K1, 4:K4, 5:R9, 6:M5, 7:R9, 8:M8, 9:M7, 10:M14, 11:M15, 12:R9, 13:R8 |

## 기존 결정과 중복

| ID | 판정과 근거 |
|---|---|
| K1 | **릴리스에도 추적 구현이 포함됨.** 기존 M0b-C9와 중복이다. Swift 훅은 internal, Java 훅은 package-private이고 기본값은 nil/null이다. Swift 팩토리는 writer가 없으면 원래 런타임을 그대로 반환하고, Android의 session이 null이면 파일을 만들지 않는다. 컴파일 시 제거하는 장치는 없으며, 의도적으로 훅을 켜면 릴리스에서도 기록할 수 있다는 한계는 남는다. 이를 원격 공격이나 기본값 데이터 유출로 확정할 근거는 없다. |
| K2 | **Node의 모든 F64 결과 강한 참조·전체 스냅샷.** Task 5 Ruling 및 M0b-C2와 중복이다. 별칭 뷰 쓰기를 GC 시점과 무관하게 잡기 위한 선택이다. 긴 기록 세션의 메모리 상한과 다른 번들 재생 시 전체 write가 차이를 덮는 한계는 해결하지 않았다. |
| K3 | **Swift 기록기의 접근자 실행.** 실제 한계다. Swift probe에서 결과 객체의 getter가 한 번 실행됐다. Task 6 Ruling이 공개 JSC C API만으로 접근자 검사를 하지 않으며 코어의 평범한 데이터 결과를 전제로 한다고 이미 명시한다. 임의의 JSValue·getter·Proxy를 쓰는 세션을 부작용 없는 오라클로 취급해서는 안 된다. |
| K4 | **Android 타입 전송에서 기록 중단.** Task 7 Ruling과 중복이다. 11개 훅이 중단 sidecar를 기록하며, TraceRecorderTest가 중단 함수·줄 번호를 검사한다. M0b는 충실한 앞부분만 보존한다. Android 전체 수치 경로의 동등성 증거는 아니며 향후 JNI 추적 빌드·실시간 차분·플랫폼 스위트가 필요하다. |

## 현재 결함으로 확정하지 않은 항목

| ID | 반박 근거와 판단 한계 |
|---|---|
| R1 | **Swift 설정·번호·실패 목록의 무잠금 경쟁 주장.** `BaroChartTraceSettings`가 모든 공유 상태 접근을 NSLock으로 지킨다. 새 non-nil 디렉터리를 설정하면 번호와 실패 목록을 비우고 nil로 끈 뒤에는 실패를 검사할 수 있게 보존한다. 따라서 다음 writable 세션에 이전 실패가 남는다는 재현도 성립하지 않는다. 서로 다른 기록 세션을 동시에 켜는 문제는 M7이다. |
| R2 | **오류 타입·문구, VM 분리, 수명·autorelease 회귀 주장.** `perform`은 이전과 같은 guard를 먼저 실행하고 `takeException`으로 read/clear한다. `invoke`에 IngestionError 검사와 64/256 UTF-16 한도가 그대로 있다. CoreRuntimeTests가 기존 본문과 결과·오류·잔여 예외를 대조한다. `makeIsolated`는 호출마다 새 VM을 만든다. `sourceIdentity`는 통지 여부를 결정할 때만 `owner.contextBacking === source`와 함께 쓰므로, 클라이언트가 이전 JSContext를 따로 붙잡아도 새 wrapper 수명으로 인한 잘못된 통지가 생기지 않는다. 기존 copy 호출의 autoreleasepool도 유지된다. 새 Swift 실행과 골든 비교가 통과했다. |
| R3 | **포인터·GC·잔여 예외에 대한 주장.** 현재 bulk-copy 구현은 count를 검사한 뒤 포인터를 얻고 JSC 재진입 없이 memcpy한다. 기록기의 host write는 `invoke` → 기록 → copy → `hostWrote`로 이어지며 지역 JSValue가 뷰를 보유하고, 다음 호출 시작 시 lastView를 비운다. 결과 그래프도 인코딩 동안 뿌리 JSValue에 연결되어 있다. JSC 오류 출력은 지역 exception 인자를 쓴다. 골든의 F64 write와 기존 동등성 테스트가 통과했고, 별도 GC probe 1,000회도 통과했다. 이는 임의의 getter·Proxy나 미래 Rust 구현의 안전성 증명이 아니며, 현재 경로의 UAF·pending-exception 변화는 재현하지 못했다. |
| R4 | **Node가 내장 전역 200개를 guard한다는 주장.** 실제 sandbox 객체와 realm global을 혼동했다. probe에서 빈 sandbox 자기 키는 0개, 번들 평가 뒤 101개, Object·Math·Promise·Array는 그 목록에 없고 guard는 1개였다. 정상 native 호출 2줄도 기록됐다. |
| R5 | **숫자·호스트 변환·키 순서 주장.** trace는 JSC가 받은 double을 기록하며 원본 u64를 보존하는 형식이 아니다. Swift 딕셔너리 인자 정렬은 명시된 계약이고, 결과 키는 JSC 순서다. 숫자 표기는 20,000개 JSC 벡터와 Node BCJSON 테스트로 검사한다. `[NSNumber(1): "numeric", "key": "string"]` 실험에서 trace와 실제 JSC 브리징 모두 문자열 키만 남겼다. 비문자열 키를 JSC만 문자열로 바꾼다는 Q2.8의 전제는 틀렸다. 미래 Rust가 같은 변환을 구현해야 한다는 요구는 유지한다. |
| R6 | **골든 출처·누락을 성공으로 오판한다는 주장.** 골든을 추가한 커밋은 리팩터링 전 `8c4a60a` 하나이며 이후 수정되지 않았다. `testScenarioTraces`는 실패 목록뿐 아니라 `.meta.json` 파일이 하나도 없는지도 검사하고, 새 프로세스의 같은 검사를 통과해야 골든을 비교한다. 호스트 글꼴 측정값이 현재 코어 trace에 섞인다는 구체적 불일치는 제시·재현되지 않았다. 무작위 UUID 정규화의 별도 한계는 M3이다. |
| R7 | **rope 문자열 손실·null prototype 크래시 주장.** 로컬 SDK 헤더는 JSString의 backing Unicode buffer와 JSValue인 prototype 반환을 설명한다. JSStringRef를 rope의 nullable 저장소라고 한 전제는 확인되지 않았다. 길이 10,000의 조립 문자열은 따옴표 포함 10,002자로 손실 없이 기록됐고, null-prototype 객체는 `prototype` 사유로 거절됐다. 이 실험으로 모든 JSC 판의 동작이나 OOM 상황까지 보장하지는 않는다. |
| R8 | **미구현·비계약 API 또는 테스트 의도를 결함으로 간주한 항목.** M0은 JS 구현 하나를 위한 facade이며 Rust 구현 시 값·context를 확장하는 것은 후속 계획에 있다. supports·번들 평가는 별도 검사이고 trace 호출 종류가 아니다. 호출 순서·정확한 글자를 고정한 테스트는 동작 보존 목적에 맞는다. foreign/function 테스트에 트랩이 없다는 점, 같은 버퍼의 alias가 살아 있다는 점은 기존 GC 회귀 테스트를 무효화하지 않는다. JavaScript 재귀 스택 초과가 반드시 Node 프로세스 abort가 된다는 주장도 성립하지 않는다. `property(name)` 오류의 동적 name은 name/message/code/length 같은 내부 필드명이다. 반복 Drop이 필요한 Rust와 Node 파서를 혼동하지 않는다. |
| R9 | **JNI JSON·code·File import 주장.** JNI는 결과를 QuickJS JSON.stringify한 텍스트로 반환하고 함수·심볼의 `undefined` 결과는 중단 처리한다. 일반 문자열 `""`도 유효 JSON 문자열로 인코딩된다. Android 오류에 code가 없는 것은 JNI가 이를 전달하지 않는 표준 모드 계약이다. Android trace를 Node 무손실 replayer에 그대로 넣는 범용 지원은 이번에 구현하지 않았다. `java.io.*` import가 이미 있어 File 컴파일 오류도 없으며 실제 계측 빌드가 통과했다. |

## 보류한 P3 도구 개선·한계

| ID | 남은 문제와 범위 |
|---|---|
| M1 | `readFloat64Data`의 invalid-count 경로는 작은 placeholder와 항상 throw하는 기본 구현에 의존하고 뒤의 return은 실행되지 않는다. 현재 JS·recording 구현은 먼저 검사하므로 잘못된 복사를 재현하지 못했다. 미래 구현을 추가할 때 invoke-before-validation 순서를 유지하며 포인터 없는 경로로 단순화할 수 있다. |
| M2 | 골든 재생성은 명시적 환경 변수로 실행하지만 소스 트리를 직접 갱신하고, 기존 파일을 먼저 지우며 Bundle.module 사본은 재빌드가 필요하다. 실패 원자성·재실행 안내 개선이 가능하다. 일반 테스트 실행은 골든을 바꾸지 않는다. |
| M3 | UUID 정규화 정규식은 렌더러 토큰 위치만 한정하지 않아 임의의 UUID 모양 사용자 문자열 차이도 지울 수 있다. 십진 좌표 숫자가 UUID라는 주장은 성립하지 않지만 문자열 범위가 넓다는 한계는 실재한다. |
| M4 | Swift 공개 context로 직접 평가·호출한 작업은 trace를 우회한다. 해당 경로를 사용하는 세션은 현재 trace의 동등성 대상으로 삼을 수 없다. |
| M5 | Android 오류 이름 판별은 ASCII identifier와 `": "`에 의존한다. 빈 메시지·비표준 이름의 실제 JS 오류도 안전하게 중단하지만 수집 범위가 줄며, 미래 JNI 오류가 같은 모양이면 오분류할 여지가 있다. |
| M6 | Android lone-surrogate에 대한 파일 바이트 설명은 실제 Java JSON 텍스트·JNI UTF-8 변환을 구분해 정밀하게 적을 필요가 있다. 다른 엔진 입력으로 직접 쓰려면 플랫폼 변환을 명시해야 한다. |
| M7 | 기록 세션은 quiescent 상태에서 디렉터리를 바꾼다는 전제다. 같은 디렉터리 재사용은 파일을 비우고, 병렬 테스트 세션은 서로 간섭할 수 있다. Android map은 세션 종료까지 recorder를 보유하며 주소 재사용 시 새 recorder로 교체된다. 정상 명령의 이전 기록 혼입은 확인하지 못했으나 세션 메모리 상한·수명 정리는 후속 개선이다. |
| M8 | 추적을 켜면 동기 파일 I/O, 해시, base64 사본, map lookup이 비용을 만든다. Android createNanos에도 attach 비용이 들어간다. 추적 실행을 성능·RSS 비교의 원래 기준선으로 사용하지 않는다. 파일을 줄마다 닫으므로 동시 열린 FD가 계속 누적된다는 주장은 기각한다. |
| M9 | 테스트 보조 프로세스 timeout·SIGTERM 뒤 종료 대기 상한, process.run 실패 시 FileHandle 정리, continuation timeout, 일부 단언·진단 메시지의 정밀도 개선이 남는다. firstDifference 마지막 문구는 사실상 도달하지 않는다. SDK 기본 동작 결함으로 분류하지 않는다. |
| M10 | Node 기록기는 native 호출을 함수 호출로 다루며 임의 생성자·동적인 this를 기록하지 않는다. 현재 브리지 함수는 이 사용법에 의존하지 않지만, preexisting 객체의 내부 변경과 재진입 콜백의 임의 전역 삭제까지 일반적으로 관찰하는 도구는 아니다. |
| M11 | harvest는 중단·skip·호출 수를 보고하지만 CLI는 stopped를 별도 요약하지 않고, harvest의 합격 조건도 calls>0을 요구하지 않는다(M0b-C5와 관련). 테스트 선택 결과가 0개일 때 Node의 자동 발견을 막는 guard도 없다. 이번 수집은 68파일·1,284호출임을 별도 확인했다. 중단된 prefix를 전체 세션 동등성으로 보고하지 않는다. |
| M12 | Node replayer는 신뢰된 로컬 trace와 번들을 실행하는 도구다. fn을 own native 함수로 제한하는 추가 검사는 없다. 외부 입력을 처리하는 sandbox로 사용해서는 안 된다. |
| M13 | Swift의 임의 JSValue F64 인자는 해시만으로 재생할 수 없고, detached F64와 빈 F64도 형식만으로 구분하지 않는다. 현재 native 시나리오는 해당 입력을 사용하지 않는다. Rust 재생 입력 범위를 넓힐 때 명시적 거절 또는 바이트 전송 표현이 필요하다. |
| M14 | Android 기록기는 IOException·SecurityException을 처리하지만 OOM 같은 Error까지 격리하지 않는다. 별도 JVM probe에서 파일 접근에 Error를 주입하면 runtime attach와 append 모두 바깥으로 전파됨을 확인했다. 이는 실제 추적 도구 실패 경로다. trace가 켜진 세션에서는 코어 성공 뒤 기록 실패가 성공을 가리거나 native handle 취득 뒤 attach 실패가 소유권을 잃게 할 수 있다. 디스크 중간 쓰기·프로세스 종료 때의 완전한 줄 보존도 보장하지 않는다. 기본값 session=null 경로에서는 실행되지 않아 P3로 보류했으며, 모든 메모리 실패에서 투명한 recorder라고 주장하지 않는다. |
| M15 | `--sdk`로 M0b 이전 Swift 소스 스냅샷을 검사하는 일부 로컬 스크립트도 새 파일 둘을 무조건 나열하므로 실패할 수 있다. 현재 SDK의 두 새 파일은 Package.swift·npm payload·빌드 목록에 들어 있고 패키지 검사는 통과했다. 과거 스냅샷을 대상으로 하는 개발 도구 호환성은 보류한다. |

## 검증

아래는 `aa11296`의 실행 근거다. 이번 판정에서 SDK·테스트·빌드 코드는 바꾸지 않았고, 문서·원장만 갱신한다. 새 네트워크 요청 없이 로컬 캐시와 도구를 사용했다.

| 검사 | 결과 |
|---|---|
| `npm test` (Node 22.20.0, 로컬 TypeScript 5.9.3 경로) | 5,842/5,842, fail·skip 0 |
| `npm run check` | 통과 |
| `npm run check:types` | 통과 |
| `npm run check:package` | offline pack·install·소비자 타입·실행 검사 통과 |
| `npm run check:security:offline` | 통과, findings 0 |
| `npm run check:quickjs` | 통과 |
| `node scripts/trace/harvest.mjs` | 322 traces, 238 withCalls, 1,284 calls, mismatches 0, stopped 291, skipped 1; 기록 모드 테스트 900/900 |
| `swift test --disable-automatic-resolution --scratch-path artifacts/swift-test` | 59/59, 기존 골든 11개와 바이트 동일 |
| `artifacts/toolchain/android-test.sh --offline connectedDebugAndroidTest` | 라이브러리 68/68, Compose 5/5 |
| `artifacts/toolchain/android-test.sh --offline :barochart-compose:connectedDebugAndroidTest` | 5/5 |
| 추가 로컬 probe | Node sandbox guard 전제 확인; Swift rope·null prototype·NSDictionary 변환·GC 1,000회 확인; JVM 기록 Error 전파 확인 |

플랫폼 회귀 러너는 같은 코드의 2026-11-02 결과를 재사용한다(M0 계획 Task 8 허용). Android 요약은 15/15다. iOS는 24/25이며 회전 직후 XCUI 탭 경합으로 mobile-ux가 실패했고 같은 빌드 단독 재실행은 통과했다는 기존 원장 기록을 유지한다. 이를 새로운 25/25 성공으로 바꾸어 보고하지 않는다. 전체 회귀 러너는 이번에 다시 실행하지 않았다.

새 실행 로그·probe 원본은 로컬 `barochart-reviews/m0b/codex-20261103/`에 있다. 외부 원문·생성 trace는 저장소에 추가하지 않는다.

## 다음 단계

1. GitHub 네트워크 접근 승인을 받은 뒤 현재 브랜치를 push하고 PR을 만든다. CI가 통과한 뒤 squash merge한다. 공개 태그·레지스트리 업로드는 포함하지 않는다.
2. M1a를 최신 main 위로 rebase하고 이미 받은 외부 답변을 판정한다.
3. M0c 깊은 JSON 제한은 별도 PR에서 진행한다. M0b의 기록 한계를 M0c나 Rust 전체 동등성의 완료로 간주하지 않는다.
