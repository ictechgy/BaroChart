# 호스트 앱의 시세 연결 레시피

[English](FEED-INTEGRATION.md) · [데이터 계약](DATA.md) · [수집 큐](INGESTION.md)

HTTP 초기 시세와 순서가 있는 실시간 스트림을 연결하는 실행 예제입니다. 인증·시세 권한·피드 구독·재시도는 앱이 담당합니다. SDK에 새 네트워크 클라이언트를 추가하지 않습니다.

## 공급자 계정 없이 실행

```sh
node scripts/serve-feed.mjs
```

`http://127.0.0.1:5190/examples/web/feed.html`을 엽니다. 64개 합성 봉을 실제 로컬 HTTP로 받고 SSE로 이벤트를 전달합니다. 연결한 뒤 현재 봉 갱신·추가·과거 수정·중복·순번 누락·연결 끊김·재연결을 눌러 확인합니다. 실제 시세나 주문은 없고 외부 요청이나 자동 재시도도 없습니다. 서버는 256봉·8개 스트림으로 제한된 테스트용입니다.

[세션 코드](../examples/web/feed-session.mjs)와 [HTTP/SSE 어댑터](../examples/web/feed-transport.mjs)는 앱 예제입니다. 초기 응답은 16 MiB를 넘으면 읽기를 취소하며, 단일 이벤트 텍스트는 16,384자로 제한합니다.

## 공급자가 제공해야 하는 계약

초기 응답은 `{bars, lastSequence}`, 이벤트는 `{sequence, kind, bar}`입니다. kind는 `update`, `append`, `correction` 중 하나입니다. 둘은 같은 종목·주기·세션·가격 보정 정책과 순번 체계를 공유해야 합니다. 초기 응답에는 `lastSequence`까지의 변경이 포함되며 그다음 이벤트 순번은 연속이어야 합니다. 구독의 `ready`는 이후 이벤트를 빠짐없이 전달할 준비가 끝났을 때 완료돼야 하고 `close`는 자원을 해제해야 합니다.

모든 거래소가 이 계약을 제공하는 것은 아닙니다. 채널별 cursor, revision, 재연결 토큰 등이 있다면 호스트 어댑터에서 해당 공급자의 부트스트랩 절차를 구현하세요. 봉 시각이나 도착 순서만으로 어느 가격이 최신인지 추측하지 않습니다.

## 연결 순서

1. 이전 구독을 닫고 초기 요청을 취소한 뒤 새 구독을 먼저 엽니다.
2. 구독 준비가 끝나면 초기 조회를 시작합니다. 그동안 들어오는 이벤트는 복사해 기본 128개까지 보관합니다(최대 4,096개로 설정 가능).
3. 별도 BarStore에서 초기 데이터와 이벤트를 검증합니다. 초기 watermark 이하의 중복은 건너뛰고 이후의 연속 이벤트를 적용합니다.
4. 현재 차트의 원본이 바뀌지 않았는지 확인한 뒤 완성된 컬럼을 한 번 게시합니다. 잘못된 입력·버퍼 초과·순번 누락은 수락된 차트를 유지합니다.
5. 연결 후 이벤트는 기존 SDK API로 반영합니다. 중복은 무시하고, 누락·잘못된 봉·외부 원본 변경·예산 초과가 있으면 멈춥니다. 재연결은 새 초기 데이터를 받아 명시적으로 수행합니다.
6. 화면을 떠나면 구독을 닫고 소유자가 끝날 때 dispose합니다. 이전 연결의 이벤트나 늦게 도착한 초기 응답은 새 연결에 게시하지 못합니다.

브라우저 예제는 탭이 숨겨지면 구독을 닫습니다. 연결 의도가 유지된 채 돌아오면 새 초기 데이터를 받으며, 사용자가 일시 정지했다면 그대로 유지합니다. SSE 오류 때 EventSource를 직접 닫아 브라우저의 암묵적 자동 재시도도 중지합니다.

## 앱에 연결할 자리

```js
import {createFeedSession} from './feed-session.mjs';
import {createHttpFeedTransport} from './feed-transport.mjs';
const feed = createFeedSession(chart.api, {
  ...createHttpFeedTransport(),
  maxBars: 100000,
  maxBufferedEvents: 128,
  onState: state => renderConnectionState(state),
});
await feed.connect();
// 오류 뒤 사용자 재연결: await feed.connect();
// 소유자 종료: feed.dispose(); chart.destroy({disposeModel: true});
```

공급자 주소와 인증은 호스트 설정으로 처리합니다. 운영 인증정보를 예제나 버그 보고에 넣지 마세요. WebSocket 공급자는 `{ready, close}`를 반환하고 `onEvent`/`onClose`를 호출하는 어댑터로 교체합니다. 구독 준비, 순번 변환, 재연결과 타임아웃 정책은 공급자·앱 요구에 맞춰 정합니다. 이 레시피가 임의의 재시도 시간이나 최신성 규칙을 만들지는 않습니다.

## 데이터 이벤트

- 첫 조회: 웹 `setData`/`setColumns`, Swift·Android `setBars`.
- 현재 봉 교체: 웹 `applyDataEvent({kind:'update',bar})`, Swift `apply(.update(bar))`, Android `apply(DataEvent.update(bar))`.
- 새 봉 추가: 같은 API의 `append`.
- 이미 있는 과거 봉 수정: 같은 API의 `correction`.

모든 시각은 UTC epoch **밀리초**입니다. OHLCV는 유한 숫자이고 원본 시각은 증가해야 합니다. 누적 거래량은 교체하며 같은 스냅샷을 반복 합산하지 않습니다. 없는 시각의 과거 수정, 누락 채우기, 자동 정렬·중복 제거·가격 반올림은 제공하지 않습니다. 네이티브 앱은 자체 네트워크 스택에서 같은 순서·취소 정책을 구현해야 하며 이 코드는 Swift/Kotlin 네트워크 라이브러리가 아닙니다.

## 오류와 자원 범위

초기 데이터와 대기 이벤트는 게시 전에 검증합니다. 실시간 SDK 호출은 커밋 뒤 알림/observer 오류가 날 수 있으므로 오류를 롤백의 증거로 취급하지 않습니다. 불확실한 변경을 그대로 재전송하기보다 수락된 상태를 확인하고 새 초기 데이터로 재연결합니다. 원본 컬럼이나 내부 상태를 직접 쓰는 방식은 버전 보호 대상이 아닙니다.

봉 수·이벤트 수 제한은 프로세스 전체 메모리 제한이 아닙니다. 파싱·할당·초기 데이터 검증은 동기 작업이며 큰 데이터 전처리는 앱에서 UI 지연을 고려해 배치합니다. 워크스페이스에는 네트워크 인증·피드 cursor·대기 큐를 자동 저장하지 않습니다. 연결 중 앱이 원본 데이터를 직접 바꾸면 세션은 덮어쓰기 대신 멈춥니다.

```sh
node --test test/feed-session.test.mjs test/feed-transport.test.mjs
```

실제 ChartAPI/BarStore와 로컬 HTTP/SSE로 초기 조회·이벤트 겹침, 객체 재사용, 갱신/추가/수정, 중복/누락, 버퍼 초과, 잘못된 초기 데이터, 외부 원본 변경, 재연결 세대, 취소·해제 및 응답 크기 제한을 검증합니다. 실제 fetch/EventSource 화면 검사는 별도 브라우저 실행으로 확인합니다.
