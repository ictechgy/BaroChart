# API·확장·사용 수명

Retained-window history: see [DATA-COMPACTION.md](DATA-COMPACTION.md) for explicit
`compactData({keepLastBars, studyHistory:"restart"})`, exclusive ownership,
study restart and source-only transient byte limits. Optional `pendingData:"preserve-retained"`
keeps an accepted paused FIFO whose timestamp dependencies survive the trim; ordinary
drain capacity/numeric checks still apply. The default requires an empty queue.

0.2.11의 세션 VWAP·pivots·기준 시점 조회는 [SESSION-STUDIES.md](SESSION-STUDIES.md), 정적 사용자 모듈·지표 저장/병합은 [INDICATOR-MODULES.md](INDICATOR-MODULES.md)를 참고하세요. 아래 과거 실행 수와 새 검증 수를 합산하지 않습니다.

전체 타입 계약은 `src/index.d.mts`에 있습니다. 저수준 코어 API는 동기식이며 DOM 없이 Node.js/JavaScriptCore에서 사용할 수 있습니다.

화면 좌표 없이 값·지표·원본 인덱스를 조회하는 `dataAt`은 [DATA-EXPLORER.md](DATA-EXPLORER.md)를 참고하세요. 기본값은 현재 차트의 표시값이며 과거 cutoff는 명시적으로 지정합니다. 웹의 명시적 키보드 선택·Enter 조회 prototype은 [KEYBOARD-EXPLORER.md](KEYBOARD-EXPLORER.md)에 있습니다. 이동은 계산하지 않으며 실제 브라우저·보조기술 UX 검증은 아직 필요합니다.

기존 `crosshairValues` readout은 각 표시 지표 시리즈마다 한 번 얻은 계산 결과에서 output 이름과 값을 함께 선택합니다. output 생략 시 같은 지표를 다시 조회하지 않습니다. 시리즈 간 또는 프레임 간 캐시는 추가하지 않으며, 레이아웃 계산과 dirty 지표의 동기 계산 비용은 남습니다. 이 변경은 readout 내부 중복 호출 제거이며 실제 입력 지연·paint 개선 수치를 의미하지 않습니다.

## 차트 모델

`new ChartModel({store,panels,theme,visibleBars,axisWidth,precision})`는 데이터, 지표 엔진, 그리기 저장소를 조합합니다. `addPanel({id,weight,label,scale,range,padding,inverted,base,precision,formatter})`와 `setPanel(id,patch)`를 사용합니다. 패널은 x축을 공유하고 y축을 각각 가집니다. 자동 가격 범위는 가시 원본/축약 범위를 사용하고 도형이 자동 범위를 확장하지 않습니다. 수동 범위 `range:[min,max]`는 자동 축보다 우선합니다.

* `linear`: 선형 가격 축
* `log`: log(price) 축. 가시 범위와 padding 후 최솟값이 양수여야 합니다. 0 baseline 영역/히스토그램과 함께 사용하려면 양의 range/baseline을 설정하세요.
* `percent`: `(value/base-1)*100`. base 기본값은 저장된 첫 close이며 0이면 오류입니다. prepend로 기준을 유지하려면 `base`를 명시하세요.

스타일은 theme, 시리즈 color/width/fill/upColor/downColor, 패널 precision/formatter, `model.priceFormatter`/`timeFormatter`, drawing style로 설정합니다. 네이티브 색상은 `#RRGGBB`/`#RRGGBBAA`를 사용하세요. 0.2.1의 공통 API는 portable 색을 hex로 정규화하고 native 폰트 크기·bold·italic·family를 적용합니다. OS 폰트 대체·AA가 달라 같은 픽셀은 보장하지 않습니다. [공통 스타일 계약](API-PARITY.md)을 참고하세요.

```js
model.addPanel({id:'osc',weight:1,range:[0,100],precision:0});
model.indicators.add('rsi14','rsi',{period:14});
model.addSeries({id:'rsi',panel:'osc',type:'line',indicator:'rsi14',color:'#aa91f7'});
model.setPanel('price',{scale:'log',padding:.04});
model.theme = {...LIGHT_THEME};
chart.invalidate();
```

시리즈는 `candles`, `ohlc`, `line`, `area`, `histogram`입니다. 일반 시리즈는 `source:'close'|'open'|'high'|'low'|'volume'` 또는 정렬된 `values:Float64Array`를 사용합니다. `indicator`/`output`은 계산 결과 컬럼을 연결합니다. `visible:false`로 숨길 수 있고 `removeSeries`, `setSeriesValues`를 제공합니다. `source:'volume'` 히스토그램의 LOD는 캔들과 같은 구간의 거래량 합계입니다. 일반 히스토그램은 bucket 끝값, 선/영역은 끝값과 min/max envelope를 그리므로 축소 표현은 원본 모든 점과 동일한 픽셀 영상이 아닙니다.

`setVisibleRange(from,to)`는 봉 순서 기준 logical index입니다. `fit`, `zoom(factor,anchor 0..1)`, `pan(deltaBars)`로 이동합니다. 오른쪽 끝에 있으면 `follow`가 켜지고 append 시 새 봉을 따라갑니다. 모델/도형/스타일을 직접 바꾼 뒤 `chart.invalidate()`가 필요합니다. 데이터 변경은 CanvasChart가 자동 구독합니다.

## 사용자 지표

```js
model.indicators.register('typical-price', () => ({
  outputs: ['value'],
  create() {
    let count = 0;
    return {
      step(bar, index) { count++; return [(bar.high+bar.low+bar.close)/3]; },
      snapshot() { return count; },
      restore(state) { count = state; },
    };
  },
}));
model.indicators.add('custom','typical-price');
model.addSeries({id:'custom',panel:'price',type:'line',indicator:'custom'});
```

factory는 params에서 정의를 생성합니다. `step`은 원본 봉 전체에 대해 시간순 호출되고 `outputs`와 같은 수의 유한한 Number 또는 NaN을 반환해야 합니다. Infinity는 오류입니다. 전달된 bar 객체는 재사용하므로 보관하지 말고 필요한 값을 복사하세요. snapshot/restore는 계산을 결정론적으로 재개할 수 있어야 합니다. JSON 객체/배열/숫자처럼 복사 가능한 상태를 사용하고 DOM, 함수, 클래스 인스턴스, 순환 참조를 상태에 넣지 마세요. `IndicatorEngine`은 기본 256봉 checkpoint와 변경 위치에서 suffix 계산을 사용합니다. 0.2.11의 [정적 사용자 모듈](INDICATOR-MODULES.md)은 owner와 worker에 같은 구현/codec을 연결한 경우 async를 지원합니다. 기존 임의 factory/source는 동기 전용이며 지표 간 dependency graph와 비동기 외부 지표는 아직 없습니다. 웹 worker 경로는 아래와 같습니다.

`api.setSeries(id, patch)`에서 color/fill/upColor/downColor/width/visible/label만
바꾸는 패치는 dirty 지표를 계산하지 않습니다. 숨김·색 변경에 계산 오류가
끼어들지 않으며, 다시 표시한 뒤 실제 조회/렌더 시에는 정상 계산과 오류 처리가
유지됩니다. binding·type·축·offset 등 다른 키는 기존 경로입니다.
[표시 패치 계약과 검증](SERIES-PRESENTATION.md)을 참고하세요.

## 기존 지표 설정 변경

`api.setIndicatorParams(id, params)`는 기존 지표의 전체 파라미터를 원자적으로
교체합니다. 연결 시리즈·스타일·축·도형·viewport는 유지하며 계산 실패 시
이전 결과를 유지합니다. 출력 schema/plot offset 변경은 명시 거절합니다.
동기 계산 비용, no-op, 비동기 stale 처리와 예제는
[지표 파라미터 계약](INDICATOR-PARAMETERS.md)을 참고하세요.

## 지표 삭제

`api.removeIndicator(id)`는 해당 entry와 연결 시리즈를 제거합니다. 삭제할 지표를
다시 계산하지 않으므로 dirty 지표의 factory/create/step/snapshot/restore가
실패하더라도 그 계산을 시도하지 않고 삭제할 수 있습니다. 없는 ID는 기존
`Missing indicator: ...` 오류입니다. 활성 연결 도형 편집은 취소하고 drawing
입력 target을 해제하며, 저장된 연결 도형은 지우지 않고 orphan으로 남깁니다.

controller 정리 callback이나 메서드 getter가 대상 entry 또는 model/engine을
교체하면 `StaleSourceError`로 중단해 새 대상을 지우지 않습니다. 이미 실행된
애플리케이션 callback의 부수효과를 되돌리지는 않습니다. 임의 override 함수
본문은 신뢰된 호스트 코드이며, 원래 callback 예외와 삭제 후 invalidate 예외
전파 정책은 유지합니다. 같은 entry의 원본 데이터가 갱신되는 것은 삭제를
막지 않습니다. 기존에 받은 output 배열을 삭제 자체가 수정하지 않으며,
공유 store와 다른 모델의 구독도 유지합니다. NativeCheckpointEntries의
퇴역 경로를 사용해 대상 checkpoint ledger만 해제합니다.

정확한 검증·효과 범위는 [REMOVE-INDICATOR.md](REMOVE-INDICATOR.md)를 참고하세요.

## 그리기·히스토리

16종 도구: 기존 `trendline`, `horizontal`, `fibonacci`, `rectangle`, `ellipse`, `text` 및 `ray`, `extendedline`, `channel`, `fibextension`, `fibfan`, `fibtimezones`, `freehand`, `measurement`, `longposition`, `shortposition`입니다. 수평선/텍스트는 anchor1, 채널/피보 확장은3, 롱/숏은4, 자유선은2..2048, 나머지는2입니다. anchor는 `{time,price}`와 panel id로 저장합니다.

추세선은 선분, ray는 첫 점에서 두 번째 점 방향으로 확장, extendedline은 양방향 확장입니다. channel은 첫 두 점의 방향을 공유하며 세 번째 점을 지나는 평행선 및 점선 중간선입니다. channel/fibextension 생성 드래그는 세 번째 점을 끝점 아래40px에 초기화하며 이후 세 번째 핸들을 이동합니다. 3회 클릭 생성 방식은 없습니다. freehand는 1px 이상 이동한 점을 저장하며 2048개에서 중단합니다. 자동 곡선 smoothing/단순화는 없습니다.

Fibonacci retracement는 0/.236/.382/.5/.618/.786/1, extension은 세 번째 price+(두 번째−첫 번째 price)×0/.618/1/1.272/1.618/2.618입니다. 가격은 **raw price에서 산술 보간 후 축 변환**하므로 log 축 10→100의 50%는55입니다. fan은 .382/.5/.618 price 목표를 지나는 ray이고 timezones는 첫 두 점 사이의 logical 봉 간격×0/1/2/3/5/8/13/21/34의 수직선입니다. measurement는 가격 차이·첫 가격 대비%·logical 봉 간격·UTC 초 차이를 표시합니다. 누적 수익률·거래량 측정은 포함하지 않습니다. 동일 geometry 생성 함수를 렌더러와 hit-test가 공유합니다.

```js
const id=model.drawings.add({type:'text',panel:'price',points:[{time,price}],text:'관찰',style:{color:'#f5b85a',width:1.5}});
model.drawings.edit(id,{text:'수정 메모'});
model.drawings.edit(id,{locked:true});
const saved=model.drawings.save(); // schema: aster.drawings, version: 1
model.drawings.load(saved);        // 검증 후 원자적 적용, load도 undo 가능
```

도형 문서는 기본 최대 8,388,608 UTF-16 코드 단위(`maxDocumentChars`)입니다.
`save()`/`saveDrawings()`도 `load()`와 같은 한도를 검사합니다. 도형/점 개수
한도를 지켜도 좌표·문자열 길이에 따라 문서 한도를 넘을 수 있으며, 이때
저장은 `TypeError`를 던지고 원본 도형·선택·undo/redo를 그대로 보존합니다.
로드는 원본 JSON 길이와 정규화 후 다시 저장할 최소 버전 JSON 길이를 모두
검사합니다. 지수 표기 숫자의 일반 표기 변환이나 공개 API의 색상 정규화로
문서가 커질 수 있습니다. 후자가 한도를 넘으면 기존 도형·선택·이력·ID
serial을 교체하거나 redraw를 알리기 전에 거부합니다. 정확히 한도인
정규화 결과는 허용하며, 도형 교체로 변경된 상태는 기존처럼 한 번의 undo로 되돌립니다. 빈 문서에서 빈 문서로의 로드는 이력을 추가하지 않습니다.
add/edit는 입력 검사뿐 아니라 실제 JSON 정규화된 저장 후보도 검사하여 getter나 직렬화 hook이 바꾼 잘못된 좌표·스타일이 저장되지 않게 합니다. 이 계약이 getter의 실행 횟수나 애플리케이션 코드의 부수효과까지 제어하지는 않습니다.
암묵적인 삭제·축약은 하지 않습니다. 오류를 처리하고 호스트에서 내보낼
도형 범위를 명시적으로 정해야 합니다. 활성 gesture는 먼저 commit/cancel해야
저장할 수 있다는 기존 계약도 유지됩니다. 같은 크기 제한과 유효한 패널/축/
시리즈 바인딩을 가진 대상에서 v1/v2/v3/v4 문서를 복원할 수 있습니다.


begin/commit/cancel은 gesture transaction입니다. 드래그 중 여러 edit을 하나의 undo로 커밋합니다. cancel은 시작 상태로 복원하고 히스토리를 생성하지 않습니다. 기본 undo history는 최대 100건입니다. 새 수정 후 redo는 비웁니다. 현재 transaction 중 저장/로드는 오류입니다. 현재 reader는 v1/v2/v3/v4를 읽으며, 그 외 버전은 거부합니다. 필요한 최소 버전으로 저장합니다: 기존 도구에 바인딩이 없으면 v1, 축/시리즈 바인딩이 있으면 v2, 롱/숏 position이 있으면 v3, 명시적인 `visible` boolean이 하나라도 있으면 v4입니다. v3/v4도 이전 버전의 바인딩을 보존합니다. [position](POSITION-DRAWINGS.md)과 [visibility](DRAWING-VISIBILITY.md)의 이전 reader 거절 규칙을 확인하세요. 저장은 도형만 포함하며 데이터·차트 스타일·심볼 메타데이터는 호스트가 별도로 저장합니다.

선택된 unlocked 도형의 핸들을 먼저 검사하고, 나머지 geometry는 최근 도형부터 검사합니다. 잠금은 이동·geometry/style 편집·삭제를 막지만, 잠금 토글과 visibility-only 변경은 허용합니다. 숨김 도형은 캔버스 선택·hit test에서 제외되며 문서/이력/자원 한도에는 남습니다. [잠금과 표시 상태](DRAWING-VISIBILITY.md)를 참고하세요. 패널에 clip하고 prepend/zoom/resize 후 anchor를 유지합니다. 몸체 이동은 시작 화면 좌표 각각에 동일 pixel delta를 적용한 뒤 시간·가격으로 역변환합니다. log 축과 압축된 주말 간격에서도 모양을 보존합니다. 버전1의 필드 형식은 유지하며 0.1 문서를0.2가 읽습니다. 0.1 reader는 새 도구 type을 거부합니다.

## 입력 상태 기계

과거 데이터를 `prepend`할 때 기존 봉이 있으면 view 양 끝에 추가 봉 수를
더하여 같은 UTC 봉을 같은 화면상의 가로 위치에 유지합니다. 빈 저장소의 첫 페이지에는
보존할 과거 봉이 없으므로, `follow=true`이면 append와 같은 규칙으로 기존
view 폭을 유지하고 끝을 `length + forwardOffset - 0.5`에 맞춥니다.
`follow=false`이면 호스트가 정한 논리 범위를 그대로 둡니다. 빈 페이지는
view를 이동하지 않으며 잘못된 페이지는 전체 거부됩니다. 이 규칙은 동기
경로와 준비된 Worker/공통 native-JavaScript 상태 복원에 같습니다.
reset의 기존 fit 정책, 비어 있지 않은 backfill의 follow 값과 도형 UTC
좌표는 바꾸지 않습니다. [복원과 과거 화면 검증 범위](PERSISTENCE-VIEW-SAFETY.md)를
참고하세요.

`InteractionController`는 pointer id와 down/move/up/cancel, wheel, key를 받는 플랫폼 독립 코어입니다. select 도구는 팬 또는 도형 편집, 그리기 도구는 새 도형을 생성합니다. 두 번째 손가락은 pending drawing/edit을 cancel하고 pinch가 소유권을 가져갑니다. 세 번째 손가락은 무시합니다. pinch 후 남은 한 손가락은 새 drawing을 만들지 않고 전체 release를 기다립니다. pointercancel/Escape/뷰 분리는 transaction을 복원·해제합니다. wheel 중 active gesture는 무시합니다.

팬·pinch를 시작한 뒤 prepend/reset/새 봉 append처럼 저장된 시간축이 바뀌거나,
외부 `setVisibleRange`/fit/zoom 또는 follow 변경으로 현재 view가 controller의
마지막 적용값과 달라지면, 다음 pointer down/move/up 또는 cancel에서 이전 기준을
폐기합니다. 현재 모델이 보정한 view/follow를 유지하며 옛 인덱스로 되돌리거나
시간앵커를 추측하여 재보간하지 않습니다. 동일 시각 update/correction은 시간축을
바꾸지 않으므로 정상적인 드래그를 계속합니다. 값이 같은 외부 view 쓰기는 별도
변경으로 구분하지 않습니다. 추가 구독이 없으므로 데이터 변경 순간의 즉시 종료
알림을 보장하는 정책은 아닙니다.

이렇게 중단된 gesture는 추적 중인 최대 두 pointer가 모두 up될 때까지 wait합니다.
남은 손가락의 move는 화면을 이동하지 않고, 그 사이 두 번째 down도 새 pinch로
승격하지 않습니다. 세 번째 pointer는 기존대로 무시합니다. 전체 release 후 새
실제 down으로 다시 시작할 수 있습니다. pointercancel/Escape는 wait와 포인터를
즉시 비웁니다. 데이터/외부view가 그대로인 정상 cancel은 기존 시작view/follow를
복원합니다. 도형 create/edit transaction 정책은 변경하지 않습니다. 이 경계는
공통 controller 및 생성 native bundle VM에서 검사했으며 새 실제 터치기기·브라우저
실행 결과를 뜻하지 않습니다.


CanvasChart는 pointer capture, lostcapture, wheel preventDefault, 키보드 및 ResizeObserver를 연결합니다. Ctrl/Cmd+Z, Shift+Z/Y, Delete/Backspace, Escape와 Arrow(+Shift10px/Ctrl pan), +/- zoom, Home fit, End recent, PageUp/PageDown 도형 선택을 지원합니다. 선택이 없으면 PageUp은 마지막 도형, PageDown은 첫 도형에서 시작하며 기존 선택이 있으면 순서대로 순환합니다. 기존대로 잠긴 도형과 연결 대상이 사라진 도형도 목록 순서에 포함됩니다. `destroy({disposeModel:true})`는 RAF·observer·DOM 이벤트·저장소 구독을 해제하고 자신이 소유한 모델을 dispose합니다. 여러 렌더러가 하나의 모델을 공유하면 마지막 소유자가 model.dispose를 호출해야 합니다. 호스트가 만든 timer/stream 구독은 호스트가 해제합니다.

웹 canvas의 일반 모드에서는 Alt 조합을 소비하지 않습니다. Ctrl/Cmd 조합은
기존 undo/redo(Z, Shift+Z, Y)와 화살표 이동만 처리하며, 다른 조합은
preventDefault 없이 호스트에 넘깁니다. 특히 Ctrl/Cmd +/-의 브라우저 확대/축소와
Alt+좌우 이동을 차트 단축키로 가로채지 않습니다. 기존 Ctrl/Cmd 좌우 pan 및
상하 zoom, Shift 도형 이동과 modifier 없는 키는 유지됩니다. 자식 입력 대상·
IME 조합·이미 처리된 이벤트는 기존대로 무시합니다. 탐색 모드는 별도의
modifier 없는 탐색 키 계약을 유지합니다. 이는 웹 이벤트 라우팅 정책이며
직접 호출하는 native/core key 명령의 의미를 바꾸지 않습니다.


`model.dispose()`는 자신이 소유한 시리즈 범위 인덱스 참조도 해제합니다. 공유 저장소·사용자가 제공한 values·시리즈 설정과 호출자가 별도로 보관한 출력 view는 지우거나 detach하지 않습니다. dispose 뒤 파생 시리즈 데이터를 다시 만들 수 없으며, 사용자 지표 callback에서 dispose한 경우 진행 중 계산이 돌아와도 캐시를 재연결하지 않습니다.

활성 gesture 중 Undo는 gesture만 취소하고 이전 committed history는 유지합니다. Redo/Delete는 취소 후 해당 동작을 적용합니다. 툴바에서도 `controller.key`를 사용합니다. 외부 편집으로 대상/transaction이 사라진 경우 다음 move는 안전하게 cancel합니다. host가 직접 undo/remove를 호출하려면 먼저 controller.cancel을 호출해 정책을 명확히 하세요.

## GPU 선택과 지표 표시 이동

`createChart(container,model,{renderer:'canvas'|'webgl2'|'auto',onFallback})` 또는 `new GPUChart`를 사용합니다. 기본은 Canvas이며 auto는 GPU 시도/실패 폴백을 뜻하고 density 자동 선택은 아닙니다. WebGL2 instancing은 화면 좌표만 Float32로 업로드합니다. 코어 가격·시각·지표·anchors는 변환하지 않습니다. 초기화/렌더 오류 및 contextlost 때 canvas를 교체하고 동일 모델로 Canvas를 연결합니다. 선택/제스처는 취소하고 데이터·완료된 도형은 유지합니다. GPU로 자동 복귀하지 않습니다. destroy는 GL buffer/VAO/program/texture/context도 해제합니다.

문자 atlas는2048², DPR 변경 시 재구성합니다. 용량 초과는 Canvas 폴백입니다. GPU는 기본적인 glyph 배치와 선분별 butt 접합/타원 근사를 사용하며 Canvas의 모든 문자 shaping/line join과 동일한 픽셀은 보장하지 않습니다. 고밀도·단순 캔들의 비용은 다르므로 측정에 따라 선택하세요.

지표 정의의 `plotOffsets:{output:integer}`와 시리즈 `offset`은 원본 계산을 바꾸지 않고 화면 logical 위치만 이동합니다. Ichimoku는 spanA/B +26, chikou −26입니다. `get()`은 outputs와 plotOffsets를 반환하고 addSeries는 이를 기본 offset으로 사용합니다. fit/follow는 양의 선행 이동 공간을 포함합니다. 숨긴 시리즈는 autoscale과 이 공간 계산에서 제외합니다.

## Native 통합

```swift
import AsterNative // Package.swift를 local package로 추가
let engine = try AsterEngine() // 기본 빈 데이터, bundled core
try engine.setData([AsterBar(time:1700000000000,open:100,high:102,low:99,close:101,volume:300)])
// iOS:
let chart = AsterChartView(engine: engine)
chart.setTool("trendline")
// macOS/사용자 renderer:
let scene = try engine.scene(width:1200,height:700)
AsterCoreGraphicsRenderer.render(scene, in: cgContext) // top-left, Y down
```

Native scene은 JSON bridge이며 zero-copy가 아닙니다. Swift `call`과 Android `invoke`의 패널/시리즈/지표/스타일 facade 및 실제 실행 범위는 [NATIVE.md](NATIVE.md)를 참고하세요. 0.2.1의 `registerIndicatorSource`는 앱이 신뢰하는 JS factory를 JSCore/QuickJS에 등록합니다. JS 코어 자체의 register/snapshot/restore API는 동일합니다. UIKit/Android runtime을 실행 검증했지만 물리 기기와 완전한 픽셀·플랫폼 style 동등성은 검증하지 않았습니다. [공통 API 및 남은 격차](API-PARITY.md)를 참고하세요.

## 웹 Worker 계산

```js
import {prepareChartModel,recomputeInWorker,createChart} from '../src/index.mjs';
const abort = new AbortController();
const model = await prepareChartModel({columns, options:{
  panels:[{id:'price'}],
  indicators:[{id:'ema',name:'ema',params:{period:20}}],
  series:[{id:'p',type:'candles',panel:'price'},
          {id:'e',type:'line',panel:'price',indicator:'ema'}],
}}, {signal:abort.signal,onProgress:p=>showProgress(p)});
const chart = createChart(container,model);
await recomputeInWorker(model,{kind:'correction',bar:correctedBar},{signal:abort.signal});
// store 통지는 기존 renderer를 자동 invalidate합니다.
```

module Worker가 가능한 웹 전용 API이며 built-in factory만 실행합니다. 데이터/시리즈 구성/factory가 pending 중 변경되거나 dispose되면 결과를 버립니다. view/style 편집은 유지합니다. abort/timeout(기본30초)/worker 오류는 이전 모델을 유지하고 worker를 terminate합니다. event는 호출 시 snapshot하여 호출자의 재사용에 영향받지 않습니다. 모든 packet/metadata를 stage한 뒤 publish하므로 installation 오류도 원본을 유지합니다. WorkerURL 옵션은 앱이 신뢰하는 동일 프로토콜 module에만 사용하며 untrusted packet import가 아닙니다. columns는 메인에서 worker로 복사되므로 전송 전 main 복사 비용과 transient peak 메모리가 있습니다. 사용자 factory, formatter 함수 및 native JSCore/QuickJS worker는 지원하지 않습니다.

설정은 알려진 own keys/plain object를 받습니다. reserved key/unknown field/ID 변경을 거부합니다. 도형 import는 portable style/현재 존재 panel을 검사하며 immutable records로 보관합니다. 봉/패널/시리즈/출력/도형/history 제한과 observer 실패 정책은 AUDIT.md (not included in this source distribution)에 있습니다. `registerIndicatorSource`는 이름 있는 trusted API만 허용하고 JSON `dispatch`에서 제거했습니다.


## 취소 가능한 순수 상위 봉 계산

패키지 root 및 `/worker`의 `resampleOHLCVAsync(source,options)`는 전용 Worker에서 계산하고 결과만 반환합니다. source는 `{kind:'store',store}` 또는 변경 금지 계약의 `{kind:'immutable-columns',columns,length}`로 명시합니다. 동기 `/core` resample의 `{columns,length}`와 다른 타입입니다. `AbortSignal`, 전체 deadline, bounded copy/검증과 managed source stale 거절을 제공합니다. 자동 차트 설치나 native async facade는 없습니다. [전체 계약·예제·측정 한계](ASYNC-RESAMPLING.md)를 읽고 사용하세요.


## Async indicator settings (web/JavaScript)

Root/worker `setIndicatorParamsAsync(chart.api, id, params, options)` 계산은
전용 Worker에서 실행하고 기존 store/index/series/축/drawing을 보존한 채
대상 entry만 게시합니다. signal/timeoutMs/workerFactory/onProgress를 지원하며
동일 target의 중복 활성 요청은 BusyError로 거절합니다. 취소 후 settlement를
기다려 다음 요청을 시작하는 generation-safe 예제는
`examples/indicator-params-async.mjs`에 있습니다. 자동 무한 재시도는 없습니다.

출력 schema/기본 plot offset 변경은 동기 API처럼 거절합니다. canonical builtin
또는 양쪽 bundle에 미리 링크된 trusted module만 새 계산에 사용할 수 있습니다.
성공 후 invalidate 예외는 이미 게시된 상태를 실패로 되돌려 보고하지 않으며,
resolved result.observerError 및 선택적 onObserverError에 bounded 진단을 남깁니다.
이 새 async 정책은 기존 동기 changed()의 예외 전파와 다릅니다.
예산/codec/소유권/실행 범위는 [ASYNC-INDICATOR-PARAMS.md](ASYNC-INDICATOR-PARAMS.md)를
참조하세요. Node Worker 검증은 브라우저/실기기 UX 인증이 아닙니다.

## Portable workspace preparation

`saveWorkspace(chartAPI, datasetBinding)` exports bounded portable metadata without
source bars. `prepareWorkspaceAsync(store, text, {datasetBinding, signal, timeoutMs,
workerFactory, onProgress})` returns a new model sharing the caller-owned BarStore.
The existing chart remains untouched; host mounting/old-model disposal are explicit.
Dataset key/revision/adjustmentVersion/priceUnit/adjustment are host assertions, not
content fingerprints. Active gestures, custom formatters, external values and
unsupported styles reject export. See [WORKSPACES.md](WORKSPACES.md) for exact
ownership, schema, source-stale, memory, module and platform limits.

## Native workspace reads

Swift/Java facade source now has synchronous owner-thread `saveWorkspace(binding)`
and `preflightWorkspace(document, binding)` reads. Preflight returns
`status: 'validated-only', restored: false`; no calculation, restoration, job
reservation or redraw is implied. See [native workspace contract](NATIVE-WORKSPACES.md)
and [remaining native API work](NATIVE-FEATURE-PARITY.md). Generated bridge VM and
static-source checks do not certify new Swift/Java SDK compilation or devices.

## Linked web time cursors

`TimeCursorGroup` from `barochart/canvas` links up to eight live charts using an
explicit `exact` or `at-or-before` stored bar-open timestamp policy. It adds only
a transient vertical overlay; price, viewport and keyboard selection stay local.
`chart.timeCursor` exposes requested versus matched times. Mapping itself performs
no study calculation, but a later dirty receiver redraw can. See
[TIME-CURSOR.md](TIME-CURSOR.md) for lifecycle, gap semantics, bounds, the synthetic
two-chart example and unverified browser/UI limits.

## Atomic drawing group translation

`translateDrawings(ids, {deltaTimeMs, deltaPrice})` moves 1–128 explicit, unlocked drawings with one common panel/axis/series binding and one undo unit. It returns `{changed, invalidationFailed}`. All candidates and the full prior undo snapshot are validated before publication; active transactions/gestures reject. Zero or rounded-away changes preserve history and do not notify. See [raw-coordinate translation contract](DRAWING-TRANSLATION.md) for resource, failure, notification and precision rules. This core command does not add a multi-selection UI.

`deleteDrawings(ids)` removes 1–128 unlocked drawings in one undo unit. Mixed and orphan bindings are allowed without live metadata or indicator queries. Missing/locked IDs, active gestures, malformed lists or insufficient undo budget reject the whole operation. It returns `{changed, invalidationFailed}`; see [atomic drawing deletion](DRAWING-DELETE.md).

### Batch drawing styles

See [Atomic drawing style patches](DRAWING-STYLE.md) for `setDrawingsStyle(ids, patch)`, four portable style keys, stored-change receipts and one-undo failure atomicity.

### Optional drawing selection controls (web)

[Explicit drawing selection controls](DRAWING-PANEL.md) adds a separate bounded selection controller and an opt-in paged checkbox panel for group style/delete, visibility and duplication, with optional [style-only presets](DRAWING-STYLE-PRESETS.md). It does not change the chart's single pointer-selected drawing or workspace schema. The panel guide separates historical Mac style/delete focus checks from the newer modeled-only controls; recent controls and assistive-technology behavior still need real-platform QA.

### Shared-model refresh and renderer teardown

Sharing a model shares drawing records/history, but does not automatically redraw sibling renderers after drawing commands or previews. BarStore data notifications are separate. Use the [one-authority shared-model refresh recipe](SHARED-MODEL-REFRESH.md); it is host wiring with existing APIs, not an independent-model drawing synchronization service.


Destroying a CanvasChart (including its GPUChart subclass) rolls back a drawing gesture only when that controller captured the currently active drawing transaction. An idle sibling, a pan/wait sibling, or a stale creator cannot cancel another controller's or a later manual transaction. The dying controller still clears its own pointers and viewport gesture state. Explicit controller/native cancellation retains its existing semantics. A shared model also shares view, crosshair and drawing state; this does not provide independent views or simultaneous independent drawing transactions. Keep `disposeModel:false` while another renderer uses the model. Node fake-DOM and generated core VM regressions cover this ownership rule; device/browser resource lifetime is a separate validation scope.

Shared-model web input errors and tracked pointer cancellation also roll back only the receiving controller's captured drawing transaction. A second chart trying to begin while another drawing transaction is active receives the existing busy error; the first drawing survives and the second chart can try again after completion. A failed controller setup after its own begin rolls back that same transaction before propagating the error. Late pointercancel from an untracked pointer is ignored. Explicit core/native cancellation and intentionally shared model state retain their existing contracts.

A two-pointer pinch takeover likewise rolls back only a create/edit transaction belonging to that controller. A sibling pan becoming pinch preserves another chart's drawing transaction. Since the view is shared, an actual pinch zoom still changes the common projection; an ongoing drawing's existing projection-change cancellation applies on its next movement. This is ownership isolation, not independent shared-model viewports.

Renderer fallback follows the same drawing ownership rule as destroy: switching a sibling chart to Canvas does not cancel another chart's active transaction, while the owning chart's create/edit is rolled back. Existing source-canvas/controller reentry guards and explicit onFallback callback behavior are retained. This is tested by calling the actual fallback method under modeled DOM; it does not certify a physical GPU context-loss event.

If an explicit shared-model command cancels or replaces a controller's drawing transaction, its next pointer move or up retires only that stale local gesture and its tracked pointers. It cannot edit, roll back or commit the replacement transaction, including a replacement using the same drawing ID. The drawing move path rechecks ownership after layout creation. No immediate subscription-based cancellation is implied; a fresh pointer down is required to begin another gesture. Explicit cancel, tool/target changes and keyboard commands retain their documented shared/global behavior.

`setDrawingMagnet({mode: 'off' | 'weak' | 'strong', radiusPx?: number})` configures
per-controller OHLC snapping for drawing creation/individual handles. Default Off;
Weak defaults to 8 logical pixels (1–32), Strong selects nearest visible bar X
then nearest on-screen OHLC Y. See [drawing magnet](DRAWING-MAGNET.md) for axis
eligibility, tie rules, ownership, exclusions and native facade coverage.

`setCrosshairSnap({mode: 'free' | 'close' | 'ohlc', target?: DrawingTarget | null})`
configures a pointer crosshair independently of drawing magnet.
`crosshairSnapshot(width,height)` returns detached raw/resolved coordinates and
exact OHLC source metadata, or explicit unsnapped fields. Default Free preserves
legacy behavior and `crosshairValues` shape. See [crosshair snapping](CROSSHAIR-SNAP.md)
for eligibility, prepared-layout versus fresh-query costs, local/remote cursor
ownership, keyboard interaction and validation limits.

Long/short chart-only risk/reward annotations: [position drawings](POSITION-DRAWINGS.md),
including four semantic anchors, document v3, and read-only `positionMetrics(id)`.

`setDrawingVisibility(id, boolean)` and `setDrawingsVisibility(ids, boolean)` return `{changed, invalidationFailed}` with one atomic undo. Hidden drawings retain storage/history but are excluded from rendering and canvas selection. Locks permit visibility changes. See [visibility and v4 persistence](DRAWING-VISIBILITY.md).

`duplicateDrawing(id, {deltaTimeMs, deltaPrice})` / `duplicateDrawings(ids, options)` create unlocked chart-local copies with new IDs, an immutable source→copy receipt and one undo. Visibility is preserved. Both raw deltas are mandatory; see [duplication contract](DRAWING-DUPLICATION.md).

## Style-only drawing presets

`DrawingStylePresets` is an optional host-owned registry with explicit standalone JSON persistence. Capture stored portable style fields and apply a nonempty partial patch through the existing atomic drawing-style API. See [limits, receipts, panel usage and native boundaries](DRAWING-STYLE-PRESETS.md).

`saveBoundDrawings(chartAPI, identity)` and
`loadBoundDrawings(chartAPI, text, expectedIdentity)` provide opt-in exact
host-declared identity matching for primary-price drawings. They reject
secondary-axis/series bindings and unlabelled legacy documents; they do not
authenticate market data. Existing drawing/workspace formats and native commands
are unchanged. See [identity fields, compatibility, limits and callback semantics](BOUND-DRAWINGS.md).

## Manual bar replay

`BarReplay` is a separate synchronous core session with a copied host source, prefix-only fresh models with isolated forward study reuse, explicit start/step/seek/pause/reset, and detached frame/query results. It has no mutable model or live-feed attachment. See [BAR-REPLAY.md](BAR-REPLAY.md) for lifecycle, limits, staging/cold rebuild costs and the manual web example.
