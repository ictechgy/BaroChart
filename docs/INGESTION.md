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

## 동일한 직접 배치의 선택적 게시 생략

JavaScript 직접 호출 `api.applyDataEvents(events,{skipUnchanged:true})` 또는
`store.applyEvents(events,{skipUnchanged:true,maxBars,maxStoreBytes})`는 모든 입력과
중간 상태·저장 예산·거래량 트리 산술을 먼저 검증합니다. append가 없고 최종
교체 대상 여섯 OHLCV 필드가 현재 값과 각각 `Object.is`로 같을 때만 데이터
게시와 API invalidation을 생략합니다. 누적 volume은 합산하지 않고 replacement로
다룹니다. 동일 이벤트뿐 아니라 중간 변경 후 정확히 원복하는 배치도 해당합니다.
중간 overflow/잘못된 시각/없는 correction은 최종 값이 같아져도 전체 거절합니다.
append는 항상 변경이며 remove는 이 배치의 지원 이벤트가 아닙니다.

명시적 true 옵션의 receipt에는 `unchanged:true|false`가 있습니다. true이면
`events`는 검증한 이벤트 수, `from/to`는 요청한 대상의 반개구간이며 실제 게시된
변경 수가 아닙니다. version/timeVersion, 컬럼·트리 identity, 지표 dirty/checkpoint,
held buffer, store observer와 API invalidate 횟수는 모두 그대로입니다. false이면
기존 단일 게시를 수행합니다. 기본값·false·undefined 옵션은 이전 동작과 receipt
형태를 유지합니다. `+0`와 `−0`는 다른 값이고 NaN은 기존 OHLCV 검사에서 거절합니다.
옵션은 own data 속성만 허용하며 getter를 실행하지 않습니다.

이 옵션은 최신성 판별·자동 중복 제거 프로토콜이 아닙니다. revision/sequence가 없는
오래된 다른 값의 snapshot도 명시한 update/correction이면 교체합니다. 역사 조회와
live 응답이 겹치면 호스트가 공급자 revision 또는 요청 시작 시 source version 등을
사용해 병합/거절 정책을 정해야 합니다. timestamp나 도착 순서만으로 최신성을
추측하지 않습니다. 검증·트리 staging 비용은 여전히 남으며 실제 시간 성능 개선을
측정한 기능이 아닙니다.

Swift/Java에서는 [명시적 boolean overload](NATIVE-BATCH-UNCHANGED.md)로 같은 옵션을
사용할 수 있습니다. 기존 1인수/false 호출, `applyDataEvent`의 batch 형식, JSON
`dispatch`, ingestion queue/drain/저장 문서의 계약은 변경하지 않습니다. 특히 queue의 동일 payload도 수락 순번·applied 계수와 단일
게시를 기존대로 유지합니다. 직접 no-op 호출은 queue의 pending/sourceVersion을
수정하거나 재검증하지 않습니다.

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
| 대기 중 기존 API로 source 변경 | `SOURCE_CHANGED`, paused; resume은 현재 source/version에 재연결; 다음 drain에서 검증 |
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
[`api.setIndicatorParams(id, params)`](INDICATOR-PARAMETERS.md)로 같은 지표 ID와
연결된 series를 유지하며 전체 파라미터를 교체할 수 있습니다. 비동기 경로는
[웹](ASYNC-INDICATOR-PARAMS.md)과 [네이티브](NATIVE-ASYNC-PARAMS.md) 계약을 따릅니다.
이력을 버리지 않으므로 새 period는 현재 보유한 전체 이력으로 계산합니다.

실행 가능한 작은 예제: `node examples/ingestion.mjs`.
수동 실패·복구 UI는 [ingestion queue 예제](INGESTION-DEMO.md)를 참고하세요.
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
