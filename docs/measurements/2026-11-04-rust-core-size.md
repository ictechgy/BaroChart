# Rust 데이터·수집 단계 크기 측정 — 2026-11-04

현재 코드의 linked 크기다. 소스 집합 SHA-256은 `35efddd84ea0b2e7301b8c6868dbc57aca707f00670cb9060375932ec74591bb`이며, 프로필·도구 버전·재현 명령·개별 SHA는 [기계 보고서](rust-core-size.json)에 있다. 전체 차트 이식과 실기기 성능 측정은 후속 단계다. 이전 M1b 수치는 해당 커밋의 보고서에 보존된다.

## Android linked `.so`

| ABI | Rust profile | JS-only | Rust-only | dual | dual − JS | budget remaining |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| arm64-v8a | `opt-s-panic-unwind` | 1,055,616 | 1,723,624 | 2,766,568 | 1,710,952 | 379,160 |
| arm64-v8a | `opt-3-panic-unwind` | 1,055,616 | 1,579,896 | 2,618,760 | 1,563,144 | 526,968 |
| arm64-v8a | `opt-s-panic-abort` | 1,055,616 | 1,678,552 | 2,721,496 | 1,665,880 | 424,232 |
| arm64-v8a | `opt-3-panic-abort` | 1,055,616 | 1,540,104 | 2,578,968 | 1,523,352 | 566,760 |
| x86_64 | `opt-s-panic-unwind` | 1,115,400 | 1,766,832 | 2,872,768 | 1,757,368 | 272,960 |
| x86_64 | `opt-3-panic-unwind` | 1,115,400 | 1,660,000 | 2,761,872 | 1,646,472 | 383,856 |
| x86_64 | `opt-s-panic-abort` | 1,115,400 | 1,720,256 | 2,826,192 | 1,710,792 | 319,536 |
| x86_64 | `opt-3-panic-abort` | 1,115,400 | 1,621,056 | 2,722,944 | 1,607,544 | 422,784 |

두 ABI의 shipping `s`/unwind dual은 3,145,728 bytes 예산 안에 있다. Rust-linked 16개와 JS baseline 2개의 PT_LOAD 16 KiB 정렬을 검사했다. `panic=abort` 프로필은 catch_unwind/poison 경계를 충족하지 않아 비교용이다.

## iOS link contribution

동일한 `-Os -dead_strip`로 만든 unsigned arm64 최소 executable 두 개의 차이다. 실제 IPA·설치 크기·App Store thinning이나 시스템 프레임워크 크기는 측정하지 않는다.

| Binary | File bytes | `__TEXT` bytes |
| --- | ---: | ---: |
| baseline | 32,944 | 32,768 |
| Rust referenced | 771,832 | 557,056 |
| delta | 738,888 | 524,288 |

정적 archive 자체는 20,820,896 bytes이며 executable 기여분과 다르다.

## 후속 이식 시나리오

2.5 MiB 설계 prior는 실제 측정값과 독립적인 시나리오이며, 전체 이식의 상한이나 확률 구간이 아니다. 이 시나리오의 dual 합은 arm64 3,677,056 bytes, x86_64 3,736,840 bytes로 예산을 넘는다. 실제 최종 값은 구현·링크 후 측정해야 한다.

물리 `.rs` 11,323줄을 분모로 한 bytes/LOC 예측은 진단용으로만 남겼다. std/allocator/FFI 고정 비용과 실제 dead-strip 때문에 성장 법칙이나 artifact 결정 근거로 사용하지 않는다.
