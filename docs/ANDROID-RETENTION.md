# 완료된 Android 작업의 참조 정리

0.2.4에서 완료된 `AsterEngine.AsyncJob`을 앱이 보관하면 listener와 캡처한 Activity, 요청 JSON/descriptor, worker 또는 실패 객체에 도달할 수 있었습니다. native handle이 해제되어도 Java 객체가 해제된다는 의미는 아닙니다. 0.2.5는 terminal callback에 결과·metrics를 전달한 뒤 `finally`에서 listener, eventJSON, inputColumns, descriptor, worker, preceding, failure를 비웁니다. 작업 소유 Handler callback도 제거합니다. 이미 큐에 든 progress는 terminal/stopped/null listener를 확인하므로 완료 후 callback을 전달하지 않습니다.

`close()`는 observers·observer errors·error listener도 비우며 재호출할 수 있습니다. job은 nonstatic inner class여서 보관한 job이 닫힌 outer engine 및 Handler를 보관하는 관계는 유지됩니다. `AutoCloseable`/owner-thread와 명시적 `close()` 계약을 계속 지켜야 합니다. 이 수정은 모든 외부 앱 참조의 자동 수거를 약속하지 않습니다.

## 재현과 실제 결과

`RetentionVerification.java`는 성공 correction/columns, begin/worker 실패, 시작 전/복사 중 취소, timeout, supersession/replacement, throwing completion, active close를 포함한 11개 terminal handle을 계속 보관합니다. 각 callback은 정확히 한 번인지, 완료 뒤 progress는 0인지 확인합니다. private field와 weak reference, native handle inspector, 실제 `Activity.recreate()`의 이전 Activity 수거를 각각 검사합니다.

보존 0.2.4 JNI/core APK에 동일한 새 fixture와 기존 Java engine을 넣은 differential 실행은 의도한 listener/request retention을 재현했습니다. 동일 JNI/core에 수정 Java engine만 넣은 실행은 240개 단언을 통과했습니다. 최종 0.2.5 APK에서는 241개 단언, 11개 보관된 terminal handle, 두 Activity attachment, 이전 Activity 수거를 확인했습니다. 세 실행 모두 terminal 횟수·status와 native handle 수를 별도로 검사하여 다른 실패를 retention 재현으로 계산하지 않습니다. 최종 실행에서 강제 GC 시도는 1회였습니다. GC timing과 해당 fixture의 reachability 관측이며 장기 누수 부재의 증명은 아닙니다.

```sh
npm run build:native
npm run build:android
ASTER_ANDROID_SERIAL=<chosen-api36-arm64-device> npm run test:android:retention
```

runner는 명시적으로 선택한 API36/arm64-v8a 기기에 자체 debug 앱만 설치합니다. 다른 앱·AVD를 삭제하지 않습니다. baseline을 비교하려면 해당 보존 소스에서 APK를 먼저 빌드한 후:

```sh
node scripts/build-retention-probe.mjs \
  --base-apk /path/to/baseline.apk \
  --engine /path/to/baseline/AsterEngine.java \
  --out /tmp/aster-retention-probe
ASTER_ANDROID_SERIAL=<chosen-device> node scripts/test-android-retention.mjs \
  --apk /tmp/aster-retention-probe/aster-retention.apk \
  --output /tmp/aster-retention-before.json --expect-retained
```

`--out`는 builder가 classes/dex를 새로 만드는 전용 scratch 디렉터리여야 합니다. 선택한 APK의 JS/JNI만 복사하고 Java engine과 current fixture를 컴파일합니다. SDK/JDK와 로컬 debug signing key가 필요합니다. builder 자체는 기기에 연결하지 않습니다.

원본 differential JSON은 `artifacts/cycle5-review/android-retention-before.json`, `android-retention-after-frozen-core.json`, 최종 결과는 `benchmarks/results/android-retention-validation.json`입니다. 물리 기기·다른 ABI/OS·며칠 운영은 이번 실행 범위에 포함하지 않습니다.
