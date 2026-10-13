# 웹 장면과 래스터 레이어

최신0.2.6의 공유 cache 정책·예산, gap/alpha 수정, Apple frame renderer와 실행 범위는 CYCLE6-VALIDATION.md (not included in this source distribution)를 보세요. 아래 이전 결과·계약은 해당 버전의 기록입니다.

0.2.5는 기본 웹 렌더러의 RAF 경로에 데이터·축, 완료/편집 중 도형, 크로스헤어의 세 레이어를 사용합니다. 코어 `buildScene()`은 기존의 완전한 장면을 계속 반환합니다. Canvas와 WebGL2가 같은 코어 좌표와 drawing/axis helpers를 사용하며 `lastScene`, render event, 자동 갱신, 폴백 계약을 유지합니다. 네이티브 CoreGraphics/Android Canvas에는 이 웹 래스터 캐시를 추가하지 않았습니다.

## 갱신 규칙

* 포인터 이동은 마지막 데이터·축 및 도형 픽셀을 복원하고 새 크로스헤어를 그립니다. 이전 overlay를 남기지 않습니다.
* 도형 드래그·선택·문서 변경은 데이터·축 픽셀을 재사용하고 도형 레이어를 재합성합니다.
* 줌·팬·데이터 버전·series/indicator 설정·축/range·theme/font·크기·DPR 변경은 기본 레이어를 다시 만듭니다. dirty flag는 이후 hover가 덮어쓰지 않습니다.
* 명시적 `drawNow()`와 기본 `invalidate()`는 전체 장면을 재평가합니다. formatter closure 내부 값처럼 참조 비교로 알 수 없는 변경은 이 경로로 알립니다. 일반 API 변경은 자동으로 invalidate합니다.
* WebGL 컨텍스트 손실/렌더러 실패 시 진행 중 gesture를 취소한 뒤 현재 모델에서 장면을 다시 만들고 Canvas로 폴백합니다. 취소 전 미완성 도형을 폴백 프레임에 복사하지 않습니다.

장면 캐시는 최신 기본 장면 하나와 최신 도형 참조 목록 하나만 유지합니다. 과거 viewport별 캐시를 쌓지 않습니다. 완료된 도형과 UI/history 전송은 별개이며 undo/redo 문서를 래스터 캐시로 대체하지 않습니다. 직접 입력 배열을 변경한 사실을 자동 검출하는 계약도 추가하지 않습니다. 외부 값 변경은 `setSeriesValues` 등 정식 API로 알리세요.

Canvas는 DOM에 붙이지 않은 opaque Canvas 두 개(base/stable)를 사용합니다. 매 hover에 stable 전체를 표시 Canvas로 복사한 뒤 hover 명령만 실행합니다. WebGL2는 RGBA8 texture/FBO 두 개와 지원되는 sample 수의 공유 MSAA scratch renderbuffer를 사용합니다. MSAA 결과를 texture에 resolve하고 stable texture를 fullscreen quad로 표시합니다. 기본 framebuffer의 형식·sample 수에 의존하는 복사 대신 이 경로를 사용합니다. 관련 형식/샘플 규칙은 [Khronos WebGL 2 규격](https://registry.khronos.org/webgl/specs/latest/2.0/)을 참고하세요.

## 메모리와 설정

```js
const chart = createChart(host, model, {
  renderer: 'webgl2',
  layerCaching: true,        // 기본값
  maxCachedPixels: 8388608,  // device pixel 수, 기본값
});
// 메모리 우선 호스트는 layerCaching:false 또는 maxCachedPixels:0.
```

추가 Canvas raster 용량은 width×height×8바이트입니다. WebGL 추가 용량은 width×height×4×(2+MSAA sample 수)입니다. 1200×700 CSS/DPR2 및 실제 4 samples에서 각각 26,880,000바이트와 80,640,000바이트입니다. 기본 화면·glyph atlas·브라우저/드라이버 비용은 이 추가 용량 밖입니다. private 96MiB 추가 raster guard와 `maxCachedPixels` 중 더 엄격한 조건을 적용하며 초과하면 기존 full render 경로를 사용합니다. 이 수치는 알려진 할당 크기이며 GPU VRAM 최고 사용량 측정이 아닙니다.

`renderMetrics`는 직전 제출의 `baseRedrawn`, `drawingsRedrawn`, `cachedPixelBytes`, `hoverCommands` 및 GPU resolve/present 횟수를 제공합니다. `timings`는 캐시를 사용한 프레임에도 실제 해당 제출 CPU 시간을 기록합니다. `destroy()`는 숨은 Canvas와 표시 Canvas의 크기를 0으로 만들고 장면 참조·FBO·texture·renderbuffer·glyph Canvas·CPU instance 배열을 해제합니다. 보관된 chart handle의 해당 소유 자원도 검증합니다.

NaN이 포함된 시리즈에는 finite-count index를 사용합니다. 전체 visible window가 유한하면 추가 bucket gap query를 생략합니다. 공백이 있는 dense LOD bucket은 실제 유한 관측점을 순회하여 연속 구간만 그립니다. NaN에서 path를 끊으며 단일 유한 관측점과 histogram 관측점도 보존합니다. 전체가 유한한 bucket은 기존 min/max LOD를 사용합니다. flat series index는 power-of-two capacity당 16바이트가 추가되고, block index는 100만 값에서 524,288바이트가 추가됩니다. prepared index는 worker에서 생성·검증하여 설치합니다.

## 실제 검증과 범위

`npm run test:layers`는 설치된 Chrome에서 Canvas/WebGL2×DPR1/2를 실행합니다. 428개 단언과 94개 픽셀 비교에서 위 갱신·undo/redo·percent/log/inversion·correction/append/prepend/reset·resize/DPR·formatter closure·캐시 비활성화/재활성화·컨텍스트 손실 후 gesture 취소를 확인했습니다. 각 프레임의 commands/geometry는 독립 full scene과 일치합니다. Canvas 픽셀은 동일 readback backend에서 오차 0입니다. GPU는 MSAA resolve/overlay AA 차이 때문에 RGB MAE<0.05, 큰 오차 픽셀 비율<0.0005, channel 오차<96을 요구하며 실제 최대값은 별도 JSON에 보존합니다.

Canvas 기능 검사에서 반복 readback에 따른 software/GPU backend 전환을 통제했습니다. WebGL 기본 buffer가 compositor 후 지워질 수 있으므로 `aster:render` 안에서 픽셀을 읽었습니다. 실제 성능 검사는 이 기능 검사의 Canvas backend override를 사용하지 않습니다. 모든 browser/GPU/font의 동일 픽셀이나 물리 디스플레이 FPS를 보장하는 결과가 아닙니다.

같은 0.2.4 조건의 전후 실측과 추가 메모리·full redraw 비용은 CYCLE5-VALIDATION.md (not included in this source distribution)에 기록합니다. 원본: `benchmarks/results/cycle5-layers-browser.json`.

## 0.2.7 겹친 AA 경계의 정확성 우선 경로

WebGL의 resolved raster를 다시 샘플링한 뒤 MSAA hover를 겹치면 원래 per-sample coverage 상관관계가 사라집니다. 겹친 반투명 사각형 경계 재현(420×320, DPR1, light, cursor180/140)에서 0.2.6의 큰 오차 픽셀 비율은 0.000758929로 기존 0.0005 기준을 넘었습니다. 같은 커서를 5px 이동한 경우는 통과했습니다. 허용치를 높이지 않았습니다.

0.2.7은 WebGL의 drawing commands가 있는 장면을 full raster 경로로 제출합니다. SceneCache의 기본/도형 geometry 재사용은 유지하며, Canvas와 Apple/Android bitmap cache 정책은 그대로입니다. 도형이 없는 불투명 WebGL 장면의 raster cache도 유지합니다. 도형이 보이는 WebGL hover는 전체 instance packing/raster 제출 비용을 다시 부담하므로 일반적인 캐시 성능으로 보고하면 안 됩니다. 비트맵 예산 0 역시 정확성과 자원 반납을 유지하지만 전체 raster 비용을 부담합니다.

WebGL2가 따르는 GLES3의 framebuffer blit는 multisample draw target에 대한 per-sample 복사 경로를 제공하지 않습니다. [GLES3 §4.3.3](https://registry.khronos.org/OpenGL/specs/es/3.0/es_spec_3.0.pdf), [WebGL2 blitFramebuffer](https://registry.khronos.org/webgl/specs/latest/2.0/#3.7.4)를 확인하고, 이번에는 범용 shader/coverage 재설계 대신 위 정확성 경로를 적용했습니다. 실제 드라이버별 모든 중첩이 해결되었다고 주장하지 않습니다.

`node test/aa-overlap-browser.mjs`는 DPR1/2, 예산0/복원/정상, 같은 겹침/5px 이동의 10프레임을 full raster oracle과 비교합니다. 기존 MAE<0.05 /큰 오차 픽셀<0.0005 /channel error<96 기준을 그대로 사용해 수정 후 10/10, 모두 pixel difference0을 확인했습니다. raw `cycle7-aa-overlap{,-before}.json`에 수정 전 8/10과 수정 후 결과를 보존합니다.
