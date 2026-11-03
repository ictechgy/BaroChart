# M1a 외부 리뷰 판정

2026-11-03 KST · `feat/rust-m1a-js-kernel` · M0b 머지 `2ec2803` 위로 rebase한 뒤 판정·수정.

Important 3건(X1~X3)을 확정해 회귀 테스트로 고쳤다. Critical로 확정한 항목은 없고, 아래에 명시한 기존 결정·P3 한계는 남는다. M1a는 내부 JS 의미 커널과 개발 하네스이며 네이티브 앱에서 Rust를 선택하는 공개 기능은 후속 단계다.

## 확정한 문제와 수정

| ID | 위치·실패 시나리오·수정·검증 |
|---|---|
| X1 · Important · tests | `scripts/rust/conformance.mjs:1333`의 Unicode 판 차이 예외가 새 글자 자리에서 임의의 코드 포인트 하나를 허용했다. 가짜 커널이 새 글자를 전부 z로 바꿔도 3,000건 중 87건을 제외하며 PASS했다. 또 Unicode 17을 주장하면서 새 대문자를 옛 Node 답 그대로 두면 `judge`의 equality 검사에 먼저 걸려 PASS했다(`:1401`). JSC·QuickJS로 새 글자 4,803개를 전부 대조해 얻은 소문자 대응 28개와 나머지 자기 자신만 허용하고, 이 검사를 equality보다 먼저 적용했다. 가짜 커널의 잘못된 새 대문자·비대응 문자·옛 Node 답 유지 3개 모드를 포함한 회귀 검사가 RED→GREEN이다. 실제 Unicode 17 대응은 계속 허용한다. 출처: G5.1, Q5.2, 이전 G.2(C6의 남은 허점). |
| X2 · Important · tests | `.github/workflows/verify.yml:115`의 Rust 잡이 V8만 실행해 동봉 QuickJS의 변화와 Android 방언의 표류를 상시 대조하지 않았다. 명령을 `--count 100000 --engines v8,quickjs`로 바꾸고 기존 CI 계약 검사를 해당 전체 명령에 묶었다. 계약 검사는 기존 YAML에서 RED, 수정 후 GREEN이다. 실제 명령도 80만 건을 모두 비교해 불일치 0건이다. JSC는 로컬 삼각측량에서 확인한다. 출처: G1.3, G2.3, G3.9, G6.2, Q6.1. |
| X3 · Important · correctness | `rust/crates/barochart-js/src/json/parse.rs:78`, `:106`, `:486`과 `rust/tools/conformance/src/main.rs`의 JSON 연산이 파싱에는 V8/JSC 반올림만 쓰고 q에는 쓰기 방언만 적용했다. QuickJS `js_atod`는 십진 가수의 첫 38자리 뒤를 버린다. `9007199254740993`에 0을 300개와 `1e-301`을 붙인 입력은 V8/JSC에서 9007199254740994, QuickJS에서 9007199254740992다. 일반 값 1 근처의 긴 소수에서도 1 ulp 차이가 난다. `parse_json_with`·`parse_json_utf16_with`를 추가하고 기본 API는 PLATFORM을 쓰게 했다. QuickJS의 긴 가수는 기존 정규화 경로에서 38자리로 잘라 읽으며 UTF-8·WTF-16·Standard·Lossless 모두 같은 방언을 쓴다. 하네스 q는 읽기·쓰기를 모두 적용하고 코퍼스에 세 입력 형식의 고정 경계를 넣었다(`scripts/rust/conformance.mjs:756`). API 없음·JSON q 누락·경계 코퍼스 누락 RED→GREEN. 독립적인 binary64 중간값 앞뒤 1만 건은 세 엔진과 모두 일치했다. 출처: G5.2 및 기존 Task 3의 긴 가수 Ruling 재검증. |

X3는 기존 원장의 “정확한 V8 반올림을 쓰고 QuickJS에서는 제외” 결정을 대체한다. [설계](../superpowers/specs/2026-11-02-rust-core-design.md) §6.1의 같은 기기 동등성과 기존 NumberDialect 결정(C1)을 숫자 읽기에도 적용했다. 새 허용 오차나 파싱 차이 예외를 만들지 않았다. JS 백엔드·웹 코드는 바꾸지 않았다.

## 입력과 추적표

새 외부 요청 없이 기존 final 답변 15개(GLM 6·DeepSeek 5·Qwen 4)와 이전 후반부 답변 2개를 읽었다. final의 DeepSeek 02, Qwen 02·03은 비어 있어 그 모델의 해당 조각 판정은 없다. 이전 DeepSeek 답변은 최종적으로 지적을 스스로 철회했고 유효한 미결 지적은 없었다. 나머지 답변의 지적 150건을 아래 ID에 대응시킨다. 마스킹된 수치·보이지 않는 다른 조각의 구현을 저장소 결함으로 단정하지 않았다.

G/D/Q는 final의 모델·part 번호, P는 이전 GLM 후반부 답변이다. 번호가 없는 G6의 항목은 등장 순서다. K는 기존 결정·보류와 중복, R은 현재 결함으로 확정하지 않음, M은 추가 P3 개선·한계다. 원문은 로컬 `barochart-reviews/m1a-final/` 및 `barochart-reviews/m1a/`에 보관한다.

| 답변 | 건수 | 원문 지적 번호 → 판정 |
|---|---:|---|
| G1 | 7 | 1:K2, 2:K4, 3:X2, 4:M1, 5:K1, 6:M6, 7:K7 |
| G2 | 8 | 1:R1, 2:K3, 3:X2, 4:R4, 5:R4, 6:K6, 7:M5, 8:K10 |
| G3 | 10 | 1:M1, 2:R4, 3:M5, 4:R5, 5:K3, 6:M7, 7:R4, 8:R1, 9:X2, 10:M1 |
| G4 | 10 | 1:R8, 2:K5, 3:R8, 4:K5, 5:K5, 6:K5, 7:K5, 8:R8, 9:R8, 10:R8 |
| G5 | 9 | 1:X1, 2:X3, 3:K1, 4:M1, 5:K10, 6:M4, 7:R5, 8:M5, 9:R5 |
| G6 | 10 | 1:R2, 2:X2, 3:M3, 4:K8, 5:M4, 6:M4, 7:M3, 8:R8, 9:R6, 10:M5 |
| D1 | 7 | 1:K1, 2:R3, 3:R3, 4:K7, 5:R3, 6:R4, 7:R5 |
| D3 | 9 | 1:R5, 2:K3, 3:R4, 4:M6, 5:R6, 6:M7, 7:R1, 8:R3, 9:R6 |
| D4 | 4 | 1:R7, 2:R5, 3:R4, 4:R4 |
| D5 | 4 | 1:M5, 2:M1, 3:R3, 4:M6 |
| D6 | 4 | 1:R6, 2:R6, 3:R5, 4:R6 |
| Q1 | 13 | 1:R3, 2:K11, 3:K1, 4:R4, 5:K4, 6:R6, 7:R4, 8:R3, 9:R1, 10:K9, 11:R4, 12:K7, 13:R1 |
| Q4 | 17 | 1:R2, 2:K5, 3:K5, 4:M2, 5:R7, 6:R2, 7:M1, 8:K3, 9:R5, 10:M5, 11:R5, 12:K8, 13:K5, 14:K5, 15:R8, 16:K5, 17:R6 |
| Q5 | 13 | 1:M1, 2:X1, 3:K1, 4:R2, 5:R7, 6:M1, 7:M1, 8:M5, 9:K3, 10:M6, 11:M5, 12:M4, 13:R4 |
| Q6 | 16 | 1:X2, 2:R7, 3:R2, 4:R4, 5:K10, 6:K5, 7:M2, 8:M5, 9:K4, 10:M3, 11:R5, 12:M4, 13:M5, 14:M2, 15:K5, 16:M4 |
| P | 9 | 1:R5, 2:X1, 3:K1, 4:R8, 5:R8, 6:M1, 7:K3, 8:R5, 9:R6 |

## 유지한 기존 결정·보류

| ID | 근거와 남은 범위 |
|---|---|
| K1 | Date.UTC의 달을 접은 연도가 TimeClip 연도 밖이면 QuickJS처럼 NaN이라는 Task 3 Ruling이다. V8·JSC와 다른 극단값은 지정 엔진에서만 예외로 기록하고 QuickJS와는 비교한다. 코어 지원 연도는 1000~9999다. 그 밖의 날짜 일반화를 완료했다고 주장하지 않는다. |
| K2 | NumberDialect는 같은 기기의 오라클을 따르므로 플랫폼 간 문서 바이트가 항상 같다는 계약이 아니다. 일부 2의 거듭제곱 쓰기의 54개 지수 차이(C1)는 유지하며, X3는 읽기 차이도 같은 기준으로 해결한다. |
| K3 | 숫자 포맷 함수의 u32 자릿수와 slice의 정수 인자는 명시한 유효 범위·호출자 강제 변환을 전제로 한다. 커널은 전체 Number.prototype·String.prototype 어댑터가 아니다. 범위 밖 수십억 자리 입력을 직접 넘기는 안전한 공개 JS 진입점은 구현하지 않았으며, 향후 코어 호출자가 RangeError·ToIntegerOrInfinity를 먼저 적용해야 한다. |
| K4 | Standard 최상위 undefined를 null로 쓰는 것은 Android 경계와 같은 기존 Task 3 결정이다. Lossless는 undefined와 null을 구분한다. 일반 JSON.stringify의 “텍스트 없음” API를 제공한다고 주장하지 않는다. |
| K5 | check-bans의 한정 경로·공백 macro·concat·std 공백 predicate·수학/파싱 우회·Display/ToString·manifest·symlink 등 빠지는 꼴은 텍스트 검사의 한계다. 기존 C8~C11과 같은 P3로 기록한다. 완전한 타입 검사·의존성 그래프 감사가 아니다. 현재 의존성은 잠근 ryu-js뿐이고, 현재 구현의 의미는 별도 대조로 검사한다. |
| K6 | 정확한 십진 전개 기반 포맷 비용(C14)은 남는다. 이번에는 수치 파싱·판정 오류를 고쳤으며 포맷 성능 최적화를 섞지 않았다. |
| K7 | JsObject 연속 삭제의 O(n²) 가능성(C15)은 남는다. swap-remove는 삽입 순서 계약을 깨므로 대안으로 채택하지 않았다. |
| K8 | symlink로 실행한 CLI가 main 판별을 놓쳐 0으로 끝나는 C12는 남는다. 검증·CI는 실제 파일 경로로 실행한다. |
| K9 | CI의 wasm32 컴파일 누락(C13)은 남는다. 새 파서 변경은 로컬 wasm32와 Android all-targets clippy로도 검사했다. |
| K10 | Unicode 판 차이의 기존 할당 문자 속성 변경(U+0295)과 새 문자 옆 final sigma의 허용 폭은 남는다(C7). X1은 임의 문자 허용과 옛 Node 답 유지 우회를 고쳤다. CI는 실제 QuickJS와도 문자열을 비교하며, V8 단독 결과를 모든 Unicode 판의 완전한 동등성으로 확대하지 않는다. |
| K11 | 원시 JSON 파서의 반복 구현·깊이 100,000 지원은 계획 요구다. 코어 문서·호스트의 32/64 깊이 제한은 M0c, 자원 admission은 코어·FFI 단계의 계약이다. V8도 깊이 100,000 파싱을 성공하므로 “모든 JS 엔진이 그 전에 RangeError”라는 전제는 틀렸다. |

## 현재 결함으로 확정하지 않은 항목

| ID | 확인 근거 |
|---|---|
| R1 | 다른 조각에 없던 구현은 실제 트리에서 확인했다. JsValue Clone·Drop·writer는 반복이고 깊은 테스트가 통과한다. cargo 래퍼는 rust/로 cwd를 바꾸며 toolchain을 고정한다. Cargo.lock·하네스·테스트는 같은 PR에 있다. 마스킹된 기대 숫자는 저장소의 문법 오류가 아니다. |
| R2 | 독립 엔진으로 잘못된 지적을 반박했다. Node의 `(2**89).toFixed(2)`는 기존 기대인 `6.189700196426902e+26`이다. TimeClip(-0.5)는 +0이고 JSON.stringify의 U+2028은 raw 코드 단위 2028이다. `Date.UTC(-0.5,0)`은 `Date.UTC(0,0)`과 같으므로 +1900 적용 전 truncation도 맞다. 실제 삼각측량은 해당 방언의 2^89·toFixed 동률도 확인한다. |
| R3 | 작은 지수의 긴 선행 0·큰 가수에 대한 가설을 재현했다. 800/1000개 선행 0, 100,000자리 유효 숫자, 700,000개 0의 지수 상쇄 4개가 V8과 일치했다. MIN_DECIMAL_EXPONENT는 안전한 바깥 경계이고, digit_at의 구간은 앞서 검증된다. civil 변환은 i128을 쓰고 포화 동작이 문서화되어 있으며 month는 계산상 1~12다. slice의 isize::MIN도 실제 테스트에서 통과한다. |
| R4 | 미요청 표면·미구현 계층을 현재 계약으로 혼동한 경우다. toUpperCase는 API에 없고 hypot은 현재 두 인자 호출용이다. 기기의 log/exp/hypot는 §6.3 플랫폼 libm, WASM 주입·실기기 확인은 후속 단계다. Date.UTC 내부 인터페이스는 일곱 인자이며 strict 날짜·시각 파서는 M0 계약(연도 1000~9999, 24:00·윤초 거절)이다. F64 token은 M1 JSON 파서 범위 밖이다. JsonMode의 미래 variant·JsError 코드의 가상 사용자 입력·PartialEq 추가는 현재 결함 근거가 아니다. |
| R5 | CRLF task를 실제 커널에 넣어 성공을 확인했다(JSON의 CR 공백). 내부 빈 줄·필드 타입·정수 자릿수 밖 입력은 작업 스키마 오류로 거절하는 것이 맞다. ftell은 이미 size>=0을 검사한다. seed 기본값은 고정 1이고 MAX_SAFE_INTEGER를 넘는 예시는 범위 검사로 거절된다. --engines all은 허용 목록과 함께 오류가 난다. CARGO_HOME/bin의 rustup 프록시 요구는 문서화되어 있고 잘못된 환경에서 조용히 다른 cargo를 쓰지 않는다. |
| R6 | 정확한 키 순서·호출 순서·고정 벡터는 동등성 계약을 검사한다. Lossless 문자열 비교는 타입·-0·undefined를 구분하며 NaN 페이로드만 정규화하는 것이 합격선이다. 소스 목록 단언은 다른 코퍼스 coverage 단언과 함께 작동한다. body·tool·CLI 검사는 테스트 파일 여러 곳에 나뉘어 있고 한 단위 테스트에 전부 중복할 필요가 없다. 불일치 출력은 예시 상한 20개라 모든 실패 줄이 쌓여 64 MB를 넘는다는 전제도 맞지 않는다. |
| R7 | toPrecision이 Plain이어도 QuickJS 결과와 r을 실제 비교하므로 “q가 없어서 검증 불가”는 틀렸다. q는 두 방언 결과가 다를 때만 필요하다. V8·제3 엔진의 oracle-error는 expectBatch/engineResults에서 즉시 하네스 오류가 되며 제외되지 않는다(C3 회귀 검사 포함). JSON.parse가 만든 __proto__는 자기 데이터 속성이므로 revive의 대입이 상속 setter를 호출하지 않는다. |
| R8 | 커널 프로필의 일부 std 함수 허용과 포트 프로필의 보수적인 금지는 계획에 명시된 선택이다. 정수 min/max나 문자열 정밀도 형식을 금지할 수 있다는 사실은 현재 잘못된 계산 결과가 아니다. std::format!의 한정 macro는 실제로 잡히며, 공백 macro 우회는 K5로 별도 기록한다. |

## 추가 P3 개선·한계

| ID | 내용 |
|---|---|
| M1 | 기본 --count 10000은 모든 2^n을 덮지 않는다. 전체 스윕 검사는 9×3×2098건을 만들고 CI 100000은 충분하다. 최대 subnormal·NaN/±0 혼합 등 개별 단위 벡터 보강, lossless 오류 변형 퍼즈, civil helper의 수동 task 범위 명확화는 추가 개선이다. 새 X3 경계는 작은 count에서도 고정한다. |
| M2 | hardcoded 프로필의 미래 crate 이동·이름 변경과 일부 CI 텍스트 검사 우회는 완전히 막지 않는다. 현재 실제 job에는 올바른 clippy 인자와 fail-on-error 명령이 있다. X2는 conformance 실행 줄을 정확히 검사하도록 보강했으나 YAML 의미 전체를 증명하는 테스트를 새로 만들지는 않았다. |
| M3 | 보고서는 같은 suite/engines/seed/count를 최신 실행으로 교체하며 kernel ID를 key로 쓰지 않는다. 동시 쓰기·atomic 저장·손상된 이전 entry 진단·독립 역사 보관 개선은 남는다. 이번에는 한 프로세스가 순서대로 갱신했다. |
| M4 | 개발 CLI의 공유 work-dir·컴파일러 버전/플래그 cache key·EPIPE·일부 subprocess timeout·POSIX fixture의 Windows 이식성·매우 긴 fromCharCode 입력의 인자 상한 개선은 남는다. 엔진 batch 파일은 PID를 포함하며 검증은 지정한 작업 폴더를 쓴다. CI는 clean runner와 job timeout을 사용한다. |
| M5 | significant_digits의 이름, malformed/well-formed 테스트 제목, unicodeDiffers/Upgrade JSDoc, ISO 결과의 hex 설명, json 연산 가중치 설명, utf8Of의 문서상 precondition, 미래 TOML table 형태의 formatter 버전 추출 등 문서·진단 개선이 남는다. 비교 0건의 PASS 출력 뒤 exit 2가 되는 경우도 종료 코드를 기준으로 판정해야 한다. |
| M6 | 긴 리터럴 테스트의 메모리, Debug의 전체 직렬화 비용, 넓은 난수 구간의 32비트 entropy·f64 정밀도 때문에 생기는 샘플 격자는 알려진 비용·coverage 한계다. 이를 균일한 전수 검사나 사용자 프레임 성능 측정으로 주장하지 않는다. |
| M7 | QuickJS 개발 호스트의 빈 스크립트·중첩 toString 예외 진단은 더 명확히 할 수 있다. 현재는 실패 후 프로세스가 종료하며 SDK 런타임 상태를 계속 사용하는 경로가 아니다. |

## 검증 근거

기준 환경은 로컬 Node 22.20.0(Unicode 16.0), rustup 1.98.1, 시스템 JSC, 동봉 QuickJS 2026-06-04다. 로컬 의존성 검사는 offline으로 실행했다. 새 외부 모델 요청·태그·레지스트리 배포는 하지 않았다.

| 검사 | 결과 |
|---|---|
| `npm test` | 5,875/5,875, fail·skip 0 |
| `cargo.mjs test --locked --workspace` | 67/67 |
| `cargo.mjs fmt --check`, workspace/all-targets clippy `-D warnings` | 통과 |
| barochart-js Android·wasm32 all-targets clippy | 두 target 모두 통과 |
| check·types·offline package·security:offline·check-bans | 통과, 보안 findings 0 |
| CI 명령: count 100000, v8+quickjs | 800,000건 전부 비교, 커널 불일치 0; 엔진 차이는 해당 플랫폼 방언과 대조 |
| V8 count 300000, all, seed 9 | 2,400,000건 중 2,396,511건 비교, 3,489건 알려진 차이 제외, 불일치 0 |
| 측정 보고서의 영향받은 실행 | V8 round/json/string/date 80만·all 삼각측량 16만·string 삼각측량 20만을 다시 실행해 불일치 0 |
| 추가 독립 실험 | 새 Unicode 글자 4,803개 대조; 긴 수 1만 binary64 중간값 경계 × 세 엔진, 불일치 0; 작은 지수·긴 가수·CRLF probe |

[측정 보고서](rust-js-kernel-conformance.json)의 숫자 포맷 1,600만 건과 number/fixed 삼각측량 20만 건은 계산·생성 로직이 바뀌지 않아 기존 실행을 보존했다. 영향받은 JSON·문자열 실행만 갱신했다. 새로 실행한 수치와 이전 결과를 섞어 전부 이번 실행이라고 주장하지 않는다. Swift·Android SDK 소스는 M0b와 같고 Rust와 아직 링크하지 않으므로 로컬 플랫폼 회귀를 반복하지 않았다. PR CI의 플랫폼 검사는 별도로 확인한다.

새 실행 로그·재현기·반올림 경계 생성기는 로컬 `barochart-reviews/m1a-final/codex-20261103/`에 보관한다. 원문 답변과 큰 scratch 코퍼스는 커밋하지 않는다.
