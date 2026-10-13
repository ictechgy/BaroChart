# Java workspace restore 소유권 실행 검사

실행 명령:

```sh
node scripts/check-java-workspace-job.mjs
node --test test/java-workspace-job.test.mjs
```

첫 명령은 실제 production `WorkspaceRestoreJob.java`와 이 디렉터리의 독립
`WorkspaceRestoreJobHarness.java`만 새로운 임시 디렉터리에 컴파일하고 실행한다.
`ASTER_JAVA=/absolute/path/to/java`로 Java 실행 파일을 지정할 수 있다.
두 번째 명령은 Node-only runner/adapter 연결 계약 검사 6개다. `npm test`에 포함되지만 Java를
컴파일하거나 실행하지 않는다.

## 검증 범위

- 실제 package-private production state machine, 실제 worker `Thread`, 크기 128의
  bounded FIFO owner queue를 사용한다. 일반 시나리오의 owner는 harness main
  thread이며 queue 작업은 항상 해당 owner에서만 실행한다.
- 명시적으로 센 **108개 시나리오 / 1,635개 검사**와 별도 JVM의 영구 owner
  소멸 경계 **1개 시나리오 / 9개 검사**를 고정하여 확인한다. 각 Host 호출의
  thread/handle/ticket/복사 순서 fail-fast 불변식은 이 고정 검사 수 외에도 적용된다.
- 별도의 owner thread 2개가 동시에 전체 논리 바이트 예산을 예약하는 경합은
  latch로 동기화하여 정확히 하나만 성공하는지 검사한다. 일반 two-job 허용,
  세 번째 job 거절, 동시 바이트 초과 거절, 정확한 한도 합계 허용도 검사한다.
- 실제 adapter가 호출하는 production `WorkspaceRestoreJob.enqueueInitial()`을
  실행하여 초기 enqueue false/RuntimeException/Error에서 원오류를 caller로
  전달하고 callback/source-protocol/budget/retained 참조가 모두 0인지 검사한다.
  다른 reservation identity 보존, 정상 deferred 시작과 전달 전 취소도 실행한다.
  enqueue한 뒤 throw하는 Host는 계약 밖이지만, 해당 late start도 terminal guard로
  무시되는 방어 경계를 별도로 검사한다. Node guard가 `AsterEngine`의 실제 호출
  연결을 확인하지만 Android adapter 전체를 런타임 실행하는 것은 아니다.
- 성공 시 source identity, 6개 column의 정확한 bounded chunk 복사, 빈 source,
  262,144 + 1 원소 경계, source fence 해제 후 publication, worker 종료 후
  target 소유권 이전, retired source 한 번 해제를 확인한다.
- begin/admission/read/write/compute/target finish/source finish에서 throw,
  cancel, revision stale, close를 주입한다. queued handoff에서 cancel/stale/close,
  final compare/swap 거절, source handle 교체, 잘못된 ticket/짧은 복사 결과도
  별도로 확인한다.
- 취소의 단조성 및 publish monitor 경계, commit 이후 cancel/close와
  retirement/observer/completion/diagnostic callback 오류가 success를 바꾸지
  않는지 확인한다.
- observer/completion 재진입 전에 busy와 예산이 해제되는지 확인한다. 재진입
  시나리오는 해제된 원래 busy 상태를 검사한 뒤 별도 독립 Host의 다음 job을
  시작한다. 실제 `AsterEngine` adapter의 same-engine 재진입은 실행하지 않는다.
- 중복 start/admission, 미완료 admission callback 재전달, 중복/늦은 handoff와
  늦은 copy/progress callback에서 이중 해제, 이중 publication, 두 번째 worker,
  이전 ticket의 새 handle 사용, 중복 completion이 발생하지 않는지 확인한다.
- owner delivery를 멈춘 상태에서 실제 worker의 compute progress 1,000개가
  queued Runnable 1개로 합쳐지고 재개 시 마지막 done=1,000이 전달되는지 확인한다.
  progress enqueue 거절 후 후속 update 복구, callback cancel/close/throw, terminal
  이후 stale progress callback도 실행한다.
- 정상 terminal마다 `retainedForTest()` 전체 0과 시나리오 종료 후 전역
  `budgetForTest()` 시작 기준값 복귀를 확인한다. pending owner cleanup는
  terminal이 아니므로 별도 계약을 적용한다.

## Host 모델의 명시 계약

독립 fake Host는 문자열과 byte array 및 소유 handle ledger를 사용한다. 실제
native handle/JNI allocator/JSON 처리를 흉내 내어 검증됐다고 간주하지 않는다.

`createTarget`은 throw 시 새 자원을 남기지 않는 atomic-on-throw 계약을 가진다.
`beginSource`는 등록 전에도, 등록 후 응답이 유실될 때도 throw할 수 있다. Host는
호출 전에 자기 registration token을 알고 있으며, Begin 결과가 없거나 반환값이
잘못되어 ticket=-1인 경우에도 그 token으로만 Abort한다. 독립 ledger에 다른
registration을 함께 넣어도 해당 registration이 보존되는지 검사한다. 이 token
모델은 Java 소유권 검사이며 실제 JS token protocol 실행 검사는 별도다.

`finishSource`는 callback-capable source fence 해제 이후에만
최종 publication 단계가 진행되도록 모델링한다. `publish`는 재진입 callback이
없는 atomic compare/swap이다. final guard와 swap 사이에 callback을 끼워 넣어
성공하는 가짜 Host 모델을 사용하지 않는다. `releaseReservation`도 callback-free다.

`releaseSource`는 captured handle/ticket에 대한 idempotent Dispose다. 실행 전 또는
실행 후 throw의 효과를 단정하지 않으며, 정상 반환 전에는 source 해제를 확정하지
않는다. 두 종류의 throw 모두 최소 source/Host 참조와 slot/바이트/busy를 pending으로
유지한다. explicit owner 복구 또는 close에서만 재시도하고, 반복 실패 뒤 두 번째
복구·복구 중 close 재진입·원래 handle의 외부 해제와 교체도 검사한다. 이미 free된
source나 새 engine handle에는 이전 ticket으로 Dispose를 재호출하지 않는다.
Begin 응답 유실 뒤 Abort가 실행 전/후에 실패한 경우도 같은 pending/retry 계약을
적용하며, 아직 admission 전이므로 slot만 유지하고 임의의 byte 예약은 만들지 않는다.

## owner queue가 거절할 때

단발성 admission/copy/handoff/delayed-handoff enqueue 거절에서 owner가 아직
복구 작업을 수행할 수 있는 경우 정상 실패와 자원 해제를 검사한다.
`post`/`postDelayed`가 false 대신 `AssertionError`를 던지는 경우도 initial/continued
admission, copy 요청, handoff, cancel, pre-start cancel, worker final cleanup,
delayed handoff에서 실행한다. enqueue Throwable이 작업 실패로 기록되고 owner
복구 규칙이 유지되는지 확인한다.

worker의 cleanup enqueue까지 거절되면 unpublished target은 worker에서 해제하고,
`pendingOwnerCleanup()`을 노출한다. document/binding/descriptor/worker 참조는
제거되지만 **source ticket, 최소 Host 참조, busy, 전역 slot/바이트 예산은 유지**된다.
source가 여전히 보존되기 때문에 예산만 조기 반환하지 않는다.

owner가 다시 실행할 수 있을 때 `resumeOwnerCleanup()` 또는 owner close로
나머지 source/busy/예산/completion을 한 번 정리하는 복구를 검사한다.
영구적으로 owner를 잃으면 owner-only source 해제와 terminal completion을 수행할
수 없다. 이 경계는 별도 JVM에서 의도적으로 nonterminal 상태 그대로 검사하며,
프로세스 종료를 성공적인 production cleanup으로 표현하지 않는다.

## 실행 증거와 한계

runner는 source SHA-256, Java/compiler 버전, 고정 scenario/check 수, 경계 플래그,
컴파일 진단과 임시 산출물 제거 여부를 JSON으로 출력한다. 컴파일/실행에 timeout을
적용하고, class bytecode major 52(Java 8 target), source 입력 변경 여부, 중복/누락된
결과, worker uncaught exception을 포함한 stderr를 검사한다. 완료 또는 실패 시
임시 class 디렉터리를 제거한다.

사용 compiler 옵션은 `-source 8 -target 8 -Xlint:all,-options -Werror`다.
이는 최신 JDK에서 Java 8 소스/bytecode target을 확인하는 것이며 Java SE 8 전체 API
호환성 certification은 아니다. Android SDK 빌드, 실제 `AsterEngine` Host adapter,
Android 런타임, JNI/JSON/native allocator 실행, 물리 기기 성능, 장시간 누수 안정성은
이 검사의 범위 밖이다. 실행 시간은 성능 측정 결과로 사용하지 않는다.
