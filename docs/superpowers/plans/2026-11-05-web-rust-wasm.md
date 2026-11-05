# 웹 Rust/WASM 구현 계획

정본: [설계](../specs/2026-11-05-web-rust-wasm-design.md). 사용자가 계획과 구현을 승인했다. 웹 W0~W7은 네이티브 M7과 별개다. 모든 단계의 실제 검사/변경/미완료 사항은 ignored web progress에 기록한다. 중간 단계만 마치고 전체 완료로 보고하지 않는다.

## W0 — 기준선과 계약

- 기존 JS API/default를 유지한 채 action → Rust handler/argument/result/revision/event/test 원장을 작성한다. 알려진 이름과 실행 가능한 명령을 구별한다.
- 메인 demo: 시장/봉 수, 지표 추가/params/스타일/제거/배치/패널·축 순서, 도형 전체 도구/manager/이력, 파일/analysis/layout 저장·복원, explorer/readout, stream, renderer/theme/scale, 페이지 수명을 포함한다.
- 완료된 기준 관찰: e530a5f JS main demo100k ready/page errors0. 독립 3지표/5series Canvas DPR1의 탐색 기준선은 artifacts/web-rust-wasm/js-baseline.json에 보존한다. 단일 실행이며 navigation 시간이나 제출 시간을 실제 표시 FPS로 부르지 않는다.

## W1 — production WASM ABI와 브라우저 로더

- 실제 WASM RED 테스트 후 wasm-only F64/packet/capabilities/stats export를 구현한다. scope/owned bytes/alias/성장/해제/poison 규약과 기존14회귀를 검사한다.
- 브라우저용 무손실 codec, Math/Intl host, async module loader, 동기 raw runtime, 명확한 오류/재시도/abort/close를 구현한다. Node 모듈과 trace hashing은 런타임에 넣지 않는다.
- pinned EH release builder, source/import/export/asset provenance, public asset URL helper, MIME/CSP 최소 serving과 packed-browser smoke를 준비한다.
- FFI 변경으로 native source fingerprint가 바뀌면 실제 fresh native/size 검증을 계획에 반영한다. freshness를 완화하거나 옛 수치를 복사하지 않는다.

## W2 — 실제 widget와 초기 아키텍처 실험

- 별도 Rust session/API/view brand와 worker-owned actor를 구현한다. 기존 JS 동기 API와 additive Rust 비동기 API를 구분하고, 작은 표시 스냅샷과 authoritative async 조회/catalog/bulk export를 분리한다.
- pure Canvas/WebGL renderer와 DOM 입력을 연결한다. JS ChartModel/InteractionController를 Rust 경로에 만들지 않는다.
- 실제 drawing widget와 workspace save/load까지 연결한 slice를 만든다. 10k/100k/1m 준비, 여러 지표, pan, params 결과 적용과 old/candidate actor 공존을 먼저 측정한다. activation은 main에서 instance를 이전하지 않고 actor port/generation을 promote한다.
- 큰 main-thread 재계산, worker backlog, 대량 전송과 peak memory가 실제 상호작용에 미치는 영향을 먼저 기록한다. 미검증 동기 소유권을 전제로 broad demo를 포팅하지 않는다.

## W3 — Rust worker 작업과 일관된 게시

- full prepare/workspace는 독립 candidate actor에서 완료하고 promote한다. NativeParams는 SourceBegin/Step → compute Target → active SourceReceive/ArmWrite/Checkpoint/Validate/Prepare/Publish로 결과만 가져온다. worker 엔진 handle은 전송하지 않는다.
- 초기 strict params 검증 뒤 web 전용 좁은 read-set을 구현하고 기존 Native strict 의미를 보존한다. data/config/entry owner 검증, 호환 pan/drawing 보존, source 변경 거절, timeout/abort/progress/terminate, 결과 적용 실패와 close 경쟁을 실제 Worker로 검사한다.
- 고정 outcome record, 재동기화/quarantine, 통지 순서와 중첩 명령, 변이 자동 재시도 금지를 검증한다.

## W4 — 전체 상호작용/조회/이력

- 모든 도형 도구·편집·그룹·style/visibility/lock·undo/redo, pointer/wheel/key/magnet/snap, readout/explorer, resize/DPR, view/follow를 연결한다.
- layout 복합 변경은 Rust의 준비/검증/단일 게시 경계로 실행한다. 미지원 원자성을 JS primitive 호출 묶음으로 가장하지 않는다.
- renderer 교체는 engine 수명과 분리한다. packet 실패는 Rust 표현/명시적 오류로 회복한다. 양쪽 renderer에서 동일 core 결과를 검증한다.

## W5 — 실제 main demo 전체 포팅과 backend 전환

- 공통 demo-session port와 JS/Rust driver를 연결한다. 기존 JS identity 검사를 그대로 두고 Rust helper/driver를 추가한다.
- W0의 모든 기능 행을 닫는다. Rust source 지표의 명시적 unavailable 외에 요구된 demo 흐름을 capability restriction으로 제외하지 않는다.
- gesture/transaction/job safe point, stream/ingestion cut, cursor/counters/paused/error, view/tool/selection 및 drawing/layout history를 양방향 전환에서 보존한다. pending0/paused/nolease 전환 조건과 명시적 drain/cancel 안내를 검사한다. workspace와 generic Native UI migration을 함께 쓰고 ingestion을 중복 load하지 않는다. stale/activation 실패 rollback을 검증한다.
- analysis v1 exact workspace/signed-zero/250k/32MiB 계약, 1m 거절, 파일 취소·실패 시 기존 상태 보존을 검사한다.

## W6 — 패키지와 전체 브라우저 검증

- exports/types/sideEffects/asset/worker URL을 고정한다. JS entry 및 SSR에서 부작용 없는 import를 검사한다.
- offline npm tarball의 실제 production WASM hash/provenance, Vite/esbuild asset·worker 출력과 브라우저 실행을 검사한다.
- main demo 실제 Canvas/WebGL, lifecycle/shared-model/bindings/customization/financial/axes/ingestion/analysis 회귀를 영향 범위대로 실행한다. 기존 trace/golden을 Rust 결과에 맞추지 않는다.
- Chrome 및 사용 가능한 다른 엔진에서 실제 EH/CSP/worker/동작을 기록한다. 설치/전역 automation 설정 변경은 하지 않는다.

## W7 — 성능·네이티브 근거·리뷰·전달

- 설계의 비교 조건으로 JS/Rust 성능·전송 크기·메모리·생성/해제·스트리밍을 기록한다. single-run W0 수치로 기본값 전환을 정당화하지 않는다.
- 현재 native 입력에 맞는 Rust fmt/clippy/bans/header/C11, WASM/SDK 및 fresh size 근거를 확보한다. 동일 바이너리/입력의 기존 실기기 검사는 근거를 명시해 재사용하고, 변경된 실행 경로는 재검증한다.
- 독립 리뷰 지적을 재현·판정하고 고친 뒤 전체 필수 CI를 통과시킨다. 정확한 검증 head로 PR/merge하고 HANDOFF를 갱신한다. 공개 태그/registry upload는 하지 않는다.

## 실행 검사

기존 명령은 Node22, TSC_PATH, BAROCHART_NODE, CARGO_INCREMENTAL0을 사용한다. 신규 entry point는 구현 뒤 실제 flags/output/exit 조건을 문서화한다.

```sh
node scripts/rust/build-web-wasm.mjs --offline
node --test test/rust-web-wasm-abi.test.mjs test/web-wasm-runtime.test.mjs
REQUIRE_WASM=1 node --test test/rust-wasm-harness.test.mjs test/rust-core-conformance.test.mjs test/rust-aggregate-wasm.test.mjs test/rust-api-regressions.test.mjs
node scripts/check.mjs
node scripts/check-types.mjs
node scripts/verify-npm.mjs
node scripts/test-package-consumers.mjs --browser
npm run test:wasm:browser
node test/web-bootstrap-failures-browser.mjs
npm run test:wasm:package -- --tools-dir <local-verification-tools>
npm run bench:wasm
```

신규 브라우저/worker/demo/benchmark 검사는 실제 구현한 명령과 소유 로컬 서버/브라우저를 사용한다. 준비되지 않은 검사를 통과로 표시하거나 필수 검사를 조용히 생략하지 않는다.
