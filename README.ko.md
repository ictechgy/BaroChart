# BaroChart (바로차트)

직접 공급하는 데이터로 만드는 금융 차트 라이브러리입니다. DOM에 의존하지 않는 Float64 코어, Canvas/WebGL2 렌더러, 선택형 React 어댑터와 Apple/Android 네이티브 통합 경로를 제공합니다.

[English](README.md) · [API](docs/API.md) · [검증 범위](docs/PUBLIC-VALIDATION.md)

**0.2.13 개발 프리뷰입니다.** 소스 라이선스는 Apache-2.0이며, npm에는 아직 게시하지 않았습니다. Mac Chrome 155에서 일부 브라우저 동작을 확인했습니다. 보조기술·다른 브라우저·최근 네이티브 호스트 변경은 실제 플랫폼 검증이 남아 있습니다. 도입 전에 [현재 검증 범위와 한계](docs/PUBLIC-VALIDATION.md)를 확인하세요.

## 주요 기능

- 캔들, OHLC, 선, 영역, 히스토그램 시리즈와 다중 패널, 독립 가격축, 이동·확대·실시간 갱신
- SMA, EMA, RSI, MACD, Bollinger Bands, ATR, Ichimoku, 세션 기반 VWAP 등을 포함한 **35종 기본 지표**
- 시간·가격 앵커를 사용하는 **14종 그리기 도구**, 선택·편집·잠금·undo/redo
- 과거 봉 수정, 순서가 있는 수집 배치, 화면과 독립적인 데이터 조회, 세션 기준 OHLCV 리샘플링
- 데이터 소유권과 검증 규칙을 명시한 차트 구성·도형·지표 설정 저장

코어와 웹 렌더러에는 외부 npm 런타임 의존성이 없습니다. React는 `/react`를 사용할 때만 필요한 선택형 peer입니다. 시세 공급자 연결, 거래소 캘린더와 주문 실행은 호스트 앱이 담당합니다.

## 데모 실행

**Node.js 22 이상**이 필요합니다. 현재 클라우드 검증 환경은 Node.js 24.19.0입니다. 기본 웹 데모와 코어 테스트에는 패키지 설치가 필요하지 않습니다.

```sh
git clone https://github.com/ictechgy/BaroChart.git
cd BaroChart
npm run demo
```

[http://127.0.0.1:5173/examples/web/](http://127.0.0.1:5173/examples/web/)을 여세요. 데모는 고정 seed의 **합성 데이터**를 사용하며 렌더러, 지표, 도형, 테마와 스트림 시뮬레이션을 바꿔 볼 수 있습니다.

같은 서버의 다른 예제:

- [독립 가격축](http://127.0.0.1:5173/examples/web/axes.html)
- [금융 좌표·시간 정렬](http://127.0.0.1:5173/examples/web/financial.html)
- [세션 분석·사용자 모듈](http://127.0.0.1:5173/examples/web/analysis.html)
- [차트 간 시간 커서 연결](http://127.0.0.1:5173/examples/web/linked-cursors.html)
- [시간 범위 연결 예제](http://127.0.0.1:5173/examples/web/linked-ranges.html): 저장된 봉 시간으로 뷰 범위를 동기화합니다. [API 계약](docs/TIME-RANGE.md).
- [도형 그룹 선택과 일괄 편집](http://127.0.0.1:5173/examples/web/drawing-groups.html)

테스트는 별도로 실행합니다.

```sh
npm test
# node --test --test-concurrency=1 test/*.test.mjs
```

직접 차트를 만드는 실행 예제는 [영문 README의 첫 차트 예제](README.md#your-first-chart)에 있습니다. 저장소 상대 경로로 import하므로 npm 게시를 기다릴 필요가 없습니다. 차트를 넣는 요소에는 실제 높이를 지정하세요.

## 앱에서 사용하기

npm 배포 전에는 이 저장소로 만든 로컬 tarball을 설치하세요.

```sh
mkdir -p /tmp/barochart-pack
npm pack --ignore-scripts --pack-destination /tmp/barochart-pack

# 사용할 앱의 디렉터리에서:
npm install /tmp/barochart-pack/barochart-0.2.13.tgz
```

로컬 패키지를 설치하면 다음과 같이 import합니다.

```js
import { BarStore, ChartModel, createChart } from 'barochart';
```

- `barochart/core`: DOM 없는 데이터·지표·모델·그리기·계산 API
- `barochart/canvas`, `barochart/webgl`: 웹 렌더러
- `barochart/worker`: Worker 기반 준비·계산 API
- `barochart/worker-entry`: 별도로 번들링할 Worker 진입점
- `barochart/react`: 선택형 React 웹 어댑터

TypeScript 선언을 포함합니다. DOM 타입이 없는 Node 앱에는 `/core`를 사용하세요. 예제·테스트·벤치마크는 저장소에 있고 npm tarball에는 포함되지 않습니다.

### React

React 컴포넌트 이름은 호환성을 위해 `AsterChart`를 유지합니다.

```jsx
import { AsterChart } from 'barochart/react';

export function PriceChart({ bars }) {
  return <AsterChart data={bars} style={{ height: 420 }} />;
}
```

React 18.3.1 또는 19를 선택형 peer로 사용하고 ReactDOM은 앱이 설치합니다. [React 통합 계약](docs/REACT.md)에서 스트림, `dataRevision`, 모델 소유권, 정리와 SSR 제한을 확인하세요. [TypeScript 예제](examples/react-web/README.md)는 첫 `npm ci`에 npm registry 연결이 필요합니다.

### 네이티브와 이름 호환성

Apple은 JavaScriptCore/CoreGraphics와 SwiftPM, Android는 QuickJS/JNI/Canvas와 library/AAR 빌드 경로를 사용합니다. 이 렌더러 경로는 WebView를 사용하지 않습니다. [Swift SDK](docs/SWIFT-SDK.md), [Android SDK](docs/ANDROID-SDK.md), [네이티브 통합](docs/NATIVE.md)을 참고하세요.

최근 Swift·Android 호스트 변경은 현재 검증 환경에서 **실제 SDK 빌드·기기 실행을 완료하지 않았습니다.** 과거 플랫폼 실행 결과로 이후 변경까지 검증되었다고 볼 수 없습니다. React Native와 Flutter 어댑터는 제공하지 않습니다.

이전 이름인 Aster의 다음 식별자는 의도적으로 유지합니다.

- React: `AsterChart`, `AsterChartHandle`
- Swift: `AsterNative`, `AsterEngine`, `AsterChartView`
- Android: `dev.aster.charts`와 기존 클래스·JNI 이름
- 저장 문서 스키마·브라우저 이벤트: `aster.*`, `aster:*`

제품 이름은 BaroChart, npm 패키지 이름은 `barochart`입니다. 저장된 문서의 스키마 식별자를 제품 이름에 맞춰 바꾸지 마세요.

## 사용 전에 알아둘 계약

- **시간·숫자:** 유한한 OHLCV와 엄격한 오름차순의 UTC Unix **정수 밀리초**를 받습니다. Float64는 임의 정밀도 십진수 연산이 아닙니다. 기본 시간축은 봉을 같은 간격에 배치해 비거래 구간을 압축합니다. [데이터 계약](docs/DATA.md)
- **배열 소유권:** OHLCV 입력은 복사합니다. 저장소 컬럼과 지표 출력 view는 읽기 전용입니다. 외부 `series.values`는 참조를 유지하므로 변경 후 지원하는 setter로 다시 적용해야 캐시가 갱신됩니다.
- **지표 이력:** 원본 봉으로 계산하며 seed, warm-up의 `NaN`, 세션 경계와 0분모 처리에 따라 다른 구현과 결과가 달라질 수 있습니다. [수치 규약](docs/INDICATORS.md) · [세션 분석](docs/SESSION-STUDIES.md)
- **비동기 비용:** Worker API는 취소·stale 검사·논리 메모리 예산을 사용합니다. 복사·검증·할당 비용은 남으며 응답성을 개선해도 전체 완료시간과 메모리 비용은 늘 수 있습니다. 예산은 프로세스 RSS나 최대 UI 차단시간 보장이 아닙니다.
- **명시적 이력 축소:** `api.compactData({ keepLastBars, studyHistory: 'restart' })`는 동기식 유지보수입니다. 모든 지표를 남은 구간에서 다시 시작하므로 전체 이력 계산의 끝부분과 값이 달라질 수 있습니다. 자동 삭제가 아니며 소유권·수집 상태 조건을 먼저 충족해야 합니다. [이력 축소 계약](docs/DATA-COMPACTION.md)
- **저장·복원:** workspace는 이동 가능한 설정을 저장하며 OHLCV나 앱 전체 세션을 포함하지 않습니다. 복원할 데이터와 일치하는 binding은 호스트가 제공합니다. [Workspace 계약](docs/WORKSPACES.md)
- **정리:** 소유한 모델까지 해제할 때 `chart.destroy({ disposeModel: true })`를 호출합니다. 모델을 공유한다면 마지막 소유자가 별도로 정리하고, 앱이 만든 timer와 구독도 해제하세요.

Canvas가 기본 렌더러입니다. `renderer: 'webgl2'`로 GPU 경로를 선택할 수 있으며 초기화·렌더 오류나 컨텍스트 손실 시 Canvas로 폴백할 수 있습니다. 장면·기기에 따라 비용이 다르고 문자 조합·선 접합의 픽셀 결과도 완전히 같지 않습니다.

## 문서

- [API·그리기·수명](docs/API.md) · [독립 가격축](docs/INDEPENDENT-AXES.md)
- [데이터 조회](docs/DATA-EXPLORER.md) · [순서가 있는 수집](docs/INGESTION.md)
- [지표 설정 변경](docs/INDICATOR-PARAMETERS.md) · [비동기 설정 변경](docs/ASYNC-INDICATOR-PARAMS.md) · [사용자 모듈](docs/INDICATOR-MODULES.md)
- [OHLCV 리샘플링](docs/RESAMPLING.md) · [비동기 리샘플링](docs/ASYNC-RESAMPLING.md)
- [아키텍처](docs/ARCHITECTURE.md) · [렌더 레이어](docs/RENDER-LAYERS.md)
- [현재 검증 범위](docs/PUBLIC-VALIDATION.md) · [기여 가이드](CONTRIBUTING.md)

일부 상세 문서에는 이전 버전 실행 기록과 Aster 이름이 남아 있습니다. 현재 검증 요약에서 과거 결과와 이번 프리뷰의 검증 범위를 구분합니다.

## 검증 범위와 한계

공개 이름 변경 전 Linux/Node 전체 테스트는 **2,552개 중 2,551개 통과**했습니다. 한 dry-run CLI가 15초 watchdog 제한에 걸렸고, 같은 파일을 수정 없이 단독 재실행했을 때는 **131/131 통과**했습니다. 전체 실행에서 발생한 실패 원인은 해결되지 않았으므로 전체 통과로 표기하지 않습니다.

Mac Chrome 155에서 도형 패널·연결 커서·키보드 탐색과 Canvas/WebGL 1회 왕복을 확인했습니다. 화면 낭독기·다른 브라우저·장시간 렌더링은 아직 검증하지 않았습니다. 독립 QuickJS 실행과 Android 타입 stub을 사용한 Java 검사는 실제 SDK·JNI·기기 검증을 대신하지 않습니다. 모든 환경의 성능 우위, 상용 제품과의 동등성, 실기기 FPS를 입증한 상태가 아닙니다.

```sh
npm test
npm run check
# 별도로 설치한 TypeScript 5.9 이상 사용:
TSC_PATH=/absolute/path/to/typescript/lib/tsc.js npm run check:types
TSC_PATH=/absolute/path/to/typescript/lib/tsc.js npm run check:package
```

브라우저·네이티브 검사는 각 문서의 브라우저, SDK와 호스트 권한이 필요합니다. 자세한 실행 범위와 비용 해석은 [PUBLIC-VALIDATION.md](docs/PUBLIC-VALIDATION.md)에 있습니다.

## 라이선스

BaroChart는 [Apache License 2.0](LICENSE)으로 제공합니다. 귀속과 별도 라이선스 구성 요소는 [NOTICE](NOTICE)와 [라이선스·출처](docs/LICENSING.md)를 확인하세요. npm registry 배포 준비 전까지 패키지의 `private: true`를 유지합니다.
