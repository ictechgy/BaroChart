# TradingView Lightweight Charts에서 마이그레이션하기

이 문서는 오픈소스 웹 차트 라이브러리인 **Lightweight Charts 5.2.1**을 대상으로 합니다. TradingView Advanced Charts, Trading Platform, 브로커 연동, Pine Script 안내가 아닙니다. BaroChart는 별도 프로젝트이며 Lightweight Charts API와 호환되는 대체 구현을 제공하지 않습니다.

변환 헬퍼와 실행 가능한 페이지는 [lightweight-migration.mjs](../examples/web/lightweight-migration.mjs), [lightweight-migration.html](../examples/web/lightweight-migration.html)입니다. 로컬 서버를 `npm run demo`로 실행한 뒤 `http://127.0.0.1:5173/examples/web/lightweight-migration.html`을 여세요.

## 데이터를 명시적으로 변환하기

Lightweight Charts의 `UTCTimestamp` 값은 Unix 초입니다. BaroChart 봉은 정확한 UTC Unix 밀리초를 사용합니다. `lightweightSecondsToMilliseconds`는 안전한 정수 초만 받고, 밀리초 변환 결과도 안전한 정수이며 JavaScript Date 범위 안에 있어야 합니다. 곱셈 과정에서 JavaScript 음의 0을 보존합니다. 날짜 문자열과 `BusinessDay` 객체는 의도적으로 거부합니다. 세션 날짜를 실제 시각으로 바꾸려면 거래소 시간대, 캘린더, 세션 시작 정책을 호출자가 정해야 합니다.

```js
import { BarStore, ChartModel, createChart } from '../../src/index.mjs';
import { lightweightBarsToBaro } from './lightweight-migration.mjs';

const bars = lightweightBarsToBaro(lightweightRows);
const store = new BarStore(bars);
const model = new ChartModel({ store });
model.addSeries({ id: 'price', type: 'candles', panel: 'price' });
model.fit();
const chart = createChart(document.querySelector('#chart'), model);
```

각 행에는 유한한 `open`, `high`, `low`, `close`와 유효한 OHLC 범위가 필요합니다. Lightweight Charts 캔들 행은 보통 OHLC인 반면 BaroChart 데이터 모델은 OHLCV입니다. 헬퍼는 거래량을 만들어내지 않습니다. `volume` 필드를 주거나 `lightweightBarsToBaro(rows, { volumeForBar: row => volumeByTime.get(row.time) ?? 0 })`처럼 명시적인 정책을 전달하세요. 누락된 거래량을 0으로 본다는 정책은 호출자의 선택입니다. 시장 거래량을 추론한 값이 아닙니다. 거래량은 유한한 0 이상의 값이어야 하며 변환 배열은 시간순으로 엄격히 증가해야 합니다.

라인 데이터는 `{time, value}`를 BaroChart 시리즈/데이터 형태에 맞게 별도로 매핑하세요. 이 캔들 변환기는 whitespace point나 다른 Lightweight Charts 시리즈 형식을 바꾸지 않습니다. 가격을 시간 변환기에 전달하지 마세요.

## 스트리밍, 추가, 과거 정정

`applyLightweightBar(store, row)`는 숫자형 시간 행을 변환한 뒤 더 늦은 시각이면 추가하고, 마지막 시각과 같으면 최신 봉을 갱신하고, 기존 과거 시각이면 정정합니다. 현재 데이터 끝보다 앞선 알 수 없는 시각은 정렬된 저장소에 끼워 넣지 않고 거부합니다. 예:

```js
import { applyLightweightBar } from './lightweight-migration.mjs';

feed.subscribe(row => {
  // row에 volume이 필요하거나 { volumeForBar } 옵션을 명시해야 합니다.
  applyLightweightBar(store, row);
});
```

Lightweight Charts의 `series.update(bar, historicalUpdate)`는 자체 갱신 정책을 가집니다. BaroChart는 호스트 소유 `BarStore`에서 타임스탬프를 기준으로 처리합니다. 이 헬퍼의 타임스탬프 분기는 append/update/correction을 선택할 뿐, 이벤트 최신성을 판정하지 않습니다. 기존 시각을 가진 늦은 이벤트도 해당 행으로 분기됩니다. 이벤트가 최신인지 확인하려면 공급자의 순번, revision 또는 watermark 프로토콜을 사용하세요. [피드 순서·watermark·재연결 안내](FEED-INTEGRATION.ko.md#공급자가-제공해야-하는-계약)를 참고하세요. 상위 소스의 정정이 기존 시각을 가리키면 그 행을 갱신합니다. 새 과거 봉은 정렬 자체를 바꾸므로 append로 처리하지 말고, 정렬된 이력을 교체하거나 다시 불러와야 합니다. BarStore 변경 알림은 모델과 렌더러에 전달되며, 피드 구독·재시도·저장은 호스트가 관리합니다.

feed/ingestion owner가 같은 BarStore 쓰기를 조정 중이면 이벤트를 해당 owner를 통해 전달하거나 쓰기를 조율하세요. 직접 BarStore를 쓰면 owner의 순번 검사, source 버전 보호, 재연결 수명주기와 경합해서는 안 됩니다. [피드 세션 소유권](FEED-INTEGRATION.ko.md#연결-순서)을 참고하세요.

## 소유권과 저장 상태

정확한 데이터셋마다 호스트 소유 `BarStore`를 두고 `ChartModel`에 전달하세요. 공급자, 거래소, 종목, 시간 간격, 세션/캘린더 및 조정 버전을 앱 상태에 함께 유지하세요. 이식 가능한 workspace를 저장할 때 명시적인 dataset binding을 사용하고 복원 시 일치 여부를 확인하세요. workspace는 차트 설정을 저장하며 원본 봉이나 데이터 내용의 지문을 저장하지 않습니다. [workspace 식별 및 복원 계약](WORKSPACES.md#dataset-identity-is-explicit-not-a-fingerprint)을 참고하세요.

차트가 모델을 소유하면 최종 정리 시 `chart.destroy({ disposeModel: true })`를 호출하고 호스트 피드/타이머 구독도 해제하세요. 여러 차트가 모델을 공유하면 마지막 소유자가 모델을 정리해야 합니다. 실행 예제는 일반 종료와 back/forward cache 복귀를 처리합니다. 예제 데이터와 피드는 로컬 합성 데이터입니다.

## 별도로 설계할 범위

이 변환은 숫자형 시간의 캔들 피드와 기본적인 추가/갱신/정정을 다룹니다. Lightweight Charts 플러그인, 사용자 정의 시리즈, 마커, 가격선, pane, 가격축 동작, 지역화 formatter, 그리기 상호작용을 다시 구현하지 않습니다. 필요한 기능을 BaroChart의 문서화된 API에 각각 대응시키고 호스트 앱의 화면/동작 계약을 정하세요. 날짜 문자열에서 시간대를 추론하거나 거래량 누락을 실제 거래량으로 조용히 간주하지 마세요.

고정된 Lightweight Charts 5.2.1 소스와 고지는 [`benchmarks/vendor`](../benchmarks/vendor/README.lightweight-charts.md)에 있습니다. Apache-2.0 고지는 [`NOTICE.lightweight-charts`](../benchmarks/vendor/NOTICE.lightweight-charts)에서 확인할 수 있습니다.
