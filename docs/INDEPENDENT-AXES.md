# 독립 가격축과 바인딩 문서

0.2.7은 같은 패널 안에서 서로 다른 가격 도메인을 표시합니다. `ChartModel({axes:[...]})` 또는 `ChartAPI.addAxis`로 명시적 축을 만들고 일반 시리즈의 `axisId`로 연결합니다. 패널의 기본 축은 `axisId`를 생략하거나 `null`로 연결합니다. 기본 축의 기존 `setPanel` 설정은 유지됩니다.

```js
const model = new ChartModel({store, axes:[{
  id:'other-price', panel:'price', side:'left', precision:4,
  padding:0.05, tickFormat:'fixed', prefix:'B ', label:'SYNTH:B'
}]});
const api = new ChartAPI(model, {controller});
api.addSeries({id:'other', type:'line', panel:'price', axisId:'other-price',
  symbolId:'SYNTH:B', values:alignSeriesByTime(referenceTimes, otherPoints)});
api.setAxis('other-price', {scale:'percent', base:2040});
api.setDrawingTarget({panel:'price', seriesId:'other'});
api.addDrawing({type:'horizontal', panel:'price', seriesId:'other',
  points:[{time:1700000000000, price:2150}]});
```

명시적 축은 패널/ID, 좌우 위치, 선형·로그·퍼센트 스케일, 반전, padding, 자동 또는 수동 `range`, `precision`, fixed/scientific `tickFormat`, prefix/suffix, label, visible, width를 지원합니다. `range:null`은 자동 범위로 돌아갑니다. 독립 축의 퍼센트 스케일에는 유한한 0 아닌 `base`를 명시해야 합니다. 다른 종목의 첫 가격을 기본 종목에서 추측하지 않습니다. 로그는 padding까지 포함한 양의 범위만 허용합니다. 패널은 `axisVisible`/`axisSide`로 기본 축을 숨기거나 이동할 수 있습니다. 축 수는 64개 이하이며 좁은 화면에서 축 영역 폭을 줄여 최소 플롯 폭을 보존합니다. 글자가 잘리지 않도록 앱에서 적절한 width를 설정하세요.

축별 autoscale은 해당 축의 보이는 시리즈만 사용합니다. OHLC·캔들은 기본 `BarStore`의 OHLCV를 읽으며 외부 종목을 흉내 낸 OHLC를 만들지 않습니다. 외부 가격은 line/area/histogram의 정렬된 Float64Array로 표시하며 `symbolId`도 이 외부 값 시리즈에만 붙입니다. `alignSeriesByTime`은 기준 UTC 밀리초에 정확히 일치한 점만 복사하고 없으면 NaN을 둡니다. 서로 다른 세션/휴장/시간대의 데이터에 이전 가격 채움이나 합집합 시간축을 자동 적용하지 않습니다. store append/prepend/reset 시 외부 시리즈를 새 기준 길이에 다시 정렬하여 `setSeriesValues`로 교체하는 것은 앱의 책임입니다. 지표와 캔들에 `setSeriesValues`를 적용할 수 없습니다.

`crosshairValues(width,height)`는 커서가 선택한 실제 기준 봉의 `primary:{symbolId,bar}`와 `series:[{id,label,symbolId,panel,axisId,value,sourceIndex,sourceTime}]`를 별도로 반환합니다. `primary.bar`는 항상 기본 OHLCV입니다. 외부 값이 없으면 `value`와 `sourceTime`은 null입니다. offset 시리즈의 sourceIndex/sourceTime도 원본 기준 봉을 가리킵니다. 기본 Free 모드의 커서 y 연속 가격은 해당 패널의 `axes:[{id,value,formatted}]`로 구분됩니다. 값이 없는 실제 봉에서 다른 종목의 종가를 대입하지 않습니다. 선택형 [crosshair snapping](CROSSHAIR-SNAP.md)은 유효한 OHLC 바인딩에서 해석한 좌표/원시 가격을 사용하며 외부 시리즈에 기본 종목 가격을 대신 넣지 않습니다.

도형은 `axisId` 및 선택적인 `seriesId`에 연결됩니다. `seriesId`만 주면 API가 현재 축을 채웁니다. 선택/핸들 드래그/키보드 이동·Fibonacci·측정 도형 모두 해당 축의 원래 가격과 UTC 시간으로 저장합니다. 축 숨김은 변환과 도형을 유지합니다. 연결된 시리즈를 제거·숨기거나 다른 축으로 옮기면 기존 도형은 숨겨진 orphan 상태로 남습니다. 같은 ID와 축을 복원하면 다시 표시됩니다. 축 자체는 시리즈 또는 도형/undo/redo 이력이 참조하는 동안 제거할 수 없습니다.

기존 도구에 명시적인 `visible` 필드가 없을 때, 바인딩 없는 문서는 `aster.drawings` version 1, 바인딩이 있으면 version 2로 저장합니다. 현재 reader는 version 1/2/3/4를 읽습니다. [롱/숏 position](POSITION-DRAWINGS.md)은 최소 version 3, [명시적인 표시 상태](DRAWING-VISIBILITY.md)는 version 4이며 각 버전에서 축/시리즈 바인딩을 보존합니다. version 1은 패널 기본 축을 뜻합니다. version 2를 기존 0.2.6 reader에서 읽을 수는 없습니다. 공개 load는 같은 패널·축·시리즈 ID와 일관된 바인딩을 요구하며 실패 시 현재 문서/이력을 바꾸지 않습니다. 제거된 시리즈를 복원한 뒤 load하세요. 내부 worker/native UI 전달은 이미 존재하는 orphan 도형과 undo/redo 이력을 보존하며 공개 문서 검증을 우회하는 API를 노출하지 않습니다. 이 문서는 전체 차트 설정/데이터/종목 메타데이터 저장 파일이 아닙니다. ID의 종목 의미와 세션 규칙은 앱에서 관리해야 합니다.

웹 Canvas/WebGL2와 네이티브 공통 JSON command facade를 사용합니다. Swift에는 addAxis/setAxis/removeAxis/setDrawingTarget/crosshairValues 편의 메서드도 있습니다. JSON tickFormat/prefix/suffix는 worker·JavaScriptCore·QuickJS에서 보존됩니다. 임의 formatter 함수는 동기 trusted-app 사용만 지원하며 worker/native async는 명시적으로 거절합니다. 독립 prepare는 기존처럼 외부 borrowed series values를 거절합니다. 비동기 correction의 외부 배열 상태 보존과 실제 UI/platform 검증 결과는 0.2.7 검증 문서에서 범위별로 보고합니다.

웹 실행: `npm run demo` 후 `/examples/web/axes.html`. 실제 합성 NY 분할 세션 20개 기준 봉/12개 외부 일치 점/8개 공백과 가격 약 100, 2000, 1e-12를 비교합니다. 네이티브 Compare 데모는 별도 합성 UTC 24봉/12점/12공백을 사용합니다. 실제 거래소 데이터나 실기기 성능 인증이 아닙니다.

작은 웹 화면에서는 C 축 눈금을 기본 숨기고 표시 checkbox를 제공합니다. 시간 눈금은 UTC HH:mm이며 crosshair readout은 전체 ISO UTC를 유지합니다. 축 숨김은 C의 원래 가격 도메인·도형 변환을 바꾸지 않습니다.
