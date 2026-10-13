# 도형·설정·비동기 결과의 변경 경계

0.2.10에서 웹 Canvas/WebGL2, Apple JavaScriptCore/CoreGraphics와 Android QuickJS/Canvas가 같은 도형 코어를 사용합니다. UI의 선택·도구·축과 저장된 time/raw-price 값은 서로 다른 상태이며, 바인딩 변경을 화면 좌표 값으로 대체하지 않습니다.

## 진행 중인 포인터 작업과 public API

`addDrawing`, `editDrawing`, `deleteDrawing`은 포인터 gesture가 있는 경우 취소 전의 committed snapshot을 기준으로 ID·바인딩·도형·스타일·예산을 먼저 검증합니다. 성공할 수정만 gesture를 조용히 취소한 뒤 별도 이력 한 단계로 적용합니다. 예를 들어 A축의 raw 3000을 편집하던 중 B축의 raw 50으로 public API가 바꾸면, A의 임시 이동을 되돌리고 B50을 적용합니다. 이전 포인터의 후속 move/up/cancel은 B50을 덮어쓰지 않습니다. undo는 원래 A3000, redo는 B50을 복원합니다.

잘못된 binding/points/style/budget은 gesture·임시 위치·포인터·이력을 그대로 둡니다. 없는 ID 또는 locked drawing의 삭제는 false를 반환하고 진행 작업을 취소하지 않습니다. 아직 생성 중인 도형은 committed 도형이 아니므로 `editDrawing`은 거부합니다. 해당 생성 도형의 명시적 삭제는 생성을 취소하고 false를 반환합니다. 이 정책은 API가 소유한 포인터 작업에 적용하며, controller 없이 직접 `DrawingStore.begin()`으로 연 수동 transaction은 기존 grouping을 유지합니다.

`setDrawingTarget`과 `setTool`은 입력을 먼저 검증하고 취소·새 값 적용 뒤 완료 알림 하나를 보냅니다. 도형 API의 취소 중간 상태도 observer에 보내지 않습니다. 완료 알림 안에서 guarded nested API 수정은 이후의 별도 이력 단계로 남습니다. 같은 observer가 무조건 다시 같은 API를 호출하는 무한 재귀를 SDK가 자동 차단하지는 않습니다. 모든 저수준 입력·store 이벤트를 하나의 알림으로 합친다는 계약도 아닙니다.

입력 controller는 도형 ID·type·panel·axisId·seriesId가 gesture 시작 때와 일치하고 transaction과 axis projection이 존재할 때만 좌표를 변환합니다. 저수준 직접 도형 변경으로 binding이 어긋나면 이전 cached axis를 적용하지 않고 gesture를 취소합니다. 입력 시작의 해당 axis projection(left/right/top/bottom/min/max/scale/inverted/base), viewport와 time geometry도 기록합니다. 줌·직접 viewport 변경·resize·데이터로 재투영이 생기면 다음 drawing move에서 gesture를 취소하고 committed anchors를 복원합니다. 새 viewport는 유지합니다. 무관한 시리즈 제거로 해당 projection이 같으면 작업을 유지합니다. 모든 시리즈를 포함한 scene key의 변경만으로 취소하지 않습니다. 저수준 `model`/`DrawingStore` 직접 변경은 facade와 동일한 원자성·알림을 보장하지 않습니다.

## 축·패널·데모 선택

진행 중인 drawing transaction이 참조하는 축의 scale/inverted/padding/range/base/width/side/visible 변경과 관련 패널의 projection 변경은 busy 오류로 거부합니다. 패널 weight는 전체 layout을 움직이므로 transaction 중 변경을 거부합니다. 같은 값과 projection을 바꾸지 않는 설정, 참조하지 않는 별도 축의 range/label/precision 변경은 허용합니다. 미참조 축이라도 width/side/visible 또는 add/remove가 공통 plot margin을 바꾸면 거부합니다. 다른 패널의 axisVisible/axisSide도 공통 여백을 바꿀 때 거부하며 panel 추가는 높이 배치를 바꾸므로 거부합니다. 숨긴 미참조 축의 추가/삭제처럼 실제 여백이 같으면 허용합니다. 잘못된 설정은 먼저 거부되며 input과 model을 손상시키지 않습니다.

축 삭제는 현재 도형·transaction rollback snapshot·undo/redo·시리즈 참조를 모두 확인합니다. 현재 도형을 다른 축으로 옮겼더라도 undo가 필요한 이전 축을 삭제할 수 없습니다. 시리즈 제거는 기존 계약대로 연결 도형을 숨겨 두며, 같은 ID의 시리즈를 복구하면 다시 표시합니다. 없는 시리즈를 참조한 문서 load는 거부합니다. 저장은 gesture를 commit/cancel한 뒤, load는 gesture 밖에서 수행합니다.

웹 및 Apple/Android 비교 데모에서 B 제거는 B가 현재 target일 때 primary fallback을 사용하고, 무관한 C target을 유지합니다. B 복구는 현재 target을 자동 변경하지 않습니다. 명시적 target 선택이 새 도형의 가격 영역을 결정합니다. 웹 renderer 전환은 현재 도구·텍스트·target을 복원하고 툴바 표시와 맞춥니다.

## 비동기 계산·실패·취소

0.2.10의 내부 데이터 처리와 public observer 통지 순서는 [STORE-NOTIFICATIONS.md](STORE-NOTIFICATIONS.md)에 있습니다. 등록 시점과 무관하게 내부 자동 viewport/cache 갱신을 먼저 끝내고 외부 callback의 최신 지정을 보존합니다.

웹 `recomputeInWorker`는 같은 모델에 data/indicator packet을 검증한 뒤 원자적으로 게시합니다. 게시 중 observer가 바꾼 최신 viewport/follow/drawing target은 이전 snapshot으로 다시 덮지 않습니다. 시리즈별 WeakMap generation과 게시 직후 object/index/values/revision을 비교하므로 observer의 setSeriesValues는 같은 borrowed buffer라도 dirty 표시를 유지합니다. 무관한 준비 완료 cache를 다시 dirty로 만들지는 않습니다. stale data/configuration, 잘못된 packet, 사전 abort/timeout은 원본 데이터와 UI를 게시하지 않습니다. 게시가 시작된 뒤 observer의 abort는 이미 확정된 결과를 되돌리지 않습니다.

Apple/Android의 whole-model async handover는 owner UI thread에서 상태를 capture/import하고 새 runtime으로 넘깁니다. active gesture는 UI capture에서 busy로 거부합니다. 포인터 취소와 작업 AbortSignal/cancel은 별도 수명입니다. 입력 취소가 계산 job을 자동 취소한다는 계약은 없습니다. 기존 [prepare 계약](PREPARE-CONTRACT.md), [UI 전송 경계](ASYNC-UI-BOUNDARIES.md), native terminal callback/close 계약을 유지합니다.

`runChartWorker`는 낮은 수준의 packet transport입니다. signal 형태·positive timeout(최대120,000ms)·progress callback을 Worker 할당 전에 검증합니다. 생성·리스너·handler·post 실패와 reply/error/abort/timeout은 한 cleanup 경로를 사용합니다. 리스너 제거가 실패해도 terminate를 시도하며, 원래 작업 오류가 cleanup 오류보다 우선합니다. 작업은 한 번만 settle하고 늦은 reply/progress를 무시합니다. timeout은 `TimeoutError`, 취소는 `AbortError`입니다. 상위 prepare/recompute deadline도 원래 signal 등록을 같은 try/finally 경계에서 수행합니다. 등록 중 예외·동기 abort는 Worker를 만들지 않고 listener 제거를 시도하며 타이머를 정리합니다. commit 직전 signal 제거가 실패하면 게시를 시작하지 않고 원본을 유지합니다. 제거 callback의 동기 재진입이 데이터를 바꾸거나 borrowed series를 교체하면 cleanup 뒤 최종 store identity/version·series configuration 검사가 stale 결과를 거부합니다. 자세한 실패 재현과 수정 검사는 CYCLE10-WORKER-REENTRY.md (not included in this source distribution)에 있습니다. 실패한 signal 구현의 제거 동작 자체를 강제로 성공시킨다는 보장은 없습니다. 실제 Worker thread 종료와 fake transport의 오류 경로 테스트를 검증 문서에서 구분합니다.

## Android bitmap 정책

공유 pool의 policy generation은 budget 변경·memory pressure 때 바뀌고, ownership generation은 admission/release/prune 때 따로 바뀝니다. 다른 View가 bitmap을 가져가거나 반납한 사실만으로 이웃 View의 500ms retry cooldown을 무효화하지 않습니다. retry timer를 만들지 않으며 다음 실제 draw에서 retry를 판단합니다. budget/pressure 변경은 정책을 반영할 다음 draw를 허용합니다. detach/close는 owned bitmap 및 frame token을 해제합니다.

계수는 CPU Bitmap allocationByteCount와 관측한 draw/rebuild/eviction 경계입니다. RenderThread/GPU copies, 전체 RSS/PSS, 물리 기기의 배터리·열·presentation FPS를 뜻하지 않습니다. 이번 실제 호스트 결과 (not included in this source distribution)와 각 플랫폼 raw JSON으로 적용 범위를 확인하세요.
