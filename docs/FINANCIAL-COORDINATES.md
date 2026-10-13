# 금융 좌표와 정확한 시간 정렬

`examples/web/financial.html`은 외부 연결 없이 20개의 합성 A 봉과 서로 다른 분할 세션의 B 점을 표시합니다. 기존 개발 서버로 실행하고 `/examples/web/financial.html`을 여세요. 가격 축 선택, 세 패널의 축 반전, 도형 생성·취소·다시 실행·문서 저장/읽기를 사용할 수 있습니다. 실제 거래소 세션이나 기업행동 데이터를 제공하지 않습니다.

## 여러 종목의 시간 정렬

```js
const values = alignSeriesByTime(
  new Float64Array([0, 60000, 120000, 180000]),
  [{time:60000,value:10}, {time:90000,value:99}, {time:180000,value:30}],
);
// Float64Array [NaN, 10, NaN, 30]
model.addSeries({id:'b',type:'line',panel:'price',values});
```

`alignSeriesByTime(referenceTimes, points) → Float64Array`는 기존 기준 타임라인에 **정확한 UTC 밀리초가 일치하는 값만** 배치합니다. 기준은 일반 배열 또는 Float64Array, 점은 `{time,value}` 객체 배열입니다. 두 입력은 중복 없는 엄격한 오름차순이어야 하고 time은 Date 범위 안의 안전한 정수 밀리초여야 합니다. 각각 최대 `RESOURCE_LIMITS.maxBars` 길이를 허용합니다. 값은 유한한 number 또는 `null`/`NaN` 공백이며 Infinity·문자열·undefined는 거부합니다. 기준 밖의 점도 먼저 검증합니다. 결과는 별도의 Float64Array이고 `-0`도 유지합니다. 검증한 값을 다시 getter로 읽어 다른 값을 join하지 않도록 기준 time을 1회 snapshot합니다. 기준 N개·점 M개에 reference snapshot 8N, point time/value snapshots 16M, output 8N바이트의 typed storage를 사용합니다. 입력 객체와 allocator 비용은 별도이며 정렬 비용은 O(N+M)입니다.

기준에 없는 점은 제외하고 기준에 값이 없는 위치는 NaN입니다. 이전 가격을 전달하거나 보간하지 않습니다. 합집합 타임라인, 가짜 OHLC, 자동 거래소 세션 필터, 환전, 종목별 수정주가 계산을 만들지 않습니다. 단순히 같은 길이인 두 값 배열을 붙이면 서로 다른 시각의 값을 같은 봉에 놓을 수 있으므로 호스트가 먼저 정렬해야 합니다. 기준 타임라인 선택에 따라 제외되는 관측점이 달라집니다. 모든 점이 필요하면 호스트가 먼저 적절한 타임라인을 선택해야 합니다.

예제의 A 기준은 2026-02-06/09 New York의 09:30·10:00·10:30·11:00·11:30·13:00·13:30·14:00·14:30·15:00입니다. B 세션은 09:45–11:45와 13:30–15:15입니다. B 16점 중 정확히 일치하는 12점을 표시하고, A 위치 8개는 공백이며, 기준에 없는 B 4점은 제외됩니다. OHLC의 없는 봉은 생성하지 않습니다.

데이터 append/prepend/reset으로 기준 길이가 바뀌면 호스트가 다시 정렬하고 `setSeriesValues`해야 합니다. API는 저장소 시간 기준을 공유하는 general series를 지원하며 독립적인 여러 OHLCV 저장소의 자동 결합은 지원하지 않습니다. 기본 x축은 거래 봉 순서이며 주말·세션 간 공백을 같은 봉 간격으로 압축합니다. 경과 시간에 비례하는 x축과 crosshair snapping은 미구현입니다.

## 분할·야간 세션과 기간 앵커

주입한 세션은 `[open, close)`입니다. 분봉은 선택된 각 세션의 open부터 간격을 계산합니다. 점심 공백과 거래가 없는 기간의 봉은 채우지 않습니다. 야간 세션은 종료일이 아닌 **시작일**에 속합니다. 2026-01-31 22:00–02:00 UTC 세션의 2026-02-01 01:00 거래는 day=01-31, week=01-26, month=01-01 앵커를 사용합니다.

일봉은 세션 날짜, 주봉은 그 날짜가 속한 월요일, 월봉은 현지 월 첫날을 기준으로 합니다. 보통 현지 자정의 UTC epoch입니다. 그 날짜의 자정이 DST로 존재하지 않으면 해당 현지 날짜의 **첫 유효한 시각**을 사용합니다. 반복되는 자정은 더 이른 instant를 사용합니다. 날짜 전체가 사라진 경우는 거부합니다. 날짜별 앵커 캐시는 `maxCachedDays`로 제한하고 `invalidate()`에서 지웁니다. 런타임 Intl/tzdb의 시간대 규칙에 의존합니다.

| 종류 / 입력 UTC | 시간대 | 고정 기대 앵커 UTC | 앵커의 현지 시각 |
|---|---|---|---|
| day / 2026-09-06 13:00Z | America/Santiago | 2026-09-06 04:00Z | 09-06 01:00 |
| week / 2021-03-23 05:30Z | Asia/Tehran | 2021-03-21 20:30Z | 03-22 월요일 01:00 |
| month / 2023-10-15 13:00Z | America/Asuncion | 2023-10-01 04:00Z | 10-01 01:00 |
| day / 2026-11-01 15:00Z | America/Havana | 2026-11-01 04:00Z | 반복되는 첫 00:00 |

`zonedEpoch(date, clock, timezone)`의 명시적 clock 변환은 그대로 엄격합니다. 존재하지 않는 00:00을 요청하면 오류이고 반복 시각에는 earlier/later/reject를 선택할 수 있습니다. 기간 label을 실제 하루 시작에 배치하는 규칙과 임의 clock 변환은 용도가 다릅니다. 공급한 날짜 간 세션의 겹침을 자동으로 조정하지 않습니다. 호스트가 일관된 거래일·휴장·연장 세션 규칙을 제공해야 합니다.

## 축과 도형의 해석

크로스헤어 y값은 커서의 연속 축 좌표를 역변환한 값이며 최근 봉의 close에 snap한 값이 아닙니다. percent 축 라벨의 10%와 원래 가격 110(base 100)을 구분합니다. 예제는 `layout.index(x)`를 반올림하고 저장된 범위로 clamp하여 가장 가까운 **실제 봉**의 time/OHLCV와 같은 시각의 B 값을 따로 표시합니다. 관측점 사이의 보간한 timestamp나 가상의 봉을 만들지 않습니다. 예를 들어 x=logical 1.4, cursor price=110은 실제 2026-02-06 15:00Z 봉(A close=100.8, B=102.6)을 선택하지만 커서 축값은10%입니다. x=4.1에서는 실제16:30Z 봉을 선택하고 B는 공백입니다. 이 선택은 예제 readout 규칙이며 core crosshair 자체를 snap시키지 않습니다.

원본 가격과 도형 앵커는 Float64이며 log 축에서 양의 범위가 필요합니다. percent는 `(value/base−1)×100`입니다. 기본 base는 저장된 첫 close이므로 기준을 보존하려면 `base`를 명시하세요. 예제는 A와 B 모두 공통 가격 100을 사용합니다. 이는 종목별 첫 관측 가격을 기준으로 한 상대 성과가 아닙니다. 종목별 기준이 필요하면 호스트가 수익률 값을 계산해 general series로 넣거나 별도 패널을 사용하세요.

도형은 UTC time·raw price·panel을 저장합니다. 로그·퍼센트·반전 축에서 좌표를 역변환하고, 주말 압축 상태에서도 각 앵커를 유지합니다. Fibonacci 가격 수준은 raw price의 산술 보간입니다. save/load는 완료된 도형 문서를 옮기며 진행 중 gesture·undo history·심볼·통화·수정주가 버전을 저장하지 않습니다. 여러 종목과 adjustment 버전은 호스트가 별도 journal로 분리해야 합니다.

검증: `node --test test/financial-calendar.test.mjs test/financial-series.test.mjs test/markets.test.mjs test/extended-drawings.test.mjs`. 고정 UTC 전후 1ms의 현지 날짜, 분할 세션 공백, 야간 날짜, 정확한 join 및 14종 도형의 log/percent/inverted 저장·읽기/좌표 왕복을 확인합니다. 이 문서의 계약은 모든 거래소의 실제 캘린더를 인증하거나 모든 브라우저 tzdb의 동일 버전을 보장하지 않습니다.
