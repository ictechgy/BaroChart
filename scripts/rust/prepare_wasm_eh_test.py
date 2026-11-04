#!/usr/bin/env python3
"""Focused standard-library tests for prepare-wasm-eh.py.

The Node test runner invokes this file so the repository's normal ``node --test``
entry point also covers the Python preparer.  These tests never use the network
and never build Rust; the final test only reuses the repository's existing
31-package cache.
"""

from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("prepare-wasm-eh.py")
ROOT = SCRIPT.parents[2]
SPEC = importlib.util.spec_from_file_location("prepare_wasm_eh", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
PREPARER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PREPARER
SPEC.loader.exec_module(PREPARER)


class FixtureRoot:
    """Small fake rustup/project tree suitable for archive-only tests."""

    def __init__(self, temporary: Path) -> None:
        self.root = temporary / "repo"
        self.artifacts = self.root / "artifacts" / "rust-wasm"
        self.toolchain = self.artifacts / "eh-toolchain"
        self.cache = self.artifacts / "stdlib-cache"
        self.archives = self.cache / "archives"
        self.vendor = self.cache / "vendor"
        self.source = self.toolchain / "lib" / "rustlib" / "src" / "rust"
        self.rustc = self.toolchain / "bin" / "rustc"
        self._make_directories()

    def _make_directories(self) -> None:
        (self.root / "rust").mkdir(parents=True)
        self.archives.mkdir(parents=True)
        self.vendor.mkdir(parents=True)
        (self.toolchain / "bin").mkdir(parents=True)
        (self.source / "library").mkdir(parents=True)
        (self.source / "src").mkdir()
        (self.toolchain / "lib" / "rustlib").mkdir(parents=True, exist_ok=True)
        (self.root / "rust" / "rust-toolchain.toml").write_text(
            '[toolchain]\nchannel = "1.98.1"\n', encoding="utf-8"
        )
        rustc_script = """#!/bin/sh
if [ "$1" = "-vV" ]; then
  cat <<'EOF'
rustc 1.98.1 (48a229cea 2026-09-01)
binary: rustc
commit-hash: 48a229ceaefd4985c50990b14116b6d856af0985
host: aarch64-apple-darwin
release: 1.98.1
LLVM version: 22.1.8
EOF
  exit 0
fi
exit 0
"""
        self.rustc.write_text(rustc_script, encoding="utf-8")
        self.rustc.chmod(self.rustc.stat().st_mode | stat.S_IXUSR)
        for tool in ("cargo", "rustdoc"):
            tool_path = self.toolchain / "bin" / tool
            tool_path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            tool_path.chmod(tool_path.stat().st_mode | stat.S_IXUSR)
        manifest = """manifest-version = "2"
[pkg.rust-src]
version = "1.98.1 (48a229cea 2026-09-01)"
[pkg.rust-src.target."*"]
available = true
url = "https://static.rust-lang.org/dist/2026-09-03/rust-src-1.98.1.tar.gz"
hash = "411c3dccf3782ed6eb784357999cd1bffeb65a6dd55196817992a6421c0f9689"
"""
        (self.toolchain / "lib" / "rustlib" / "multirust-channel-manifest.toml").write_text(
            manifest, encoding="utf-8"
        )

    @staticmethod
    def package(name: str, version: str, payload: bytes = b"fixture") -> PREPARER.LockedPackage:
        return PREPARER.LockedPackage(name, version, PREPARER.sha256_bytes(_crate_bytes(name, version, payload)))

    def lock(self, packages: list[PREPARER.LockedPackage]) -> None:
        def render(items: list[PREPARER.LockedPackage]) -> str:
            return "".join(
                "[[package]]\n"
                f'name = "{item.name}"\n'
                f'version = "{item.version}"\n'
                'source = "registry+https://github.com/rust-lang/crates.io-index"\n'
                f'checksum = "{item.checksum}"\n\n'
                for item in items
            )

        (self.source / "library" / "Cargo.lock").write_text(render(packages[:1]), encoding="utf-8")
        (self.root / "rust" / "Cargo.lock").write_text(render(packages[1:]), encoding="utf-8")

    def make_installed_distribution(self) -> tuple[Path, Path]:
        distribution = Path(self.root).parent / "installed" / "1.98.1-aarch64-apple-darwin"
        distribution_bin = distribution / "bin"
        distribution_source = distribution / "lib" / "rustlib" / "src" / "rust"
        shutil.copytree(self.source, distribution_source)
        distribution_bin.mkdir(parents=True, exist_ok=True)
        shutil.copy2(self.rustc, distribution_bin / "rustc")
        for tool in ("cargo", "rustdoc"):
            shutil.copy2(self.toolchain / "bin" / tool, distribution_bin / tool)
        for tool in ("rustc", "cargo", "rustdoc"):
            (distribution_bin / tool).chmod((distribution_bin / tool).stat().st_mode | stat.S_IXUSR)

        distribution_lib = distribution / "lib"
        distribution_lib.mkdir(parents=True, exist_ok=True)
        (distribution_lib / "libLLVM.dylib").write_bytes(b"fixture LLVM")
        (distribution_lib / "librustc_driver-fixture.dylib").write_bytes(b"fixture driver")
        rustlib = distribution_lib / "rustlib"
        shutil.copy2(
            self.toolchain / "lib" / "rustlib" / "multirust-channel-manifest.toml",
            rustlib / "multirust-channel-manifest.toml",
        )
        host = rustlib / "aarch64-apple-darwin"
        target = rustlib / "wasm32-unknown-unknown"
        (host / "bin").mkdir(parents=True, exist_ok=True)
        (host / "bin" / "rust-lld").write_text("#!/bin/sh\nprintf 'LLD fixture\\n'\n", encoding="utf-8")
        (host / "bin" / "rust-lld").chmod((host / "bin" / "rust-lld").stat().st_mode | stat.S_IXUSR)
        (target / "lib").mkdir(parents=True)
        (target / "lib" / "libstd-fixture.rlib").write_bytes(b"fixture std")
        return distribution, distribution_source


def _crate_bytes(name: str, version: str, payload: bytes = b"fixture") -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for relative, content in (
            ("Cargo.toml", b'[package]\nname = "fixture"\n'),
            ("src.txt", payload),
        ):
            info = tarfile.TarInfo(f"{name}-{version}/{relative}")
            info.size = len(content)
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            archive.addfile(info, io.BytesIO(content))
    return output.getvalue()


def _write_archive(fixture: FixtureRoot, package: PREPARER.LockedPackage, data: bytes | None = None) -> None:
    if data is None:
        data = _crate_bytes(package.name, package.version)
    (fixture.archives / package.filename).write_bytes(data)


class PreparerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.fixture = FixtureRoot(Path(self.temporary.name))

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _prepare(self, *, download: bool = False) -> dict[str, object]:
        return PREPARER.prepare(root=self.fixture.root, download=download, pinned_rustc=self.fixture.rustc)

    def test_checksum_mismatch_is_rejected_before_extraction(self) -> None:
        package = self.fixture.package("checksum-fixture", "1.0.0")
        self.fixture.lock([package])
        _write_archive(self.fixture, package, b"not the locked crate")
        with self.assertRaisesRegex(PREPARER.PrepareError, "checksum mismatch"):
            self._prepare()
        self.assertFalse((self.fixture.vendor / package.directory).exists())

    def test_archive_traversal_and_links_are_rejected(self) -> None:
        package = self.fixture.package("escape-fixture", "1.0.0", b"escape")
        self.fixture.lock([package])
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "escape.crate"
            with tarfile.open(archive_path, "w:gz") as archive:
                info = tarfile.TarInfo("escape-fixture-1.0.0/../outside")
                payload = b"outside"
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
            # The lock checksum describes this intentionally hostile archive.
            locked = PREPARER.LockedPackage(package.name, package.version, PREPARER.sha256_file(archive_path))
            self.fixture.lock([locked])
            (self.fixture.archives / locked.filename).write_bytes(archive_path.read_bytes())
            with self.assertRaisesRegex(PREPARER.PrepareError, "unsafe archive member path"):
                self._prepare()
        self.assertFalse((self.fixture.root / "outside").exists())

    def test_archive_symlinks_are_rejected(self) -> None:
        package = self.fixture.package("link-fixture", "1.0.0")
        self.fixture.lock([package])
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "link.crate"
            with tarfile.open(archive_path, "w:gz") as archive:
                info = tarfile.TarInfo("link-fixture-1.0.0/Cargo.toml")
                content = b"[package]\n"
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
                link = tarfile.TarInfo("link-fixture-1.0.0/src.txt")
                link.type = tarfile.SYMTYPE
                link.linkname = "../../outside"
                archive.addfile(link)
            locked = PREPARER.LockedPackage(package.name, package.version, PREPARER.sha256_file(archive_path))
            self.fixture.lock([locked])
            (self.fixture.archives / locked.filename).write_bytes(archive_path.read_bytes())
            with self.assertRaisesRegex(PREPARER.PrepareError, "archive links or special files"):
                self._prepare()

    def test_missing_offline_dependency_never_calls_downloader(self) -> None:
        package = self.fixture.package("missing-fixture", "1.0.0")
        self.fixture.lock([package])
        with mock.patch.object(PREPARER, "download_archive", side_effect=AssertionError("network")) as downloader:
            with self.assertRaisesRegex(PREPARER.PrepareError, "offline cache is missing"):
                self._prepare()
        downloader.assert_not_called()

    def test_vendor_and_config_are_idempotent(self) -> None:
        package = self.fixture.package("idempotent-fixture", "1.0.0")
        self.fixture.lock([package])
        _write_archive(self.fixture, package)
        first = self._prepare()
        checksum_path = self.fixture.vendor / package.directory / ".cargo-checksum.json"
        config_path = self.fixture.cache / "cargo-home" / "config.toml"
        wrapper_path = self.fixture.toolchain / "bin" / "rustc-with-sysroot"
        before = (checksum_path.read_bytes(), config_path.read_bytes(), wrapper_path.read_bytes())
        second = self._prepare()
        after = (checksum_path.read_bytes(), config_path.read_bytes(), wrapper_path.read_bytes())
        self.assertEqual(before, after)
        self.assertEqual(first["packages"], second["packages"])
        self.assertIn('build-std = ["std", "panic_unwind"]', config_path.read_text(encoding="utf-8"))

    def test_fresh_directory_assembles_project_sysroot(self) -> None:
        package = self.fixture.package("fresh-fixture", "1.0.0")
        self.fixture.lock([package])
        _write_archive(self.fixture, package)
        distribution, source = self.fixture.make_installed_distribution()
        fresh = self.fixture.artifacts / "eh-toolchain-fresh"
        result = PREPARER.prepare(
            root=self.fixture.root,
            toolchain_dir=fresh,
            pinned_rustc=distribution / "bin" / "rustc",
            requested_source=source,
        )
        self.assertEqual(result["packages"]["cached"], 1)
        self.assertTrue((fresh / "bin" / "cargo").is_file())
        self.assertTrue((fresh / "bin" / "rustdoc").is_file())
        self.assertTrue((fresh / "lib" / "libLLVM.dylib").is_symlink())
        host_rustlib = fresh / "lib" / "rustlib" / "aarch64-apple-darwin"
        self.assertTrue(host_rustlib.is_symlink())
        self.assertTrue((host_rustlib / "bin" / "rust-lld").is_file())
        target_lib = fresh / "lib" / "rustlib" / "wasm32-unknown-unknown" / "lib"
        self.assertTrue(target_lib.is_dir())
        self.assertEqual((fresh / "lib" / "rustlib" / "src" / "rust").resolve(), source.resolve())
        self.assertIn("--sysroot", (fresh / "bin" / "rustc-with-sysroot").read_text(encoding="utf-8"))

    def test_source_candidate_must_match_rustc_and_manifest(self) -> None:
        package = self.fixture.package("source-fixture", "1.0.0")
        self.fixture.lock([package])
        _write_archive(self.fixture, package)
        # Remove the pinned-source tree and offer a mismatched local toolchain.
        import shutil

        shutil.rmtree(self.fixture.source)
        candidate_root = Path(self.temporary.name) / "toolchains" / "stable-aarch64-apple-darwin"
        candidate_source = candidate_root / "lib" / "rustlib" / "src" / "rust"
        (candidate_source / "library").mkdir(parents=True)
        (candidate_source / "library" / "Cargo.lock").write_text("", encoding="utf-8")
        (candidate_root / "lib" / "rustlib").mkdir(parents=True, exist_ok=True)
        (candidate_root / "lib" / "rustlib" / "multirust-channel-manifest.toml").write_text(
            (self.fixture.toolchain / "lib" / "rustlib" / "multirust-channel-manifest.toml").read_text(
                encoding="utf-8"
            ),
            encoding="utf-8",
        )
        candidate_rustc = candidate_root / "bin" / "rustc"
        candidate_rustc.parent.mkdir(parents=True)
        candidate_rustc.write_text(
            "#!/bin/sh\nprintf 'rustc 1.97.0\\nrelease: 1.97.0\\n"
            "commit-hash: bad\\nhost: wrong\\n'\n",
            encoding="utf-8",
        )
        candidate_rustc.chmod(candidate_rustc.stat().st_mode | stat.S_IXUSR)
        with self.assertRaisesRegex(PREPARER.PrepareError, "matching rust-src is not installed"):
            PREPARER.prepare(
                root=self.fixture.root,
                pinned_rustc=self.fixture.rustc,
                toolchains_root=candidate_root.parent,
            )

    def test_cached_rustc_release_must_match_channel(self) -> None:
        self.fixture.rustc.write_text(
            self.fixture.rustc.read_text(encoding="utf-8").replace("1.98.1", "1.97.0"),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(PREPARER.PrepareError, "does not match rust-toolchain.toml channel"):
            self._prepare()

    def test_noncanonical_registry_is_rejected(self) -> None:
        package = self.fixture.package("private-fixture", "1.0.0")
        self.fixture.lock([package])
        lock = self.fixture.source / "library" / "Cargo.lock"
        lock.write_text(
            lock.read_text(encoding="utf-8").replace(
                "registry+https://github.com/rust-lang/crates.io-index",
                "registry+https://private.example.invalid/index",
            ),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(PREPARER.PrepareError, "unsupported non-crates.io registry source"):
            self._prepare()

    def test_repository_cache_preparation_is_offline_and_complete(self) -> None:
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "--offline", "--json"],
            cwd=ROOT,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertEqual(result["packages"], {"locked": 31, "cached": 31, "downloaded": 0, "missing": 0, "staged": 31})
        environment = result["environment"]
        self.assertEqual(environment["RUSTC_BOOTSTRAP"], "1")
        self.assertEqual(environment["CARGO_INCREMENTAL"], "0")
        self.assertIn("panic_unwind", (ROOT / "artifacts/rust-wasm/stdlib-cache/cargo-home/config.toml").read_text())
        wrapper = Path(environment["RUSTC"]).read_text(encoding="utf-8")
        self.assertIn("export DYLD_LIBRARY_PATH=", wrapper)
        self.assertIn("--sysroot", wrapper)


if __name__ == "__main__":
    unittest.main()
