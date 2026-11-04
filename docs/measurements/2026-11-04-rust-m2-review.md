# Rust 데이터 단계 외부 검토 — 2026-11-04

검토 대상은 M2 데이터·입력·수집·브리지·실제 WASM 대조다. M3~M7의 전체 차트·비동기 job·성능 결과를 승인하는 검토가 아니다.

GLM 8개와 DeepSeek v4-pro 8개 패킷 응답을 수집하고 원본 JS/Rust 코드 및 재현 테스트로 모두 판정했다. 16개 응답은 종료 코드 0, 본문 비어 있지 않음, 수집 기록의 byte 수/SHA-256 일치를 확인했다. GLM 모델 식별자는 도구에서 제공하지 않았다. Qwen은 이전 보호 실행기 로컬 설정 실패 이후 이번 라운드에서 호출하지 않았다. 패킷은 수정 전 스냅샷이며 수정 후 새 모델 검토로 표시하지 않는다.

## 실제로 확인하고 수정한 사항

| 문제 | 근거와 수정 |
| --- | --- |
| WASM32 aggregate 중간 정수 곱 overflow | 실제 Core를 WASM으로 컴파일해 131,072행/65,536 bucket에서 결과 0을 재현했다. 중간 계산을 u64로 바꾸고 동일 실행에서 131,072를 확인했다. checked-in WASM 회귀 fixture를 유지한다. |
| Batch unchanged 판정의 중복 전체 store 복사 | live store는 staging 중 변경하지 않으므로 별도 original clone 없이 staged와 live를 비교한다. 원자성·unchanged·중간 이벤트 검증 테스트를 유지한다. |
| Fatal UTF-8 decode 실패의 WASM 결과 buffer 누수 | 실제 owned 결과에만 잘못된 UTF-8을 주입해 해제 전후 allocation 수/bytes 차이를 재현했다. decode도 finally로 보호하고 수/bytes 복원을 검사한다. |
| 잘못된 Node major로 oracle 실행 가능 | VM/엔진 생성 전에 Node22를 확인하고 fixture schema/version, 비교 정책과 출력 경로 인자를 검증한다. Node26 JSON.parse 결함은 별도 기존 재현 기록을 유지한다. |
| 플랫폼 숫자 방언을 고정한 codec 테스트 | 구현의 실제 NumberDialect별 예상값으로 분리했다. |
| 증거를 약하게 만드는 테스트 조건 | 상수 listener 오류 self-assertion과 Android의 다른 함수 이름도 허용하던 조건을 제거했다. |

## 소스 대조로 기각한 대표 사항

96×전역 maxBars는 store byte budget의 기본·상한이고 1,536은 ingestion의 명시적 최소다. 현재 코드와 JS가 같다. cancelled 철자, 미등록 ingestion 명령의 봉투 밖 오류, 최대 arity만 제한하고 부족한 인자는 undefined로 두는 동작도 원본 계약이다.

NaN bar의 직접 commit 주장은 이후 Store 검증을 누락한 판독이었다. 모든 OHLCV·시간 순서 검증 뒤 게시한다. BlockRangeIndex의 직접 helper 동작과 managed cache의 연속 suffix 갱신도 구분했다. Generic CSS·숫자 문자열 임의 길이 제한·추가 counter 규칙을 적용하면 현재 JS 계약을 바꾸므로 도입하지 않았다.

작은 문자열 할당과 임시 메모리 관련 제안은 최종 실기기 프로파일링에서 판단한다. 응답의 심각도 표기만으로 성능 위반을 선언하지 않았다. 확인된 M2 정확성 문제는 회귀 검증을 마쳤으며, 최종 실행 결과는 [데이터 검증 보고서](2026-11-04-rust-m2-data.md)에 있다.
