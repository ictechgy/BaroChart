# iPhone XR native backend A/B — 2026-11-05

동일한 Release 앱에서 같은 10,000봉·EMA20 fixture를 두 백엔드로 실행했다. UIKit layer의 기기 CPU 렌더 시간이며 화면 표시 FPS가 아니다.

| Backend | 시작 p50 (ms) | 팬 p95 (ms) | 팬 측정 시 phys_footprint (MiB) |
| --- | ---: | ---: | ---: |
| JavaScript | 207.15 | 6.10 | 77.84 |
| Rust | 282.95 | 7.24 | 58.31 |

두 백엔드 모두 시작500ms·팬16.7ms 기준을 충족한다. 이 기기에서는 JavaScript가 더 빠르고 Rust의 프로세스 메모리 사용량이 낮았다. 메모리는 requested Rust allocation과 구분한다.

iPhone XR(iPhone11,8), iOS18.7.10에서 시작12회 중앞2회를 제외하고10회, 팬2회워밍업뒤120회를 측정했다. 백분위수는 nearest-rank다. Rust native profile은 s/unwind/fatLTO이며 두 백엔드는 같은 앱 실행파일을 사용했다.

XCTest UI 자동화 모드 초기화가 시간초과해, 동일한 DeviceBenchmark.run을 devicectl foreground launch로 실행하고 결과를 수집했다. UI 자동화 검증을 통과한 결과로 보지 않는다. 디버그 비교값도 [기계 보고서](2026-11-05-native-rust-ios-ab.json)에 따로 보존했다.

서명한 샘플 앱을 설치한 뒤 다음 명령으로 같은 측정을 재현할 수 있다. 백엔드를 `javascript`로 바꿔 같은 앱으로 비교한다.

```sh
xcrun devicectl device process launch --device PRIVATE_DEVICE_ID \
  --terminate-existing --console kr.coden.barochart.sample -- \
  -barochart-benchmark -barochart-backend rust \
  -barochart-run-id UNIQUE_RUN_ID -barochart-benchmark-exit
```

Rust Source SHA: `67512c06b9c639de4e284a3d61bd345779b5d4c3da2818a8244899a1f81fc583`. 앱 SHA와원시samples요약·방법은 기계보고서에 있다. Release 링크맵 SDK 코드+자산은 3,839,591 B로 승인된5MiB예산 안에 있다.

실기기500회생성·해제는 통과했고, 30분 streaming soak는 진행중이다. Android 실기기는 현재 사용할 수 없어 플랫폼별 기본값 전환 게이트는 남아 있다. JavaScript 기본값은 유지한다.
