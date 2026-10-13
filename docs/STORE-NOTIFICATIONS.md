# 데이터 게시와 observer 순서

0.2.10은 ChartModel을 생성하기 전에 등록된 public store observer가 지정한 최신 viewport를 보존합니다. 이전에는 reset/prepend 알림의 등록 순서에 따라 observer의 `api.setVisibleRange(4,14)`가 뒤의 내부 fit/이동 처리로 덮였습니다. 같은 문제로 early observer가 가격 시리즈 range 또는 지표를 조회하면 이전 cache를 읽을 수 있었습니다.

BarStore의 mutation이 검증·commit된 뒤 Model의 자동 viewport/dirty 처리와 IndicatorEngine의 invalidation을 먼저 완료합니다. 그 뒤 public `subscribe` snapshot을 등록 순서로 통지합니다. `_subscribeInternal`은 core 내부용이며 public callback용 API가 아닙니다. 내부 구독도 기존 `listeners` ledger에 기록되어 dispose가 제거합니다.

public callback에서 다시 데이터를 변경하면 그 nested mutation의 내부 처리는 즉시 완료됩니다. 외부 통지는 기존 FIFO/version 순서로 예약됩니다. 따라서 nested reset 뒤 명시적으로 지정한 viewport를 나중의 자동 fit으로 덮지 않습니다. 등록 해제와 신규 구독은 mutation 시점의 snapshot 계약을 유지하며, callback 예외 격리·오류 원인·bounded listenerErrors 정책도 유지합니다. 모든 데이터 사건을 합치거나 arbitrary observer의 무한 데이터 재게시를 자동 차단하는 계약은 아닙니다.

동기 API와 worker staged packet에 동일하게 적용됩니다. 준비 완료 packet의 시리즈 cache 정리도 외부 callback에서 정상 변경한 동일 borrowed buffer/revision을 보존합니다. 다른 observer가 더 나중에 명시적으로 지정한 값은 그 호출 순서를 따릅니다.

```sh
node --test test/store-publication-order.test.mjs test/notifications.test.mjs \
  test/binding-transactions.test.mjs test/publication-boundaries.test.mjs
```

새 8개 수용 사례는 기존 동결 소스에서 2pass/6fail, 수정 후 8pass입니다. public callback의 reset/prepend/correction, 실제 계산한 staged packet, 현재 indicator/range 조회 및 nested mutation의 viewport와 version 순서를 검사합니다. 실제 설치 tarball/module Worker 및 네이티브 실행은 0.2.10 최종 보고서 (not included in this source distribution)에 별도로 기록합니다.
