# Android private Float64 표시 전송

`AsterChartView`는 QuickJS의 display commands를 private packet으로 받는다. 원본 OHLCV·지표 벡터를 변경하거나 transfer하지 않는다. 기존 public `scene()`·`render(Canvas, JSONObject)` 및 native JSON 함수는 유지한다. Apple renderer는 기존 JSON 경로를 사용하며 이 Android 전송의 네이티브 구현을 Apple에도 제공했다고 설명하지 않는다.

packet v1은 작은 UTF-8 JSON metadata와 소유한 `double[]`로 구성된다. metadata에는 string dictionary·layer counts·표시 크기·background·stats가 있으며 geometry와 dash는 Float64Array에서 JNI 소유 복사로 전달한다. JNI 반환은 표준 `Object[]{String,double[]}`라 새 nested Java class 이름을 C에서 찾지 않는다. borrowed QuickJS buffer를 Java에 남기지 않는다. 이는 zero-copy 전송이 아니다.

숫자 record는15개 Float64 header 다음 dash와 순서 있는 geometry다. 여섯 연산은 lines·rects·path·box·ellipse·text이다. null layer는 기존 cache 유지, commands0인 layer는 실제 비움이다. Float64 합산과 Canvas/Path의 float 변환 위치는 기존 renderer와 같다. color/font/dash 및 전체 record를 Canvas에 쓰기 전에 검증한다.

private 한도는 숫자8,388,608개(64MiB), UTF-8 metadata1MiB, commands/strings 각각65,536개다. 초과·손상 packet은 잘라서 그리지 않는다. 실패 counter와 원인을 기록하고500ms cooldown·필요한 frame token 해제·강제 base 재작성 후 기존 JSON 경로로 복구한다. cache bitmap의 process-wide 예산과 detach/close 계약은 유지한다.

Node writer의 exact Float64·negative zero·Unicode·header/clip/dash/수치 한도·실제 buildScene·기존 JSON·cache-empty 회귀와 native module 검사는9/9 통과했다. macOS JSC의 기존 수집23·codec7·async34, closed-ring 검사는 새 공통 bundle에서 통과했다. API36 arm64 Android emulator에서 decoder39·pixel7·실제 attached JNI/View27 검사가 통과했다. 이73개에는6-op pixel equality, 비정상 record의 사전 거부, nonzero byteOffset, Unicode/NUL/lone surrogate, zero-length cached packet, legacy fallback/retry, bitmap/handle 정리를 포함한다.

Android fixture 전용 wrapper는 별도 APK asset에만 추가한다. 실제 기능 APK의 base core SHA는 `9513852230e19b9e3ee483fd7d15f022e4e50bcda972160ef93fd4678c31cb7f`이고 test wrapper 포함 SHA는 `443ee6a4534a48ed8bc2110fb459bf0df9b9660ce5962be51932b0bf7d6ce7ae`다. 공유 production bundle에 test dispatch를 넣지 않았다. QuickJS 원본을 바꾸지 않고 dependency headers를 `-isystem`으로 구분하며 새 JNI는 `-Wall -Wextra -Werror`로 빌드했다.

독립 Kotlin 소비자 debug/release의 각1056 semantic checks도 통과했다. 기존 release fixture는debuggable=true여서 R8 task 실행만으로 완전 optimization/obfuscation을 증명하지 않는다. 별도 `/tmp` 소비자 사본은debuggable=false·shrinking/obfuscation을 켜고 실제 R8 APK를 실행했다. mapping에서ScenePacket의 난독화명`a.p`를 확인했고 `packetFrames>0`, `packetFailures=0`, HOME/resume/recreate/close 및 기존 소비자 계약이 통과했다. 원본 소비자나 AAR keep rule은 바꾸지 않았다. 해당 APK SHA는 `4f05ec7c5aa7e0ca29995106dd2a4750c3a9955d65acee505db666ede38e7d7d`다.

최적화·warnings-as-errors로 빌드한 macOS CLI의 self/API/study/publication/axes/frame/async/prepare 회귀8명령도 모두 종료 코드0이다. 같은 fixture의 반복·900초 성능 비교는 별도 증거로 기록한다. 여기서 미측정 성능 개선률, 물리 기기 FPS나 장기 누수 부재를 주장하지 않는다. 비용 선택 근거는 CYCLE13-COST-ATTRIBUTION.md (not included in this source distribution)에 있다.
