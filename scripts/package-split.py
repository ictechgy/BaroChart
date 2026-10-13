"""Partition an existing, verified source ZIP without changing its source bytes.

Source and raw evidence can be attached separately. No builds, keys, new network
operations, or Git data are collected from the current checkout.
"""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

PREFIX = 'aster-charts/'
LIMIT = 15_000_000


def digest(data):
    return hashlib.sha256(data).hexdigest()


def classify(name):
    source_extras = {'artifacts/aster-core.js',
                     'artifacts/review-status/status-review.md',
                     'benchmarks/results/tests.log'}
    if (name in source_extras
            or name.startswith('benchmarks/results/cycle12/browser900/harness/')
            or not name.startswith(('artifacts/', 'benchmarks/results/'))):
        return 'source'
    if name.startswith('benchmarks/results/cycle12/apple/'):
        return 'apple'
    if name.startswith('benchmarks/results/cycle13/web/'):
        return 'cycle13-web'
    if name.startswith('benchmarks/results/cycle13/android/'):
        return 'cycle13-android'
    if name.startswith('benchmarks/results/cycle13/'):
        return 'cycle13-verification-attribution'
    return 'core-web-android-history'


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + '\n').encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--output-dir', type=Path, default=Path('artifacts'))
    parser.add_argument('--baseline-revision', required=True)
    args = parser.parse_args()
    input_sha = digest(args.archive.read_bytes())
    args.output_dir.mkdir(parents=True, exist_ok=True)
    results, coverage = [], set()
    with zipfile.ZipFile(args.archive) as original:
        assert original.testzip() is None, 'Input ZIP CRC failure'
        manifest = json.loads(original.read(PREFIX + 'SOURCE-MANIFEST.json'))
        assert set(original.namelist()) == {PREFIX + name for name in manifest} | {PREFIX + 'SOURCE-MANIFEST.json'}
        package = json.loads(original.read(PREFIX + 'package.json'))
        version = package['version']
        groups = {name: [] for name in ['source', 'apple', 'core-web-android-history',
                                      'cycle13-web', 'cycle13-android',
                                      'cycle13-verification-attribution']}
        for name, entry in manifest.items():
            assert not Path(name).is_absolute() and '..' not in Path(name).parts
            data = original.read(PREFIX + name)
            assert {'bytes': len(data), 'sha256': digest(data)} == entry, name
            assert not name.lower().endswith(('.png', '.jpg', '.jpeg', '.webp', '.gif')), 'Use the screenshot-free Library archive as input'
            groups[classify(name)].append(name)
        for group, names in groups.items():
            if not names:
                continue
            names.sort()
            file_name = (f'aster-charts-source-{version}-light.zip' if group == 'source'
                         else f'aster-charts-evidence-{version}-{group}.zip')
            path = args.output_dir / file_name
            temp = path.with_suffix('.zip.tmp')
            subset = {name: manifest[name] for name in names}
            guide_name = f'SPLIT-DELIVERY-{group}.md'
            guide = f'''# Aster {version}: {group}

Preserved baseline revision: `{args.baseline_revision}`.
Input archive: `{args.archive.name}`; SHA256 `{input_sha}`.
This part preserves the original bytes of {len(names)} files.

Extract the light source ZIP into a new directory, then optionally extract both
evidence ZIPs into the same directory. The three parts cover every original file
listed in the screenshot-free input manifest. Evidence parts have distinct
manifests and do not overwrite the light source manifest. Generated manifests
and these delivery notes are the only added metadata.

From `aster-charts/`: `npm test`, `npm run check`, and `npm run demo`.
Open `http://127.0.0.1:5173/examples/web/`. Node 22+ is required.
See `README.md`, `docs/NATIVE.md`, and `docs/PUBLIC-VALIDATION.md` for native
SDK build commands, toolchain prerequisites, verified platforms and limits.
Type checking needs TypeScript 5.9+: set `TSC_PATH` and run `npm run check:types`.
The licensed QuickJS sources and all native/demo/test/build sources are in the
light source ZIP. Native build outputs and signing keys are not redistributed.

`apple` contains cycle12 Apple raw evidence. `core-web-android-history` contains
the remaining current and previous evidence. Frozen browser harness source,
the latest tests log, and final review status are retained in the source part.
Raw evidence is optional for running the library, tests and demo.
Full original source ZIP and the existing Library file version remain preserved;
these are new delivery files, not replacements of that Library version.
'''
            if any(groups[key] for key in groups if key.startswith('cycle13-')):
                guide = (guide.replace('both\nevidence ZIPs', 'all\nevidence ZIPs')
                         .replace('The three parts cover', 'The parts cover')
                         + '\nCycle13 diagnostic web, Android, and verification/attribution evidence\n'
                         + 'has separate parts so each attachment stays below15,000,000 bytes.\n')
            guide = guide.encode()
            subset[guide_name] = {'bytes': len(guide), 'sha256': digest(guide)}
            manifest_name = ('SOURCE-MANIFEST.json' if group == 'source'
                             else f'EVIDENCE-MANIFEST-{group}.json')
            with zipfile.ZipFile(temp, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
                for name in names:
                    info = original.getinfo(PREFIX + name)
                    target.writestr(info, original.read(info), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
                for name, data in [(guide_name, guide), (manifest_name, json_bytes(subset))]:
                    info = zipfile.ZipInfo(PREFIX + name, (2026, 10, 12, 0, 0, 0))
                    info.external_attr = 0o100644 << 16
                    target.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
            assert temp.stat().st_size < LIMIT, f'{file_name} exceeds {LIMIT} bytes'
            with zipfile.ZipFile(temp) as checked:
                assert checked.testzip() is None
                assert set(checked.namelist()) == {PREFIX + name for name in subset} | {PREFIX + manifest_name}
                for name, entry in subset.items():
                    data = checked.read(PREFIX + name)
                    assert {'bytes': len(data), 'sha256': digest(data)} == entry
            if path.exists():
                assert path.read_bytes() == temp.read_bytes(), f'Refusing to overwrite different existing delivery: {path}'
                temp.unlink()
            else:
                temp.rename(path)
            assert not (coverage & set(names)), 'Partition overlap'
            coverage.update(names)
            results.append({'group': group, 'path': str(path.resolve()),
                            'file_name': file_name, 'bytes': path.stat().st_size,
                            'sha256': digest(path.read_bytes()), 'original_files': len(names),
                            'manifest': manifest_name, 'crc_and_manifest_passed': True})
        assert coverage == set(manifest), 'Partition coverage failure'
    assert digest(args.archive.read_bytes()) == input_sha, 'Input archive changed'
    proof = {'baseline_revision': args.baseline_revision, 'version': version,
             'input_archive': str(args.archive.resolve()), 'input_sha256': input_sha,
             'original_files': len(coverage), 'coverage_complete': True,
             'input_preserved': True, 'attachment_limit_bytes': LIMIT, 'archives': results}
    (args.output_dir / f'package-verification-split-{version}.json').write_bytes(json_bytes(proof))
    print(json.dumps(proof, indent=2))


if __name__ == '__main__':
    main()
