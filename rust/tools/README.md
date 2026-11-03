# rust/tools

개발 전용 도구 크레이트를 두는 곳이다. 출하 산출물(XCFramework, Android `.so`)에는 들어가지 않는다.

- `conformance`: JS 의미 커널을 V8·JSC·QuickJS와 대조하는 `bc-conformance` 바이너리(M1 Task 4)
  - 직접 부르지 않고 `node scripts/rust/conformance.mjs`로 돌린다. 이 스크립트가 release로 빌드하고 코퍼스·기대값·판정을 맡는다.
  - 삼각측량(`--engines v8,jsc,quickjs`)은 macOS `jsc`와 C 컴파일러가 필요하다. `quickjs-host.c`를 저장소의 QuickJS와 함께 컴파일한다(`JSC_PATH`, `QUICKJS_HOST_PATH`로 다른 실행 파일을 쓸 수 있다).
  - 삼각측량은 엔진마다 그 플랫폼의 커널 결과와 비교한다. `bc-conformance`는 숫자를 쓰는 연산의 QuickJS 방언 결과가 다르면 `q`로 함께 낸다.
  - 대량 대조 결과는 `docs/measurements/rust-js-kernel-conformance.json`에 남긴다(`--report`).
- `trace-replay`: 이음새 추적 재생기(설계 §6.5)

이 파일은 `rust/Cargo.toml`의 `members = ["crates/*", "tools/*"]`가 도구 크레이트가 하나도 없을 때도 열리게 한다.
cargo는 아무것도 찾지 못한 glob을 실제 경로로 읽어 워크스페이스 로드에 실패하지만, 파일만 찾은 glob은 디렉터리가 아니라서 건너뛴다.
