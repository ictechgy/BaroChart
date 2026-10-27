# 선택형 Java engine lifecycle 검사

실행:

```sh
ASTER_JAVA=/path/to/jdk/bin/java \
ASTER_JAVA_HOME=/path/to/jdk \
node scripts/check-java-engine-lifecycle.mjs
```

이 fixture는 실제 `AsterEngine.java`, `ParamsUpdateJob.java`,
`NativeJobBudget.java`의 생성자와 close callback 경로를 JVM에서 실행합니다.
작은 host JNI library는 handle 생성·해제·호출 횟수와 해제 오류 주입만
제공합니다. Android와 `org.json` 클래스는 이 테스트가 사용하는 asset,
owner queue, primitive serialization 동작만 제공하는 test-only fixture입니다.

따라서 이 검사는 production Java facade의 lifecycle 동작과 Java 8 target
컴파일을 입증하지만, Android runtime/SDK, production JNI 또는 QuickJS,
완전한 Android JSON 동작, 실기기 실행을 입증하지 않습니다. `npm test`는
runner 모듈의 정적 계약만 검사하며 Java나 clang을 실행하지 않습니다.
