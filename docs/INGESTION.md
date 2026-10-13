# 순서가 있는 배치와 선택형 수집 세션

`ChartAPI`를 Canvas/WebGL 차트의 `chart.api`, 직접 만든 core 모델, Swift
`AsterEngine`, Android `AsterEngine`에서 같은 명령 이름으로 사용합니다.
네트워크 연결과 공급자 구독, 실행 주기, 재시도는 호스트가 소유합니다.

```js
api.configureDataIngestion({
  streamId:'exchange:A', generation:1, firstSequence:0,
  maxQueuedEvents:64, maxQueuedBytes:64*49, maxBatchEvents:8,
  maxStoredBars:100_512, maxStoreBytes:96*131_072,
});
api.enqueueDataEvents({streamId:'exchange:A',generation:1,firstSequence:0,
  events:[{kind:'update',bar:current},{kind:'append',bar:next}],
});
const committed=api.drainDataEvents(8); // 호스트가 선택한 owner-thread 시점
```

봉은 기존 UTC 밀리초·유한 OHLCV 계약을 그대로 따릅니다. `update`는 마지막
시각, `correction`은 존재하는 정확한 과거 시각입니다. 배치는 입력 순서대로
모든 중간 상태의 유효성을 검사하고 한 번만 게시합니다. 자동 정렬·중복 제거·
업서트·누락 시각 삽입·가격 반올림은 없습니다. 같은 봉의 반복 update도 순번과
개수를 보존합니다. `reset`과 `prepend`는 별도 기존 API를 사용하고, 대기
데이터가 있으면 먼저 drain 또는 명시적으로 cancel하세요.

`api.applyDataEvents(events)` 또는 `api.applyDataEvent({kind:'batch',events})`는
큐 없이 1–4096개 이벤트를 원자적으로 적용합니다. `store.applyEvents`에는
`{maxBars,maxStoreBytes}`를 직접 줄 수 있습니다. 설정된 수집 정책은 새 API의
배치·drain 경로에 적용됩니다. 기존 단일 이벤트/전체 교체 API의 동작은
그대로이므로 호스트가 우회하면 저장량이 수집 정책보다 커질 수 있습니다.
정책은 프로세스 전체 메모리 제한이 아닙니다.

검증 실패는 컬럼·구간 트리·버전·공개 알림을 변경하지 않습니다. 성공 뒤
observer 오류는 커밋을 취소하지 않습니다. 임의의 신뢰 사용자 지표가 이후
lazy 계산에서 던지는 오류까지 데이터 트랜잭션이 되돌려 주지는 않습니다.
기존 길이에 맞춘 외부 positional values가 있는 차트의 append 배치는
`EXTERNAL_ALIGNMENT`으로 거절합니다. 공급자가 정렬한 값의 새 전체 스냅샷을
호스트가 명시적으로 적용해야 합니다.

큐는 OHLCV 여섯 Float64 컬럼과 Uint8 종류 컬럼의 고정 ring입니다.
`ownedBytes`는 실제 ring 할당량, `pendingBytes=49*pendingEvents`는 현재 대기
payload의 논리 크기입니다. `maxQueuedEvents`와 `maxQueuedBytes`를 모두
만족하는 capacity만 할당하며 최대4096 이벤트입니다. 데이터 저장소는
power-of-two capacity의 컬럼·min/max/volume 트리로 `96*capacity` bytes입니다.
지표 출력/체크포인트, 렌더링, VM, GC 지연, 호출자의 원본, RSS는 이 숫자에서
제외됩니다. 이력을 제거하지 않으므로 지표 seed, warm-up, 원래 인덱스,
percent 축 기준과 시간/가격 drawing anchor가 보존됩니다.

상태와 오류:

| 경우 | 결과 |
| --- | --- |
| 잘못된 stream/generation, 중복/누락 순번 | `STREAM_MISMATCH` / `SEQUENCE_MISMATCH`, nextSequence 유지 |
| 큐 공간 부족 | `QUEUE_BUDGET`, packet 전체를 호스트가 계속 소유 |
| 저장 행/typed byte 한도 또는 잘못된 순서 | drain `DRAIN_FAILED`, prefix 전체를 유지하고 paused |
| 대기 중 기존 API로 source 변경 | `SOURCE_CHANGED`, paused; resume은 호스트의 명시적 재검증 선택 |
| pause / async lease | `PAUSED` / `BUSY`, 새 packet 미수락 |
| 미설정 / 교체된 session | `NOT_CONFIGURED` / `CLOSED` |

실패한 drain은 자동 재시도하지 않습니다. `pauseDataIngestion`,
`resumeDataIngestion`, `cancelDataEvents`로 호스트가 처리합니다. cancel은
취소한 sequence range를 반환하고 이미 수락한 nextSequence를 되돌리지
않습니다. 항상 `accepted = applied + cancelled + pendingEvents`입니다.
거절은 수락으로 세지 않습니다. `rejectedPackets`는 거절 시도 수,
`rejectedEvents`는 오류 전에 유효한 owned snapshot을 만든 이벤트 수입니다.
입력 검증 전 pause/busy 거절은 후자에 포함되지 않습니다. 공급자 시도/재시도
수는 호스트가 별도로 기록해야 합니다. observer에서 새 packet 수락·취소·
pause를 할 수 있지만 같은 drain 안의 중첩 drain은 `BUSY`입니다.

`saveDataIngestion` / `loadDataIngestion`은 bounded `aster.ingestion` version1
문서로 정책, 순번, 통계, 대기 payload를 보존하며 `−0` codec을 사용합니다.
OHLCV·지표 module/configuration·layout·drawing/history는 별도입니다. 동일한
source를 먼저 복원하고 session 문서를 불러오세요. 기존 대기 데이터가 있으면
먼저 처리해야 하며 잘못된 문서는 기존 session을 교체하지 않습니다.

async recompute/preparation을 시작하려면 큐가 비어 있고 drain이 끝나야 합니다.
작업 하나가 owner lease를 잡고 terminal 성공·실패·취소·close에서 해제합니다.
Swift/Android의 deferred begin 전에도 호스트 facade가 새 큐 변경을 거절합니다.
완료 observer는 복원된 빈 session에 새 packet을 넣을 수 있습니다. 네이티브
context 교체는 정책·통계·순번을 보존하고 live busy 상태는 저장하지 않습니다.
기존 데이터 API로 직접 source를 바꾸면 기존 stale-result 규칙이 적용됩니다.

두 심볼은 독립 모델/엔진 두 개를 사용합니다. `setSymbol`은 메타데이터 변경이며
공급자를 해제하거나 데이터를 자동 교체하지 않습니다. producer의 streamId와
generation을 묶고 구독 해제를 호스트가 처리해야 합니다. 지표 period 변경은
현재 remove/add와 관련 series 재등록을 사용합니다. 이력을 버리지 않으므로
새 period는 원래 전체 이력으로 계산합니다.

실행 가능한 작은 예제: `node examples/ingestion.mjs`.
15분 fixture와 실제 검증 결과는 Cycle12 검증 (not included in this source distribution)과
실측 경계 (not included in this source distribution)에 기록했습니다.

## Explicit retained-window maintenance

The optional [compactData](DATA-COMPACTION.md) command is separate from ordinary
ingestion admission. Stop the producer, drain, pause, compact with explicit study
history restart, then resume. Pending payload is never automatically discarded.
Trigger before maxStoredBars/maxStoreBytes rejects an append where possible. A paused,
source-current FIFO may opt into `pendingData:'preserve-retained'`: compaction checks all
pending timestamp dependencies against the retained suffix and earlier pending appends,
preserves payload/cursors/counters, then rebinds the source version before observers.
It does not apply the FIFO or certify that a later drain fits numeric/capacity budgets.
An evicted-target correction rejects the complete compaction. The default still requires
an empty queue; no-op does not validate or rebind pending data. See the compaction contract
for small-prefix progress and unresolved cap/dependency cases. This is not atomic
append-plus-eviction and does not preserve full-history study seeds.
