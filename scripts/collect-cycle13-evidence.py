"""Collect explicit, text-only Cycle13 evidence without running platform workloads."""
import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path, PurePosixPath
sys.dont_write_bytecode = True

WEB_FILES = (
    'ANALYSIS.txt', 'CLEANUP.json', 'COMMANDS.txt', 'CONTRACT.log',
    'LIGHT-COMPLETED.json', 'NORMAL-COMPLETED.json', 'PLAN-normal.json',
    'PLAN.json', 'PLAN.md', 'QUIET.json', 'RAW-MANIFEST.json', 'SUMMARY.json',
    'SUMMARY.md', 'TRIAGE.json', 'TRIAGE.md', 'analyze-existing.mjs',
    'contract-check.mjs', 'frozen/cycle13-web-profile.mjs',
    'runs/diagnostic/feed.cpuprofile', 'runs/diagnostic/feed.heapprofile.json',
    'runs/diagnostic/post-feed-workers.cpuprofile',
    'runs/diagnostic/post-feed-workers.heapprofile.json',
    'runs/diagnostic/report.json', 'runs/light/report.json',
    'runs/normal/report.json', 'summarize.mjs',
)
FROZEN_HARNESS_FILES = (
    'benchmarks/ingestion.mjs', 'benchmarks/browser-ingestion.mjs',
    'benchmarks/browser-soak.mjs', 'scripts/cdp.mjs',
    'scripts/profile-cycle12-ingestion.mjs', 'test/cycle12-ingestion-browser.mjs',
)
APPLE_FILES = ('CAUSES.json', 'CAUSES.md')
P2_FILES = ('CONFIRMATION.json', 'CONFIRMATION.md', 'archive-audit.json',
            'audit-archives.py', 'current-budget-probe.json',
            'node-regressions.log', 'write-confirmation.py')
ROOT_LOGS = ('aster-cycle13-full-unit.log', 'aster-cycle13-syntax.log',
             'aster-cycle13-types.log', 'aster-cycle13-types-corrected.log',
             'aster-cycle13-native-codec-focused.log')
NATIVE_FILES = {
    'functional': ('build-manifest.json', 'build.log', 'native-ingestion.json', 'run.log'),
    'closed': ('build-manifest.json', 'build.log', 'native-closed-ingestion.json', 'run.log'),
}
ALLOWED_SUFFIXES = {'.json', '.md', '.txt', '.log', '.tap', '.mjs', '.js',
                    '.py', '.swift', '.java', '.mts', '.cpuprofile', '.diff'}
BLOCKED_PARTS = {'.git', 'node_modules', 'SDK', 'sdk', 'cache', '.gradle',
                 'AVD', 'avd', '.build', 'DerivedData', 'build', 'keys'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_relative(value):
    path = PurePosixPath(value)
    if not isinstance(value, str) or not value or path.is_absolute() or '..' in path.parts or '\\' in value:
        raise ValueError('Unsafe package path')
    return path


def read_allowed(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f'Missing regular evidence file: {path}')
    if path.suffix.lower() not in ALLOWED_SUFFIXES or any(part in BLOCKED_PARTS for part in path.parts):
        raise ValueError(f'Non-allowlisted evidence type/location: {path}')
    before = path.stat()
    if before.st_size > 32 * 1024 * 1024:
        raise ValueError(f'Evidence exceeds32MiB text-file bound: {path}')
    data = path.read_bytes()
    after = path.stat()
    if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
        raise ValueError(f'Evidence changed during collection: {path}')
    if b'\x00' in data:
        raise ValueError(f'Binary evidence is forbidden: {path}')
    data.decode('utf-8')
    return data


class Group:
    def __init__(self, root):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        proof = self.root / 'COPY-SHA-PROOF.json'
        manifest = self.root / 'PACKAGED-MANIFEST.json'
        self.copies = json.loads(read_allowed(proof)) if proof.is_file() else []
        self.provenance = json.loads(read_allowed(manifest))['externalHostProvenance'] if manifest.is_file() else []

    def put(self, name, data):
        safe_relative(name)
        target = self.root / name
        if target.is_symlink():
            raise ValueError(f'Existing evidence symlink: {target}')
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.resolve().is_relative_to(self.root.resolve()):
            raise ValueError('Evidence destination escapes group')
        if target.exists() and target.read_bytes() != data:
            raise ValueError(f'Refusing to overwrite changed preserved evidence: {target}')
        if not target.exists():
            target.write_bytes(data)

    def copy(self, source, name, expected=None, role='original evidence'):
        data = read_allowed(source)
        actual = digest(data)
        self.put(name, data)
        row = {'path': name, 'sourceAbsolutePath': str(source.resolve()),
               'bytes': len(data), 'sha256': actual, 'copySHAIdentical': True,
               'role': role}
        if expected is not None:
            row.update(recordedSHA256=expected, recordedHashMatches=actual == expected)
        if not any(old['path'] == name and old['sha256'] == actual for old in self.copies):
            self.copies.append(row)
        provenance = {'originalAbsolutePath': str(source.resolve()),
                      'included': False, 'containedCopy': name,
                      'reason': 'Original host location is provenance only; the byte-identical contained copy is inventoried by its relative path.'}
        if provenance not in self.provenance:
            self.provenance.append(provenance)
        return row

    def external(self, path, reason, contained_reference=None):
        row = {'originalAbsolutePath': str(path), 'included': False, 'reason': reason}
        if contained_reference:
            row['containedReference'] = contained_reference
        if row not in self.provenance:
            self.provenance.append(row)

    def finish(self, readme):
        allowed = {row['path'] for row in self.copies} | {'README.md', 'COPY-SHA-PROOF.json'}
        for existing in self.root.rglob('*'):
            if existing.is_symlink():
                raise ValueError('Evidence symlink')
            if existing.is_file() and existing.name != 'PACKAGED-MANIFEST.json' and existing.relative_to(self.root).as_posix() not in allowed:
                raise ValueError(f'Existing file is not in explicit collection allowlist: {existing}')
        self.put('README.md', readme.encode())
        (self.root / 'COPY-SHA-PROOF.json').write_text(json.dumps(self.copies, indent=2, ensure_ascii=False) + '\n')
        rows = []
        for path in sorted(self.root.rglob('*')):
            if path.is_file() and path.name != 'PACKAGED-MANIFEST.json':
                if path.is_symlink():
                    raise ValueError('Evidence symlink')
                data = path.read_bytes()
                rows.append({'path': path.relative_to(self.root).as_posix(),
                             'bytes': len(data), 'sha256': digest(data)})
        manifest = {'schema': 'aster.packaged-evidence.v1',
                    'includedFiles': rows, 'externalHostProvenance': self.provenance,
                    'scope': 'Explicit allowlist copies only. No workload, platform build, replay or benchmark execution.'}
        # Metadata can be regenerated for a later explicit receipt collection;
        # original files above are never replaced with different bytes.
        (self.root / 'PACKAGED-MANIFEST.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
        return manifest


def optional_receipts(group, allowlist):
    if allowlist is None:
        group.external('validator-final-receipts', 'Not frozen yet. Collect later only through an explicit JSON allowlist with expected SHA256 for every file.')
        return
    rows = json.loads(read_allowed(allowlist))
    if not isinstance(rows, list) or len(rows) > 64:
        raise ValueError('Receipt allowlist must contain at most64 explicit rows')
    for row in rows:
        if set(row) != {'source', 'path', 'sha256'} or not isinstance(row['sha256'], str) or len(row['sha256']) != 64:
            raise ValueError('Receipt row requires source/path/sha256')
        name = 'receipts/' + str(safe_relative(row['path']))
        source = Path(row['source'])
        data = read_allowed(source)
        if digest(data) != row['sha256']:
            raise ValueError('Final receipt SHA changed')
        group.copy(source, name, row['sha256'], 'Explicit later final validator receipt')


def load_verifier(repo):
    spec = importlib.util.spec_from_file_location('evidence_verifier', repo / 'scripts/verify-evidence-package.py')
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    return verifier


def collect(args):
    repo = args.repo.resolve()
    output = args.output.resolve()
    if args.receipts_only:
        if args.receipts_allowlist is None:
            raise ValueError('--receipts-only requires --receipts-allowlist')
        verification = Group(output / 'verification')
        verifier = load_verifier(repo)
        verifier.verify_directory(verification.root)
        old_manifest = json.loads((verification.root / 'PACKAGED-MANIFEST.json').read_text())
        verification.copies = json.loads((verification.root / 'COPY-SHA-PROOF.json').read_text())
        verification.provenance = old_manifest['externalHostProvenance']
        optional_receipts(verification, args.receipts_allowlist)
        verification.finish((verification.root / 'README.md').read_text())
        return {'schema': 'aster.cycle13.evidence-collection', 'measurementRan': False,
                'receiptsIncluded': True, 'receiptOnly': True,
                'verification': verifier.verify_directory(verification.root)}
    web = Group(output / 'web')
    attribution = Group(output / 'attribution')
    verification = Group(output / 'verification')
    verifier = load_verifier(repo)
    for group in (web, attribution, verification):
        if (group.root / 'PACKAGED-MANIFEST.json').is_file():
            verifier.verify_directory(group.root)
    for name in WEB_FILES:
        web.copy(args.web / name, name)
    plan = json.loads((args.web / 'PLAN.json').read_text())['runs'][0]
    for name, expected in plan['originalHarness'].items():
        if name not in FROZEN_HARNESS_FILES:
            raise ValueError('Unexpected frozen harness entry')
        copied = web.copy(args.frozen_harness / name, 'frozen-harness/' + name, expected, 'Measured original Cycle12 harness')
        if not copied['recordedHashMatches']:
            raise ValueError('Original frozen harness SHA differs')
    if set(plan['originalHarness']) != set(FROZEN_HARNESS_FILES):
        raise ValueError('Missing one of six measured harness files')
    for name, expected in plan['source']['files'].items():
        safe_relative(name)
        if not (name.startswith('src/') or name == 'package.json'):
            raise ValueError('Unexpected frozen web source entry')
        row = web.copy(args.baseline / name, 'frozen-source/' + name, expected, 'Exact measured4a web source')
        if not row['recordedHashMatches']:
            raise ValueError('Frozen web source differs from measurement')
    web.external('/tmp/aster-cycle12-browser-pressure900-final/report.json', 'Original900 raw remains unchanged in separately preserved Cycle12 evidence; Cycle13 TRIAGE contains derived read-only observations.', '../../cycle12/browser900/report.json')
    web.external(plan['sourceRoot'], 'Old absolute sourceRoot is not a portable path; exact source bytes are included under frozen-source.', 'frozen-source')
    web.external('/tmp/aster-cycle13-web/runs', 'Original RAW-MANIFEST absolute paths remain verbatim; all seven raw report/profile files are included here under runs.', 'runs')

    for name in APPLE_FILES:
        attribution.copy(args.apple / name, 'apple/' + name)
    for name in P2_FILES:
        attribution.copy(args.p2 / name, 'p2/' + name)
    p2 = json.loads((args.p2 / 'CONFIRMATION.json').read_text())
    for name, expected in p2['sourceSHA256'].items():
        safe_relative(name)
        source = args.baseline / name
        if not source.is_file() and (repo / name).is_file():
            source = repo / name
        if not source.is_file():
            attribution.external(source, 'Recorded source was not available in the preserved extracted baseline; current source is not substituted as a measured match.')
            continue
        if digest(read_allowed(source)) != expected and (repo / name).is_file() and digest(read_allowed(repo / name)) == expected:
            source = repo / name
        row = attribution.copy(source, 'frozen-baseline-source/' + name, expected, 'Source cited by P2 confirmation; recordedHashMatches states whether the exact cited bytes were available')
        if not row['recordedHashMatches']:
            attribution.external(source, 'Recorded source snapshot SHA unavailable; available text copied for context with recordedHashMatches:false, never represented as the original executed source.')
    attribution.external('/tmp/aster-cycle12-apple/ios-candidate-900-corrected', 'Original iOS900 data is separately preserved; CAUSES is analysis, not a new run.', '../../cycle12/apple/ios900')
    attribution.external('artifacts/*.zip', 'Large original release/source archives stay separately preserved; archive-audit reports their original identities without copying ZIPs here.')

    for name in ROOT_LOGS:
        source = Path('/tmp') / name
        if source.is_file():
            verification.copy(source, 'root/' + name)
        else:
            verification.external(source, 'Requested verification log was unavailable; no successful execution is invented.')
    for kind, names in NATIVE_FILES.items():
        source_dir = Path('/tmp/aster-cycle13-native-' + kind)
        if not source_dir.is_dir():
            verification.external(source_dir, 'Native functional text evidence unavailable; no platform run was started by this collector.')
            continue
        for name in names:
            verification.copy(source_dir / name, 'native-' + kind + '/' + name)
        build = json.loads((source_dir / 'build-manifest.json').read_text())
        for name, expected in build['sources'].items():
            safe_relative(name)
            verification.copy(repo / name, 'native-' + kind + '/source-at-collection/' + name, expected, 'Source at collection; recordedHashMatches distinguishes it from the executed build')
        verification.copy(repo / 'native/Resources/aster-core.js', 'native-' + kind + '/source-at-collection/native/Resources/aster-core.js', build['coreSHA256'], 'Resource at collection; recordedHashMatches distinguishes it from executed native core')
        verification.external(source_dir / 'ingestion-cli', 'Compiled executable deliberately excluded; binary SHA remains in original build-manifest. Rebuild from the included source in an authorized functional window.')
    verification.copy(repo / 'scripts/verify-evidence-package.py', 'frozen-scripts/verify-evidence-package.py', role='Collector inventory verifier source')
    collector_sha = digest(read_allowed(Path(__file__)))
    verification.copy(Path(__file__), 'frozen-scripts/collect-cycle13-evidence-' + collector_sha + '.py', collector_sha, 'Versioned collector source; earlier source snapshot remains preserved')
    optional_receipts(verification, args.receipts_allowlist)

    web_readme = f'''# Cycle13 웹 귀속진단 증거\n\n원본26파일, 실제3report+4profile, 동결6harness와 정확한4a 웹 source/package를 포함한다. 원래 absolute host path가 들어간 JSON/명령은 수정하지 않았다. 상대 includedFiles 목록이 실제 포함물이며, externalHostProvenance는 복사 전 호스트 위치와 따로 보존된 자료를 명시한다. COPY-SHA-PROOF의모든 copy SHA는 source bytes와 같다.\n\n패키지의 web 디렉터리에서 계획만 확인한다(브라우저/측정 없음):\n\n```sh\nnode frozen/cycle13-web-profile.mjs --source ./frozen-source --frozen-harness ./frozen-harness --mode normal\npython3 ../verification/frozen-scripts/verify-evidence-package.py --source-dir ..\n```\n\n새 측정은 사용자 승인 quiet 환경에서만, 원본 출력을 덮어쓰지 않는 새 디렉터리로 세 모드를 순차 실행한다:\n\n```sh\nnode frozen/cycle13-web-profile.mjs --isolated --mode normal --duration 60 --source ./frozen-source --frozen-harness ./frozen-harness --expected-web-sha {plan['source']['sha256']} --expected-harness-sha {plan['diagnosticHarnessSHA256']} --expected-frozen-harness-sha {plan['originalHarnessSHA256']} --output /tmp/aster-cycle13-repro-normal\n# 같은 명령에서 mode/output을 light/repro-light, diagnostic/repro-diagnostic으로 각각 바꿔 순차 실행한다.\n```\n\nNode26.5/globalWebSocket, 설치된 Chrome(CHROME_BIN 선택 가능), loopback 권한이 필요하다. 새npm/global설치나 native SDK는 필요하지 않다. 원본 contract-check/analyze/summarize 스크립트의 절대경로는 당시 증거이며 자동 portability 수정은 하지 않았다. Frozen profiler harness의 SHA/phase와 private borrowed counter 한계는 SUMMARY에 유지했다. 이자료는60초 귀속진단이고900초 leak 인증이나 생산 최적화율이 아니다. 원래900 raw는 Cycle12 증거와 별도로 비교한다.\n'''
    attribution_readme = '''# Cycle13 원인분석·이전 수정 확인\n\nApple CAUSES2파일과 P2확인7파일을 byte-identical로 보존하고, P2 sourceSHA가 가리키는 baseline 텍스트 source도 동결했다. 새iOS/Android 실행·프로파일링은 없다. archive-audit에 기재된 ZIP과 iOS900 원자료는 별도 보존물이며 이디렉터리에 있다고 주장하지 않는다.\n\n```sh\npython3 ../verification/frozen-scripts/verify-evidence-package.py --source-dir ..\n```\n\n분석 숫자는 CAUSES/CONFIRMATION의 원래 범위만 따른다. RAW와 호스트 경로를 바꾸거나 없는 환경·시각·실행 ID를 채우지 않았다. 원래 audit/write-confirmation script는 증거로 포함하며 절대 host/artifact 경로가 필요한 재분석이다. 직접 실행 전 입력root를 명시적으로 준비해야 한다.\n'''
    verification_readme = '''# Cycle13 검증·패키지 inventory 증거\n\nRoot unit/syntax/types와native64/closed 실행의 text JSON/log/build-manifest를 허용목록으로 보존했다. Collector는 테스트·브라우저·native빌드·benchmark를 실행하지 않았다. 비어 있는 성공 stdout은 그사실 그대로며 collector가 exit0를 새로 입증한 것으로 설명하지 않는다. Source-at-collection의 recordedHashMatches:false는 실제 실행 source와 현재 source가 다름을 뜻한다. 실행 때의 binary는수집하지 않고 원래manifest의 SHA만 남긴다.\n\n```sh\npython3 frozen-scripts/verify-evidence-package.py --source-dir ..\n```\n\nFinal validator receipts는 기본값에서 수집하지 않는다. 판정기 수정이끝난 뒤 root가 명시한JSON목록으로만 수집할 수 있다:\n\n```json\n[{"source":"/absolute/final-receipt.json","path":"web/final-receipt.json","sha256":"64-character-expected-sha256"}]\n```\n\n```sh\npython3 /path/to/repo/scripts/collect-cycle13-evidence.py --repo /path/to/repo --output /path/to/cycle13 --receipts-only --receipts-allowlist /path/to/settled-receipts.json\n```\n\n이후receipt-only 모드는 기존 source/raw/snapshot을 재수집하거나 바꾸지 않는다. SDK/cache/APK/AAR/dylib/signing key/AVD/build tree와 noisy 전체OS로그는 포함하지 않는다. optional receipts는 source/path/SHA명시와 text-only상한을 요구한다. PACKAGED-MANIFEST의 상대 includedFiles는 실제 inventory이며, absolute host provenance는 included:false+reason으로 별도 표기한다.\n'''
    web.finish(web_readme)
    attribution.finish(attribution_readme)
    verification.finish(verification_readme)
    verifier = load_verifier(repo)
    results = [result for group in (web, attribution, verification) for result in verifier.verify_directory(group.root)]
    return {'schema': 'aster.cycle13.evidence-collection', 'measurementRan': False,
            'verification': results, 'copiedBytesIdentical': all(row['copySHAIdentical'] for group in (web, attribution, verification) for row in group.copies),
            'receiptsIncluded': args.receipts_allowlist is not None,
            'excluded': ['compiled binaries', 'SDK/cache/build/AVD', 'keys', 'large release ZIPs', 'Android measurement directories owned by another worker']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path)
    parser.add_argument('--web', type=Path, default=Path('/tmp/aster-cycle13-web'))
    parser.add_argument('--apple', type=Path, default=Path('/tmp/aster-cycle13-apple'))
    parser.add_argument('--p2', type=Path, default=Path('/tmp/aster-cycle13-p2'))
    parser.add_argument('--baseline', type=Path, default=Path('/var/folders/lw/r6rd_zlj3ps7pb_h2sdtcr3w0000gn/T/aster-split-extract-wv705vne/aster-charts'))
    parser.add_argument('--frozen-harness', type=Path, default=Path('/tmp/aster-cycle12-browser-pressure900-final/harness'))
    parser.add_argument('--receipts-allowlist', type=Path)
    parser.add_argument('--receipts-only', action='store_true')
    args = parser.parse_args()
    if args.output is None:
        args.output = args.repo / 'benchmarks/results/cycle13'
    print(json.dumps(collect(args), indent=2, ensure_ascii=False))
