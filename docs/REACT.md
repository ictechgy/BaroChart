# React 웹 통합

0.2.9의 `barochart/react`는 기존 imperative 모델·Canvas/WebGL2 위의 작은 React 어댑터입니다. React Native·Flutter 어댑터가 아닙니다. 기본 `/core`·`/canvas`·`/webgl`·`/worker` 소비에는 React가 필요하지 않습니다. SDK의 runtime dependencies는 0개이고 `/react`만 선택적 React peer를 사용합니다.

## 시작

실제 TypeScript 예제는 [examples/react-web](../examples/react-web/README.md)입니다.

```sh
cd examples/react-web
npm ci
npm run typecheck
npm start
# http://127.0.0.1:5174
```

기존 React 앱은 저장소에서 `npm pack --ignore-scripts --pack-destination /tmp`로 만든 로컬 tarball을 설치하고 아래 진입점을 사용합니다. TypeScript 앱에는 앱이 선택한 React 버전의 `@types/react`와 DOM lib가 필요합니다. ReactDOM은 소비 앱이 설치합니다. SDK의 root 선언은 React 선언을 가져오지 않습니다. Node의 DOM 없는 계산은 `/core`를 사용하세요.

```tsx
import {useRef} from 'react';
import {AsterChart, type AsterChartHandle} from 'barochart/react';
import type {Bar} from 'barochart/core';

export function PriceChart({bars}: {bars: readonly Bar[]}) {
  const ref = useRef<AsterChartHandle>(null);
  return <AsterChart ref={ref} data={bars} style={{height: 420}}
    aria-label="Price chart" onError={error => console.error(error)} />;
}
```

## 데이터와 모델 소유권

`data`는 OHLCV 봉 배열 또는 `{columns, length?}`입니다. 입력을 검증하고 복사하며 원래 TypedArray buffer를 detach/transfer하지 않습니다. 봉 배열은 배열 identity, 컬럼 입력은 6개 컬럼 identity와 length를 비교합니다. 같은 컬럼을 새 wrapper에 넣는 rerender는 데이터를 다시 복사하지 않습니다. 같은 배열의 값을 바꾼 경우 `dataRevision`을 변경하세요. 이 규칙은 데이터 내용을 매 React render마다 스캔하는 비용을 피합니다.

실시간 tick은 `ref.current?.api?.applyDataEvent(...)`로 전달합니다. tick마다 React 상태를 갱신할 필요는 없습니다. `data`를 생략하면 adapter가 imperative 데이터 변경을 덮어쓰지 않습니다. 변경 없는 `data` prop도 append/correction을 매 rerender마다 reset하지 않습니다. `data`를 생략하면 비교 cache를 비우므로, 이후 같은 배열/컬럼을 다시 제공하면 한 번 적용합니다. 이때 imperative로 추가한 봉도 제공한 데이터로 바뀝니다. 일반 시리즈의 별도 `values`는 기존 저수준 모델의 borrowed-readonly·notify 계약을 따릅니다. OHLCV `data` 복사 계약을 모든 외부 시리즈에 확대하지 않습니다.

모델 지정 방식은 둘 중 하나입니다.

* `model`: 앱이 소유하는 살아 있는 `ChartModel`. renderer 정리와 재생성 뒤에도 모델을 dispose하지 않습니다. 앱이 마지막 소비자까지 정리한 뒤 모델을 해제합니다.
* `createModel`: effect마다 **새 모델과 소유 store**를 만드는 factory. renderer 재생성·StrictMode 재실행 시 다시 호출하고 각 모델을 adapter가 dispose합니다. 공유 모델/store를 이 factory에서 반환하지 마세요. 기본 factory는 새 candle 모델을 만듭니다.

`createModel` 함수 identity 변경만으로 모델을 재생성하지 않습니다. 초기 설정 변경 후 재생성이 필요하면 `resetKey`를 바꾸세요. 모델/store 할당은 SSR이나 React render 중 실행되지 않습니다. `model`과 `createModel`을 함께 전달하면 오류를 보고합니다.

## 갱신과 수명

`theme`, `tool`, `text`, `drawingTarget`, `visibleRange`는 값이 바뀔 때 기존 chart API에 적용합니다. 생략하면 imperative 값을 유지하며 매 프레임 prop 값으로 되돌리는 완전한 controlled-state 모델은 아닙니다. `visibleRange={null}`은 fit입니다. theme 필드, target ID와 range 숫자는 값으로 비교하므로 동일한 inline wrapper가 gesture를 취소하거나 render loop를 만들지 않습니다. tool/text/target/range를 생략하면 현재 imperative 값을 유지하며 마지막 prop의 비교 cache를 비웁니다. 이후 이전과 같은 prop 값도 다시 적용합니다. 잘못된 target의 추가 키 또는 prototype을 수정하면 ID가 같아도 재검증합니다.

partial theme의 `undefined` 필드는 기존 값을 유지합니다. 거부된 prop도 시도한 값을 기록하므로 `onError`에서 React 상태를 바꾸더라도 같은 오류를 무한히 되풀이하지 않습니다. 수정한 값·dataRevision·resetKey로 명시적으로 재시도할 수 있습니다. 생략 후 같은 값을 다시 제공하는 것도 새로운 적용 시도입니다.

`model`, `renderer`, `resetKey` 또는 실제 constructor 옵션(dpr 함수, interactive, observeResize, layerCaching, maxCachedPixels, rasterCaching, cacheBudget) 변경은 renderer를 재생성합니다. 소유 factory 모델의 상태도 새로 시작하므로 유지할 상태는 borrowed 모델에서 관리하세요. `renderer` 기본은 Canvas이며 `webgl2`·`auto`가 가능합니다.

`onReady({chart,model})`는 초기 데이터·테마·도구·range 적용 후 호출되며 동기 cleanup 함수를 반환할 수 있습니다. 스트림 구독과 timer를 이 함수에서 해제하세요. async onReady/Promise cleanup은 지원하지 않으며 타입 검사에서 거부합니다. JavaScript 소비자가 thenable을 반환하면 계약 TypeError를 onError로 보고하고, 거절도 onError로 전달해 unhandled rejection을 막습니다. 나중에 resolve된 cleanup 함수를 실행하는 async 수명 계약은 제공하지 않습니다. 해제 순서는 다음과 같습니다.

1. adapter 이벤트 구독 제거 및 ref getters를 null로 전환
2. `onReady`가 반환한 cleanup
3. chart의 RAF·ResizeObserver·입력·캐시 정리
4. `onDispose({chart,model})`
5. adapter가 소유한 모델 dispose

콜백/cleanup 예외는 `onError`에 보고하며 나머지 정리를 계속합니다. `onDispose`에서는 chart가 이미 정리됐고 소유 모델은 아직 살아 있습니다. `onRender`, `onState`, `onError`, `onFallback`, `onDispose`는 최신 committed 콜백을 사용하며 콜백 교체만으로 chart를 재생성하지 않습니다. ref의 `chart`·`model`·`api` getters는 effect 밖에서 null일 수 있습니다. 이전 lifecycle의 API를 보관해 사용하지 마세요.

host는 기본 높이 320px인 div입니다. style/className/HTML 속성을 전달할 수 있지만 children은 지원하지 않습니다. 툴바·로딩 UI·접근성 대체 데이터 뷰는 host 밖에 배치하세요.

## SSR·번들·검증 한계

SSR import/render는 모델·DOM을 생성하지 않고 빈 host markup을 반환합니다. plain ReactDOM의 서버 렌더와 실제 브라우저 hydration을 검사합니다. `'use client'` 표시가 있지만 Next.js/RSC 전체 실행이나 모든 SSR framework를 검증한 것은 아닙니다.

이번 생략·재제어·target 교정·완료 observer·실제 Worker 결과는 0.2.9 웹 QA (not included in this source distribution), 보존된 실제 tarball 소비자의 버전·StrictMode·스트리밍·실패·정리 결과는 0.2.8 React QA (not included in this source distribution), DOM 없는 타입·tree shaking·optional peer·worker와 bundle bytes는 패키지 검증 (not included in this source distribution)에 기록합니다. Vite 기본 worker와 esbuild 별도 worker 출력은 서로 다른 통합 방법입니다. 이번 native transaction/idle 검사도 각 Apple/Android fixture에서 별도로 실행합니다. React 통과를 native 검사로 합산하지 않습니다.

## Live web input preferences

`options.interaction` synchronizes through `setInteractionOptions` without rebuilding the renderer or owned model. See [web customization](WEB-CUSTOMIZATION.md) for defaults, strict validation and omitted-key semantics. This change has modeled hooks/DOM tests only, not a new actual React/StrictMode/browser run. The setter is not a read-only boundary, and keyboard switches do not remap shortcuts.
