# 웹·네이티브 공통 API와 실제 격차

0.2.12의 `applyDataEvents`와 선택형 수집 세션은
[INGESTION.md](INGESTION.md)에 같은 웹·Swift·Java 명령 이름, 순서·소유 복사·
예산·취소·저장 계약을 기록합니다. 새 배치는 데이터 게시를 한 번으로 묶으며
기존 단일 이벤트 API의 기본 동작을 바꾸지 않습니다.

0.2.11의 세션 VWAP·pivots·기준 시점 조회는 [SESSION-STUDIES.md](SESSION-STUDIES.md), 정적 사용자 모듈·지표 저장/병합은 [INDICATOR-MODULES.md](INDICATOR-MODULES.md)를 참고하세요. 아래 과거 실행 수와 새 검증 수를 합산하지 않습니다.

0.2.10의 모바일 라벨·입력·opt-in 시스템 글꼴 계약은 [MOBILE-LAYOUT.md](MOBILE-LAYOUT.md), 독립 SDK 소비·실제 실행 경계는 CYCLE10-VALIDATION.md (not included in this source distribution)에 있습니다. SwiftPM 및 Android AAR는 raw native SDK이며 React Native/Flutter wrapper와 구별합니다.

0.2.8에 추가한 [React 웹 어댑터](REACT.md)는 기존 웹 `chart.api`와 같은 코어를 사용합니다. 선택적 `/react` 진입점과 lifecycle/props wrapper이며 Swift·Java·React Native API로 확대하지 않습니다. package 타입·worker 통합 변경과 실제 React 18/19 결과는 통합 검증 (not included in this source distribution)에 있습니다. 공통 코어의 이후 변경은 0.2.9/0.2.10 보고서에 기록하며 아래 이전 native 실행 수를 최신 결과와 합산하지 않습니다.

0.2.7은 공통 `ChartAPI`에 독립 가격축과 시리즈에 연결된 도형을 추가합니다. 웹 `chart.api`, Swift `engine.command(operation, arguments)`, Java `engine.command(operation, arguments...)`는 동일한 코어 메서드를 실행합니다. Swift·Java에는 자주 쓰는 명령의 이름 있는 메서드도 있습니다. 기존 저수준 API와 바인딩 없는 도형 JSON v1을 유지하며, 바인딩 문서는 v2로 저장합니다. 당시 실제 실행 범위는 CYCLE7-VALIDATION.md (not included in this source distribution)에 있습니다.

## 공통 계약

| 기능 | 공통 명령 / 인수 | 웹·Swift·Android 구현 | 이번 실행 검증 |
|---|---|---|---|
| 외부 OHLCV | `setData(bars)` | UTC ms/Double 6필드; 소유 복사·검증 | Node, 웹 Canvas/GPU, Swift/Java tiny 가격·UTC 주입 |
| 컬럼 입력 | `setColumns(columns, length?)` | 웹 Float64 또는 JSON 숫자 배열; native JSON 배열 | Node 복사, Swift·Java 컬럼 주입 |
| 실시간·역사 수정 | `applyDataEvent(event)` | reset/append/update/correction/prepend; 기존 follow/지표 checkpoint | Node, 웹 append/update, Swift·Java 모든 수정 종류 |
| 순서가 있는 배치 | `applyDataEvents(events)` / `applyDataEvent({kind:'batch',events})` | append/update/correction 1–4096개, 검증 후 한 번 게시 | 전체 컬럼·지표·원자적 실패·도형/뷰 보존 검증; 실행 기록은 Cycle12 문서 |
| 선택형 수집 | configure/enqueue/drain/pause/resume/cancel/stats/save/load `DataIngestion` 명령 | 모델별 bounded owned ring, stream/generation/sequence, 명시적 실패/취소 | 웹 실제 Worker, JSC·QuickJS 공개 facade의 큐·lease·handoff 검증 |
| 패널·축 | `addPanel(options)`, `setPanel(id, patch)` | weight/linear/log/percent/inverted/range/base/precision | 공유 layout 기존 tests, host range/precision 설정 |
| 독립 가격축 | `addAxis(options)`, `setAxis(id,patch)`, `removeAxis(id)` | 패널 내 축 ID/좌우/scale/range/base/precision/tickFormat/visible/width, 일반 시리즈 axisId | Node·웹 Canvas/GPU·JSCore·QuickJS fixture; 세부 계약은 INDEPENDENT-AXES.md |
| 시리즈 | `addSeries(options)`, `setSeries(id,patch)`, `setSeriesValues(id,values)`, `removeSeries(id)` | 5종, 출력/패널/색/굵기/visible/offset; 순서 유지·데이터 바인딩 불변의 캐시 보존 | Node atomic patch, 웹/native 명시 출력·스타일·삭제 |
| 내장 지표 | `addIndicator(id,name,params)`, `removeIndicator(id)` | 동일34종 계산; add는 `{outputs,plotOffsets}`만 반환하고 자동 plot 안 함 | 기존33종 수치/parity; 새 facade 대표 RSI/Supertrend |
| 지표 값 조회 | `indicatorValues(id,output?)` | 원본 정렬 배열, warm-up/NaN은 JSON `null` | 웹 batch parity, Swift·QuickJS custom 값 |
| 사용자 지표 | 웹 `registerIndicator(name,factory)` / `registerIndicatorSource(name,source)` | native는 신뢰하는 JS factory 표현식 등록, 최대64KiB | Node·JSCore·QuickJS의 동일 `close*2` custom 계산 |
| 도형 CRUD | `addDrawing`, `editDrawing`, `deleteDrawing`, `selectDrawing` | 기존14종, 잠금/핸들/시간·가격 anchor; panel 존재 검사 | 공유14종 tests; host text 잠금/편집/저장, 기존 native channel/freehand gesture |
| 도형 저장·축 바인딩 | `saveDrawings()`, `loadDrawings(text)`, `setDrawingTarget(target)` | v1/v2·atomic load, axisId/seriesId 및 raw price/UTC 보존 | 웹/Swift/Java 정확한 왕복·orphan/reconnect·undo/redo |
| 커서 값 조회 | `crosshairValues(width,height)` | primary OHLCV·각 시리즈 price/gap/sourceTime·축별 연속 가격 분리 | 읽기 revision/observer 유지, 합성 세션 exact UTC join |
| Undo/Redo | `undo()`, `redo()` | controller를 통해 진행 중 gesture 취소 정책 유지 | 기존 stale gesture 회귀 + facade exact geometry |
| 입력 도구·문자 | `setTool(name)`, `setText(text)` | select+14종, 다음 text 생성용 문자 최대2000 | 공유 controller/native gesture; programmatic Unicode text |
| 테마·폰트 | `setTheme(patch)` | 아래 portable 색/폰트 계약, native 크기·bold·italic·family 적용 | 웹 scene/font, Swift·Android 실제 text pixel coverage |
| 도형 글꼴 | `style.font` | theme font 기본값, 개별 text/label font 우선 | Node 저장, 웹 scene, native renderer font fixture |
| 시장 표시 | `setSymbol(metadata)` | 검증된 priceDecimals/tickSize/adjustment 계약, IANA zone, `YYYY-MM-DD HH:mm` 시각 표기 | Node·Swift·Java 설정, 기존 DST host checks |
| 뷰 범위 | `setVisibleRange`, `fit`, `zoom`, `pan` | 같은 logical 축과 다중 패널 공유 x | 기존 core/browser/native 검사 |
| 상태 조회 | `inspect()` | view/theme/panels/series/lastBar/drawings/selection/input 상태 | host/Node 실제 값 확인 |

`dispatch`는 데이터·설정 명령만 허용합니다. 0.2.2에서는 code 실행인 `registerIndicatorSource`를 JSON dispatch/command에서 제거했습니다. 웹·Swift·Java의 이름 있는 trusted 메서드는 별도 native bridge로 유지합니다. 각 명령의 성공 후 갱신하고, 읽기와 거부된 변경은 native notification을 발생시키지 않습니다. 원자적 배치는 위 데이터 이벤트 범위이며 임의의 여러 설정 명령을 묶는 transaction은 제공하지 않습니다. `indicatorValues`는 배열을 복사하고 JSON으로 전달하므로 큰 출력 조회를 매 프레임 호출하지 마세요.

시리즈 `color`는 line/area/histogram, `fill`은 area, `upColor/downColor`는 candles/OHLC에 적용합니다. `width`는 line/area stroke와 candle wick/OHLC stroke에 적용하며 기본 candle/OHLC 두께1은 유지합니다. Candle body 폭은 LOD bucket 폭으로 정해지며 독립 body-width 옵션은 없습니다. 공통 API는 candles/OHLC에서 무시될 custom source/values/indicator 입력을 거부합니다.

색은 hex3/4/6/8, 쉼표 RGB/RGBA(숫자·%), CSS 기본16색과 transparent를 RGBA hex로 정규화합니다. `var(--color)`, HSL, 전체 CSS named-color 집합은 공통 경로에서 거부합니다. 웹 저수준 API의 전체 browser CSS 지원과 구별합니다. raw nativeTheme/nativeAddSeries 또는 직접 renderer scene에는 native-safe hex6/8을 사용하세요. 공통 facade가 다른 portable 표기를 정규화합니다. 폰트는 선택적 bold/italic/normal, `4..96px`, family 문자열입니다. generic monospace/sans-serif/serif와 설치된 family 이름을 사용할 수 있고 쉼표 목록의 첫 family를 native에 적용합니다. Native 미설치 family는 OS가 대체하므로 같은 픽셀/같은 글꼴 파일을 보장하지 않습니다. 논리 픽셀 크기입니다. UIKit Dynamic Type/Android fontScale는 기본 false인 opt-in이며 renderer가 scene font를 재확대하지 않습니다. 호출자 font ownership과 clipping/ellipsis 정책은 MOBILE-LAYOUT.md에 있습니다.

custom `values`의 JSON `null`은 NaN gap입니다. Swift는 `[Double?]`, Java는 JSONArray의 `JSONObject.NULL`을 사용합니다. `setSeries`의 indicator/output/values를 `null`로 주면 제거하고 기본 source로 돌아갑니다. `setPanel`의 range/base `null`은 수동 범위/기준 해제입니다. 고정 values의 길이는 데이터에 정렬되어야 하므로 데이터 길이가 바뀌면 호스트가 다시 주입해야 합니다.

## 갱신과 소유권

CanvasChart/GPUChart의 `api`는 RAF invalidate에 연결됩니다. UIKit View는 engine mutation observer를 약한 참조로 연결하고 해제 시 구독을 정리합니다. Android View는 attach 시 연결하고 detach 시 해제합니다. 동일 스레드에 생성된 engine의 이름 있는 메서드 또는 `command`를 쓰면 엔진만 바꾸어도 실제 뷰가 다시 그려집니다. macOS 데모도 observer를 연결합니다. scene/inspect 읽기 때문에 무한 렌더링이 발생하지 않습니다.

네이티브 엔진은 단일 소유 스레드에서 사용합니다. Swift와 Java 모두 다른 스레드의 호출을 거부합니다. UIKit/Android View를 연결하면 UI 스레드에서 생성하고 호출하세요. 기존 reset·지표 계산 API는 동기입니다. 0.2.4의 선택형 prepareColumnsAsync/prepareSeededAsync와 applyDataEventAsync는 별도 VM/runtime을 쓰며 데이터·UI 전송 비용이 있습니다. 한 엔진은 한 interactive chart view 용도로 사용하세요.

호환성을 위해 Swift `call`, Java `invoke`, 기존 `native*` 함수는 남겨 둡니다. 이 escape hatch의 임의 변경은 자동 갱신하지 않으며 호스트가 뷰 refresh를 책임집니다. 특히 기존 `nativeIndicator`는 모든 출력을 자동 plot하는 0.2 행동을 유지합니다. 새 `addIndicator`와 `addSeries(output:...)`를 권장합니다. trusted factory source는 앱 코드만 넣는 경로이며, 시세/도형 JSON에서 코드를 자동 실행하지 않습니다. 웹 CSP가 동적 Function을 제한하면 source 대신 `registerIndicator` 함수를 사용하세요. Swift/Kotlin로 작성한 함수를 JSON 경계 너머 JS factory로 전달하는 기능은 없습니다.

## 초기화 예

웹:

```js
const model = new ChartModel();
const chart = createChart(container,model,{renderer:'canvas'});
chart.api.addSeries({id:'price',type:'candles',panel:'price'});
chart.api.setData(bars);
chart.api.addIndicator('r','rsi',{period:14});
chart.api.addPanel({id:'rsi',range:[0,100]});
chart.api.addSeries({id:'r-line',type:'line',panel:'rsi',indicator:'r',output:'value'});
chart.api.applyDataEvent({kind:'append',bar:nextBar});
chart.api.setTheme({background:'#123',font:'bold 18px sans-serif'});
```

Swift Package:

```swift
let engine = try AsterEngine(options:["panels":[["id":"price"]],
    "series":[["id":"price","type":"candles","panel":"price"]]])
let chart = AsterChartView(engine:engine)
try engine.setData(bars) // [AsterBar]
try engine.applyDataEvent(["kind":"append","bar":nextBar]) // JSON dictionary
try engine.addIndicator("r","rsi",["period":14])
try engine.addPanel(["id":"rsi","range":[0,100]])
try engine.addSeries(["id":"r-line","type":"line","panel":"rsi","indicator":"r","output":"value"])
try engine.setTheme(["background":"#123","font":"bold 18px sans-serif"])
```

Android:

```java
JSONObject options=new JSONObject().put("panels",new JSONArray().put(new JSONObject().put("id","price")))
    .put("series",new JSONArray().put(new JSONObject().put("id","price").put("type","candles").put("panel","price")));
AsterEngine engine=new AsterEngine(context,0,options);
AsterChartView chart=new AsterChartView(context,engine);
engine.setData(bars); // JSONArray
engine.applyDataEvent(new JSONObject().put("kind","append").put("bar",nextBar));
engine.addIndicator("r","rsi",new JSONObject().put("period",14));
engine.command("fit");
```

명시적인 options로 native를 만들면 series는 제공한 것만 생성합니다. 옵션을 생략한 기존 count initializer는 0.2 호환성을 위해 price/volume/EMA 합성 데모 구성을 유지합니다. options가 없는 빈 count=0도 이 데모 구성의 빈 데이터입니다. 옵션은 panels/axes/series/theme/visibleBars/axisWidth/precision을 지원합니다.

## 남은 격차

* Swift·Java options는 dictionary/JSONObject 기반이며 전체 강타입 Panel/Series options 모델은 없습니다. 웹 TypeScript 선언과 runtime validation이 계약의 기준입니다.
* 임의 JS formatter 함수는 웹 모델에서 사용할 수 있으나 native JSON 명령 인수로 전송할 수 없습니다. 공통 경로에서는 precision·percent 축과 `setSymbol`의 고정 가격/시간 형식을 사용합니다.
* 외부 종목은 기준 UTC에 정렬된 일반 시리즈 값입니다. 별도 OHLCV 저장소·자동 합집합 시간축·기업행동/환율·자동 재정렬은 제공하지 않습니다. `crosshairValues`는 새 layout/range 조회를 수행하며 cached hover의 무계산 경로와 비용이 다릅니다.
* native JSON scene은 copy/encode/decode 경계입니다. GPU는 웹 WebGL2 경로이며 별도 native Metal/Vulkan/WebGPU renderer는 없습니다.
* 완전한 문자 shaping·같은 OS font·동일 AA/joins, native 접근성 데이터 표, 모든 font의 동일 glyph layout, 전체 chart snapshot, framework adapter, 자동 데이터 provider는 제공하지 않습니다.
* macOS/iOS 데모 toolbar는 일부 도구만 표시하고 Android toolbar는14종을 모두 표시합니다. 모든 native 도구는 setTool로 호출 가능합니다. 실제 시스템 입력과 직접 controller 호출의 최신 구분은 CYCLE10-VALIDATION.md에 있습니다. 실기기·다른 Android ABI/최소 OS 실제 실행과 장시간 lifecycle은 여전히 미검증입니다. 공통34/14 코드가 같은 runtime에 있다고 해서 모든 도구/지표의 모바일 입력·픽셀을 각각 실측했다고 계산하지 않습니다.

이 범위에는 새 플랫폼 선택이나 계정 접근 권한이 필요하지 않았습니다. 실기기/추가 ABI 검증은 실제 기기와 해당 빌드·서명 환경이 있어야 진행할 수 있습니다.

0.2.2는 BarStore와 Swift/Java observer 오류를 격리하여 뒤 구독을 통지합니다. 네이티브 semantic 상태 요약·keyboard 입력 경로를 추가했고 하드웨어 키보드/VoiceOver/TalkBack은 미검증입니다. 웹에는 built-in worker API·OHLCV 접근성 table·375px layout 검증이 있으며 native에도 제공한 것으로 해석하지 않습니다. 웹 WebView는 이 경로를 사용할 수 있지만 실제 WebView wrapper/기기 검증은 없습니다.

0.2.3 native opt-in `applyDataEventAsync`는built-in factory의owner-main engine을별도VM/context로계산합니다. customfactory/formatter async이전은미지원; 기존동기API는유지합니다. Applebusy/Androidsupersede 정책과rawcontext갱신,취소/실패/메모리비용은[NATIVE.md](NATIVE.md),실측은ASYNC-VALIDATION.md (not included in this source distribution)에기록합니다.

## 0.2.4 준비와 패키지 계약

Swift prepareColumnsAsync/prepareSeededAsync와 Java prepareColumns/prepareSeeded는 builtin 초기 준비를 별도 runtime에서 수행합니다. source UI/history는 분할 전송하고 cancel/stale/fault에서 source가 유지됩니다. public trusted custom factory의 동기 등록은 유지하며 native async 이전은 거부합니다. API·owner·배열 소유권은 [준비 계약](PREPARE-CONTRACT.md)에 있습니다. npm5개 entrypoint의 runtime/value types를 isolated offline consumer에서 일치 검증했습니다. core drawingGeometry/drawingPointCount, worker runChartWorker 선언도 포함합니다. worker helper는 저수준 module transport이며 native 임의 eval 전달 API가 아닙니다.

## 0.2.7 바인딩과 캐시

축·시리즈·도형 바인딩과 portable tick 형식은 worker 및 native correction context 전달에서 보존합니다. async/prepare의 임의 formatter와 사용 중인 custom factory 제한은 유지합니다. 초기 prepare는 외부 borrowed values를 거절하며, 성공한 correction은 외부 배열과 orphan 도형 이력을 보존합니다. [독립 축 계약](INDEPENDENT-AXES.md)에 v1/v2 migration과 remove/reconnect 의미를 기록했습니다.

Apple·Android renderer는 코어의 base/drawing/hover frame 계약을 사용합니다. Android View는 main-thread 공유 bitmap pool과 enable/budget/metrics API를 추가합니다. 보관 bitmap byte budget, 압박 시 direct rendering, 실패 후 재시도와 엔진 close 규칙은 [ANDROID-HOVER.md](ANDROID-HOVER.md)에 있습니다. JSON bridge는 전체 장면이 바뀔 때 여전히 encode/decode하며 GPU 완료나 물리 presentation을 측정한 기능이 아닙니다.
