# 지원 및 운영 상태

상태 기준일: **2026-11-04** · [English](SUPPORT.md) · [마이그레이션 가이드](MIGRATING-FROM-LIGHTWEIGHT-CHARTS.ko.md) · [브라우저 측정](measurements/2026-11-04-migration-operations.md).

BaroChart `0.3.0-dev`는 개발 프리뷰입니다. 패키지는 private이며 npm, SwiftPM 릴리스 태그, Maven Central에 공개되지 않았습니다. 아래의 “지원 경로”는 이 소스 트리에 구현과 문서가 있다는 뜻이며, 공개 릴리스의 호환성 보장은 아닙니다.

## 호환성·지원 범위

| 경로 | 현재 상태 | 근거와 경계 |
| --- | --- | --- |
| JavaScript 코어·웹 | **현재 지원 구현 경로.** DOM 없는 코어, Canvas/WebGL2 렌더러, 소스 및 로컬 패키지 소비자 경로. | 로컬 데모와 마이그레이션 예제를 Headless Chrome에서 1280, 390, 320 CSS px로 확인했습니다. 단일 브라우저 실행이며 모든 브라우저·GPU·입력 기기 인증은 아닙니다. 패키지는 미출시 프리뷰입니다. |
| Lightweight Charts 마이그레이션 | **좁은 범위의 레시피이며 어댑터가 아닙니다.** 숫자 시간 캔들, UTC 초→밀리초, 명시적 OHLCV, 추가/갱신/정정과 호스트 수명주기를 설명합니다. | [마이그레이션 계약](MIGRATING-FROM-LIGHTWEIGHT-CHARTS.ko.md)을 참고하세요. Lightweight Charts API나 Advanced Charts, Trading Platform, Pine Script와의 호환성을 주장하지 않습니다. |
| React 웹 | **선택형 어댑터.** 호환 export 이름은 `AsterChart`입니다. | 소비자 예제는 실행할 수 있습니다. 모의 hooks 테스트만으로 실제 React 런타임, SSR, hydration, 모든 React 버전을 증명하지 않습니다. 대상 앱의 고정 React/ReactDOM 버전으로 소비자 앱을 실행하세요. |
| 모바일 웹 | **반응형 호스트 예제와 명시적 입력 프리셋.** | 마이그레이션 페이지를 측정한 폭에서는 가로 넘침이 없습니다. 브라우저 viewport 에뮬레이션은 터치 제스처, 스크롤 처리, VoiceOver, TalkBack, 실기기를 검증하지 않습니다. |
| Apple 네이티브 | **기존 Swift/JavaScriptCore SDK 통합.** 로컬 소스 체크아웃에서 SwiftUI/UIKit 뷰를 제공합니다. | CI, 날짜가 기록된 시뮬레이터/실기기 근거는 [네이티브 측정](measurements/native-device-performance.json)에 있습니다. 2026-11-01 실기기 결과는 iPhone 한 대의 화면 밖 CPU 작업이며 display FPS나 폭넓은 기기 지원을 뜻하지 않습니다. SwiftPM 릴리스 태그는 없습니다. |
| Android 네이티브 | **기존 Android/QuickJS SDK 통합.** 로컬 소스 체크아웃에서 View/Compose API와 두 ABI를 제공합니다. | CI, 에뮬레이터, 날짜가 기록된 실기기 근거는 [네이티브 측정](measurements/native-device-performance.json)에 있습니다. 2026-11-01 실기기 결과는 Samsung 기기 한 대의 CPU bitmap 렌더링이며 display FPS나 폭넓은 기기 지원을 뜻하지 않습니다. Maven Central 릴리스는 없습니다. |
| Rust 네이티브 차트 백엔드 | **미완성·개발 중.** M1b ABI/패키징/내부 선택 기반은 구현됐으며 완전한 차트 백엔드와 적합성 관문은 아직 통과하지 않았습니다. | [M1b 검사](measurements/2026-11-04-rust-m1b.md)는 count-echo 뼈대를 검증합니다. JS 기능 동등성·차트 속도 비율·Rust 기본값을 주장하지 마세요. 승인된 M1b–M7 구현과 호스트/플랫폼 관문을 마친 뒤 상태를 갱신합니다. |
| 피드·계정·거래 | **호스트 소유이며 제공하지 않습니다.** | 로컬 HTTP/SSE fixture는 합성 데이터만 씁니다. 운영 공급자 인증, 사용 권한, 순번/watermark 정책, 재시도, 계정, 주문 실행은 앱 책임입니다. [피드 통합](FEED-INTEGRATION.ko.md)을 참고하세요. |

웹 React 이름 `AsterChart`와 저장용 `aster.*` 스키마는 호환 표면으로 유지합니다. 네이티브 SDK의 브랜드 이름은 `BaroChart`입니다. 제품 이름을 바꾼다고 저장 스키마를 개명하지 마세요. 이 프로젝트는 TradingView 제품과 독립적이며 API 관계를 주장하지 않습니다.

## 근거, 자동 검사와 수동 검사

[2026-11-04 마이그레이션 실행](measurements/2026-11-04-migration-operations.md)은 로컬 페이지 하나를 실제 브라우저에서 실행한 기록입니다. 합성 입력, viewport 폭, Canvas에 표시된 갱신, 실제 BFCache 복귀, 최종 정리 동작, 처리되지 않은 페이지 오류 0건을 기록합니다. 전체 브라우저 행렬이나 기기 검증은 아닙니다.

[피드 통합 보고서](measurements/2026-11-03-feed-integration.md)와 [온보딩 보고서](measurements/2026-11-03-onboarding-analysis.md)는 해당 시점 소스에서 실행한 Node/Chrome 자동 검사 결과입니다. 이전 체크포인트와 실패는 [공개 검증 이력](PUBLIC-VALIDATION.md)에 보존되어 있습니다. 과거 통과 수치는 현재 체크아웃이나 PR이 같은 명령을 통과했다는 뜻이 아닙니다. [CI](../.github/workflows/verify.yml)에 있는 워크플로 정의를 확인하고 출시 전에 대상 PR의 실행 결과를 보세요.

[모바일 샘플 보고서](measurements/2026-11-04-mobile-quality.md)는 네이티브 수명주기·회전·데이터 revision 회귀, 큰 글자의 자동 접근성 검사, Chrome의 실제 터치 이벤트 에뮬레이션을 추가합니다. 네이티브 UI는 iOS 7개와 큰 글자 2개, Android 8개와 큰 글자 1개이며 브라우저 12개 검사는 팬·핀치·취소·키보드·스크롤을 다룹니다. 모두 시뮬레이션 결과입니다. 매우 큰 차트 글자는 말줄임표로 줄어들 수 있고 실기기 화면 낭독기 사용성 확인은 남아 있습니다.

자동 테스트 및 DOM/RAF/호스트 모의 검사는 상태 전이와 API 계약을 검사할 수 있습니다. 아래 수동 검사를 대신하지 않습니다.

- 실제 iOS·Android 기기의 터치 입력, 브라우저 스크롤, 차트 컨트롤 사용성.
- VoiceOver와 TalkBack의 탐색, 포커스 순서, 레이블, 차트 대안.
- 대상 앱의 실제 React/SSR 설정, 데이터 공급자 순서 계약, 운영 재연결 정책.
- 출시별 네이티브 패키징, 서명, 스토어 제출, 버전 호환성 검토.

모의 테스트만으로 위 항목을 통과 처리하지 마세요. 각 수동 관문에 기기/브라우저 버전, 절차, 결과, 미해결 항목을 기록하세요.

## 출시 관문

이 프리뷰를 릴리스로 설명하거나 지원 주장을 변경하기 전에:

1. 검토가 끝난 정확한 소스 revision에서 테스트, 패키지, 타입 검사를 실행하고 CI 결과를 확인하세요. 과거 테스트 수치는 원래 날짜와 revision을 유지하세요.
2. 대상 브라우저/버전으로 브라우저 검사를 하고, 실기기에서 터치 및 스크린 리더 수동 검사를 하세요. 실패와 사용할 수 없는 환경을 함께 기록하세요.
3. React 주장은 실제 소비자 앱으로 실행한 React 버전과 런타임/SSR 범위에 한정하세요.
4. Rust M1b–M7 구현 및 지원 호스트 전체의 JS/네이티브 적합성을 완료하기 전에는 기능 동등성을 주장하거나 기본 경로로 켜거나 속도 비교를 공개하지 마세요. 성능은 두 구현이 같은 화면 작업을 수행하고 측정 방법을 기록한 뒤 비교하세요.
5. 버전 관리, 패키지 공개, 릴리스 태그, 서명과 플랫폼 배포는 별도 승인을 받으세요. 현재 로컬 소스/패키지 검사는 artifact를 게시하지 않습니다.

## 개인정보를 보호하는 문제 재현 양식

결함 보고에는 아래 양식을 사용하세요. 관련 입력 형태와 이벤트 순서를 보존하는 합성 데이터로 바꾸세요. 재현에 필요한 정리된 파일만 첨부하세요.

```text
제품/revision: BaroChart <버전 또는 git revision>
통합 경로: <JS/web | React | Swift/iOS | Kotlin/Android | Rust 개발 중>
런타임과 버전: <OS, 브라우저/런타임, SDK/도구체인>
기대 동작: <관찰 가능한 결과 1개>
실제 동작: <관찰 가능한 결과 1개>
재현 단계: <짧은 번호 목록>
최소 합성 입력: <스키마와 생성 값; 운영 봉 데이터 금지>
오류: <경로·식별자를 지운 이름/code/message>
명령/테스트: <명령과 종료 코드>
근거: <개인정보를 지운 스크린샷 또는 최소 로그 경로>
수동 또는 자동: <종류 및 기기/시뮬레이터/브라우저 정보>
```

API 키, 토큰, 쿠키, 인증 헤더, 계정/고객 식별자, 공급자 endpoint, 비공개 종목/거래소 이름, 개인 파일 경로, 기밀 OHLCV를 제거하세요. workspace나 export에 비공개 도형, 주석, 식별자, 데이터가 남아 있는지 확인하기 전에는 첨부하지 마세요. 피드 문제 재현에 비밀 정보를 보내지 마세요. 로컬 합성 fixture나 정리한 adapter를 사용하세요.
