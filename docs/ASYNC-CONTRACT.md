# 0.2.3 비동기 계산 계약

> 이 문서는0.2.3 수정 경로의 당시 계약·측정 기록입니다.0.2.4 초기 준비와 큰 UI/history 분할 이전, 현재 검증은 [PREPARE-CONTRACT.md](PREPARE-CONTRACT.md), PREPARE-VALIDATION.md (not included in this source distribution), STABILITY.md (not included in this source distribution)를 참고하세요.

동기 API는 유지합니다. 웹은 module worker, native는 별도 JSC/QuickJS context에서 계산하고 성공 시 소유 스레드에서 prepared context를 전달합니다. native opt-in API는 main/UI owner 생성 engine을 우선 지원합니다. 검증 범위는 같은1m/8지표/15출력 correction fixture의50ms+ UI blocking 감소, exact vector/range parity, 취소·stale·실패 후 원본 불변, snapshot/peak 비용 분리입니다. 실측 전 성능 통과 주장은 하지 않습니다.

## 파일 소유권

root: src/core, src/web, examples/native/bridge.mjs, build/test scripts, declarations, docs/benchmarks/package/Library. Apple worker: native/AsterNative.swift, examples/native/async.swift, examples/native/main.swift, examples/ios/App.swift. Android worker: native/android/java/dev/aster/charts/AsterEngine.java, native/android/aster_jni.c, examples/android/AsyncVerification.java, examples/android/DemoActivity.java. Explorer는 frozen0.2.2의 /tmp 계측만 담당합니다. generated assets/실제 기기·성능 실행은 root가 조율합니다.

## native JS protocol (root 구현)

모든 메타데이터/상태 인수 및 결과 JSON은 **문자열**입니다. Typed buffer helper 결과만 Float64Array이고 JSON stringify하지 않습니다. ticket/slot/index는 정수, chunk count<=262144 doubles(2MiB), checkpoint chunk<=64 rows. 공개 command whitelist로 이 internal helper를 노출하지 않습니다.

Source/owner context:

* nativeAsyncBegin(eventJSON): JSON string {ticket,metadataJSON,buffers:[{slot,length}],checkpoints:[{entry,total}]}. 이벤트 deep snapshot. max1 capture. used builtin factory만 허용. model identity/store version/config/entry revision을 고정합니다. source의 지표 계산을 강제로 동기 실행하지 않습니다.
* nativeAsyncCheck(ticket): true 또는 stale error. **매 capture chunk 및 commit 전에** 확인합니다. 스타일/뷰 변경은 source의 latest UI 상태를 merge하지만 데이터/factory/시리즈 binding 변화는 거부합니다.
* nativeAsyncBuffer(ticket,slot,offset,count): readonly Float64Array view. Source context owner thread에서만 C/JSC typed bytes를 복사하세요. 복사 Data/byte[]는 background으로 전달하고 UI에서 다음 chunk를 queue합니다. 모든 데이터를 JSON 숫자 배열로 변환하지 않습니다.
* nativeAsyncCheckpoint(ticket,entry,offset,count): JSON rows[[index,state],...], nonfinite number는 private marker로 보존. Snapshot 과정의 lazy decode/cache 변경을 source의 의미 변경으로 간주하지 않습니다.
* nativeAsyncUI(ticket): current UI state JSON. 활성 gesture면 commit을 거부하고 원본을 유지합니다. view/follow/crosshair/theme/panels/precision/axis/symbol, drawing records/history/selection/tool/text/size를 포함합니다. 큰 UI 상태 serialize 비용도 측정/문서화합니다.
* nativeAsyncRelease(ticket): 해당 capture reference 해제. stale/cancel/failure도 반드시 owner로 돌아와 release. context swap 전에 old context에 release하며 새 context를 잘못 release하지 않습니다.

Background/isolated context:

* nativeAsyncCreate(metadataJSON): bounded metadata validation, typed target buffers allocation. source 모델은 변경하지 않습니다.
* nativeAsyncTargetBuffer(slot,offset,count): writable Float64Array view. Native host가 정확한 byte length/type/bounds를 검사 후 raw memcpy. source pointer를 background에 넘기지 않습니다.
* nativeAsyncCheckpointImport(entry,rowsJSON): bounded snapshot rows restore.
* nativeAsyncStart(): hydration 검증 후 owned snapshot에 event 적용; source와 같은 vectors/checkpoints/range cache 재사용.
* nativeAsyncStep(maxBars=4096): JSON {phase,done,total,complete}. 계산 chunks 사이 cancel/timeout 확인. builtin 및 같은 resource에 정적으로 연결한 versioned module만 계산합니다. 기존 임의 custom factory/source는 `UnsupportedIndicatorError`로 거부합니다. [정적 모듈 계약](INDICATOR-MODULES.md)을 참고하세요. 함수 실행 중 강제 엔진 free 금지.
* nativeAsyncFinish(uiJSON): 최신 UI 상태를 검증/적용하고 global nativeModel/nativeAPI/nativeInput을 준비합니다. 이 호출은 계산 worker가 완전히 멈춘 후 owner thread로 전달한 prepared context에서 실행합니다. 실패 시 source context는 유지합니다.

## host 수명/결과 계약

기존 engine 객체/observers를 유지하고 그 engine의 context/handle을 성공 시 교체합니다. 공개 context를 캐시한 raw escape-hatch 사용자는 opt-in swap 후 새 context를 조회해야 함을 문서화합니다. source getter/sync API 행동은 async를 사용하지 않을 때 그대로입니다. 전달 후 background은 prepared context에 접근하거나 free하지 않습니다. QuickJS는 native call/copy/free에서 JS_UpdateStackTop와 current JNIEnv를 갱신합니다. JSC VM은 worker와source가 공유하지 않아 compute lock으로 UI를 막지 않습니다.

copy chunks는 한 개씩 backpressure를 적용하여 전체 native snapshot byte[]/Data를 한꺼번에 쌓지 않습니다. background은 target에 copy 후 그 chunk를 해제하고 owner가 다음 chunk를 생성하게 합니다. snapshot intermediate peak를 보고합니다. capture 중 데이터/revision 변경은 discard합니다.

진행/완료는 owner main queue/Handler로 전달합니다. source close/deinit, cancel, supersede, worker/create/parse/copy/compute/finish 오류 및 timeout은 정확히 한 terminal 결과를 내고 source data/contexts를 덮어쓰지 않습니다. progress callback 오류는 worker/cleanup을 중단시키지 않습니다. max1 active job per engine. API는 job.cancel()과 Result/callback 또는 동등한 구조를 제공합니다. cancel은 worker chunk 경계에서 적용하며 지연을 실제 측정합니다.

기본 실행 검사는 success/exact outputs+range+view/drawings/undo, cancel-before/during, stale data/config/source init, wrong owner, error, source closed/deallocated와 callbacks/recreate 수명을 포함합니다. actual platforms/키보드·VoiceOver/physical device scope를 구분합니다. semgrep 인증서 우회·계정/라이선스·공개 배포는 하지 않습니다.

JSON 제한: 공통 checkpoint/UI parser는8Mi UTF-16 code units 및250k nodes/depth32를 사용합니다. host UIUTF-8상한32MiB는 별도의 byte검사입니다. 구성에 따라 해당 한도보다 작은 지원 가능 drawing history가 될 수 있으며 제한 초과는 오류로 원본을 유지합니다.
