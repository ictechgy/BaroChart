# 바로차트 첫 도입

[English](GETTING-STARTED.md) · [API](API.md)

로컬 체크아웃으로 시작합니다. 현재 `0.3.0-dev`는 npm·SwiftPM 릴리스 태그·Maven Central에 공개되지 않았습니다. 예제는 합성 데이터를 사용하므로 계정이나 시세 API 키가 필요 없습니다.

## 먼저 분석 흐름 체험하기

저장소 루트에서 Node.js 22 이상으로 실행합니다.

```sh
npm run demo
```

[메인 분석 화면](http://127.0.0.1:5173/examples/web/)에서 지표를 추가하고 선을 그린 뒤 **도형 관리**를 엽니다. 목록에서 도형을 숨기거나 복제하고 **분석 파일 저장**을 누르세요. 차트를 바꾼 뒤 **분석 파일 복원**으로 저장한 시세·지표·도형·표시 범위를 되돌릴 수 있습니다. 복원 후 합성 스트림은 일시 정지합니다. [흐름과 파일 제한](ANALYSIS-DEMO.md).

작은 데이터로 먼저 보려면 [4봉 예제](http://127.0.0.1:5173/examples/web/quickstart.html)를 엽니다. 이 주소들은 로컬 데모 서버가 실행 중일 때 작동합니다.

## 플랫폼 선택

| 대상 | 실행 예제와 가이드 | 생성·갱신·해제 |
| --- | --- | --- |
| JavaScript / TypeScript | [웹 첫 차트 소스](../examples/web/quickstart.mjs) | 높이가 있는 컨테이너에 모델·차트를 만들고 데이터를 갱신합니다. 소유 화면이 끝날 때 `chart.destroy({disposeModel: true})`로 해제합니다. |
| React 웹 | [TypeScript 소비자](../examples/react-web/README.md) | `barochart/react`의 `AsterChart`와 ref API를 사용합니다. 어댑터가 만든 모델은 unmount 때 해제하며 빌린 모델은 앱이 해제합니다. |
| SwiftUI / UIKit | [SwiftUI 샘플](../examples/swiftui-sample), [iOS 가이드](IOS-GUIDE.ko.md) | 앱이 메인 스레드에서 엔진을 만들고 `setBars`/`apply`로 갱신합니다. 뷰는 엔진을 빌리며 엔진 소유자가 수명 종료 때 닫습니다. |
| Compose / Android View | [Compose 샘플](../examples/compose-sample), [Android 가이드](ANDROID-GUIDE.ko.md) | 앱이 소유 스레드에서 엔진을 만들고 갱신합니다. 소유자 종료 때 `close()`를 호출합니다. 뷰 해제가 엔진을 닫지는 않습니다. |

### 일반 웹 패키지

저장소 루트에서 소스 tarball을 만듭니다.

```sh
npm pack --ignore-scripts --pack-destination /tmp
```

앱 프로젝트에서 출력된 `barochart-0.3.0-dev.tgz`를 설치한 뒤 다음처럼 가져옵니다.

```sh
npm install /tmp/barochart-0.3.0-dev.tgz
```

```js
import {BarStore, ChartModel, createChart} from 'barochart';
```

[첫 차트 전체 소스](../examples/web/quickstart.mjs)의 상대 import를 위 패키지 import로 바꾸면 됩니다. 현재 봉 교체와 페이지 종료 시 해제도 포함돼 있습니다. [패키지 상세](PACKAGE-CONSUMPTION.md).

### React 소비자

```sh
cd examples/react-web
npm ci
npm run typecheck
npm start
```

`http://127.0.0.1:5174`를 엽니다. 예제의 잠긴 개발 의존성을 설치하는 과정이며, 의존성 설치가 필요 없는 일반 웹 데모와 별개입니다. `AsterChart`는 호환성을 유지하는 export 이름입니다. React Native 컴포넌트는 제공하지 않습니다.

### SwiftUI 샘플

Xcode에서 `examples/swiftui-sample/BaroChartSample.xcodeproj`를 열고 `BaroChartSample` 스킴과 iOS Simulator를 선택해 실행합니다. 저장된 프로젝트가 로컬 SDK를 참조하므로 공개 태그가 필요 없습니다. 프로젝트를 재생성할 때만 XcodeGen이 필요합니다.

**Pause → Line → Save → Restore**로 기본 흐름을 확인합니다. 이 네이티브 샘플의 Save는 시세를 제외한 워크스페이스를 저장하므로 Restore에는 같은 원본 데이터가 필요합니다. [수명과 데이터 이벤트](IOS-GUIDE.ko.md).

### Compose 샘플

Android Studio에서 `examples/compose-sample`을 열고 API 26 이상 기기·에뮬레이터로 `app`을 실행합니다. 포함된 Gradle 빌드가 로컬 SDK를 연결합니다. Android 도구와 의존성 준비에는 다운로드가 필요할 수 있습니다.

**Pause → Line → Save → Restore**로 확인합니다. iOS와 마찬가지로 이 샘플의 워크스페이스는 같은 원본 데이터를 요구합니다. [수명과 데이터 이벤트](ANDROID-GUIDE.ko.md).

## 시세 연결

[실행 가능한 초기 조회·스트림 레시피](FEED-INTEGRATION.ko.md)로 조회/이벤트 겹침, 순번 누락, 취소와 재연결을 확인합니다. 로컬 예제는 `node scripts/serve-feed.mjs`로 실행합니다.

## 첫 통합 확인

1. 크기가 0이 아닌 컨테이너에 차트가 표시됩니다.
2. 같은 UTC 밀리초 시각으로 현재 봉을 교체하고, 더 늦은 시각으로 새 봉을 추가합니다.
3. 잘못된 입력은 오류로 보고되며 수락된 데이터는 유지됩니다.
4. 화면을 떠날 때 소유한 자원을 해제하고, 다시 돌아오면 사용 가능한 차트를 만듭니다.

시세 구독·취소·저장은 호스트 앱이 담당합니다. 바로차트는 시세를 공급하거나 주문을 실행하지 않습니다. 먼저 알려진 데이터로 확인한 뒤 앱의 피드를 연결하세요. [데이터 계약](DATA.md) · [수집 예제와 경계](INGESTION.md) · [현재 지원 범위](../README.ko.md#지원과-검증-범위).
