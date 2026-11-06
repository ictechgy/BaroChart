# 전체 제품 8개 모델 리뷰와 수정 — 2026-11-07

기준 커밋은 `bd78d278ff0c6b9cbd1f151b7696fb027cf84fe3`이며 실행 식별자는 `full-eight-578d63369e74`이다. JavaScript 모델·데이터·비동기 작업, Rust 코어·FFI·캐시, 도형·WebGL, Swift·Android 호스트, React·접근성, 패키지·CSP·CI를 파일 묶음으로 나눠 검토했다. 큰 Rust 파일은 연결된 의미 단위로 범위를 정했다.

## 모델 실행 결과

| 모델 | 실제 실행 결과 | 반영 기준 |
| --- | --- | --- |
| Claude | 주간 한도로 본문 미수신 | 재시도·계정/모델 변경 없이 종료 |
| Codex | 독립 영역 리뷰와 수정 후 재검토 완료 | 소스·재현·회귀 테스트로 판정 |
| AGY | 보호된 실행 경로에서 로그인 형식 오류 | 모델 실행 전 종료, 우회 없음 |
| Grok | 최초와 축소한 한 번의 재시도 모두 시간 초과 | 본문 미수신 |
| Devin | 입력/비동기와 워커 작업 2개 응답 수신 | 개별 주장을 Codex가 검증 |
| GLM | 지표와 장면/캐시 2개 응답 수신 | 개별 주장을 Codex가 검증 |
| DeepSeek | 보호된 MAIN/SUB 경로로 FFI/WASM 응답 수신 | 두 주장을 소스 계약과 대조 |
| Qwen | Swift와 Android 2개 응답 수신 | 호스트 수명·실패 경로를 대조 |

외부 본문의 scope/hash 위치, 일부 confidence/category 표기와 인용 형식은 공용 구조 검증을 통과하지 못했다. 패킷 수집기의 line-range 헤더도 공용 인용 파서와 호환되지 않았다. 원문과 검증 실패를 보관하고, 응답을 결함 탐색의 단서로 사용했다. 모델 간 찬반 점수나 전원 승인 결론을 산출하지 않았다. 최종 채택은 독립적인 코드 확인과 실행 증거에 근거한다.

## 확정한 수정

| 영역 | 문제와 수정 | 회귀 근거 |
| --- | --- | --- |
| Rust 모델 게시 | 실제로 유지한 series 벡터의 메모리 lease를 유지하고, 미리 준비한 identity를 게시 단계에서 이동 | `native_ui_tests` |
| Rust 캐시 | 음수/소수 incremental 시작을 JS와 같은 bounds 오류로 거부하고, mutable resolver 전의 실제 base/drawing 상태에 캐시 키를 연결 | `series_cache_memory`, `frame_cache` |
| 타원 선택 | 긴 타원 내부에서 윤곽과 먼 점이 선택되는 오류를 JS/Rust의 실제 Euclidean 윤곽 거리로 수정 | 독립 샘플 기준과 실제 hit-test 경로 |
| WebGL | 생성 중 실패 시 부분 자원을 정리하고, context loss 뒤 직접 render를 명확히 실패 처리 | 자원 예산·fallback 수명·실제 GPU 브라우저 |
| 데이터 입력 | null/undefined/접근자 예외를 안전하게 감싸고, prepend의 처음 승인한 행 수와 복사한 값을 게시 전에 검증 | `ingestion`, `set-data-count` |
| 워커 | 잘못된 응답과 messageerror를 즉시 거부하고 종료. 선택적 messageerror 기능으로 기존 sealed 커스텀 어댑터 호환 유지 | `worker-cleanup`, `calculation-worker-envelope` |
| 모델 옵션 | getter 재진입 뒤 패널·축·시리즈 및 지표/데이터 소유권을 재검증해 중복·고아·비정렬 시리즈 게시 차단 | `model-add-reentry` |
| React | controlled prop 비교 중 getter/reflection 예외를 onError로 전달하고 같은 거부의 반복 보고 억제 | `react-interaction-options`, 초기화 재시도 |
| 메인 웹 데모 | 시작용 저장 배치를 시장 전환 때 다시 적용해 journal 설정을 덮는 경로를 차단. 배치 undo는 UI 작업 완료 후 진행 | 실제 WASM에서 다른 저장 지표 값으로 RED/GREEN, CPU 4배 제한·UTC 재검증 |
| 네이티브 도구 | 직접 Swift 컴파일에 백엔드 타입 파일을 포함하고 비 SwiftPM 분기의 리소스 URL 참조를 수정 | 실제 CLI 빌드·8개 기능 모드·일반/닫힌 입력 링 |

성공한 내부 재진입 변경은 유지하고 오래된 바깥 작업의 게시를 취소한다. 잘못된 최초 React 구성은 기존처럼 초기화를 실패시키고, 유효한 구성으로 바뀌면 재시도한다.

## 채택하지 않은 주요 주장

- WASM 출력은 별도 transport buffer 소유권과 수명 계수로 관리된다. packet의 숫자 상한 8,388,608과 chunked F64 전송 상한 262,144는 서로 다른 계약이다.
- Swift의 빌린 포인터는 FFI 호출 중 동기 복사하며, 최적화 빌드의 precondition과 64비트 NSNumber 경로에 대한 주장도 확인되지 않았다.
- 중복 JSON 키는 생성자가 마지막 값으로 처리하고 precision은 입력에서 0~18로 검증한다. GLM의 underflow/panic 주장은 해당 분기 전에 수행하는 범위 검사로 반박됐다.
- 워커 commit은 타이머와 abort listener를 먼저 해제한다. 이미 멱등적인 release, 외부로 노출되지 않는 내부 계산 context, 보장하지 않은 mutable-column 입력을 결함으로 확대하지 않았다.

## 검증

최종 실행 결과와 바이너리 출처는 아래 측정 문서에 연결한다. 배포용 WASM은 현재 Rust 소스에서 EH/unwind 설정으로 다시 빌드하고 개인정보 경로·ABI·hash를 검사했다. 네이티브 번들 변경은 고정된 103개 JS 호출과 대조했으며 기대 결과·인수·oracleCommit은 유지했다.

- [고정 JS 기준 대조](measurements/core-bundle-compatibility.json)
- [현재 소스 SDK 크기](measurements/rust-core-size.json)
- [WASM 측정](measurements/web-rust-wasm.json)

로컬 Node 6,216개(실패·skip 0), Rust 650개(실패 0, 기존 대용량 수동 테스트 2개 ignore), 모듈·타입·C 헤더/C11·fmt·clippy·금지 패턴 검사를 통과했다. 실제 Chrome의 WASM 8개 프로그램과 bootstrap 실패 경로, GPU·레이어·UX·API·React·커스터마이징·지표 레이아웃을 확인했다. React 19 실제 런타임은 59개 시나리오/1,924개 assertion과 Worker 14/14 종료를 통과했다. 고정 React 18 브라우저 의존성은 오프라인 캐시에 없어 해당 실행은 제외했다.

새 SDK 크기 행렬의 출하용 듀얼 합계는 arm64 4,461,390 B, x86_64 5,106,606 B로 각각 5,242,880 B 이내다. 원본 WASM은 3,325,956 B이며 gzip 1,046,003 B/Brotli 783,587 B다. 실제 tarball의 Vite와 esbuild 빌드·브라우저 실행도 통과했다. 성능은 cold 18개/warm 36개/parity 9개를 새로 측정했다. 10,000개 행의 6개 OHLCV 필드 60,000값을 전체 대조했고 Worker 36/36, 모델 9/9, 양쪽 차트 각각 18/18이 종료됐다. 측정은 SDK 파이프라인 범위이며 표시 FPS나 Rust의 일반적 우월성을 주장하지 않는다. 첫 CI80은 네이티브 네 작업 성공 후 웹 데모의 시장 journal 비교에서 실패했다. 저장 배치(지표 period 9)가 journal(period 5)을 덮는 경로를 로컬에서 재현해 시작 시 1회 복원으로 수정했다. 전체 설정 비교와 시작 배치의 실제 지표/시리즈/축 복원 검사를 유지·강화했고, 해당 드라이버 21개 및 실제 브라우저의 정상/CPU 4배 제한 실행이 통과했다. 라이브러리·Rust·자산·SDK 및 성능 워크로드 입력은 동일해 앞선 검증을 재사용한다. 수정 후 PR의 다섯 필수 CI 작업을 새 head에서 다시 확인한다. Android 실기기 성능/장시간 soak 및 수동 VoiceOver/TalkBack 게이트는 기존 별도 항목으로 유지한다. 기본 백엔드와 5 MiB 듀얼 SDK 예산은 기존 결정을 따른다.
