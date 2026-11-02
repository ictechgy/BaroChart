# rust/tools

개발 전용 도구 크레이트를 두는 곳이다. 출하 산출물(XCFramework, Android `.so`)에는 들어가지 않는다.

- `conformance`: JS 의미 커널을 V8·JSC·QuickJS와 대조하는 `bc-conformance` 바이너리(M1 Task 4)
- `trace-replay`: 이음새 추적 재생기(설계 §6.5)

이 파일은 `rust/Cargo.toml`의 `members = ["crates/*", "tools/*"]`가 도구 크레이트가 하나도 없을 때도 열리게 한다.
cargo는 아무것도 찾지 못한 glob을 실제 경로로 읽어 워크스페이스 로드에 실패하지만, 파일만 찾은 glob은 디렉터리가 아니라서 건너뛴다.
