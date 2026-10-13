# Cycle10 reproducible native/core before-after profile

이 폴더만 `benchmarks/cycle10/`에 복사하면 machine-specific `/tmp` 경로 없이 실행할 수 있습니다. 실제 runtime source/SDK를 바꾸지 않습니다. Mac용 JSC/CoreGraphics profile은 Xcode command-line Swift compiler가 필요합니다. Node26.5.0에서 준비했으며 runtime/version은 결과에 기록됩니다. baseline root는 보존한0.2.9 소스ZIP을 푼 디렉터리여도 됩니다. Git이 없을 때도 `--baseline-root`를 지정하면 archive 없이 복사·빌드합니다.

## 복사할 파일 목록

```
config.mjs
prepare.mjs
run-pairs.mjs
summarize.mjs
NativeLabelProfile.swift
main.swift
probes.js
phase-hooks.js
README.md
node/notification.mjs
node/prepare.mjs
node/run-pairs.mjs
node/summarize.mjs
```

컴파일 binary/module cache나 이전 snapshot은 소스ZIP에 넣을 필요가 없습니다. 원자료와 before/after SHA/manifest는 별도 결과로 보존합니다. Root가 원본`benchmarks/native-hover.swift`를 함께 유지하여 입력 출처를 설명할 수 있습니다.

## 필요한 입력 root

각 SDK root에 아래 파일이 있어야 합니다.

```
native/AsterNative.swift
native/AsterColumns.swift
native/AsterFrameRenderer.swift
native/Resources/aster-core.js
src/core/*.mjs
```

baseline20720b9b7c8bfb91e209cf9b32b9ed2aa6a3d24e15fb23880822419b753b3a53은479b870/보존0.2.9에 해당합니다. candidate 준비 시 현재 final bundle SHA를 명시합니다. SHA가 다르면 진행하지 않습니다. root의`native/AsterUIKit.swift`는 macOS offscreen compile에 사용하지 않습니다.

## prepare (측정하지 않음)

프로젝트 root에서 아래를 실행합니다. `/path/to/baseline-0.2.9`는 ZIP 압축을 푼 실제 root로 바꿉니다. `--candidate-root .` 대신 별도 candidate root도 지원합니다. 모든 생성물은`--output-root`에만 씁니다.

```
node benchmarks/cycle10/prepare.mjs --baseline-root /path/to/baseline-0.2.9 --candidate-root . --output-root /tmp/aster-cycle10-profile --candidate-core-sha 4d601b4a413887ade500a3e9c5606c295aadd29291fe1670f853e4ed348e8df3
node benchmarks/cycle10/node/prepare.mjs --baseline-root /path/to/baseline-0.2.9 --candidate-root . --output-root /tmp/aster-cycle10-profile
```

같은 값은`ASTER_BASELINE_ROOT`, `ASTER_CANDIDATE_ROOT`, `ASTER_PROFILE_OUTPUT_ROOT`, `ASTER_CANDIDATE_CORE_SHA`로 지정할 수 있습니다. Git479b870이 있는 저장소에서는 baseline-root 생략 시 git archive를 사용합니다. 저장소가 없는 ZIP 소비자는 baseline-root를 지정해야 합니다.

## 명시적 quiet slot 후 serial 실행

GO 전에는 `--quiet-approved-by-root`를 빼면 명령 계획만 출력합니다. Native 또는 Node를 동시에 돌리지 않습니다. 실행 중 자체 native/browser/build 작업을 함께 돌리지 않습니다.

```
node benchmarks/cycle10/run-pairs.mjs --output-root /tmp/aster-cycle10-profile --quiet-approved-by-root
node benchmarks/cycle10/summarize.mjs --output-root /tmp/aster-cycle10-profile --mode clean
node benchmarks/cycle10/node/run-pairs.mjs --output-root /tmp/aster-cycle10-profile --quiet-approved-by-root
node benchmarks/cycle10/node/summarize.mjs --output-root /tmp/aster-cycle10-profile
```

필요하고 승인된 경우에만 별도 optional diagnostic run:

```
node benchmarks/cycle10/run-pairs.mjs --output-root /tmp/aster-cycle10-profile --quiet-approved-by-root --instrumented
node benchmarks/cycle10/summarize.mjs --output-root /tmp/aster-cycle10-profile --mode instrumented
```

## 측정/해석 경계

Native: 100k seed42 candle1+line1/32, recent200/full100k, CSS1200×700, DPR1/2, cached frame, warm20+80. 세 fresh-process pair를 AB/BA/AB로 serial 실행합니다. sceneJSONMs는 core/JSON/host string 변환 aggregate이고 decode/CoreGraphics software bitmap+makeImage/1-byte completion을 분리합니다. nativeAccessibility(true) JS, Foundation toDictionary, host readout/fallback 작성·UTF8 byte count, render+readout total도 별도입니다. UIView/AppKit 실제 draw, input hardware, compositor/presentation FPS를 뜻하지 않습니다. setup/source/VM/first range preparation/disk/PNG/digest는 샘플 밖입니다.

Clean bundle은 연산을 바꾸지 않고 untimed read-only probe만 추가합니다. Instrumented bundle은 SceneCache.frame/외부 JSON.stringify의 Swift clock crossing이 들어간 별도 진단값입니다. Pure uninstrumented core 비용이라고 주장하지 않고 clean aggregate와 섞지 않습니다. 원본/각 변형 SHA를 보존합니다.

Native lifetime: bitmap/budget owned bytes, bridge Map frame entry, Mirror engine frameCleanup callback count 및 closed renderer rejection을 관측합니다. close 후0을 요구하지만 전체 JSContext/CGImage COW/RSS/GPU/장기 leak count는 아닙니다. 모델 Float64 vectors의2×UInt32 FNV-style bit digest와 raw rows/view/document/crosshair 값을 paired 비교합니다. FNV digest는 cryptographic hash가 아니며 code/bundle/harness에는 SHA256을 씁니다.

Node: 100k seed42, close-column line1/32, EMA20 internal invalidation1개, external callback4개(모델 이전2/이후2), tail update/append warm200+1000. callback은 event/committed raw store만 읽습니다. Source mutation+index+invalidation+callbacks의 동기 비용이며 renderer/bridge/실시간 feed 처리량을 주장하지 않습니다. input objects/EMA/query/digest는 timed loop 밖입니다. 실제 callback count/checksum/raw-value sums, full Float64/EMA SHA256, raw rows/view/document/공개 listener ledger cleanup0를 paired 비교합니다. 초기100k+1200 append는 capacity131072 안에 있으므로 capacity-growth 비용은 제외됩니다.

아직 측정되지 않은 상태에서 결과/향상/FPS를 주장하지 않습니다. root의47개 native frame regression 검사는 별도 기능 검증 근거입니다.
