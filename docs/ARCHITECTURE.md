# 설계와 성능 비용

## 경계

```
외부 OHLCV/DataEvent
        ↓
BarStore (Float64 SoA + RangeIndex)
        ↓                   ↓
IndicatorEngine         ChartModel ↔ DrawingStore
        └───────────────────┘       ↑
                           InteractionController
                   ↓
     createLayout + buildScene (renderer-neutral display list)
              ↓                          ↓
 Canvas 2D / WebGL2          JSON bridge / JavaScriptCore or QuickJS
                                         ↓
                          Swift CoreGraphics / AppKit / UIKit / Android Canvas
```

코어는 DOM, Canvas, AppKit, UIKit에 의존하지 않습니다. Canvas renderer만 browser event/RAF/ResizeObserver를 소유합니다. JSCore host와 CoreGraphics renderer는 Swift 타입으로 분리합니다. 네이티브에 웹페이지를 넣는 구조가 아닙니다. JavaScriptCore의 앱 내 평가 API와 CoreGraphics의 2D 그리기를 사용합니다. [Apple JavaScriptCore](https://developer.apple.com/documentation/javascriptcore), [CoreGraphics](https://developer.apple.com/documentation/coregraphics).

## 언어 선택

실행 환경에 Node 26, Chrome, Swift 6.4/Xcode가 있었고 wasm Rust target은 설치돼 있지 않았습니다. 웹과 Apple host는 기존 런타임의 ECMAScript + Swift를 선택했습니다. Android SDK/NDK/JDK도 설치되어 있어 MIT QuickJS 원본을 JNI로 컴파일하여 같은 코어를 실행했습니다. QuickJS는 인터프리터이며 JSC/V8과 같은 속도를 가정하지 않습니다. JIT와 typed arrays의 실제 비용을 측정합니다. C++/Rust/wasm/Metal이 항상 더 빠르다고 가정하지 않습니다. 이 구현에서 첫 병목은 컬럼 입력에서 매 봉 임시 객체를 만드는 경로였으며 직접 숫자 검사로 제거했습니다. 변경 전·후 raw 측정은 `core-baseline.json`과 `core.json`입니다. 단일 측정 비교이므로 통계적 개선율의 보장값으로 해석하지 않습니다.

## 데이터와 range index

시간·OHLC·거래량 6개 Float64Array를 power-of-two capacity로 할당합니다. min(low), max(high), sum(volume)의 flat segment tree를 별도로 보관합니다.

* bulk load/트리 구성: O(N)
* append/update: O(log N), capacity 성장 시 O(N) 복사·재구성
* min/max/sum query: O(log N)
* OHLCV LOD: O(W log N), W는 화면 candle bucket 수
* 원본 저장+트리: capacity당 96 byte, capacity=1,048,576이면 100,663,296 byte

100만 원본 봉 전체를 화면에 그리는 경우도 candle geometry는 CSS 가로폭 약 3px당 1 bucket으로 제한합니다. 각 구간의 first open, max high, min low, last close, summed volume을 보존합니다. 일반 선은 가로 pixel 구간의 마지막 값과 min/max vertical envelope를 그립니다. 집계 표현은 모든 원본 점을 겹쳐 그리는 영상과 다를 수 있습니다. min/max envelope는 구간 내부 값의 시간 순서까지 보존하지 않습니다.

구간 트리는 가격 자동 범위·팬·줌마다 전체 원본을 스캔하는 비용을 줄입니다. 화면 장면은 object/number-array display list이고 완전한 zero-allocation 프레임 파이프라인은 아닙니다. 부호별 캔들 body·wick 명령을 batch하여 그리기 호출을 줄입니다. Canvas는 dirty request를 한 RAF로 합치고 크기 변경 때만 bitmap을 다시 할당합니다. 크로스헤어만 움직여도 현재는 scene 전체를 다시 제출하며 별도 overlay/layer 캐시가 없습니다.

## 지표

기본 256봉마다 각 지표 상태를 snapshot합니다. append/current update는 그 checkpoint에서 최대 한 block 정도를 다시 계산하고 과거 수정은 해당 block부터 모든 suffix를 다시 계산합니다. 결과 출력은 별도 Float64Array입니다. 지표 선의 range index도 변경 suffix만 갱신하며 큰 수정은 O(N) bulk 재구성합니다. 262144봉 이상 일반시리즈는32봉 block min/max tree와 원본 edge scan(최대62값)을 사용합니다. 트리 저장을32배 줄이며 update는한 block+tree, query는edge+O(log blocks)입니다. 스타일만 바꾸면 values/revision/index를 유지합니다. reset/prepend는 full recompute입니다.

EMA/RSI/ATR/MACD/ADX 같은 stateful 지표의 append 정확성을 확보하면서 역사 correction도 배치 결과와 같게 합니다. state snapshot 크기는 기간/지표에 의존하고 long-period custom indicator는 checkpoint 메모리를 크게 늘릴 수 있습니다. WMA/CCI는 O(period) per bar이며 모든 지표에 동일한 처리속도를 주장하지 않습니다. 동기 코어/native에서 여러 지표 초기화나 reset은 UI 스레드를 점유합니다. builtin과 양쪽에 정적으로 연결한 versioned module은 웹 module Worker의 prepare/recompute API 또는 native의 별도 VM/runtime 초기 준비·수정 경로로 이동할 수 있습니다. 임의 custom factory/source는 동기 전용입니다. dependency graph, wasm/SIMD는 미구현입니다. 연결·codec 규약은 [INDICATOR-MODULES.md](INDICATOR-MODULES.md)에 있습니다.

## 정리와 스레드

store subscription, observer, DOM listener와 RAF는 명시적으로 해제합니다. 코어는 single writer이고 동기적입니다. `store.columns`, result views, 모델 internals를 동시에 외부에서 바꾸는 동작은 지원하지 않습니다. Swift JSContext도 동일 소유 스레드에서 호출합니다. GPU render thread/native background 계산은 구현하지 않았습니다. 웹 worker는 자체 모델/소유 buffers를 만들고 transferable packet으로 메인에 전달합니다. Node lifecycle 테스트와 Chrome explicit-GC 측정은 특정 경로의 resource 해제를 보여주며 모든 호스트 앱의 누수 부재를 보장하지 않습니다.

tick detail과 calendar cache는 제한하지만 원본 BarStore는 maxBars guard를 적용하지만 자동으로 오래된 봉을 버리지 않습니다. tail ring buffer, eviction/downsampling storage, out-of-core 데이터는 향후 범위입니다. 실시간 업데이트의 평상시 비용과 capacity 증가 시 지연은 구분해야 합니다.

## 성능 목표의 다음 단계

먼저 실제 interactive viewport, 다중 차트, 다수 indicator, 지속 stream, 역사 correction의 latency와 memory를 재현 측정해야 합니다. native JSON encode/decode와 bitmap 재할당, 대량 초기 지표 계산, 많은 draw commands가 측정 가능한 병목 후보입니다. 현재 데이터에서 60Hz에 가까운 rAF interval을 관측했어도 고주사율·실제 모바일·GPU 구성의 성능 목표가 충족됐다는 뜻은 아닙니다. Metal/WebGPU renderer나 native worker/wasm 계산은 이런 근거에 따라 추가할 수 있도록 경계를 분리했습니다.

## GPU 구현과 측정된 비용

밀집32시리즈의 Canvas submit+readback 비용을 확인한 뒤 WebGL2 instanced quad 경로를 추가했습니다. 각 instance는 screen corners8, RGBA4, UV4의 Float32 16개(64 bytes)입니다. 같은 clip의 연속 명령을 painter order대로 batch하고 scissor로 패널을 제한합니다. 문자만 Canvas2D로 atlas를 생성하고 실제 문자·geometry는 GPU에서 그립니다. 삼각형 strip instancing을 사용하며 raw price/time/indicator/anchor를 GPU에 업로드하지 않습니다.

처음 구현에서 임시 array spread/slice·Float32 packing의 CPU 비용도 컸습니다. quad packing의 임시 배열을 제거했습니다. glyph atlas는2048² RGBA(논리16MiB), instance buffer는 power-of-two로 재사용합니다. 이 할당 크기는 driver VRAM 실측과 다릅니다. 단순 캔들에는 atlas/GL 초기화와 동기화 비용이 불리해 Canvas 기본을 유지합니다. GPU context loss/초기화/atlas 실패는 canvas를 교체해 fallback하며 model을 유지하고 gesture를 cancel합니다. 복구 후 GPU 자동 재선택은 없습니다.

프로파일은 scene CPU, renderer CPU submit, submit+1pixel readback 완료, EXT timer query를 구분합니다. query는 GPU 명령 구간 시간이며 CPU 명령 도착 대기를 포함할 수 있습니다. Canvas와 GPU의 시각 표현은 joins/AA/glyph에서 다르므로 성능을 픽셀 동일 비교나 display FPS로 주장하지 않습니다. browser가 실제 ANGLE Metal/M4Pro를 보고한 환경에서만 실행했습니다. 별도 직접 Metal/WebGPU renderer는 없습니다.

## 공통 facade와 native invalidation

`core/api.mjs`의 ChartAPI는 같은 모델에 JSON 호환 명령을 적용합니다. core/계산/LOD 정책은 유지하며 portable color를 RGBA hex로 정규화하고, 지표 등록과 series plot을 분리합니다. CanvasChart는 facade 변경을 기존 RAF에 연결합니다. Swift engine은 mutation observers, Android engine은 attach/detach view listeners를 사용합니다. read 호출을 mutation으로 통지하지 않아 draw→scene→draw 루프를 만들지 않습니다. 새 설정 생성은 검증에 성공한 뒤 이전 native model을 해제합니다. raw call/invoke는 자동 invalidation 계약 밖의 기존 escape hatch입니다.

성공한 setSeries patch는 add/replace 공유 순수 검증을 거쳐 기존 painter 위치를 대체합니다. style/visible 변경은 데이터 range cache를 보존하고 source/values/indicator/output 변경만 다시 구성합니다. JSON null로 indicator/custom values를 제거할 수 있습니다. setData/columns와 indicatorValues의 JSON 복사는 native hot path 비용이며 zero-copy 또는 background 계산이라는 주장은 하지 않습니다. 글꼴 family/size는 native renderer에 전달되지만 설치된 face/AA는 OS가 결정합니다.

## Immutable history와 계산 전달

DrawingStore는 저장 record/points/style을 freeze하고 변경되는 한 record만 복사합니다. history/redo/transaction은 record references 배열을 공유하며 public snapshot은 deep copy입니다. conservative serialized byte budget이 오래된 history를 제한합니다. geometry는 immutable drawing + store/timeVersion/view/layout/font key로 캐시하고 compact geometry의 bbox miss를 screen 변환 전에 거부합니다. frozen app-owned fixtures도 이 계약을 따릅니다.

Web worker checkpoint는 object graph 대신 UTF8 byte stream/Uint32 offsets로 전송하고 main은 Map-like lazy container를 설치합니다. 최초 load decode0개, incremental calculation은 필요한 checkpoint만 decode(캐시32개)합니다. 이는 압축이나 native worker 기능이 아닙니다. input event/config/data revision은 request의 일관된 snapshot이며 abort/stale/fault-install 시 기존 chart를 유지합니다. packet validation/staging 후 publish 및 notification을 수행합니다. 실제 전달 buffers와 wall/main longtask는 AUDIT.md (not included in this source distribution)에 분리 기록합니다.

0.2.3 correction은canonical future state를Object.is재귀비교해같아진checkpoint 뒤를재사용합니다. dirtyTo를통해다중queued수정범위를보호하고,series가여러indicatorrevision을놓치면index를rebuild합니다. 웹packet은expectedrequest와상태schema를설치전에검증합니다. native는별도VM/runtime의boundedchunks와targetarrays를소유하고ownercontext전달은worker완전종료후실행합니다. 인터페이스/제한은[ASYNC-CONTRACT.md](ASYNC-CONTRACT.md).
