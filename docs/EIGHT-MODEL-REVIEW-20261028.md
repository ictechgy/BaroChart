BEGIN_CONSENSUS_JSONL
END_CONSENSUS_JSONL

# 2026-10-28 다중 모델 리뷰와 수정

기준 커밋은 `88466199de33b128bf59462c77e05cc7cf206c0e`다. Claude, Grok, Devin, GLM, Qwen, Kimi, DeepSeek에서 총 15개 분할 범위의 응답을 받고, Codex가 코드·계약·실행 테스트로 지적을 다시 확인했다. 확인된 15개 항목을 수정했다. 현재 수정 범위에 남은 확인된 P1/P2는 없다.

이 문서는 **ultra-review with unavailable tracks**다. 외부 모델 전체의 승인이나 전체 저장소의 모든 행을 검토했다는 의미는 아니다. 외부 응답은 수정 전 기준 코드에 대한 것이며 수정 후 외부 모델 재승인은 받지 않았다. 최종 판정은 아래 회귀 검사와 Codex의 독립 재검토에 근거한다.

## 리뷰 범위와 응답 상태

Review-Run-Token: `ultra-review:1fc9af48-9b5c-41f8-be9f-2f360885d222`

각 분할의 파일·원본 행 범위·redacted target SHA-256은 [측정 기록](measurements/eight-model-review-20261028.json)에 남겼다. 준비만 한 분할은 완료 범위에 포함하지 않았다.

| Track | 응답 범위 수 | 범위 | 검증과 판정 |
| --- | ---: | --- | --- |
| Claude | 2 | JS API·interaction, Swift engine | 응답을 확보했다. 출력 계약 검증 실패로 투표에서 제외하고 지적을 독립 검증했다. |
| Codex | 로컬 독립 검토 | 수치 계산, 데이터·Worker, 수명주기, UI, Swift·Java | 재현·회귀 검사와 수정 후 재검토를 수행했다. |
| Antigravity (AGY) | 0 | — | 보호된 adapter가 선택된 로그인 형식을 지원하지 않아 모델 호출 전에 중단됐다. |
| Grok | 2 | Worker 게시, Java engine 전반부 | 출력 계약 또는 인용 검증 실패로 투표에서 제외하고 지적을 독립 검증했다. |
| Devin | 2 | layout 적용·합성 범위, 메인 UI·CSS | 출력 계약 검증 실패로 투표에서 제외하고 지적을 독립 검증했다. |
| GLM | 3 | 데이터 집계, Swift async, Java engine 후반부·workspace job | 출력 계약 또는 인용 검증 실패로 투표에서 제외하고 지적을 독립 검증했다. |
| Qwen | 3 | 지표·params, model·contracts, Android View·budget | model 분할은 출력·인용 검증을 통과했다. 나머지는 독립 검증용 지적으로 취급했다. |
| Kimi | 1 | Canvas chart | 응답을 확보했다. 출력 계약 검증 실패로 투표에서 제외하고 지적을 독립 검증했다. 추가 선택 범위는 로그인 만료로 중단됐다. |
| DeepSeek | 2 | model·contracts, Swift async jobs | model 분할은 출력·인용 검증을 통과했다. Swift 분할은 인용 검증 실패로 독립 검증용 지적으로 취급했다. |

엄격한 외부 출력·인용 검증을 모두 통과한 범위는 Qwen/model과 DeepSeek/model이다. 나머지 응답을 승인표나 합의 분모로 계산하지 않았다. 잘못된 인용·출력 형식을 수정해 과거 응답을 통과시키지 않았으며, 실제 테스트로 확인한 문제만 고쳤다.

## 확인한 수정

P1은 프로세스 중단 또는 Worker 게시 무결성 문제, P2는 계산·원자성·수명주기·UI 동작 오류, P3는 낮은 영향의 경계 일관성 문제다.

| 항목 | 심각도 | 문제와 수정 |
| --- | --- | --- |
| Bollinger rolling 계산 | P2 | `period=2`, `[1e16,1,1,1]`에서 큰 값이 빠진 뒤 중간값 오차가 남았다. 지배적인 표본 제거 시 소실된 통계를 현재 ring으로 재구축하고 `period*mean` overflow를 피한다. 정상 경로의 작업량 상한도 검사한다. |
| CCI rolling 평균 | P2 | 같은 극단값 퇴거 후 rolling 합 오차가 평균·편차에 남았다. 기존 O(period) 편차 계산에 앞서 현재 FIFO 합을 재계산한다. |
| Worker 이벤트 개수 | P1 | 유효한 packet이어도 append/prepend/update 개수가 요청과 다르면 잘못된 알림으로 게시될 수 있었다. 게시 전 길이 차이와 이벤트 timestamp를 대조한다. |
| 데이터 drain 후 종료 | P2 | drain 알림에서 API를 폐기한 뒤 오래된 invalidate가 실행됐다. 커밋된 receipt를 반환하면서 기존 소유권을 확인한 변경 경로를 사용한다. |
| Axis 제거 원자성 | P2 | drawing target 검사·정리 실패 전에 axis가 제거될 수 있었다. 참조·gesture·own data descriptor·소유권을 사전 검사한 후 한 번 게시한다. |
| 폐기 모델의 외부 series 값 | P3 | `setSeriesValues`가 폐기된 모델을 변경했다. 기존 disposed 계약과 같이 거절한다. |
| Canvas fallback 준비 | P2 | 새 Canvas의 2D context 확보 실패 전에 기존 renderer·입력이 해제됐다. context를 먼저 확보하고 재진입·종료·소유권 변경 때 임시 자원을 정리한다. |
| Layout 최종 상태 | P2 | 마지막 cleanup 또는 invalidate 콜백이 배치를 바꿔도 성공으로 반환했다. 마지막 콜백 후 panel 순서·보호 자원·indicator 배치를 다시 대조하고 오래된 작업을 거절한다. |
| 합성 range pin | P2 | 콜백 실패 시 오래된 pin이 남거나 중첩 호출의 새 pin이 삭제될 수 있었다. 실제 자원과 캡처한 pin의 소유권을 비교해 해당 항목만 정리한다. |
| 추가 지표 팔레트 | P2 | `extra-N`을 비수치 값으로 순환해 추가 지표가 같은 색을 사용했다. 안전한 순번과 결정적 fallback으로 3색을 순환하고 사용자 지정 색상을 보존한다. |
| 비활성 버튼 hover | P3 | dark theme hover 규칙이 disabled 표현을 덮었다. 활성 버튼에만 hover 규칙을 적용한다. |
| 빈 aggregate 입력 | P3 | 빈 범위에서는 잘못된 bucket 개수가 검증을 우회했다. 빈 결과 반환 전 양의 정수 개수와 NaN 경계를 검사하며 Infinity clamp는 유지한다. |
| Swift JSON 경계 | P1 | NaN·Infinity·Date 등을 포함한 async 입력이 Foundation 예외로 프로세스를 중단했다. 세 공개 async API에서 JSON 유효성을 먼저 검사하고 고정된 Swift 오류로 반환한다. |
| Java 초기화 정리 | P2 | 초기화 `Error` 또는 asset close 실패 후 native handle이 남을 수 있었다. asset을 닫은 뒤 handle을 만들고, 초기화 실패 시 handle을 먼저 0으로 한 후 해제하며 정리 오류는 suppressed로 보존한다. |
| Java 종료 재진입 | P2 | close 콜백에서 handle이 살아 있는 동안 새 명령을 실행할 수 있었다. 일반 명령은 closing 상태를 거절하며 내부 frame·listener 정리는 허용한다. |

## 제외한 지적

Welford 제거 공식 자체, CCI의 period divisor, 순수 builtin checkpoint 재사용, Worker 종료 대기를 포함한 deadline, indicator 제거 후 주석이 있는 panel 보존, 드로잉 transaction 정책 등은 기존 계약과 실행 결과를 확인해 오탐으로 제외했다. 외부 모델의 제안을 모두 적용하지 않았다.

Java workspace의 임의 제3스레드 취소와 owner queue 거절을 조합한 지적은 재현 가능한 지원 환경의 실패를 입증하지 못했다. 실제 worker 취소·owner queue 복구 검사는 통과했다. 이를 확인된 버그로 세거나 추측에 따라 상태 전이를 변경하지 않았다. 임의 제3스레드의 stale-read stress 검사는 남은 검증 공백이다.

## 실행 근거

- Node 22.20.0: **5,760/5,760**, 실패·취소·skip 0. 604개 ESM 구문 검사, TypeScript 5.9.3 strict 검사, 오프라인 npm tarball·소비자 타입·공개 export 검사 통과.
- Chrome 156.0.8078.48: 분석·layout 128개, customization 54개, GPU 102개, UX 15개 검사 통과. 별도 5개 UI 검사로 추가 지표의 dark/light 3색 순환·테마 왕복·사용자 색상·disabled hover를 확인했다.
- 실제 Swift/JSC 공개 SDK: JSON 경계 110개, layout observer 11개 검사 통과.
- JDK 21: Java lifecycle 5개 시나리오·26개 검사, layout receipt 19개 시나리오·32개 검사 통과. Java 8 bytecode와 warnings-as-errors를 확인했다.
- 로컬 오프라인 AST 검사: 84개 파일에서 지정된 동적 실행·HTML 삽입 규칙의 새 finding 0.

Java lifecycle 검사는 production Java facade를 host JNI fault stub과 test-only Android/JSON fixture로 실행한다. Android SDK/runtime, production JNI/QuickJS, 실기기 실행을 입증하지 않는다. Chrome 측정은 이 Mac의 실행 결과이며 제품 간 성능 우위나 모든 기기 FPS를 뜻하지 않는다. 외부 CVE feed나 전체 interprocedural 보안 분석은 수행하지 않았다.

## 재검증

```sh
npm test
npm run check
npm run check:types
npm run check:package
npm run test:indicator-layout:browser
npm run test:customization:browser
npm run test:gpu
npm run test:ux
npm run check:security:offline
node scripts/test-native-json-inputs.mjs
node scripts/test-native-layout-notifications.mjs
ASTER_JAVA=/path/to/jdk21/bin/java node scripts/check-java-engine-lifecycle.mjs
ASTER_JAVA=/path/to/jdk21/bin/java node scripts/check-java-layout-notifications.mjs
```

## 최종 판정

Final Verdict: APPROVE

판정 범위는 확인된 문제의 수정과 위 로컬 검증이다. 외부 8개 모델의 만장일치 승인으로 해석하지 않는다. 원문 prompt·packet·모델 응답은 저장소에 포함하지 않으며, 최소 범위·hash·검증 요약만 보관한다.
