# Android hover와 렌더 캐시

Android는 `AsterChartView`의 실제 `View`/Canvas/Skia와 QuickJS JNI를 사용합니다. WebView 경로와 별개입니다.0.2.7은 공유 `nativeRenderFrameJSON` 계약으로 base·drawing 장면이 바뀔 때만 전달하고, View가 물리 픽셀 크기의 bitmap에 두 층을 보관합니다. hover는 매번 별도 Canvas 명령으로 제출합니다. 빈 drawing 층에는 bitmap을 만들지 않습니다.

## API와 수명

```java
// View/공유 pool API는 Android main thread에서 호출합니다.
chart.setRenderCacheEnabled(false); // 직접 scene/Canvas 경로
chart.setRenderCacheEnabled(true);  // 기본값
AsterChartView.setSharedCacheBudgetBytes(64L * 1024 * 1024); // 기본64MiB
JSONObject local = chart.renderCacheMetrics();
JSONObject pool = AsterChartView.sharedCacheMetrics();
```

공유 예산은0..256MiB이며0은 직접 렌더링을 선택합니다. 예산은 살아 있는 캐시가 소유한 `Bitmap.getAllocationByteCount()`를 셉니다. QuickJS 장면 캐시·원본 데이터·Java 객체·RenderThread/GPU의 보관 사본·전체 RSS/PSS를 제한하는 예산은 아닙니다. 예를 들어1080×2400 ARGB8888 base는10,368,000bytes이며 drawing 층이 있으면 같은 크기가 하나 더 필요합니다.

pool은 View를 약한 참조로 기록하고 오래 사용하지 않은 다른 View부터 퇴출합니다. 메모리 callback·크기 변경·detach·disable·engine close 때 bitmap 소유권과 core frame token을 해제합니다. hardware display list가 아직 bitmap을 사용할 수 있으므로 즉시 `recycle()`하지 않습니다. 퇴출된 View를 invalidate해 다음 draw에서 이전 display list를 교체합니다. 이것이 즉각적인 RSS 반환을 보장하지는 않습니다.

예산 거부, bitmap allocation 오류, packet/렌더 오류는 직접 scene 렌더링으로 이어집니다. 부분 캐시는 버리고 core token도 제거합니다. 실패/메모리 정리 후 재시도는500ms가 지나거나 pool generation이 바뀐 뒤 실제 다음 draw에서 이뤄집니다. 재시도용 timer를 게시하지 않습니다. 크기 변경과 cache enable은 즉시 재구축을 허용합니다. 메모리 압력 아래 직접 scene 경로는 전체 bridge/parse 비용이 다시 발생합니다.

테마·시리즈·데이터·축·view 상태의 base 무효화와 drawing/selection 무효화는 공유 코어 계약을 따릅니다. drawing 층은 투명하게 합성하고 base bitmap은 `SRC`로 그려 RGBA 배경을 유지합니다. bitmap density는 `DENSITY_NONE`으로 설정해 다른 Canvas density에서도 물리 픽셀 크기로 복사합니다. 실제 다른 density 회귀의2,273,409 pixel mismatch를 수정한 뒤0 mismatch를 확인했습니다. close cleanup listener는 attached View만 구독하며 detach/close에서 제거합니다. 기존 change observer 격리·async cancellation·owner thread 규칙은 유지합니다.

마우스 `ACTION_HOVER_ENTER/MOVE`는 좌표를 density로 나누어 core pointer move로 전달합니다.0.2.7의 `nativeHoverExit`은 crosshair만 제거하므로 다른 touch의 drawing/pan gesture를 취소하지 않습니다. 기존 touch/pinch·키보드 경로를 유지합니다.

## 재현과 측정 경계

`HoverInstrumentation`은 `UiAutomation.injectInputEvent(SOURCE_MOUSE)`으로 Android 시스템 InputDispatcher에 이벤트를 주입합니다. `View.dispatchTouchEvent/dispatchGenericMotionEvent`를 직접 호출하는 fixture가 아닙니다. 매번 한 입력만 진행 중이며 실제 받은 `eventTime`, source8194, tool3과 다음 `onDraw` 제출을 연결합니다. baseline/candidate의 같은 `OnHoverListener` adapter는 capture clock과 `nativePointer` 전달을 수행합니다. 별도 기능 fixture는 adapter를 제거하고 기본 View의 시스템 hover/exit 경로도 확인합니다.

입력 주입 직전·이벤트 capture·Java `onDraw` 종료의 `System.nanoTime`을 기록합니다. `sceneJNISerializeMs`는 JNI 안의 코어 장면 생성·JS JSON 직렬화·반환을 포함합니다. 반환 JSON envelope의 decoding과 scene/frame 본문 `JSONObject` parsing을 분리합니다. Canvas 전체 단계, base/drawing bitmap raster, bitmap copy **명령 기록**, hover 명령 기록, accessibility 비용도 기록합니다. `onDraw` 종료는 CPU 제출 지점이며 GPU 완료·SurfaceFlinger presentation·물리 화면 반응 시간이 아닙니다.

Window `FrameMetrics`의 total/draw/sync/swapBuffers durations와 dropped reports를 별도 수집합니다. 이 framework duration도 물리 presentation timestamp가 아닙니다. main Handler16ms heartbeat는 측정 구간만 기록하며 timer 중단 직전 마지막 gap을 포함합니다. RSS/PSS 및 QuickJS/pool 수치는 구간 전후에 측정합니다. endpoint는 peak가 아니며 QuickJS requested peak는 해당 runtime 전체 수명 범위입니다.

고정 fixture는100,000봉/seed42, price panel의 `source:'close'` line1개/32개, recent indices99800..99999 또는 full0..99999입니다. 각 선의 range index는 별도로 생성됩니다. 브라우저/다른 native 프로파일의 `close+i*.1` aligned values와 값 구성이 다르므로 수치를 서로 직접 비교하지 않습니다. 이 Android before/after끼리는 같은 구성을 씁니다. measured viewport는1080×2400/density2.625, warmup15/measured60회이며 nearest-rank p50/p95/p99를 제공합니다. warm hover이며 최초 데이터 생성·첫 bitmap 생성·첫 장면/텍스처 업로드 비용을 포함한 cold latency 측정은 아닙니다.

전용 `/tmp/aster-avd/aster-validation.avd`, port5580, adb server5038만 사용합니다. runner는 다른 serial/port를 거부합니다. baseline 소스와 APK는 `/tmp/aster-cycle7-baseline`에 보존하며 수정하지 않습니다. scratch build는0.2.6 APK의 arm64 JNI 바이너리를 추출하고, 고정 core asset과 Java/helper 소스를 복사한 뒤 각 hash를 `build-manifest.json`에 기록합니다. baseline Java에는 시간 probe만 추가하고 기존 렌더 순서와 동작을 유지합니다. 최신 core 검증은 생성이 끝난 asset에 `--current-core`를 사용합니다. 이 fixture용 APK는 기존 제품이나 외부 배포가 아닌 로컬 debug 패키지입니다.

```sh
# 전용 emulator가 boot_completed=1인 상태에서 실행합니다.
# baseline: 보존된0.2.6 core/library + clock overlay
node scripts/build-android-hover.mjs --baseline
node scripts/test-android-hover.mjs --baseline

# Java cache 변경만 격리하려면 --current-core를 생략합니다.
# final0.2.7 core asset이 생성된 뒤 snapshot:
node scripts/build-android-hover.mjs --current-core
node scripts/test-android-hover.mjs --cache-test
node scripts/test-android-hover.mjs
node scripts/compare-android-hover.mjs
```

빌드 도구는 기존 Android SDK36/build-tools36, OpenJDK를 사용합니다. JNI/코어 전체를 이 scratch 빌드에서 재컴파일하지 않습니다. Java8 `-Werror -Xlint:-options`로 검사하며 기존 API의 deprecation note는 남습니다. 메인 APK 빌드는 `scripts/build-android.mjs`에 fixture3개를 포함합니다. `ASTER_HOVER_BUILD`, `ASTER_HOVER_REPORT`, `ASTER_HOVER_SAMPLES`로 scratch output/결과/sample 수를 지정할 수 있습니다. 원본의 기본값을 바꾼 결과는 별도 조건으로 표시해야 합니다.

추출한 소스 ZIP에서 현재 버전만 재현하려면 먼저 `npm run build:native`, `npm run build:android`를 실행하고 `node scripts/build-android-hover.mjs --current-core`를 실행합니다. 보존 baseline APK가 없으면 현재 로컬 `artifacts/android/aster-native.apk`의 JNI library를 사용하며 출처와 hash를 manifest에 기록합니다. baseline 비교는 고정0.2.6 소스 및 APK가 필요합니다. 보존 ZIP이나 로컬 Git baseline에서 다시 만들고 `ASTER_HOVER_BASELINE_ROOT=/path/to/aster-charts`, `ASTER_HOVER_BASELINE_APK=/path/to/aster-native-0.2.6.apk`로 명시하세요. 자동 다운로드·게시를 수행하지 않습니다. 비교 도구는 양쪽 JNI hash와 측정 adapter2개의 source hash가 같은지 확인합니다. 이 실행의0.2.6/0.2.7 JNI 바이너리는 실제 byte-identical입니다.

## 실행한 근거와 한계

API36 arm64 `sdk_gphone64_arm64`/SwiftShader 에뮬레이터에서 시스템 입력 smoke와 최종 before/after 각각4조건×60회가 성공했습니다. 다른 자체 compiler/test/benchmark 없이 순차 실행했습니다. 최종0.2.7 core hash는 `c01b55ea24afe1b8a2109b92f1ec418c918ffdd2262c2b102657a3f07414ca8d`, 양쪽 JNI hash는 `022a0b02e751dc40031daee1b1f1edbc50b6533c7aa304a085540fb3765e6139`입니다. core는0.2.6→0.2.7로 바뀌며 JNI와 측정 adapter2개는 같은 hash를 확인했습니다.

최종 nearest-rank p95(ms):

| 선/표시 범위 | onDraw0.2.6 | onDraw0.2.7 | capture→submit0.2.6 | capture→submit0.2.7 | injected→submit0.2.6 | injected→submit0.2.7 |
|---|---:|---:|---:|---:|---:|---:|
|1/recent200|2.038|0.481|2.309|0.742|36.695|37.453|
|1/full100k|7.350|0.476|7.607|0.803|35.386|35.429|
|32/recent200|48.418|0.553|48.789|0.894|101.744|36.548|
|32/full100k|193.101|0.635|193.391|0.872|270.924|35.666|

32line/full100k의 warm onDraw p95는99.67%, injected→submit p95는86.84% 감소했습니다.1line의 injected→submit p95는 recent에서2.07%, full에서0.12% 늘어 작은 장면의 전체 입력 latency 개선은 주장하지 않습니다. 최초 병목 프로파일과 최종 비교는 별도 실행이며 최종 수치로 판단합니다.

32line/full100k의 본문 전달 크기 p50은1,122,575→2,997chars, 최종 JNI/JS serialization p50은0.150ms, body parse0.118ms, bitmap copy 명령 기록0.00775ms, hover 명령 기록0.09346ms였습니다. 모든240개의 최종 샘플이 cache 사용/base·drawing rebuild0회였으며 base bitmap은10,368,000bytes입니다. 같은 조건의 heartbeat gap p95는200.657→19.932ms, framework FrameMetrics total p95는294.742→22.144ms였습니다. 각 조건60FrameMetrics/drop0을 받았으며 이 수치를 physical FPS나 presentation latency로 바꾸지 않습니다.

원본·환경/hash·p50/p95/p99·전후 RSS/PSS endpoint는 before (not included in this source distribution), after (not included in this source distribution), 비교 (not included in this source distribution)에 있습니다. 메모리 수치는 native requested allocation, Java-owned bitmap과 process RSS/PSS를 분리합니다. RSS/PSS의 전후 snapshot으로 장기간 누수나 최고 사용량을 판단하지 않습니다.

최종0.2.7 core를 사용하는 cache 기능 실행에서97개 체크를 통과했고20상태의 모든 픽셀이 direct software Canvas와 정확히 일치했습니다. 테스트는 transparent overlay의 채널 단위 반올림을 고려해 최대1 unit을 허용하되 실제 mismatch 수와 최대 차이를 모두 기록합니다. 실제 창 `PixelCopy`의 foreground도 확인했습니다. 기본 View의 시스템 hover/exit와 활성 touch gesture 보존, 읽기 명령의 revision/observer 보존, hover/base reuse, RGBA 배경·다른 Canvas density, theme, drawing 선택/편집/undo/redo/delete, correction/autoscale/full range, resize, budget denial/direct/retry, 공유 pool/engine close, cleanup 오류 후 해제, 다른 owner thread의 동기식 offscreen rendering, 실제 HOME/복귀와 Activity recreation을 검증했습니다. 기능 결과 (not included in this source distribution), density 수정 전 실패 (not included in this source distribution)와 함께 최종 APK의 axes15/shared13/UI4, retained terminal handles240checks/11handles/original Activity collection 회귀도 확인했습니다.

`onTrimMemory` 검증은 등록된 callback을 fixture가 직접 호출한 것입니다. 실제 OS low-memory kill, 자연 OOM, API26 기기 실행, 다른 ABI, 물리 Android 기기, 모든 GPU/backend, 긴 기간의 누수 없음은 검증하지 않았습니다. 기능 fixture의 pixel 비교는 software Canvas 두 경로의 비교이며 PixelCopy만으로 전체 hardware pixel parity를 주장하지 않습니다. 기존 async/retained-job 회귀와 앱 lifecycle 검증 결과는 해당 별도 보고서와 함께 해석해야 합니다.
