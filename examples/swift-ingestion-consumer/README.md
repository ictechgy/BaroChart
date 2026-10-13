# 독립 SwiftPM ingestion 소비자

`import AsterNative`로 SDK product와 기본 `Bundle.module` 자원을 소비한다. SDK 소스를 앱 target에 넣거나 private JS context를 읽지 않는다. 10개 named ingestion 메서드, 입력 소유권, pending 저장·복원, 커서·취소 원장, typed error, 격리된 JSC async handoff를 작은8bar fixture로 검증한다. UI나 성능 측정은 하지 않는다.

저장소 루트에서 새 임시 작업 공간을 사용한다.

```sh
task_sdk_root="$PWD"
task_consumer_dir="$(mktemp -d /tmp/aster-swift-ingestion.XXXXXX)"
cp -R examples/swift-ingestion-consumer "$task_consumer_dir/consumer"
ASTER_NATIVE_PACKAGE_PATH="$task_sdk_root" swift build \
  --package-path "$task_consumer_dir/consumer" \
  --scratch-path "$task_consumer_dir/build" -Xswiftc -warnings-as-errors
task_consumer_bin="$(ASTER_NATIVE_PACKAGE_PATH="$task_sdk_root" swift build \
  --package-path "$task_consumer_dir/consumer" \
  --scratch-path "$task_consumer_dir/build" --show-bin-path)"
```

SwiftPM이 출력하는 bin path를 조회하고 해당 `IngestionConsumer`를 실행한다. 일부 SwiftPM 버전은 `build/debug`, 다른 버전은 `build/out/Products/Debug`를 사용한다. 실행 파일을 새 작업 공간 안에서 확인한다.

기본 자원은 인수 없이 실행한다. 로컬 정적 모듈은 별도 경로로 빌드한 자원 URL을 전달한다.

```sh
node scripts/build-native.mjs --bundle-only \
  --output "$task_consumer_dir/local-core.js" \
  --indicator-module examples/indicators/local-volume-balance.mjs
"$task_consumer_bin/IngestionConsumer"
"$task_consumer_bin/IngestionConsumer" "$task_consumer_dir/local-core.js"
```

공유 `native/Resources/aster-core.js`를 로컬 모듈 자원으로 덮어쓰지 않는다. 실제 결과는 실행 파일의 JSON 보고서 및 SDK·자원 SHA와 함께 보존한다. sandbox 안에서 SwiftPM 자체 manifest sandbox가 거부되면, 정상 SwiftPM sandbox를 유지한 승인된 실행 환경에서 동일 명령을 사용한다.
