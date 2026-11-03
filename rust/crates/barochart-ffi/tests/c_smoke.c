#include "barochart_core.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

_Static_assert(sizeof(double) == 8, "BaroChart ABI requires IEEE-754 binary64");
_Static_assert(sizeof(uintptr_t) <= sizeof(int64_t), "engine token must fit a JNI jlong");
_Static_assert(BC_OK == 0 && BC_THROW == 1 && BC_UNAVAILABLE == 2, "status prefix");
_Static_assert(BC_CLOSED == 3 && BC_POISONED == 4 && BC_BUSY == 5 && BC_INVALID == 6, "status suffix");
_Static_assert(BC_FLAG_LOSSLESS == 1u, "lossless flag");
_Static_assert(offsetof(BcBuf, ptr) == 0, "BcBuf pointer first");
_Static_assert(offsetof(BcBuf, len) == sizeof(void *), "BcBuf length second");
_Static_assert(offsetof(BcBuf, cap) == sizeof(void *) + sizeof(size_t), "BcBuf capacity third");
_Static_assert(offsetof(BcHost, context) == 0, "BcHost context first");
_Static_assert(offsetof(BcHost, zone_resolve) == sizeof(void *), "BcHost callback layout");

typedef struct SmokeContext {
  int releases;
} SmokeContext;

static int32_t zone_resolve(void *raw, const uint8_t *name, size_t len, BcBuf *out) {
  (void)raw;
  return bc_buf_new_copy(name, len, out) == BC_OK ? 0 : 1;
}

static int32_t zone_offset(void *raw, const uint8_t *zone, size_t len, double epoch_ms, int32_t *out) {
  (void)raw;
  (void)zone;
  (void)len;
  (void)epoch_ms;
  *out = 0;
  return 0;
}

static void release(void *raw) {
  SmokeContext *context = (SmokeContext *)raw;
  context->releases += 1;
}

int main(void) {
  SmokeContext context = {0};
  BcHost host = {&context, zone_resolve, zone_offset, NULL, release};
  BcEngine *engine = NULL;
  BcBuf error = {0};
  if (bc_engine_new(&host, &engine, &error) != BC_OK || engine == NULL || error.ptr != NULL) return 10;
  uintptr_t token = (uintptr_t)engine;
  if ((token & 7u) != 0 || (BcEngine *)token != engine) return 11;
  if (!bc_supports((BcEngine *)token, (const uint8_t *)"nativeInit", strlen("nativeInit"))) return 12;
  BcBuf out = {0};
  if (bc_call((BcEngine *)token, (const uint8_t *)"nativeInit", strlen("nativeInit"),
              (const uint8_t *)"[7]", 3, 0, &out) != BC_OK) return 13;
  if (out.len != 1 || memcmp(out.ptr, "7", 1) != 0) return 14;
  bc_buf_free(out);
  bc_engine_free(engine);
  if (context.releases != 1 || bc_supports(engine, (const uint8_t *)"nativeInit", 10)) return 15;
  out = (BcBuf){0};
  if (bc_call(engine, (const uint8_t *)"nativeInit", 10, (const uint8_t *)"[]", 2, 0, &out) != BC_CLOSED) return 16;
  bc_buf_free(out);
  bc_engine_free(engine);
  return context.releases == 1 ? 0 : 17;
}
