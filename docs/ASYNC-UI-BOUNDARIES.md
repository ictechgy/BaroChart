# 비동기 UI 조각의 직렬화 크기 경계

0.2.4의 `AsyncUICapture.next()`는 조각당 참조 64개와 새 점 2,048개를 제한했지만 JSON 문자열의 실제 길이는 마지막에 검사했습니다. Public drawing API가 허용한 텍스트 도형 64개에 각 2,000개의 줄바꿈을 넣으면 저장 문서는 266,154 UTF-16 코드 단위이고, 첫 전송 조각은 267,742 코드 단위가 되어 262,144 제한을 넘었습니다. 계산된 데이터나 원본 UI가 손상되지는 않았지만 정상 prepare/correction이 실패했습니다.

수정된 packer는 새 immutable 도형을 한 번 직렬화한 뒤 JSON escaping이 반영된 실제 UTF-16 길이, UTF-8 바이트 수, 직렬화 구조의 노드 수를 계산합니다. 각 후보의 envelope·slot·reference·쉼표 길이도 포함하여 다음 다섯 예산을 모두 만족할 때만 조각에 넣습니다.

| 한 조각의 예산 | 최대 |
|---|---:|
| UTF-16 코드 단위 | 262,144 |
| UTF-8 바이트 | 1,048,576 |
| checkpoint 구조 노드 | 250,000 |
| 참조 | 64 |
| 새 도형에 포함된 점 | 2,048 |

크기 때문에 다음 조각으로 넘어가는 후보 하나만 보관합니다. 이미 전달한 도형은 이력 프레임에서 기존 slot을 참조합니다. 점점 커지는 후보 조각을 반복하여 직렬화하지 않습니다. 완성한 조각에 포함된 slot과 offset만 확정하므로, 포함되지 않은 후보나 잘못된 Unicode로 실패한 조각이 capture의 진행 위치를 바꾸지 않습니다. Importer의 순서·offset·중복/미사용 record·도형/프레임/전역 이력 예산·요청 binding·stale 검사는 유지했습니다.

현재 drawing schema에서는 최대 도형 하나를 더 잘게 나눌 필요가 없습니다. 점 2,048개, 각 점의 유한 숫자 두 개를 JSON token당 보수적인 25자로 계산하고, 텍스트 2,000자의 최대 6배 escaping 및 ID·panel·font·style 한도를 더해도 한 record는 180,000 코드 단위 아래입니다. 실제 최대 경계 fixture는 ±Date 범위, ±Number.MAX_VALUE, 2,000개의 NUL, 최대 ID와 font를 함께 사용합니다. 이후 schema의 한도를 확대할 경우 이 한-record 조건도 다시 검증해야 합니다.

UTF-16 길이와 UTF-8 바이트 수를 같은 값으로 취급하지 않습니다. CJK는 보통 코드 단위당 3바이트, paired emoji는 2코드 단위/4바이트이며, NUL·줄바꿈·따옴표·백슬래시는 JSON escaping 후 길이를 검사합니다. 기존 checkpoint의 Unicode scalar 검사는 그대로 유지합니다. Unpaired surrogate는 비동기 portable protocol에서 거부되며, 이 수정이 해당 입력을 정상 문자열로 바꾸어 수용하지는 않습니다.

## 검증

수정 전 `artifacts/cycle5-review/ui-red-node.log`에서 prepare/correction 기대 성공 검사 2개가 모두 동일한 크기 오류로 실패했습니다. 동일한 0.2.4 core를 사용하는 보존된 실제 macOS JSC 하네스에서도 두 API가 같은 오류를 반환했습니다. `artifacts/cycle5-review/ui-red-native.json`은 terminal 각 1회, 원본 context·32봉의 6개 컬럼·inspect·drawing 문서 유지, terminal callback/context 필드 해제를 기록합니다. 하네스가 함께 출력한 기존 close 3개 probe는 이 새 수정의 별도 성과로 집계하지 않습니다. 실행 binary/core 해시는 `artifacts/cycle5-review/ui-frozen-hashes.txt`에 남겼습니다.

수정 후 `node --test test/async-ui.test.mjs test/async-ui-boundaries.test.mjs`의 18개 검사가 통과했습니다. 기존 100k점 이력 검사와 새 텍스트 64개, NUL/quote/backslash/CJK/emoji/separator/mixed scalar, 최대 단일 freehand record, 긴 유한 좌표, 모든 drawing type, 전체 undo/redo graph·선택·serial·limits, history dedup, 첫 조각 후 target 폐기와 UI stale, 잘못된 Unicode의 offset/slot 원자성을 확인합니다. 직렬화 호출 계수도 새 immutable 도형당 1회를 확인합니다. 이는 전송 경계의 정확성 검사이며 처리량 벤치마크나 모든 플랫폼의 속도 보장이 아닙니다.

수정 파일이 반영된 전체 `npm test`도 당시277/277 통과했고, 최종0.2.5는278/278 통과했습니다(`artifacts/cycle5-review/final-tests.log`). macOS 전체 Swift 소스의 `swiftc -typecheck -warnings-as-errors`도 통과했습니다. 이 타입 검사는 JavaScriptCore에서 새 fixture를 실제 실행한 결과와 구분합니다.

Swift fixture는 기존 `--prepare-test`에 `text-ui`, `max-text-ui`, `unicode-text-ui`, `text-ui-cancel`, `text-ui-stale`를 추가하고, `--async-test`에 `text-ui`, `max-text-ui`를 추가합니다. setup과 큰 inspect/save/scene/undo/redo reference 검사는 heartbeat 측정 밖에서 수행합니다. 실제 macOS/iOS prepare287단언/43paths와 correction129/31paths가 통과했습니다. prepare는42retainedterminalhandles와132weakprobes도 검사합니다. Android prepare200/correction53/large29는 별도의 기존 100k점 UI와15output full-vector 경로입니다. Swift text-specific fixtures를 Android에서 실행했다고 표시하지 않습니다. 원본과 실행 asset 범위는 CYCLE5-VALIDATION.md (not included in this source distribution)와 `artifacts/cycle5-review/`에 기록합니다. 0.2.4의243/38·113/29 결과와 구분합니다.
