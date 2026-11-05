/* cbindgen 0.29.4가 생성한 파일이다. 수정하지 말고 node scripts/rust/cbindgen.mjs를 실행한다. */

#ifndef BAROCHART_CORE_H
#define BAROCHART_CORE_H

#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

// 무손실 BCJSON 입력과 출력을 선택하는 플래그다.
#define BC_FLAG_LOSSLESS 1

// C ABI 호출 상태다.
typedef enum {
  // 성공했다.
  BC_OK = 0,
  // 코어가 JavaScript 오류를 던졌다.
  BC_THROW = 1,
  // Rust 백엔드에 아직 이식되지 않은 함수다.
  BC_UNAVAILABLE = 2,
  // 이미 해제된 단조 핸들 ID다.
  BC_CLOSED = 3,
  // Rust panic 뒤 poison된 엔진이다.
  BC_POISONED = 4,
  // 동시 진입이나 콜백 재진입이 거부됐다.
  BC_BUSY = 5,
  // 포인터·UTF-8·JSON·플래그 같은 전송 계약이 틀렸다.
  BC_INVALID = 6,
  // 제한된 엔진의 requested-byte 한도 또는 allocation이 실패했다.
  BC_OOM_LIMIT = 7,
  // 무제한 엔진의 system allocation이 실패했다.
  BC_OOM_SYSTEM = 8,
} BcStatus;

// C에서는 역참조하지 않는 단조 핸들 ID 타입이다.
typedef struct BcEngine BcEngine;

// Rust가 할당한 바이트 버퍼다.
// `ptr == NULL`이면 `len == cap == 0`이다. 소유자는 값을 바꾸지 말고 정확히 한 번 `bc_buf_free`로 돌려준다.
typedef struct {
  // 바이트 시작 포인터다. 비어 있으면 NULL이다.
  uint8_t *ptr;
  // 유효한 바이트 수다.
  size_t len;
  // Rust 할당 용량이다.
  size_t cap;
} BcBuf;

// 엔진이 소유하는 플랫폼 콜백 표다.
// 모든 콜백은 unwind하지 않아야 하고, 바이트 입력은 해당 콜백 중에만 유효하다.
// `bc_engine_new == BC_OK`일 때만 context 소유권이 엔진으로 넘어간다.
// 엔진은 순차적으로 다른 스레드로 옮겨갈 수 있고 terminal `release`는 마지막 lease 스레드에서 불릴 수 있다.
// context를 여러 엔진이 공유하면 호스트가 retain/refcount와 엔진별 `release` 1회를 동기화해야 한다.
typedef struct {
  // 모든 콜백에 넘길 호스트 context다. NULL을 허용한다.
  void *context;
  // 시간대 이름을 표준 이름으로 동기 해석한다. 필수 콜백이다.
  // 반환 코드와 무관하게 nonempty 출력은 `bc_buf_new_copy`가 만든 고유한 버퍼여야 한다.
  int32_t (*zone_resolve)(void*, const uint8_t*, size_t, BcBuf*);
  // 지정 시각의 시간대 오프셋을 초 단위로 동기 작성한다. 필수 콜백이다.
  int32_t (*zone_offset_seconds)(void*, const uint8_t*, size_t, double, int32_t*);
  // 선택적 개발자 진단 로그 콜백이다.
  void (*log)(void*, int32_t, const uint8_t*, size_t);
  // 선택적 context 정리 콜백이다. terminal이며 context를 쓰는 export 재진입은 금지다.
  // registry lock은 이미 풀려 있으므로 제거된 같은 token의 반복 `bc_engine_free`는 no-op으로 허용한다.
  void (*release)(void*);
} BcHost;

// Rust가 할당한 `double` 버퍼다.
// `len`과 `cap`은 바이트가 아니라 원소 수고, 포인터는 `double`에 맞게 정렬된다.
typedef struct {
  // `double` 원소의 시작 포인터다. 비어 있으면 NULL이다.
  double *ptr;
  // 유효한 `double` 원소 수다.
  size_t len;
  // Rust 할당 용량인 `double` 원소 수다.
  size_t cap;
} BcF64Buf;

// 관찰형 typed write의 실제 target 길이와 복사 여부다.
typedef struct {
  // Core가 한 번 handout한 실제 `double` 원소 수다.
  size_t actual_count;
  // Host source가 유효하고 실제 길이와 정확히 같아 복사됐는지 나타낸다.
  bool did_write;
} BcF64WriteReceipt;

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

// Rust 소유 바이트 버퍼를 해제한다. canonical empty는 no-op이다.
//
// # Safety
// nonempty 버퍼는 Rust export가 만든 값을 변경하지 않은 고유 값이어야 하고 정확히 한 번만 넘겨야 한다.
void bc_buf_free(BcBuf buf);

// 호스트 메모리에서 바이트를 복사해 Rust 소유 `BcBuf`를 만든다.
// `src == NULL`은 `len == 0`일 때만 허용한다. 반환된 nonempty 버퍼는 정확히 한 번
// `bc_buf_free`로 돌려주거나 `zone_resolve` 출력으로 소유권을 Rust에 넘긴다.
//
// # Safety
// `out`은 기존 live `BcBuf`를 담지 않은 writable slot이어야 하고 `src`와 alias하지 않아야 한다.
// nonzero `len`이면 `src`에서 그 길이만큼 읽을 수 있어야 한다.
BcStatus bc_buf_new_copy(const uint8_t *src,
                         size_t len,
                         BcBuf *out);

// 함수 이름과 JSON/BCJSON 배열 인자로 Rust 코어를 부른다.
// `BC_THROW`/`BC_UNAVAILABLE`의 출력은 flags와 무관한 Standard JSON이며 `code`가 없으면 `null`이다.
// stale token은 `BC_CLOSED`, 활성 호출 중 재진입은 `BC_BUSY`다.
//
// # Safety
// 핸들 token은 변조하지 않아야 하고 입력 구간은 읽기 가능해야 한다.
// `out`은 기존 live `BcBuf`를 담지 않고 name/args와 alias하지 않는 writable slot이어야 한다.
BcStatus bc_call(BcEngine *engine,
                 const uint8_t *name,
                 size_t name_len,
                 const uint8_t *args,
                 size_t args_len,
                 uint32_t flags,
                 BcBuf *out);

// 엔진 token을 닫고 호스트 context를 해제한다.
//
// NULL과 stale/반복 token은 no-op이다. free 선형화 시점부터 새 호출은 `BC_CLOSED`를 받는다.
// 이미 승인된 호출이 있으면 그 호출은 소유 출력을 게시하고, 마지막 Arc lease가 떨어진
// 스레드에서 terminal `release` 콜백을 한 번 부른다. 따라서 이 함수는 callback 안에서도 부를 수 있다.
//
// # Safety
// non-NULL token은 `bc_engine_new`의 반환값 그대로여야 하며 호출자는 free 후 자신의 저장 핸들을 NULL로 바꾸어야 한다.
void bc_engine_free(BcEngine *engine);

// 호스트 콜백을 소유하는 빈 Rust 엔진을 만든다.
// 성공할 때만 context 소유권이 엔진으로 넘어간다. 반환된 `BcEngine *`는 64-bit Apple/Android에서
// 저장·비교·재전달만 하는 8-byte 배수 token이며 역참조하면 안 된다.
//
// # Safety
// `host`, `engine_out`, `error_out`은 각각 읽기/쓰기 가능하고 서로 alias하지 않아야 한다.
// `error_out`은 기존 live `BcBuf`를 담지 않은 slot이어야 하며, 콜백과 context는 헤더 수명 계약을 따른다.
BcStatus bc_engine_new(const BcHost *host,
                       BcEngine **engine_out,
                       BcBuf *error_out);

// 요청 바이트 한도를 가진 빈 Rust 엔진을 만든다. 0은 무제한이다.
//
// # Safety
// `bc_engine_new`과 같은 포인터·alias·host 수명 계약을 따른다.
BcStatus bc_engine_new_with_limit(const BcHost *host,
                                  uint64_t memory_limit,
                                  BcEngine **engine_out,
                                  BcBuf *error_out);

// Rust 소유 `double` 버퍼를 해제한다. canonical empty는 no-op이다.
//
// # Safety
// nonempty 버퍼는 Rust export가 만든 값을 변경하지 않은 고유 값이어야 하고 정확히 한 번만 넘겨야 한다.
void bc_f64_buf_free(BcF64Buf buf);

// live token의 FFI shell 메모리 통계를 Standard JSON으로 돌려준다.
// poison 뒤에도 진단을 위해 동작하지만 busy 중에는 `BC_BUSY`, stale token은 `BC_CLOSED`다.
//
// # Safety
// token은 `bc_engine_new`의 반환값 그대로여야 한다. `out`은 기존 live `BcBuf`를 담지 않는
// writable slot이어야 하며 다른 입출력과 alias하지 않아야 한다.
BcStatus bc_memory_stats(const BcEngine *engine,
                         BcBuf *out);

// packet v1 메타데이터와 숫자를 소유 버퍼로 돌려준다.
// 인자는 Standard JSON 배열이다. 실패 오류는 `metadata_out`의 Standard JSON에 담고 numbers는 비운다.
//
// # Safety
// token과 입력은 유효해야 한다. 두 출력은 기존 live 버퍼를 담지 않고
// 입력·서로와 alias하지 않는 writable slot이어야 하며, 두 할당이 모두 준비된 뒤에만 게시된다.
BcStatus bc_packet(BcEngine *engine,
                   const uint8_t *args,
                   size_t args_len,
                   BcBuf *metadata_out,
                   BcF64Buf *numbers_out);

// Rust 함수의 숫자 배열 결과를 호스트 `double` 배열로 복사한다.
// 인자는 Standard JSON 배열만 받는다. 실패·busy·poison에서 destination은 바뀌지 않는다.
//
// # Safety
// token과 입력은 유효해야 하며, nonzero count의 `dst`는 정렬된 writable `double[count]`여야 한다.
// `error_out`은 기존 live 버퍼를 담지 않고 입력·destination과 alias하지 않는 writable slot이어야 한다.
BcStatus bc_read_f64(BcEngine *engine,
                     const uint8_t *name,
                     size_t name_len,
                     const uint8_t *args,
                     size_t args_len,
                     double *dst,
                     size_t count,
                     BcBuf *error_out);

// Rust 함수의 실제 숫자 배열 결과 전체를 소유 snapshot으로 돌려준다.
//
// 기존 fast read와 달리 host destination/count를 받거나 검증하지 않는다. Core 함수는 정확히 한 번
// 실행하며, caller가 payload를 기록한 뒤 별도로 길이를 검증할 수 있다.
//
// # Safety
// token/name/args는 `bc_read_f64`와 같은 계약을 따르고, `out`과 `error_out`은 비어 있는 writable
// output slot이며 서로와 입력에 alias하지 않아야 한다.
BcStatus bc_read_f64_snapshot(BcEngine *engine,
                              const uint8_t *name,
                              size_t name_len,
                              const uint8_t *args,
                              size_t args_len,
                              BcF64Buf *out,
                              BcBuf *error_out);

// JSON/BCJSON 인자를 보존하며 실제 typed 결과 전체를 소유 snapshot으로 돌려준다.
// `flags`는 `bc_call`과 같고, 숫자 결과는 JSON으로 펼치지 않는다.
//
// # Safety
// token/name/args와 비어 있는 두 output slot은 `bc_read_f64_snapshot`의 계약을 따른다.
BcStatus bc_read_f64_snapshot_with_flags(BcEngine *engine,
                                         const uint8_t *name,
                                         size_t name_len,
                                         const uint8_t *args,
                                         size_t args_len,
                                         uint32_t flags,
                                         BcF64Buf *out,
                                         BcBuf *error_out);

// 현재 live Rust 함수 표가 이름을 지원하는지 묻는 정적 메타데이터 조회다.
// busy/poison gate를 취득하지 않고, stale·NULL·변조 token은 `false`다.
//
// # Safety
// non-NULL token은 `bc_engine_new`의 반환값 그대로여야 하고 이름 구간은 읽기 가능해야 한다.
bool bc_supports(const BcEngine *engine,
                 const uint8_t *name,
                 size_t name_len);

// 호스트 `double` 배열을 Rust 함수에 소유 복사로 넘긴다.
// 인자는 Standard JSON 배열만 받는다.
//
// # Safety
// token과 입력은 유효해야 하며, nonzero count의 `src`는 정렬된 readable `double[count]`여야 한다.
// `error_out`은 기존 live 버퍼를 담지 않고 입력·source와 alias하지 않는 writable slot이어야 한다.
BcStatus bc_write_f64(BcEngine *engine,
                      const uint8_t *name,
                      size_t name_len,
                      const uint8_t *args,
                      size_t args_len,
                      const double *src,
                      size_t count,
                      BcBuf *error_out);

// Core typed target을 한 번 관찰한 뒤 host source가 정확할 때만 쓴다.
//
// `host_count`는 signed host 값 그대로 받는다. Core target handout과 선택적 `before_out` snapshot이
// 먼저 일어나며, 이후 count가 `1...262144`가 아니거나 실제 길이와 다르거나 source가 유효하지 않으면
// `BC_OK`와 `did_write=false`를 돌려준다. 따라서 host는 실제 Core 결과를 기록한 뒤 자체 protocol 오류를
// 만들 수 있다. Core 오류는 host count 오류보다 먼저 반환된다.
//
// # Safety
// token/name/args는 `bc_write_f64`와 같은 계약을 따른다. `receipt_out`은 writable slot이어야 한다.
// `before_out`은 NULL이거나 비어 있는 writable `BcF64Buf` slot이어야 하고, `error_out`은 비어 있는
// writable `BcBuf` slot이어야 한다. 출력들은 서로 alias하지 않아야 한다. `src`는 실제 target 길이와
// 일치하는 유효 host count에서만 읽으며, 그때 정렬된 readable `double[host_count]`여야 한다.
BcStatus bc_write_f64_observe(BcEngine *engine,
                              const uint8_t *name,
                              size_t name_len,
                              const uint8_t *args,
                              size_t args_len,
                              uint32_t flags,
                              const double *src,
                              int64_t host_count,
                              BcF64WriteReceipt *receipt_out,
                              BcF64Buf *before_out,
                              BcBuf *error_out);

// 호스트 `double` 배열을 쓰면서 write 직전 target-owned 값을 소유 snapshot으로 돌려준다.
//
// # Safety
// `bc_write_f64` 계약에 더해 `before_out`은 비어 있는 writable `BcF64Buf` slot이어야 하며
// 다른 입출력과 alias하지 않아야 한다.
BcStatus bc_write_f64_snapshot(BcEngine *engine,
                               const uint8_t *name,
                               size_t name_len,
                               const uint8_t *args,
                               size_t args_len,
                               const double *src,
                               size_t count,
                               BcF64Buf *before_out,
                               BcBuf *error_out);

#ifdef __cplusplus
}  // extern "C"
#endif  // __cplusplus

#endif  /* BAROCHART_CORE_H */
