# 데이터 계약과 시장 모델

## OHLCV 계약

일반적인 OHLCV 필드 구조를 채택했습니다. 하나의 국제표준이라고 주장하지 않습니다.

```ts
type Bar = {
  time: number;   // UTC Unix epoch, 정수 밀리초
  open: number; high: number; low: number; close: number;
  volume: number; // 해당 봉의 거래량; 음수 불가
};
```

모든 값은 유한한 Number입니다. 시각은 안전한 정수이며 JavaScript Date 범위 안이어야 합니다. 시간은 엄격한 오름차순이고 중복을 허용하지 않습니다. `low ≤ open/close ≤ high`를 검사합니다. 음수 가격은 코어에서 허용하지만 로그 축은 양의 가시 범위가 필요합니다. 결측 값을 0으로 치환하지 않습니다. 거래가 없는 기간은 봉이 없는 상태로 표현하고 기본 시간축은 **거래 봉 순서에 따른 동일 간격**으로 휴장 구간을 압축합니다. 실제 경과 시간에 비례한 공백 축은 미구현입니다.

0·1봉일 때 `new BarStore(bars,{timeframeMs:60000,timeOrigin:0})`의 가상 시간 간격을 사용합니다. 1봉은 그 봉 시각, 0봉은 timeOrigin을 기준으로 logical index↔time을 역변환합니다. 빈/단일 데이터에서도 클릭한 x 위치의 도형을 유지하며 앵커 시각은 보간된 소수 밀리초일 수 있습니다. 실제 OHLCV 입력 time의 안전한 정수 규칙은 유지됩니다. 2봉 이상은 실제 시각 간격으로 보간/외삽합니다.

가격·시각·거래량은 Float64로 보관합니다. 렌더러 좌표를 만드는 마지막 단계까지 가격과 epoch 값을 float32로 바꾸지 않습니다. 이는 임의 정밀도 십진수 회계 연산이 아닙니다. `1e-12` 수준 코인 가격 표현·왕복을 테스트했지만 모든 가격·거래량의 십진수 정확성을 보장하지 않습니다. 나노초 시각을 Number에 그대로 넣지 마세요. 밀리초와 별도의 원래 시각/순번 메타데이터로 어댑트해야 합니다.

## 입력과 메모리 소유권

| 입력 | API | 복사 | 검증/할당 |
|---|---|---|---|
| 객체 배열 | `new BarStore(bars)`, `setData(bars)` | 각 숫자를 내부 컬럼에 복사 | 전체 원본 검사 후 power-of-two 컬럼·트리 할당 |
| 컬럼형 | `setColumns({time,open,high,low,close,volume}, length?)` | 내부 Float64Array로 복사 | 소유 snapshot 복사 후 숫자 검사, 트리 bulk build |
| 단일 봉 | `append`, `update`, `upsert` | 숫자 필드 복사 | 단일 봉 검사, 구간 트리 갱신 |
| 사용자 일반 시리즈 | `setSeriesValues(id, Float64Array)` | **참조 유지** | 길이 정렬 필요; 다시 설정해야 캐시가 갱신됨 |

컬럼 복사는 외부 배열 변경이 저장소를 손상시키지 않도록 선택했습니다. zero-copy 옵션은 제공하지 않습니다. `store.columns`와 지표 결과 typed view는 읽기 전용 계약입니다. 직접 쓰면 버전·트리·체크포인트를 우회하므로 지원하지 않습니다. 모든 변경은 저장소 API로 주입하세요. 실패한 데이터 검증은 기존 데이터를 유지합니다.

```js
const columns = {
  time: new Float64Array([1700000000000, 1700000060000]),
  open: new Float64Array([1, 2]), high: new Float64Array([2, 3]),
  low: new Float64Array([.5, 1]), close: new Float64Array([1.5, 2.5]),
  volume: new Float64Array([100, 120]),
};
store.setColumns(columns);
```

`normalizeOHLCV(rows,{format:'tuples',timeUnit:'s'})`는 `[timestamp,open,high,low,close,volume]`의 숫자/비어 있지 않은 숫자 문자열을 객체 봉으로 변환합니다. `format:'objects'`도 지원합니다. 시간 단위는 어댑터에서 명시하세요. 원본 공급자 스키마·심볼·조정 메타데이터 변환은 호스트의 책임입니다.

## 변경·재연결 계약

`applyDataEvent(store,event)`는 네트워크 없이 외부 이벤트를 적용합니다.

| kind | 의미 | 중복/겹침 정책 |
|---|---|---|
| `reset` | `bars` 또는 `columns`로 전체 데이터 원자적 교체 | 오름차순·중복 금지. 지표 초기화, 모델은 전체 화면으로 fit |
| `append` | 마지막 시간보다 큰 완료/신규 봉 추가 | 같은 시각은 오류 |
| `update` | 현재 마지막 봉의 OHLCV 전체 교체 | 마지막 봉과 동일한 time만 허용 |
| `correction` | 기존 과거 시각을 찾아 그 봉 전체 교체 | 없는 시각·시간 이동은 오류; 이력 삽입은 reset |
| `prepend` | 페이지네이션으로 더 오래된 객체 봉 추가 | 기존 첫 봉 이전, 중복/겹침 오류; 표시 시간·그리기 anchor 유지 |
| `batch` | ordered append/update/correction을 검증한 뒤 한 번에 게시 | 1–4096개, 중간 오류도 전체 거절; 자동 정렬·중복 제거 없음 |

`store.upsert`는 현재 봉 교체와 미래 봉 추가만 자동 선택합니다. 과거 데이터는 `correction`으로 명시해야 합니다. prepend는 전체 컬럼 복사·트리 재구성·지표 재계산을 합니다. 사용자 별도 시리즈는 호스트가 같은 길이로 재정렬하여 `setSeriesValues`해야 합니다.

재연결 시 호스트가 최신 스냅샷·시퀀스/버전을 확인한 뒤 current update와 historical correction을 적용하거나 reset하세요. 선택형 [수집 세션](INGESTION.md)은 stream/generation/정확한 다음 순번과 소유 큐 한도를 검사합니다. 기본 단일 이벤트 API에는 자동 순번 확인이 없습니다. 재시도·외부 스트림 구독은 호스트 책임입니다. 서버 cursor를 사용하는 호스트는 `loadHistory({before,limit,signal}) → Bar[]` 결과를 정규화한 뒤 prepend할 수 있습니다. 스트림 호스트는 DataEvent를 주입하고 해제 시 자체 구독을 취소합니다. 특정 공급자 SDK·인증·네트워크 프레임워크에 의존하지 않습니다.

## 심볼과 수정주가

```js
const symbol = validateSymbol({
  id: 'provider:exchange:symbol', exchange: 'EXCHANGE', provider: 'external',
  timezone: 'America/New_York', currency: 'USD', priceDecimals: 2,
  tickSize: .01, volumeUnit: 'shares', adjustment: 'split',
  adjustmentVersion: 'host-defined-revision',
});
```

KRW/USD는 라벨 메타데이터이며 환전하지 않습니다. `tickSize`는 메타데이터이고 가격을 자동 반올림하지 않습니다. 주문용 tick 검증도 수행하지 않습니다. 수정/비수정/total-return 값의 실제 계산은 공급자가 수행합니다. 조정 정책·버전이 바뀌면 호스트가 reset하여 혼합 이력을 피해야 합니다. 기업행동을 자동 적용하지 않습니다.

## 캘린더·세션·DST

`SessionCalendar(timezone,sessionsForDate,{maxCachedDays:512})`에 날짜별 세션 공급 함수를 주입합니다. 빈 배열은 휴장, 짧은 세션은 조기 종료, `kind`는 정규/시간외 구분입니다. 같은 날짜의 세션은 정렬되고 서로 겹치면 안 됩니다. 닫는 시각이 여는 시각 이하이면 다음 날 종료하는 overnight 세션입니다. 세션은 `[open, close)`입니다. 캐시 변경은 `invalidate()`로 반영합니다.

```js
const calendar = new SessionCalendar('America/New_York', date =>
  externallyProvidedCalendar[date] ?? []
);
const session = calendar.at(utcMilliseconds, ['regular','extended']);
```

시간대는 IANA timezone과 런타임 Intl/tzdb를 사용합니다. 미국 봄·가을 DST, 존재하지 않는 시각과 반복되는 시각을 테스트했습니다. `zonedEpoch(...,'earlier'|'later'|'reject')`로 반복 시각 정책을 선택합니다. 존재하지 않는 local time은 거부합니다. timezone 규칙 최신성은 런타임에 의존합니다.

분봉 bucket은 선택된 세션 open부터 interval 밀리초 간격입니다. 일봉은 **시장 세션 날짜의 현지 자정**, 주봉은 그 날짜가 속한 월요일 현지 자정, 월봉은 현지 월 첫날 자정의 UTC epoch를 사용합니다. 이는 UTC 날짜와 다를 수 있습니다. 정규/시간외를 하나의 일·주·월 봉에 합치면 선택된 kind의 거래를 함께 집계합니다. overnight 거래는 세션이 시작된 날짜에 속합니다. 캘린더에 휴장 데이터를 공급해야 하며 평일이라는 이유만으로 거래일이라고 판단하지 않습니다.

데모의 KR/US 평일 시간표와 코인 UTC 24/7은 **예시 설정**입니다. 실제 거래소 휴장·경매·시간외 전체 규칙을 구현했다고 주장하지 않습니다. 실제 시세·거래소 연결은 없습니다.

## 선택적 tick 집계

`TickAggregator`는 외부에서 받은 `{id?,time,price,volume}`를 캘린더 기준 OHLCV로 묶는 참조 구현입니다. tick volume은 누적 거래량이 아닌 해당 거래의 양입니다. 기본 latePolicy는 `reject`, 선택적으로 `correct`는 보관된 bucket의 tick을 시간순 재정렬하여 시가·종가도 수정합니다. 같은 bucket 안의 동일 id는 중복으로 무시합니다. 빈 문자열도 명시된 ID이며 중복 제거합니다. ID 없이 중복을 판별하지 않습니다. 같은 millisecond 거래는 수신 순서를 사용합니다. 변경된 ID의 거래 교체/거래 취소는 지원하지 않고 완성된 봉 correction으로 주입해야 합니다.

기본 256 bucket, bucket당 최대 100,000 tick으로 detail 보관을 제한합니다. 두 보관 제한은 양의 safe integer여야 합니다. 숫자 interval도 양의 safe integer 밀리초이며 `day`/`week`/`month`를 사용할 수 있습니다. 입력은 `time`/`price`/`volume`/`id`만 한 번씩 읽어 복사합니다. 추가 속성은 읽거나 보관하지 않습니다. 입력 검사·보관 한도·거래량 합계 overflow가 실패하면 bucket, 중복 ID, 수신 순서, 마지막 시각을 변경하지 않습니다. 합계는 기존 안정 시간순 정렬과 같은 Float64 덧셈 순서로 계산하며 비유한 OHLCV를 발행하지 않습니다. 늦은 tick의 대상 bucket이 보관되지 않았다면 누락된 구간이든 퇴거된 과거든 `outside-correction-window`로 상태 변경 없이 거절합니다. 역사 중간 삽입은 별도 데이터 reset으로 처리해야 하며 봉이 없는 구간을 만들어 채우지 않습니다. 고빈도 체결용 범용 feed 엔진으로 성능 검증한 기능은 아닙니다. 고성능 경로는 외부에서 집계한 OHLCV를 주입하는 방식입니다.

0.2.2는 복사한 컬럼/한 번 읽은 봉 snapshot을 검사하여 getter·overridden TypedArray helper 경계에서 검사와 commit을 일치시킵니다. 기본 maxBars4,194,304를 더 낮출 수 있습니다. 구독 예외는 성공 commit을 취소하지 않고 listenerErrors/onListenerError로 보고하며 뒤 구독을 계속 통지합니다. reentrant 변경은 FIFO notification으로 전달합니다. JSON/native/Worker 이동 비용과 제한은 AUDIT.md (not included in this source distribution)를 참고하세요.

## 세션 기준 상위 OHLCV 봉과 확정값 정렬

`resampleOHLCV`는 명시한 원본/목표 interval과 세션 일정으로 상위 봉을 계산합니다. 원본의 open timestamp, 정확한 source grid, 부분 target 처리 정책을 요구하며 빈 봉을 생성하거나 경계를 걸친 원본 봉을 잘라 쓰지 않습니다. `alignConfirmedByTime`은 각 의사결정 시각에 이론상 닫힌 완전한 상위 봉만 전달합니다. 거래소 확정 증명이나 수신 시각을 가진 point-in-time backtest는 아닙니다. 과거 correction이 있으면 과거 결과도 달라질 수 있습니다. [API·정확성·자원 계약](RESAMPLING.md)과 [순수 계산 예제](../examples/resampling.mjs)를 참고하세요.
