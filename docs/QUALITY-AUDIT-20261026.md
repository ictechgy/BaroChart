# 2026-10-26 품질 점검과 수정

기준은 `cf20d0c`이며 성능, 입력 경계, 객체 수명주기, 웹 UI/UX와 Swift/Java 명령 동작을 함께 점검했다. 아래 11개 항목은 실제 재현 또는 실행 가능한 회귀 테스트로 확인한 수정이다. P1은 큰 메모리 사용이나 다른 소유자의 상태 변경으로 이어지는 문제이며, P2는 제한 검사·성능·계약·사용성 문제다.

| 항목 | 심각도 | 확인한 문제와 수정 |
| --- | --- | --- |
| OHLCV 입력 | P2 | 정규화가 행 한도보다 먼저 순회·복사했다. 최대 행 수와 조밀한 own data 슬롯을 먼저 검사한다. |
| Worker 설정 | P2 | 과도한 panel/axis/series/indicator 목록을 메인 스레드에서 먼저 복사했다. 각 목록의 기존 한도를 복사 전에 적용하고 접근자와 잘못된 구조를 거절한다. |
| Tick 집계 | P2 | 정상 순서의 tick마다 전체 bucket을 재정렬·재계산했다. 순차 입력은 OHLCV를 한 번 갱신하며 늦은 정정만 시간순으로 재계산한다. 보관 한도와 퇴거도 검증했다. |
| GPU 메모리 | P1 | 유효한 타원 문서가 수백 MiB의 packed/GPU 버퍼를 만들 수 있었다. 200,000 instances·16 MiB에서 추가 할당 전에 기존 Canvas 전환을 사용한다. |
| GPU 색상 캐시 | P2 | 색상 키가 무제한 누적됐다. 모든 색상 형식을 합친 256개 LRU로 제한하며 반복 색상은 같은 RGBA 배열을 재사용한다. |
| 거래 마커 | P2 | 변경 없는 256개 마커 갱신도 반복 style 쓰기를 발생시켰다. 패널 위치를 한 번 계산하고 실제 값이 바뀔 때만 DOM에 쓴다. |
| 폐기된 API와 controller | P1 | 종료 후 남은 참조와 진행 중 작업이 공유 모델·드로잉을 바꿀 수 있었다. 비공개 소유권을 확인하고 입력 검증·비동기 계산 후 최종 게시 직전에도 확인한다. 종료는 생성 당시 소유한 객체만 정리한다. |
| 초기 renderer 전환 | P2 | 초기 fallback 콜백에서 모델을 종료하면 생성 중인 차트의 구독·이벤트가 남을 수 있었다. 초기화 완료 후 알리고 종료·실패 경로를 정리한다. |
| Native 무변경 알림 | P2 | Swift/Java가 동일 panel 순서·indicator 배치에도 변경 알림을 보냈다. 엄격히 검사한 Boolean/changed 결과가 실제 변경을 나타낼 때만 알린다. |
| 수명주기 타입 | P2 | 공식 BFCache 예제의 `chart.disposed`와 `model.disposed`가 선언에 없었다. 실제 런타임 동작과 일치하는 읽기 전용 선언 및 소비자 검사를 추가했다. |
| 밝은 테마 가격 라인 | P2 | 캔들에서 라인으로 바꾸면 기본 색상이 남아 대비 검사를 실패했다. 초기 가격 시리즈를 데모 팔레트에 연결해 테마 전환을 유지한다. 사용자 지정 색상은 보존한다. |

## 실행 근거

전체 Node 회귀 테스트 **5,706/5,706**이 실패·skip 없이 통과했다. 594개 ESM 구문 검사, 엄격한 TypeScript 검사, 오프라인 npm tarball 설치·소비자 타입·공개 export 일치 검사도 통과했다. [수치와 실행 환경 기록](measurements/quality-audit-20261026.json)을 함께 보관한다.

Chrome 156.0.8078.48의 독립된 프로필에서 다음 경계를 확인했다.

- DPR 1·2 GPU 점검 54개: Canvas/GPU 내부 알파 픽셀이 일치했다. 1,000개 타원에서 200,000 instances·16 MiB로 제한하고 큰 GPU 업로드 전에 전환했다. 기존 GL 객체 삭제와 context 해제, 정확한 드로잉 journal 보존, 다음 Canvas 렌더를 확인했다.
- 256개 거래 마커: 변경 없는 hover·명시적 draw·refresh의 `style`/`hidden` mutation은 각각 0이었다. pan/resize 후에는 오래된 투영을 숨기고 새 위치를 표시했다.
- 메인 분석 화면 128개 검사: 지표 배치·되돌리기·검색·키보드 탐색·320/390/1280px 레이아웃과 실제 WebGL context loss를 확인했다.
- 커스터마이징 화면 54개 검사와 기존 GPU 회귀 검사 102개도 통과했다. DPR 1·2의 원시 도형·알파·클리핑·전환·반복 종료를 포함한다.
- UX 15개 검사: 100만 봉 Worker 로딩·취소·과거 정정, 키보드 편집, HTML 형태 텍스트, 접근성 테이블, BFCache 복원을 확인했다. 375px 화면에서 가로 넘침이 없고 plot은 252px, 기본 도구는 44×48px였다. 밝은 가격 라인의 배경 대비는 6.10:1이었다.
- 실제 Swift/JSC 공개 SDK 검사 11개에서 실제 변경 두 건에만 observer 콜백 두 번과 revision 증가가 발생했다. Java는 production receipt decoder의 19개 시나리오·32개 검사를 실행하고 Java 8 bytecode로 엄격히 컴파일했다.

로컬 성능 수치는 이 Mac/Chrome 실행의 관찰값이며 제품 간 우위나 기기 전체의 FPS를 뜻하지 않는다. Java 검증은 Android/JNI observer 실행을 대신하지 않는다. 이번 점검은 저장소 코드와 오프라인 AST 검사에 기반하며 새 외부 의존성 취약점 데이터 조회, 실제 모바일 기기, 보조공학 실행은 포함하지 않았다.

## 재검증

Node 22 이상에서 다음 명령을 사용한다. TypeScript와 Java 검사는 설치된 컴파일러 경로를 지정할 수 있다.

```sh
npm test
npm run check
npm run check:types
npm run check:package
npm run test:indicator-layout:browser
npm run test:customization:browser
npm run test:gpu
npm run test:ux
npm run check:security:offline
node scripts/test-native-layout-notifications.mjs
ASTER_JAVA=/path/to/jdk21/bin/java node scripts/check-java-layout-notifications.mjs
```

오프라인 AST 검사는 동적 코드 실행과 HTML 삽입 지점을 점검한다. 신뢰한 애플리케이션 코드용 `registerIndicatorSource`의 명시적 실행 경로는 별도 취급하며, 이 API는 비신뢰 코드 sandbox가 아니다.
