# M0c 리뷰와 검증

2026-11-03 KST. 구현 기준 `20a604e`, 기반 `abc4db1`. 코드 diff 72,075 B를 GLM·DeepSeek·Qwen에 한 번씩 보냈다. 생성 번들·로컬 로그·HANDOFF는 제외했다. GLM 보호 패킷 preview의 키/secret/home/email/phone 탐지는 모두 0, offline doctor는 launchable이며 키를 읽지 않았다. 본문은 세 모델에 동일하게 주었고 답변을 명령으로 실행하지 않았다. GLM은 기존 전용 Keychain 경로, DeepSeek/Qwen은 기존 safecode pure/plan·GitHub none 경로를 사용했다. 원문·receipt·종료 정보는 로컬 `barochart-reviews/m0c/`에 보관한다.

Codex는 정확성·동등성·보안/수명·성능 관점으로 직접 검토했다. Claude 전용 워크플로나 독립 Claude 4개 실행을 했다고 주장하지 않는다. 외부 답변의 15개 지적 중 Critical·Important 확정은 없고 구현 수정은 필요하지 않았다. 이식 지도 문장 1곳의 시점 표시는 고쳤다.

| 원문 | 판정과 근거 |
|---|---|
| GLM 1 · Important | 기각. `command`의 배열이 잘못 중복된 것이 아니다. Swift `BaroChartEngine.swift:1594,1601`도 `[operation, arguments]`, Java도 `[operation, JSONArray(arguments)]`다. 실제 전송 JSON에는 두 배열이 있다. `nativeEcho(x)`의 `[x]`와 다른 호출을 같은 깊이로 비교한 전제가 틀렸다. JNI의 실제 텍스트 스캔도 같은 64를 적용한다. |
| GLM 2 · Minor | 기각. Android 플랫폼 org.json을 upstream JSON-java의 bean reflection과 혼동했다. SDK36 android.jar의 javap 결과에는 `JSONObject(Object bean)` 생성자가 없고 String/Map/JSONTokener/JSONObject 생성자만 있다. 임의 POJO getter graph를 재귀 인코딩한다는 전제는 이 구현에 적용되지 않는다. |
| GLM 3 · Minor | P3 보류. Java command와 Swift tracing 경로에 중복 깊이 검사가 있다. 첫 검사는 재귀 인코딩 전, 두 번째는 최종 인자 모양/실제 호출을 보호한다. 추가 순회·할당 비용은 실재하나 측정된 사용자 회귀나 잘못된 결과는 제시되지 않았다. |
| GLM 4 · Minor | 기존 의도 확인. 두 호스트의 public pre-encoding 거절은 코어 진입 전이라 코어 호출 trace에 쓰지 않는다. Java의 stop 분기는 JNI 방어 검사까지 도달한 경우에만 사용한다. trace의 바이트 비교는 같은 플랫폼의 전후 비교이며 서로 다른 호스트의 모든 SDK 호출 수를 같게 한다는 계약이 아니다. |
| DeepSeek 1 · Important | 기각. command 첫 문장이 check()이고 close도 owner-thread를 강제한다(`BaroChartEngine.java`의 command/close). 임의 다른 스레드가 정상적으로 dispose하는 race라는 전제가 성립하지 않는다. 인자 사용자 코드가 도중에 엔진을 닫는 재진입은 entry의 closed 우선순위와 별개다. public invoke는 직렬화 뒤 check()도 다시 하므로 폐기된 핸들로 JNI에 들어가지 않는다. |
| DeepSeek 2 · Important | 기각. Java public guard도 callRuntime 전에 던지므로 trace.threw에 들어가지 않는다. 두 public 경로 모두 코어 미진입 호출은 건너뛴다. Node harvest 1,298호출은 cross-platform 호출 수 비교가 아니다. 거절 뒤 writer.begin을 먼저 부르라는 제안은 깊은 host 인코딩을 다시 먼저 실행하게 하므로 채택하지 않았다. |
| DeepSeek 3 · Important | P3로 재분류·보류. 이중 스캔은 동등성 결함이 아닌 비용이다. JNI 실제 UTF-8 검사는 Java 그래프 검사와 보호 지점이 다르다. 값/수명/경계 테스트와 플랫폼 전체 테스트가 통과했으며 새 UI 성능 개선을 주장하지 않는다. |
| DeepSeek 4 · Minor | 기각. 저수준 invoke/command의 JNI 오류는 원래 IllegalStateException의 `Name: message` 형태다. SyntaxError prefix를 기존 BaroChartException.wrap/typed API가 INVALID_ARGUMENT로 분류한다. 검증 테스트도 이 계약을 확인한다. 새 예외 타입·저수준 API 전체 wrapping을 추가하지 않았다. |
| DeepSeek 5 · Minor | P3 coverage 보류. UTF-8과 UTF-16은 구조 ASCII 토큰이 같고 UTF-8 다중 바이트는 0x80 이상이라 bracket/quote 오탐은 없다. 실제 JNI quoted bracket/escaped quote와 64/65/100000 입력을 테스트했다. 더 넓은 Unicode·깨진 escape의 공유 퍼즈는 후속 보강이다. |
| DeepSeek 6 · Minor | 기각. active 객체는 부모만이 아니라 각 Frame.reference가 직접 강하게 보유한다. 완료 캐시는 owner와 withExtendedLifetime을 가진다. 약한 참조만 있다는 전제가 틀렸다. |
| Qwen 1 · Minor | P3 보류. Java 중복 순회·leaf container 높이 메모의 할당 비용은 남는다. 최종 wire 깊이와 Swift 형상에는 맞는다. 측정 없는 최적화와 private fast-path API를 이번 정확성 변경에 섞지 않았다. |
| Qwen 2 · Minor | P3 보류. trace-enabled Swift의 두 번째 검사 비용은 남는다. 바깥 검사는 writer가 깊은 인자를 먼저 재귀 인코딩하지 않게 한다. 기본 꺼짐이며 11개 골든이 같음을 확인했다. |
| Qwen 3 · Minor | 의도 유지. JNI는 파싱 전에 깊이를 검사하므로 파싱 뒤의 16-argument 검사보다 먼저다. Java public invoke는 기존 name/count 검사부터 한다. 여러 조건을 동시에 위반한 private/raw JNI 입력의 우선순위는 이 순서이며 별도 top-level JSON 파서를 추가하지 않았다. |
| Qwen 4 · Minor | 기각. GLM 2와 같은 Android org.json/JSON-java 혼동이다. |
| Qwen 5 · Minor | 문서 수정. §3.9.1의 기존 bare-parse 오류 문단에 명시적인 Pre-M0c baseline 표시와 현재 오류로 대체됐다는 문장을 넣었다. 런타임 코드는 바꾸지 않았다. |

## 검증

- Node `npm test`: 5,884/5,884, skip 0. 깊이 32/33, 10만 층, 문자열·escape·Symbol/string-hint 1회, prototype 변경, 파싱 전 거절·state/ticket 보존을 확인했다.
- Swift: 66/66, ArgDepth 7개 포함. 기존 trace 골든 11개와 바이트 동일. warnings-as-errors build 통과.
- Android: 라이브러리 73/73 + Compose 5/5, failures/errors/skips 0. Java encoding 전 경계·순환·컬렉션, 공유 높이 64/65, 실제 JNI 10만 층/엔진 재사용, core document 세 메시지를 확인했다.
- check·types·offline package·security:offline(findings 0), QuickJS workspace/checkpoints/source/target 전부 통과.
- harvest: 325 traces, 241 withCalls, 1,298 calls, mismatches 0, stopped 293, skipped 1; 69파일 기록 모드 909/909. 중단된 앞부분을 전체 세션 동등성으로 표현하지 않는다.

M0c Task9가 요구하는 플랫폼/Node/QuickJS 게이트를 실행했다. UI·렌더러·회귀 하네스는 바꾸지 않았고 전체 iOS25/Android15 UI runner는 반복하지 않았다. M0b의 이전 결과를 새 M0c UI 성공으로 보고하지 않는다. Swift VM 객체 참조는 값 복사 대상이 아니므로 속성을 검사하지 않는다. 따라서 이 변경은 임의 JS-only VM 객체 그래프 전체의 깊이 상한을 보장하지 않는다. Stage M1b 이후의 인코더·ABI는 자신의 전달 경계를 따로 지켜야 한다.
