# 웹 Rust/WASM 선택형 코어 설계

상태: 선택형 프리뷰 구현 계약. 사용자는 2026-11-05 웹 코어 통일 방향을 검토한 뒤 계획과 구현을 승인했다. 이 문서는 기존 네이티브 설계의 웹 제외 범위를 새 단계로 확장한다. 웹·네이티브의 JS 기본값과 네이티브 M7 실기기/수동 게이트는 유지한다. 현재 통합 방법과 실제 검증 범위는 [웹 가이드](../../WEB-RUST-WASM.md)에 기록한다.

## 1. 완료 범위

Rust가 데이터·지표·모델·도형/이력·입력 제어·장면·워크스페이스의 유일한 실행 상태를 소유한다. JS/TS는 DOM, 접근성, 입력 전달, Canvas/WebGL 제출, 제어판의 미적용 초안과 표시 스냅샷을 맡는다. JS ChartModel을 함께 계산하는 이중 코어는 Rust 경로가 아니다.

기존 JS 클래스/동기 API/worker exports와 기본값은 보존한다. 새 `barochart/wasm` 진입점의 고수준 API는 명시적으로 비동기다. Rust 엔진은 Worker actor 안에 계속 있으며, DOM/렌더러는 revision이 붙은 표시 결과를 받는다. 동기 raw runtime은 actor 내부 경계다. 실제 메인 데모의 기존 기능을 모두 연결해야 완료다. 로더 또는 작은 캔들 예제만으로 완료를 주장하지 않는다.

JS source 지표는 기존 JS 백엔드에서 계속 지원한다. Rust에서는 기존 `JAVASCRIPT_BACKEND_REQUIRED` 계약으로 거절한다. 이 제한을 이유로 메인 데모의 built-in/static 지표나 다른 필수 기능을 생략할 수 없다.

## 2. 소유권과 API

- 컴파일한 WebAssembly.Module만 공유할 수 있다. 각 세션은 별도 instance, memory, Rust engine, host context를 소유한다.
- `loadRustBackend(options)`는 로드/컴파일을 비동기로 끝낸 backend factory다. `await backend.createSession(options)`로 actor를 만든다. 명령·authoritative 조회·준비/복원은 Promise를 반환한다. 동기 `snapshot()`은 마지막으로 게시된 불변 표시 값일 뿐 live core 조회가 아니다.
- `await createRustChart(container, session, options)`는 표시/입력 host와 첫 유효 frame을 준비한다. 세션과 view의 수명은 별도이며 view 파괴는 기본적으로 세션을 파괴하지 않는다. 한 Rust 세션에는 활성 view 한 개만 허용하고 두 번째 연결을 명시적으로 거절한다. 기존 JS shared-model 동작은 바꾸지 않는다.
- Rust API는 별도 타입/brand를 갖는다. ChartModel/ChartAPI prototype을 흉내 내거나 기존 JS identity 검사를 완화하지 않는다. 기존 workspace/widget 함수에는 실제 driver overload를 추가하거나 별도 Rust adapter를 쓴다.
- store/indicator/drawing 배열의 외부 직접 변경은 Rust API가 아니다. 읽기 전용 표시 스냅샷과 명령을 제공한다. 대량 열/지표 값은 명시적 소유 Float64 export이며 hot-path 스냅샷에 넣지 않는다.

| 표면 | 계약 |
| --- | --- |
| 데이터 | reset/setColumns/append/upsert/events, ingestion 정책·큐·통계·저장/복원. 기존 검증/오류와 Source 순서를 Rust에서 실행한다. |
| 모델 | panels/axes/series, theme/symbol, viewport/follow. 명령 후 Rust가 검증한 표시 결과를 게시한다. |
| 지표 | built-in/static module, 추가/제거/params/배치, 소유 Float64 조회. source 등록은 명시적 unavailable다. |
| 도형/입력 | 모든 노출 도구, pointer/wheel/key, magnet/snap, selection, undo/redo, 스타일·그룹·import/export. JS controller를 생성하지 않는다. |
| 조회 | 작은 UI 상태, 별도 구성 catalog, 도형 목록/선택, bounded dataAt/readout, 별도 scene/packet, 명시적 bulk export로 나눈다. |
| 저장 | 기존 workspace/drawing/analysis 형식. analysis v1의 exact workspace text, signed zero, 250k bars/32MiB 제한을 보존한다. 1m 분석 저장 거절도 검사한다. |
| 수명 | subscribe/unsubscribe, close/dispose, attached view와 Worker 정리. 종료 후 모든 조작은 명시된 closed 오류다. |

실제 action → 실행 handler → 입력/결과 → revision/write-set → 테스트 원장을 구현 전에 채운다. `supports()`는 알려진 이름 판정이므로 기능 가용성 게이트로 쓰지 않는다. 버전 handshake는 ABI/패킷/체크포인트/static module 및 실제 실행 가능한 표를 확인한다.

## 3. 전송 경계

기존 6개 WASM export를 보존하고 WASM 전용 byte/F64/packet/capability API를 더한다. unsafe는 barochart-ffi 안에만 둔다. BcBuf는 wasm32의 little-endian u32 세 개이며, 출력은 8-byte 정렬과 len=cap, `bc_free(pointer,cap)` 한 번 해제를 따른다. native Vec/F64 해제 규약을 임의로 재사용하지 않는다.

Float64 출력은 raw little-endian 비트이며 NaN payload와 -0을 보존한다. 입력은 호스트 소유 bc_alloc 영역에서 복사한다. pointer 범위·정렬·길이 곱셈·alias를 확인한다. memory.grow 가능 호출/할당 뒤 모든 view를 다시 만든다. 공개 결과에 빌린 WASM view를 넘기지 않는다.

W1 export는 `bc_web_abi_version`, `bc_web_capabilities`, `bc_web_read_f64`, `bc_web_write_f64`, `bc_web_packet`, `bc_web_memory_stats`다. write 성공 여부는 미리 할당한 u32 output에 기록한다. 성공 후 boolean 응답을 새로 할당하지 않는다. packet은 Rust metadata와 숫자 byte output을 각각 소유한다. packet 용량 초과는 같은 Rust의 제한된 JSON 장면 또는 명시적인 capacity 오류로 처리한다.

브라우저 wire codec은 Node fs/crypto/os/vm을 import하지 않는다. 무손실 scalar codec과 trace 전용 F64 hashing을 분리하며 기존 trace 결과를 보존한다. 수학/Intl import는 같은 브라우저의 Math/Intl을 쓴다. core 차분은 float 비트·문서 키/순서·오류를 exact 비교한다. GPU 화면 픽셀의 기존 시각 비교 방식과 core 동등성을 혼동하지 않는다.

## 4. 호출 결과와 표시 게시

호스트는 명령 전에 고정된 outcome record와 단조 command ID를 준비한다. ID는 호스트 내부 값이며 재사용/사용자 지정하지 않는다. 안전한 정수 범위를 소진하면 명령을 거절하고 명시적 새 세션을 요구한다. 입력은 호출 전에 소유 인코딩을 마친다.

Rust call 반환 status를 기록한 뒤 소유 응답을 읽고 해제한다. 변이 후 decoding/표시 설치 실패가 생겨도 명령을 자동 재실행하지 않는다. 작은 authoritative Rust 표시 조회로 재동기화하기 전에는 새 변이를 막는다. 재동기화 실패, panic/poison 또는 trap은 해당 세션을 quarantine한다. 정상 panic은 기존 상태4/다음 호출4/host release1회를 보존한다. 임의 trap에서 Rust destructor 실행을 보장했다고 주장하지 않는다.

한 transaction의 표시 스냅샷은 불변이고 revision 일관성을 갖는다. FFI busy guard를 푼 뒤 통지한다. 중첩 명령의 통지는 현재 통지 묶음 뒤에 순서대로 배달한다. listener 오류를 다른 listener/소유권 정리 실패로 확장하지 않는다. unsubscribe/dispose 중 배달, 재진입, 오래된 이벤트 거절을 검사한다.

## 5. 작업/전환의 일관된 cut

메타데이터는 data, indicator/configuration, drawings/history, presentation/controller, ingestion의 구분된 stamp를 갖는다. 새 host의 모든 변이 진입점은 portable epoch를 보수적으로 전진시킨다. UI의 미적용 초안은 core 변이가 아니다.

기존 Rust NativeParams/Prepare/Workspace 단계와 실제 Swift SDK 흐름을 구분해 포팅한다. full prepare/workspace는 다른 Worker의 engine handle을 main으로 가져오지 않는다. candidate Worker가 자신의 instance에서 끝까지 준비하고, 성공하면 메인 facade의 actor port/generation을 교체한다. 큰 복사/검증/이력 순회는 promotion 전에 끝낸다. JS target은 실제 JS prepare/hydration 경로로 메인 JS 모델을 만들며 JS 객체를 Worker에서 이전했다고 주장하지 않는다.

params는 active actor의 `nativeParamsSourceBegin/Step` → compute actor의 TargetCreate/buffers/Start/Step/Descriptor/Checkpoint → active actor의 SourceReceive/ArmWrite/SourceCheckpoint/Validate/Prepare/Publish 흐름을 쓴다. changed-params candidate에 old Native UI를 덮는 방식은 사용하지 않는다. UI binding이 params/outputs/offset까지 exact 비교하므로 실제로 거절되기 때문이다.

현재 NativeParams의 strict fingerprint는 pan 등도 stale로 만든다. 초기 protocol 검증에서는 모든 변이를 fence한다. main demo UX를 닫기 전에는 별도 web params read-set을 구현해 data identity/version/capacity, 관련 symbol/calendar/formatter, registry/entry/params, indicator/output/value binding와 cache만 고정한다. view/follow/theme/drawing/history/controller 변경은 보존한다. 기존 네이티브 strict 프로토콜 의미는 바꾸지 않는다.

| 작업 | 읽는 상태 | 게시/보존 |
| --- | --- | --- |
| 초기/데이터 준비 | 요청 데이터·구성·세션 generation | 독립 candidate actor. 성공 전 active session 불변 |
| params | 명시한 web 데이터/지표 read-set | active actor에 출력/params만 게시. 좁은 read-set 구현·검증 뒤 호환 pan·선택·도형 상태 보존 |
| workspace/analysis | 불변 문서와 source binding, 요청 owner | 기존 파일/상한/정확성 검증 후 candidate 교체. 중간 owner 변경은 stale |
| backend 전환 | portable 상태 전체와 ingestion 상태 | 양방향 보존/rollback. 실제 Source 형식의 pending/cursor/generation/counters/error/paused 상태 포함 |

전환 때 합성 stream을 멈추고 새 변이 입력을 fence한다. lease 없음, ingestion paused, pending 0을 safe point로 요구한다. 현재 target이 pending ingestion을 거절하므로, pending이 있으면 명시적 drain/cancel 전까지 전환을 거절한다. 자동 drain/cancel로 데이터를 버리지 않는다. policy/cursor/generation/counters/lastError/원래 paused 상태는 canonical ingestion 문서로 보존한다. ingestion load는 workspace/UI 한 경로만 소유하고 다른 경로는 exact 일치만 확인한다. timeout/실패 시 old owner와 stream intent를 복구하며 조용한 재시도를 반복하지 않는다.

실행 중 gesture, pointer capture, drawing/layout transaction 또는 recomputation이 있으면 backend 전환을 거절하고 먼저 종료/취소하도록 명시한다. renderer 변경은 backend 변경과 별도이며 기존 JS의 입력 취소 규칙을 보존한다.

backend 전환은 workspace source/target의 data/bindings/checkpoints 전송과 Native UI history/controller 전송을 함께 쓴다. workspace만 쓰면 drawing history/selection/serial이 초기화된다. correction ticket 전용 UI capture/import를 workspace migration ticket용으로 일반화하고 exact indicator binding 검사는 그대로 둔다.

candidate는 실제 크기/DPR의 비활성 DOM/접근성 host에서 복원과 첫 frame 검증을 마친다. commit 직전 workspace/UI source check를 다시 통과해야 한다. 메인 facade의 active actor port/generation과 DOM owner를 교체하며, activation 실패 시 old owner를 되살린다. old actor 폐기는 성공 acknowledgment 뒤다. stream intent와 사용자 원래 paused 상태를 복원한다.

## 6. 브라우저/배포/성능

새 entry import는 SSR 안전하고, 요청 전 WASM을 fetch하지 않는다. 기존 JS entry는 WASM을 로드하지 않는다. asset은 typed JS URL helper와 패키지 안의 `.wasm` 파일로 배포한다. module worker는 literal URL과 명시적 override를 지원한다.

공개 서버는 `application/wasm`과 좁은 CSP `wasm-unsafe-eval`만 더하고 host/method/path/realpath 제한을 유지한다. artifacts/도구/서명 자료는 공개하지 않는다. 실제 packed asset/worker를 Vite 및 명시적 esbuild 설정에서 실행한다. 새 runtime dependency를 추가하지 않는다.

현재 Rust std의 정상 unwind를 위해 pinned 소스와 std/panic_unwind를 재빌드한다. abort std를 웹 출하물로 쓰지 않는다. 실제 EH 지원은 설치된 브라우저에서 검증한다. 미설치/자동화 차단 엔진은 unavailable로 기록하고 통과 수에 넣지 않는다.

첫 widget/workspace slice에서 큰 데이터·여러 지표·pan·params 적용·old/candidate actor 공존을 측정한다. 메인 thread에 큰 데이터/이력 재계산을 넣지 않는다. 처리 backlog와 input-to-frame 지연, worker export/import, promotion, 메모리 peak도 측정한다. 기본값 전환은 이번 완료 조건이 아니다.

10k/100k/1m(지원되는 준비 범위)과 실제 demo workload, cold/warm/순서 교차, 최소 warmup10+측정100, 반복3회로 fetch/compile/instantiate/init/첫 표시, 동기 제출과 input-to-frame p50/p95, 긴 작업, 메모리 및 raw/gzip/Brotli bytes를 구분한다. 강제 GC나 전역 설정 변경 없이 측정하고 unavailable 메모리 지표를 명시한다. 네이티브 5MiB를 웹 예산으로 가져오지 않는다.

## 7. 근거와 검토

- [MDN instantiateStreaming](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/instantiateStreaming_static): streaming과 MIME 계약.
- [MDN script-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src): WASM만 허용하는 CSP 구분.
- [Rust wasm target](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html): std unwind와 EH 빌드 제약. 프로젝트는 실제 고정 툴체인/소스/검사로 검증한다.
- [Tradoor](https://github.com/rsalianto/tradoor)는 Rust/WASM Worker 금융 차트의 참고 사례다. 이 저장소의 성능/시장 성공을 검증했다고 주장하지 않는다.

Ralplan 3회 검토의 migration cut, 결과 불확실성, activation 비용, 기존 JS identity, ingress 보존, view 수명, hot-path 상한 지적을 위 계약으로 구체화한다. W1의 독립 ABI/로더 기반부터 구현하며, 큰 UI 포팅 전 실제 widget/workspace/worker 실험으로 남은 가정을 닫는다. 계획 초안의 일반 float tolerance 문구는 적용하지 않는다.
