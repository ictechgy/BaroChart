# 선택형 Java host 컴파일 검사

실행: `node scripts/check-java-host.mjs`

이 폴더는 Android SDK를 설치하지 않은 환경에서 실제
`AsterEngine.java`, `AsterColumns.java`, `WorkspaceRestoreJob.java`의 Java 문법·타입·checked exception
경계를 검사하는 **test-only compile signatures**입니다. 생산 소스를
재작성하거나 native 메서드와 `System.loadLibrary`를 제거하지 않습니다.
실제 JNI, Android `Handler`/`Looper`, JSON 파서, 메모리 계측을 구현하지
않으며 해당 동작은 `UnsupportedOperationException`으로 즉시 실패합니다.
`JSONException`의 메시지 보관과 `JSONObject.NULL`의 타입 placeholder는
예외이며, NULL의 Android 동등성/직렬화 의미는 구현하지 않습니다.

## 재현과 검증 범위

- 기존 Java의 `jdk.compiler/com.sun.tools.javac.Main` module만 실행합니다.
  `ASTER_JAVA`로 기존 실행 파일을 지정할 수 있습니다. 설치·다운로드는 없습니다.
- 실제 세 생산 파일과 이 폴더의 `.java`, `test/java-host-consumers`의
  공개 workspace API 사용 예제만 명시적으로 컴파일합니다.
  빈 class/source path, `-implicit:none`, `-proc:none`으로 주변 클래스와
  annotation processor의 암묵적 사용을 차단합니다.
- `-source 8 -target 8 -Xlint:all,-options -Werror`를 사용합니다. 배출된
  engine/job/columns class의 Java 8 major version 52도 확인합니다.
- 현재 cloud javac 21.0.12.1은 `--release 8`을 지원하지 않습니다.
  따라서 **Java 8 언어/bytecode 검사 + 설치된 JDK의 표준 라이브러리**이며
  Java SE 8 API 호환성 증거가 아닙니다. `options` 경고만 제외합니다.
- 컴파일 전후 각 입력 SHA-256이 같아야 성공합니다. 클래스 출력은 새 OS
  임시 디렉터리에만 생성하며 성공/실패 후 삭제합니다.
- 출력에는 compiler version, source hash, diagnostics, class count,
  제한을 명시하는 boolean이 포함됩니다. `npm test`에서는 Java를 실행하지
  않으며 check는 명시적으로 호출해야 합니다.

이는 Android SDK/NDK/Gradle 빌드, JNI 연결/숫자 전송, JSON 동작,
스레드/queue 소유권, cancel/commit race, 메모리 수명, 화면 렌더링 또는
실기기 실행을 검증하지 않습니다. Android API availability나 전체 overload
집합도 증명하지 않습니다. 실제 Android 빌드/기기 검증은 별도로 필요합니다.

## 서명 출처와 구현 경계

직접 작성한 최소 서명이며 Android 또는 다른 JSON 구현 소스를 복사하지
않았습니다. 사용한 JSON constructor/checked-exception 서명은 공식 참조로
확인했습니다:

- <https://developer.android.com/reference/org/json/JSONArray>
- <https://developer.android.com/reference/org/json/JSONObject>
- <https://developer.android.com/reference/org/json/JSONTokener>

## 향후 실제 Java 소유권 harness를 위한 경계 제안

별도 변경에서 package-private instance `NativeAccess`와 package-private
test constructor를 도입하면 public constructor는 production bridge를 선택하고
test constructor만 scripted bridge를 받을 수 있습니다. native library loading은
production bridge를 선택할 때만 수행하고 기본 public 경로의 의미를 유지해야
합니다. 모든 context 생성·호출·buffer 전송·메모리 조회·free는 같은 instance
bridge를 지나야 하며 서로 다른 engine의 bridge를 static 전역으로 바꾸면
안 됩니다. `AsterColumns`의 native `writeSlice`도 이 경계를 통과해야 합니다.

소유권·callback 순서를 실행 검증하려면 native bridge 외에 명시적인 owner
queue/clock 경계가 필요합니다. 위 compile-only `Handler`/`Looper`나 JSON
stub를 동작하는 Android 구현처럼 사용해서는 안 됩니다. 좁은 scripted fake의
검증 범위를 별도로 밝혀야 하며 JNI/Android runtime 검증으로 보고하면 안 됩니다.
이 checkpoint는 production adapter나 ownership runtime harness를 추가하지 않습니다.
