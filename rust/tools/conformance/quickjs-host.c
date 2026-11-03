/*
 * 대조 하네스용 QuickJS 평가기(개발 전용, M1 계획 Task 4).
 * scripts/rust/conformance.mjs가 저장소의 QuickJS(native/android/quickjs)와 함께 컴파일해, 생성한 엔진 대조 스크립트를
 * Android 백엔드와 같은 엔진으로 실행한다. 스크립트 하나를 전역 코드로 실행하고, 완료 값(문자열)을 표준출력에 쓴다.
 * 사용법: quickjs-host SCRIPT → 종료 코드 0 성공, 1 JS 예외 또는 결과가 문자열이 아님, 2 인자 오류, 3 파일·메모리 오류
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "quickjs.h"

/* 대조 스크립트는 작업 수만 건을 담으므로 크기 제한 없이 읽는다. 실패하면 NULL이고 errno가 남는다 */
static char *read_file(const char *path, size_t *length) {
  FILE *file = fopen(path, "rb");
  if (!file) return NULL;
  char *text = NULL;
  long size = -1;
  if (!fseek(file, 0, SEEK_END)) size = ftell(file);
  if (size >= 0 && !fseek(file, 0, SEEK_SET)) text = malloc((size_t)size + 1);
  if (text && fread(text, 1, (size_t)size, file) != (size_t)size) {
    free(text);
    text = NULL;
  }
  fclose(file);
  if (!text) return NULL;
  text[size] = 0;
  *length = (size_t)size;
  return text;
}

/* 남은 JS 예외를 사람이 읽을 수 있게 표준오류에 쓴다(예외를 버리지 않는다) */
static int report_exception(JSContext *context, const char *where) {
  JSValue error = JS_GetException(context);
  const char *text = JS_ToCString(context, error);
  fprintf(stderr, "quickjs-host: JavaScript exception in %s: %s\n", where, text ? text : "(unprintable)");
  JS_FreeCString(context, text);
  JS_FreeValue(context, error);
  return 1;
}

/* 스크립트를 실행하고 완료 값을 쓴다. 완료 값이 문자열이 아니면 하네스 쪽 스크립트가 잘못된 것이다 */
static int evaluate(JSContext *context, const char *path, const char *source, size_t length) {
  JSValue value = JS_Eval(context, source, length, path, JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(value)) return report_exception(context, path);
  int status = 0;
  if (!JS_IsString(value)) {
    fprintf(stderr, "quickjs-host: %s must end with a string expression (the joined results)\n", path);
    status = 1;
  } else {
    size_t size = 0;
    const char *text = JS_ToCStringLen(context, &size, value);
    if (!text) status = report_exception(context, "result conversion");
    else if (fwrite(text, 1, size, stdout) != size || fputc('\n', stdout) == EOF) {
      perror("quickjs-host: cannot write the results");
      status = 3;
    }
    JS_FreeCString(context, text);
  }
  JS_FreeValue(context, value);
  return status;
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: quickjs-host SCRIPT\n");
    return 2;
  }
  size_t length = 0;
  char *source = read_file(argv[1], &length);
  if (!source) {
    perror("quickjs-host: cannot read the script");
    return 3;
  }
  JSRuntime *runtime = JS_NewRuntime();
  JSContext *context = runtime ? JS_NewContext(runtime) : NULL;
  int status = 3;
  if (!context) fprintf(stderr, "quickjs-host: cannot create a QuickJS context (out of memory)\n");
  else status = evaluate(context, argv[1], source, length);
  free(source);
  if (context) JS_FreeContext(context);
  if (runtime) JS_FreeRuntime(runtime);
  if (fflush(stdout)) {
    perror("quickjs-host: cannot flush the results");
    status = 3;
  }
  return status;
}
