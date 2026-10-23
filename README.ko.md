# BaroChart (바로차트)

**내 데이터로 만드는, 내 앱에 맞는 차트.**

DOM 없는 Float64 코어, Canvas/WebGL2 렌더러, 선택형 React 어댑터와 Apple/Android 네이티브 통합 경로를 제공하는 금융 차트 라이브러리입니다. 데이터와 저장, 화면 구성의 주도권은 호스트 앱에 있습니다.

[English](README.md) · [빠른 시작](#빠른-시작) · [웹·모바일 웹 화면](#웹모바일-웹-화면) · [API](docs/API.md)

> **개발 프리뷰 · 0.2.13 · Apache-2.0.** npm 미출시입니다. [지원·검증 범위](#지원과-검증-범위)를 확인하세요.

<p align="center">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="assets/showcase/desktop-dark.png">
<img src="assets/showcase/desktop-light.png" alt="프로덕션 Canvas 차트가 포함된 BaroChart 브라우저 쇼케이스">
</picture>
</p>

BaroChart로 구성한 웹 화면입니다. 합성 캔들·EMA·거래량·RSI를 실제 브라우저에서 캡처했습니다. `npm run demo` 실행 후 [예제 열기](http://127.0.0.1:5173/examples/web/showcase.html) · [캡처 정보](docs/EXAMPLE-SCREENSHOTS.md#current-browser-showcase).

## 무엇을 만들 수 있나요?

- **차트·지표:** 캔들, OHLC, 선, 영역, 히스토그램, 여러 패널·가격축과 **35종 내장 지표**. EMA, RSI, MACD, 볼린저 밴드, 일목균형표, 세션 VWAP 등을 포함합니다.
- **그리기·복기:** **16종 그리기 도구**, 롱/숏 위험·보상 표시, 다중 선택·잠금·undo/redo, 수동 봉 리플레이와 세션·북마크 메타데이터.
- **맞춤 UI:** 다크/라이트, 색상·폰트, 도구 모음 구성, 명시적 데스크톱/모바일 입력 프리셋, 선택형 모서리 overlay slots와 navigator.
- **저장된 차트:** 차트 구성·지표·드로잉·뷰포트를 저장하는 버전 있는 workspace와 별도의 입력·도구 모음 설정 codec. 저장소와 복원 책임은 앱이 가집니다.
- **데이터 통합:** 실시간 봉 교체·추가, 과거 데이터 수정, 수집 큐, OHLCV 리샘플링, 차트 간 시간 커서·범위 연결과 외부 tradeID 마커.

코어·웹 렌더러에는 **npm 런타임 의존성이 없습니다.** React는 선택형입니다. 시세 공급, 주문 실행, 계정, 매매 일지 서버와 클라우드 동기화는 제공하지 않습니다. tradeID 마커는 호스트 데이터를 표시할 뿐 주문을 넣지 않습니다.

## 빠른 시작

**Node.js 22 이상**을 사용하세요. 기본 웹 데모에는 의존성 설치가 필요하지 않습니다.

```sh
git clone https://github.com/ictechgy/BaroChart.git
cd BaroChart
npm run demo
```

[기본 데모](http://127.0.0.1:5173/examples/web/index.html), [최소 첫 차트](http://127.0.0.1:5173/examples/web/quickstart.html), [UI 커스터마이징](http://127.0.0.1:5173/examples/web/customization.html)을 여세요. 이 주소들은 데모 서버가 실행 중인 내 컴퓨터에서만 동작합니다. 데이터는 모두 **합성 데이터**이며 실시간 시세 연결이 아닙니다.

## 웹·모바일 웹 화면

### 현재 브라우저 쇼케이스

같은 데이터를 다크·라이트 테마로 보여 주는 390px 모바일 웹 화면입니다. 위 데스크톱 이미지는 GitHub 테마에 맞춰 전환됩니다.

<p>
<img src="assets/showcase/mobile-dark.png" width="390" alt="BaroChart 다크 모바일 브라우저 캡처">
<img src="assets/showcase/mobile-light.png" width="390" alt="BaroChart 라이트 모바일 브라우저 캡처">
</p>

다크 / 라이트 · 직접 구성한 웹 예제의 실제 브라우저 캡처. [소스·이미지 해시](assets/showcase/manifest.json).

<details>
<summary>이전 캡처와 소스 기반 미리보기</summary>

### 웹: 과거 실제 브라우저 캡처

1분·5분 차트의 저장된 시각 범위를 연결한 예제입니다. **2026-10-14**, macOS Chrome 155.0.8059.79, 소스 **`e3284e54`**에서 촬영한 원본 PNG입니다. 이후 추가된 v88 기능 전체의 최신 실행 화면은 아닙니다.

![과거 실제 웹 캡처: 시간 범위가 연결된 차트](assets/screenshots/web-linked-ranges.png)

<details>
<summary>실제 웹 화면 더 보기: 도형 그룹과 연결 커서</summary>

![과거 실제 웹 캡처: Undo 후 도형 그룹 선택](assets/screenshots/web-drawing-groups.png)

![과거 실제 웹 캡처: 연결 커서와 값 읽기](assets/screenshots/web-linked-cursors.png)

</details>

### 모바일 웹: 소스 기반 UI 미리보기

**390 CSS px 폭**을 기준으로 만든 다크/라이트 미리보기입니다. 차트는 실제 scene/Canvas 그리기 코드와 합성 OHLCV로 그렸고, 주변 도구 모음은 보관된 소스 버전의 모바일 프리셋·커스터마이징 CSS에 근거한 설명용 구성입니다. **브라우저 스크린샷이나 네이티브 화면, 터치 기기 검증 결과가 아닙니다.**

<p>
<img src="assets/previews/mobile-web-dark-preview.png" width="390" alt="다크 모바일 웹 UI 미리보기. 실제 브라우저 캡처 아님">
<img src="assets/previews/mobile-web-light-preview.png" width="390" alt="라이트 모바일 웹 UI 미리보기. 실제 브라우저 캡처 아님">
</p>

[커스터마이징 예제](http://127.0.0.1:5173/examples/web/customization.html)에서 모바일 프리셋을 선택하고 화면 폭을 줄여 볼 수 있습니다. 기기 자동 감지는 하지 않으며, 예제 CSS는 920px 이하에서 도구 모음을 차트 위에 배치합니다. [전체 갤러리·출처·재생성 방법](docs/EXAMPLE-SCREENSHOTS.md).

</details>

## 첫 차트 만들기

[quickstart.html](examples/web/quickstart.html)에 높이가 있는 컨테이너가 준비되어 있습니다. 아래는 실제 [예제 모듈](examples/web/quickstart.mjs)의 전체 코드입니다. 시각은 UTC Unix **밀리초**입니다.

```js
import { BarStore, ChartModel, createChart } from '../../src/index.mjs';

const store = new BarStore([
  { time: 1700000000000, open: 100, high: 103, low: 99, close: 102, volume: 500 },
  { time: 1700000060000, open: 102, high: 104, low: 101, close: 103, volume: 650 },
  { time: 1700000120000, open: 103, high: 105, low: 102, close: 104, volume: 700 },
  { time: 1700000180000, open: 104, high: 106, low: 103, close: 105, volume: 800 },
]);
const model = new ChartModel({ store });
model.addSeries({ id: 'price', type: 'candles', panel: 'price' });
model.indicators.add('ema3', 'ema', { period: 3 });
model.addSeries({
  id: 'ema3', type: 'line', panel: 'price',
  indicator: 'ema3', color: '#f0b755',
});
model.fit();
const chart = createChart(document.getElementById('chart'), model, {
  renderer: 'canvas',
});

// Same timestamp replaces the last bar; a later timestamp appends.
store.upsert({
  time: 1700000180000, open: 104, high: 107,
  low: 103, close: 106, volume: 900,
});

// Preserve the chart across back/forward-cache navigation; dispose on exit.
window.addEventListener('pagehide', event => {
  if (!event.persisted) chart.destroy({ disposeModel: true });
});
window.addEventListener('pageshow', event => {
  if (event.persisted && !chart.disposed) chart.resize();
});
```

컴포넌트를 해제할 때 모델까지 소유하고 있다면 `chart.destroy({ disposeModel: true })`를 호출하세요. 공유 모델은 마지막 소유자가 별도로 정리하고, 앱의 timer·구독도 중단해야 합니다. 기본은 Canvas이며 `renderer: 'webgl2'`는 Canvas 폴백이 있는 선택 경로입니다. 기기와 장면에 무관한 성능이나 동일한 문자 픽셀을 보장하지 않습니다.

## 앱에 설치하기

**아직 npm에 게시하지 않았습니다.** 이름이 같은 다른 registry 패키지를 설치하지 말고, 이 소스로 로컬 tarball을 만드세요.

```sh
mkdir -p /tmp/barochart-pack
npm pack --ignore-scripts --pack-destination /tmp/barochart-pack

# 사용할 앱의 디렉터리에서:
npm install /tmp/barochart-pack/barochart-0.2.13.tgz
```

설치 후에는 소스 상대 경로 대신 다음 import를 사용합니다.

```js
import { BarStore, ChartModel, createChart } from 'barochart';
```

TypeScript 선언을 포함합니다. 진입점은 `barochart/core`(DOM 없음), `/canvas`, `/webgl`, `/worker`, `/worker-entry`, 선택형 `/react`입니다. 예제·테스트·벤치마크·갤러리 이미지는 저장소에만 있고 npm 배포 내용에는 포함하지 않습니다.

### React

호환성 export 이름은 `AsterChart`를 유지합니다.

```jsx
import { AsterChart } from 'barochart/react';

export function PriceChart({ bars }) {
  return <AsterChart data={bars} style={{ height: 420 }} />;
}
```

앱이 React 18.3.1/19와 ReactDOM을 제공합니다. [React 소유권·스트림·SSR 계약](docs/REACT.md) · [실행 가능한 TypeScript 예제](examples/react-web/README.md).

## UI·UX 커스터마이징

새 차트를 만들 때 프리셋을 선택하고 도구 모음을 명시적으로 붙입니다.

```js
import { CanvasChart, attachChartToolbar, createChartUIPreset } from 'barochart';

const ui = createChartUIPreset('mobile');
const chart = new CanvasChart(chartElement, readyModel, {
  interaction: ui.interaction,
});
const toolbar = attachChartToolbar(emptyToolbarElement, chart, ui.toolbar);
toolbar.setOptions({labels: {select: '이동', fit: '전체 보기'}});
```

- 모바일 프리셋: 선택 허용 거리 24px, 휠 줌 꺼짐, 편안한 가로 도구 모음. 호스트가 스타일을 바꾸기 전 편안한 도구 모음 버튼의 **최소 너비와 높이는 44px**입니다.
- 테마·폰트·도구 구성/순서/간격, 패널 높이 비율과 가격축 방향을 설정합니다. [Overlay slots](docs/CHART-OVERLAYS.md), [navigator](docs/CHART-NAVIGATOR.md), [trade 마커](docs/TRADE-MARKERS.md)는 선택해서 붙입니다.
- 커스터마이징 스튜디오는 localStorage로 **외관 프로필을 명시적으로 저장·불러오기**하고 JSON을 가져오거나 내보냅니다. 자동 저장은 없으며 색상·패널 배치·입력·도구 문구·표시 옵션을 저장하고 드로잉과 데이터는 현재 차트에 유지합니다. 앱의 저장 기능은 [UI 상태](docs/WEB-UI-STATE.md)와 [workspace](docs/WORKSPACES.md)를 조합하세요.
- 키보드 옵션은 켜기/끄기이며 **단축키 재매핑이 아닙니다.** 자유로운 패널 도킹과 네이티브 UI 동등 지원도 포함하지 않습니다. [전체 계약](docs/WEB-CUSTOMIZATION.md).

## 예제와 문서

| 살펴볼 기능 | 로컬 예제 | 계약 |
| --- | --- | --- |
| 수동 리플레이·북마크 | [봉 리플레이](http://127.0.0.1:5173/examples/web/bar-replay.html) | [공개된 prefix만 사용](docs/BAR-REPLAY.md), 자동 재생 없음 |
| 상대 성과 비교 | [비교 차트](http://127.0.0.1:5173/examples/web/comparison.html) | [명시적 기준·시간 정렬](docs/RELATIVE-COMPARISON.md) |
| 뷰 연결 | [시간 범위](http://127.0.0.1:5173/examples/web/linked-ranges.html) · [커서](http://127.0.0.1:5173/examples/web/linked-cursors.html) | [시간 범위](docs/TIME-RANGE.md) · [공유 모델 소유권](docs/SHARED-MODEL-REFRESH.md) |
| 드로잉 작업 | [도형 그룹](http://127.0.0.1:5173/examples/web/drawing-groups.html) | [스타일 프리셋](docs/DRAWING-STYLE-PRESETS.md) · [위험/보상](docs/POSITION-DRAWINGS.md) |
| 실시간 묶음 갱신 | [수집 큐](http://127.0.0.1:5173/examples/web/ingestion-queue.html) | [호스트 소유 데이터 수집](docs/INGESTION.md) |
| 데이터·분석 | [분석 화면](http://127.0.0.1:5173/examples/web/analysis.html) | [지표](docs/INDICATORS.md) · [수집](docs/INGESTION.md) · [리샘플링](docs/RESAMPLING.md) |

[API·수명 관리](docs/API.md) · [데이터 규칙](docs/DATA.md) · [독립 가격축](docs/INDEPENDENT-AXES.md) · [구조](docs/ARCHITECTURE.md) · [기여](CONTRIBUTING.md)

## 지원과 검증 범위

| 통합 경로 | 제공 내용 | 주요 제한 |
| --- | --- | --- |
| 일반 웹 | Canvas/WebGL2와 HTML 컨트롤 | 과거 Chrome의 일부 흐름 확인. 최신 UI·기기 동작은 브라우저 QA 필요 |
| React 웹 | 선택형 `AsterChart` 어댑터 | 최신 모의 hooks 테스트가 실제 React/SSR 실행을 대신하지 않음 |
| 모바일 웹 | 명시적 입력 프리셋·반응형 예제 CSS | 이미지는 설명용 미리보기. 터치·스크롤·보조 기술 미검증 |
| Apple 네이티브 | JavaScriptCore/CoreGraphics·SwiftPM | [Swift SDK](docs/SWIFT-SDK.md). 최근 호스트 변경은 실제 SDK·기기 검증 필요 |
| Android 네이티브 | QuickJS/JNI/Canvas·library/AAR 경로 | [Android SDK](docs/ANDROID-SDK.md). 최근 호스트 변경은 실제 SDK·기기 검증 필요 |

네이티브 경로는 WebView가 아닙니다. React Native/Flutter 어댑터는 없습니다. `AsterChart`, `AsterNative`, `AsterEngine`, `dev.aster.charts`, `aster.*` 식별자는 호환성을 위해 유지하며 저장 스키마 이름을 바꾸면 안 됩니다.

Node 계약 테스트, strict TypeScript, 오프라인 패키지 소비자 검사는 자동 검사이며 브라우저·기기 인증은 아닙니다. Float64는 임의 정밀도 십진수가 아니며 workspace 복원에는 맞는 호스트 데이터가 필요하고 Worker에도 복사·할당 비용이 있습니다. [전체 검증 이력·한계](docs/PUBLIC-VALIDATION.md) · [상태·소유권 로드맵](docs/MARKET-ROADMAP.md).

<details>
<summary>이전 검증 기록과 보존한 실패</summary>

2026-10-18 소스 `381fb00fc41c49aadfb72f45fb0c0a66f500d62c`에서 **4,870/4,870** Node 테스트, 513 ESM 구문 검사, strict TypeScript 5.9.3과 오프라인 패키지 검사가 통과했습니다. 브라우저·네이티브 실행 결과를 의미하지 않습니다.

그보다 이른 Linux/Node 기준은 **2,551/2,552** 테스트가 통과했습니다. 한 dry-run CLI가 15초 watchdog에 걸렸고, 변경하지 않은 해당 파일만 다시 실행했을 때 **131/131** 통과했습니다. 당시 전체 실행 실패를 삭제하거나 전체 성공으로 바꾸지 않습니다.

</details>

```sh
npm test
npm run check
# 설치된 TypeScript 5.9+ 컴파일러가 있을 때:
TSC_PATH=/path/to/typescript/lib/tsc.js npm run check:types
TSC_PATH=/path/to/typescript/lib/tsc.js npm run check:package
```

이 로컬 명령은 게시하지 않습니다. 브라우저·네이티브 검사는 각각 문서에 명시된 환경과 권한이 필요합니다.

## 라이선스

[Apache License 2.0](LICENSE) · [NOTICE](NOTICE) · [제3자 구성요소](docs/LICENSING.md). 패키지는 `private: true`이며 registry 출시를 선언하는 문서가 아닙니다.
