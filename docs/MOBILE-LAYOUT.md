# 작은 화면의 라벨과 입력 계약

0.2.10의 시간·가격·축 제목·패널 제목은 현재 논리 글꼴 크기와 사용 가능한 영역에 맞춰 배치됩니다. 같은 축에서 제목과 가격 라벨을 별도 행에 두고, 공간이 부족하면 라벨 개수를 줄입니다. 시간 라벨은 0~5개이며 좁은 plot에서는 하나로 요약합니다. 폭이 부족하면 `…`를 표시하고, `DisplayCommand.fullText`에 완전한 문자열을 보존합니다. 글꼴 하나도 들어가지 않는 영역은 라벨을 숨깁니다. 숫자를 잘라 완전한 가격처럼 표시하지 않습니다.

`labelBounds`는 DOM 없이 계산한 보수적 배치 영역 `[x,y,width,height]`입니다. 모든 사용자 글꼴의 실제 glyph 측정 API는 아닙니다. 실제로 검증한 플랫폼·글꼴은 해당 사이클 보고서에 한정합니다. 패널 제목은 panel label과 보이는 series label/indicator 이름을 함께 표시하며 전체 내용은 native 접근성 요약에도 유지됩니다. 작은 높이에서 글꼴을 크게 쓰는 앱은 충분한 차트 높이와 전체 값 읽기 UI를 제공해야 합니다.

크로스헤어 가격은 축 안에서 위·아래 경계에 맞춰지고 불투명 배경으로 기존 축 라벨을 가립니다. 이 배경은 theme background의 RGB를 사용하며 알파는 1입니다. 커서 이동은 기존 scene cache의 layout을 재사용하고 base/drawing 레이어를 다시 생성하지 않습니다. 네이티브 뷰의 post-frame 접근성 읽기도 같은 layout을 사용합니다. 외부에서 직접 실행하는 일반 `crosshairValues(width,height)`는 현재 모델로 조회합니다.

글꼴 변화에 따라 footer와 패널 geometry가 변할 수 있습니다. 작은 행은 자체 높이의 절반 이내로 panel gap을 제한합니다. 데이터의 time/price, Float64 배열, 도형의 원본 앵커와 저장 문서는 라벨 축소로 변경되지 않습니다. 진행 중인 도형이 다른 projection에서 편집되지 않도록 core는 다음 move에서 취소하고, native 글꼴·bounds·앱 상태 전환은 먼저 입력 소유권을 해제합니다.

`InteractionController.down(id,x,y,hitTolerance=8)`은 1~32 논리 픽셀의 반경을 받을 수 있습니다. 기존 웹/마우스 기본값은 8입니다. UIKit 손가락은 22pt, Android finger는 24dp로 호출합니다. 시각적 손잡이 크기와 hit 영역은 별개이며, 겹친 선택 도형 손잡이는 가장 가까운 점을 선택합니다. 텍스트 도형의 몸체 선택도 현재 drawing/theme font 영역을 사용합니다. 실제 시스템 입력과 controller 직접 호출은 검증 보고서에서 구분합니다.

굵은 선의 몸체 선택 반경은 중심선 기준 `max(hitTolerance, strokeWidth / 2)`입니다. 따라서 폭 50의 몸체는 중심선에서 25 논리 픽셀까지 선택되며, 기본 반경 8에서 폭 16 이하의 기존 동작은 같습니다. 후보 영역 검사에도 같은 반경을 사용합니다. 선택 손잡이와 텍스트는 기존 반경을 유지하고, 패널 밖 선택·숨겨진 축·잠금·겹침 순서 정책도 그대로입니다. 이는 renderer별 cap/anti-alias 픽셀 마스크 판정이 아니며, 타원의 기존 근사 거리 계산도 유지합니다. 새 회귀는 core/controller 및 생성 native bundle VM에서 검증했으며 실제 장치 입력 검증은 별도입니다.

UIKit의 `adjustsFontForContentSizeCategory`, Android의 `setSystemFontScaleEnabled`는 기본 false인 opt-in입니다. 호출자 글꼴을 기준으로 플랫폼 배율을 적용하며 scene에 전달된 논리 글꼴을 renderer가 다시 확대하지 않습니다. disable/detach는 여전히 해당 뷰가 소유하는 적용값일 때만 원래 글꼴을 복원합니다. 사용자 theme 변경은 새 기준이 됩니다. 원시 네이티브 엔진과 interactive view의 thread/ownership 제약은 [Swift SDK](SWIFT-SDK.md), [Android SDK](ANDROID-SDK.md)를 참조하세요.

코어 회귀 검증:

```sh
node --test test/mobile-labels.test.mjs test/native-demo-binding.test.mjs test/axes-independent.test.mjs
```
