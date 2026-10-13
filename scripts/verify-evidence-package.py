"""Check included evidence bytes; external host provenance is labelled separately."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile


def verify_manifest(data, read, present, members):
    manifest = json.loads(data)
    assert manifest['schema'] == 'aster.packaged-evidence.v1'
    rows = manifest['includedFiles']
    assert isinstance(rows, list) and rows, 'Missing included evidence list'
    seen = set()
    for row in rows:
        name = row['path']
        path = PurePosixPath(name)
        assert isinstance(name, str) and name and not path.is_absolute() and '..' not in path.parts and '\\' not in name, 'Unsafe evidence path'
        assert name not in seen, 'Duplicate evidence path'
        seen.add(name)
        assert present(name), f'Missing packaged evidence: {name}'
        content = read(name)
        assert type(row['bytes']) is int and row['bytes'] == len(content), f'Evidence size mismatch: {name}'
        assert row['sha256'] == hashlib.sha256(content).hexdigest(), f'Evidence hash mismatch: {name}'
    assert seen == members, 'Packaged evidence inventory differs from actual included files'
    provenance = manifest['externalHostProvenance']
    assert isinstance(provenance, list)
    assert all(row.get('included') is False and row.get('reason') for row in provenance)
    return {'includedFiles': len(rows), 'externalHostProvenance': len(provenance), 'passed': True}


def verify_directory(root):
    results = []
    for path in sorted(root.rglob('PACKAGED-MANIFEST.json')):
        if any(part in {'.git', 'node_modules', '.build', 'build'} for part in path.relative_to(root).parts):
            continue
        base = path.parent.resolve()
        def target(name):
            file = base / name
            assert file.resolve().is_relative_to(base), 'Evidence escapes directory'
            assert not file.is_symlink(), 'Evidence symlink'
            return file
        members = {str(file.relative_to(base)) for file in base.rglob('*') if file.is_file() and file != path and not any(part == '__pycache__' for part in file.relative_to(base).parts)}
        result = verify_manifest(path.read_bytes(), lambda name: target(name).read_bytes(), lambda name: target(name).is_file(), members)
        results.append({'manifest': str(path.relative_to(root)), **result})
    return results


def verify_archive(path):
    results = []
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None, 'ZIP CRC failure'
        names = set(archive.namelist())
        assert len(names) == len(archive.namelist()), 'Duplicate ZIP member'
        assert all((info.external_attr >> 16) & 0o170000 != 0o120000 for info in archive.infolist()), 'Evidence ZIP symlink'
        for name in sorted(names):
            if name.endswith('/PACKAGED-MANIFEST.json'):
                base = name.rsplit('/', 1)[0] + '/'
                members = {item[len(base):] for item in names if item.startswith(base) and item != name and not item.endswith('/')}
                result = verify_manifest(archive.read(name), lambda item: archive.read(base + item), lambda item: base + item in names, members)
                results.append({'manifest': name, **result})
    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path)
    parser.add_argument('archives', nargs='*', type=Path)
    args = parser.parse_args()
    result = {}
    if args.source_dir:
        result['source'] = verify_directory(args.source_dir.resolve())
    for archive in args.archives:
        result[str(archive)] = verify_archive(archive)
    assert args.source_dir or args.archives, 'Specify an evidence source directory or ZIP'
    print(json.dumps(result, indent=2))
