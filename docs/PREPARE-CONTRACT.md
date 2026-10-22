# 0.2.4 native 준비·운영 검증 계약

0.2.3 ZIP을 baseline으로 보존합니다. 선택형 prepare API는 현재 owner-main engine의 데이터와 builtin 구성을 별도 VM/runtime에서 준비하고, worker가 종료한 뒤 성공한 context만 원자적으로 전달합니다. 기존 sync API를 유지합니다. 초기 0봉 engine + 필요한 builtin/panel/series 설정은 작은 owner 작업이고, 1m generation·OHLCV 검증·index·indicator 계산을 background로 옮깁니다.

## 입력과 상태

production 입력은 immutable-owned AsterColumns(6 Double arrays)입니다. Swift는 value/COW snapshot; Android copyOf는 private 배열로 복사하며 복사 비용은 별도 측정하고 calling thread 계약을 명시합니다. 입력 배열을 JSON 숫자 배열로 전송하지 않습니다. demo/benchmark seeded 준비는 별도 convenience이고 실제 시장 feed가 아닙니다. borrowed general-series values와 custom factory의 native async 이전은 이번 API에서 지원하지 않습니다. 기존 sync 등록은 유지하고 새 임의 source-string eval 전송을 추가하지 않습니다.

engine별 max1 active async 작업을 기존 정책(Apple busy / Android supersede)으로 유지합니다. source model/store identity·data version·factory/시리즈 binding이 변경되면 stale입니다. 초기 준비는 source 출력/checkpoint를 빌리지 않으므로 의미를 바꾸지 않는 cached 지표 조회는 허용합니다. correction snapshot의 computed revision 고정은 유지합니다. latest UI theme/panels/styles/symbol/drawing history/selection/tool/size를 merge합니다. 활성 gesture 또는 unsupported formatter callback은 성공 context를 설치하지 않습니다. source follow=true이면 새 데이터 마지막 visibleBars(기본200), follow=false면 source의 현재 view를 보존합니다.

## 공통 JS protocol

* nativePrepareBegin(requestJSON): source ticket/metadataJSON, buffers:[],checkpoints:[] 반환. 요청 {kind:'columns',length,visibleBars?} 또는 {kind:'seeded',count,seed?:42,visibleBars?}. 기존 source typed arrays/outputs/checkpoints를 복사하지 않습니다.
* nativePrepareCreate(metadataJSON): isolated target에 신규6 Float64 columns/capacity 할당. slot0..5=time/open/high/low/close/volume. host는 columns 모드에서 length개만 offset0부터 sequential하게 복사합니다. seeded 모드에서 host 복사는 없습니다.
* nativeAsyncTargetBuffer(slot,offset,count): 공통 target helper. native host에서 정확한 type/length/offset 검사 후 max262144 Doubles(2MiB) 복사.
* nativeAsyncStart(): 전달 완전성 검사, 이후 background phase 준비. source/worker 모델은 독립 소유입니다.
* nativeAsyncStep(maxBars=4096): JSON progress {phase:'generate'|'validate'|'store-index'|'calculate'|'indices'|'ready',done,total,complete}. seed generator는 기존seededColumns와 bit-exact. 검증/트리/계산은 취소 가능한 step 경계로 나눕니다.
* nativeAsyncFinish(latestUIJSON): ready 상태와 요청 binding을 검증해 새 model/API/Input을 설치할 준비. 오류는 원본을 덮어쓰지 않습니다. 기존 sourceCheck/UI/Release helper를 공유합니다.

`nativePrepareCreate`는 정적으로 연결된 지표 factory를 호출하는 정의 검증 전에 target admission을 예약합니다. 생성 중에는 prepare/correction/workspace/params의 네 Create entrypoint가 모두 `Async target busy`로 거부됩니다. 생성자가 실패하면 `finally`에서 예약을 해제하므로 재시도할 수 있고, workspace/params 전용 Dispose는 이 예약을 취소하지 않습니다. 기존 prepare/correction의 live-runtime admission과 buffer/step/finish 동작은 유지합니다.

legacy prepare에는 별도 JS bridge Dispose API가 없습니다. 취소는 기존 host job flag, 협력형 중단 확인, worker runtime 정리 계약을 따릅니다. 이 생성 예약의 VM·독립 QuickJS 회귀 검사는 host 취소 flag나 Swift/Android runtime retirement를 검증하지 않습니다. 정적으로 연결한 신뢰된 factory의 재진입을 다루며, 입력 문서로 임의 코드를 실행하는 기능을 추가하지 않습니다.

0.2.4 host 작업은 위 단일 문자열 UI 경로 대신 분할 전송을 씁니다. `nativeAsyncUIBegin(ticket)`는 도형 점이 없는 설정/header와 current/undo/redo frameCounts를 반환합니다. `nativeAsyncUINext(ticket)`는 최대64 references·새2048점·262144 UTF-16 chars의 chunk를 반환하고 immutable 도형 객체를 중복 전송하지 않습니다. freehand 한 개는 기존 계약대로 최대2048점입니다. 각 host는 UTF-8 1MiB 상한도 확인합니다. target worker의 `nativeAsyncUIImportBegin/Chunk/End`가 도형·history를 검사/복원하며 aggregate checkpoint parser에 전체 문서를 넣지 않습니다. worker가 멈춘 뒤 owner `nativeAsyncUICheck(ticket)`로 캡처 중 UI 변경을 확인하고 `nativeAsyncFinish('')`가 검증된 result를 설치합니다. UI가 전송 중 바뀌었으면 stale로 원본을 유지합니다. 계산 중 UI 변경은 전송 시작 시 최신 상태로 반영합니다.

기존 internal `nativeAsyncUI`/one-string codec는 작은 fixture·저수준 호환용으로 남아 있으며 큰 문서 전송 경로가 아닙니다. UI JSON의 총 크기, chunk 최대치, owner capture와 worker import 시간을 별도로 기록합니다. 소유권이 있는 UI 참조는 모든 terminal 경로에서 source ticket과 함께 해제합니다. 큰 문서를 그리는 scene/renderer와 동기 save/inspect의 비용까지 분할하는 기능은 아닙니다.

callback·progress는 owner main queue/Handler이며 cancel은 thread-safe입니다. close/deinit/recreate/timeout/worker·parse·copy·compute·finish 오류/동시 요청의 exactly-once 결과와 cleanup을 검사합니다. 실행 중인 VM을 강제로 free하지 않습니다. chunk/JSON parse/native allocator의 hard latency 상한을 주장하지 않습니다.

설치 시 source가 보관한 입력 종류·길이·seed·visibleBars·store options·다음 version/timeVersion·output budget을 target metadata와 대조합니다. 같은 지표 정의를 가진 다른 요청 결과도 거부합니다. `setSymbol`이 등록한 고정 가격/시간 formatter만 새 VM에서 복원합니다. symbol이 있어도 그 뒤 임의 formatter로 덮어쓰면 설치를 거부합니다. 사용하지 않는 registry custom factory는 옮기지 않습니다. 계산에 사용한 factory는 canonical builtin 또는 양쪽에 같은 버전/codec으로 정적으로 연결한 [사용자 모듈](INDICATOR-MODULES.md)이어야 하며 기존 임의 factory/source는 거부합니다.

데이터는 최대4,194,304봉이며 source `maxBars`도 적용합니다. 지표 출력은 engine output budget, 신규 raw/store/output typed arrays는768MiB 사전 한도를 검사합니다. 이 사전 한도는 모든 JS object/checkpoint/index/host/기존 source 메모리를 포함하지 않습니다. 실제 runtime 한도·할당 실패로 지원 가능한 조합이 더 작을 수 있으며 실패 시 source를 유지합니다.

Swift `close()`는 원래 owner에서만 호출하고 반복 호출은 허용합니다. active job을 중단하고 설치된 전용 creation-thread run loop를 retire하며 observer/error callback을 해제합니다. nonoptional 공개 `context`는 닫힌 engine을 보관하는 동안 남으므로 VM 메모리 전체를 즉시 반환하는 API로 해석하지 않습니다. raw context/JSValue 사용은 close 이후 지원하지 않습니다. Android는 owner `close()`에서 source native handle을 free하며 진행 중 worker는 협력형 중단 뒤 자신의 handle을 정리합니다.

## 측정 및 soak

cold fresh-process 초기 준비를 phase로 나눠 0.2.3과비교합니다. immutable input copy도 따로 기록하고 measured 구간을 명시합니다. 1m seed42/8builtin/15output, UI heartbeat final interval, sampled process peak 및 QuickJS requested peak, source/target bytes를 기록합니다. 출력/범위/UI를 reference와 검증합니다.

운영 harness는 bounded duration(기본3분 이상)·다중 chart·stream/correction·반복 prepare/create/close·cancel/stale·resize/context loss·background/foreground를 조합하고 메모리/지연 추세를 남깁니다. warm plateau와 sampling/GC/allocator 범위를 구분합니다. 다른 browser 설치/automation 이용 가능 여부만 확인하고 global automation settings·새 계정·라이선스·다운로드를 자동 변경하지 않습니다. unavailable 플랫폼은 그 범위만 미검증으로 남깁니다.
