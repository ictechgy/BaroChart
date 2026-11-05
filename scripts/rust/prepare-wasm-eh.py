#!/usr/bin/env python3
"""Prepare the repository-local cache and toolchain used by the WASM EH build.

The normal mode is deliberately offline.  Only checksum-locked crates already in
``artifacts/rust-wasm/stdlib-cache`` are considered cache hits.  ``--download``
is an explicit operator escape hatch; it downloads only missing locked crates
from ``https://static.crates.io`` and verifies them before they become cache
entries.

This module intentionally uses only the Python standard library.  Most work is
implemented as small functions so tests can exercise archive validation and
source selection without invoking Cargo or building Rust.
"""

from __future__ import annotations

import argparse
import filecmp
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import tomllib
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


SCRIPT = Path(__file__).resolve()
DEFAULT_ROOT = SCRIPT.parents[2]
EXPECTED_RUST_SRC_HOST = "*"
CRATES_HOST = "static.crates.io"
CRATES_BASE = f"https://{CRATES_HOST}/crates"
CANONICAL_REGISTRY_SOURCES = frozenset(
    {
        "registry+https://github.com/rust-lang/crates.io-index",
        "registry+https://index.crates.io/",
    }
)
RUSTFLAGS = (
    "-Cpanic=unwind -Ctarget-feature=+exception-handling "
    "-Cllvm-args=-wasm-use-legacy-eh=false"
)
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


class PrepareError(RuntimeError):
    """A user-actionable preparation failure."""


@dataclass(frozen=True)
class LockedPackage:
    name: str
    version: str
    checksum: str

    @property
    def filename(self) -> str:
        return f"{self.name}-{self.version}.crate"

    @property
    def directory(self) -> str:
        return f"{self.name}-{self.version}"

    def as_dict(self) -> dict[str, str]:
        return {"name": self.name, "version": self.version, "checksum": self.checksum}


@dataclass(frozen=True)
class RustcInfo:
    release: str
    commit_hash: str
    host: str

    @property
    def commit_short(self) -> str:
        return self.commit_hash[:9]


@dataclass(frozen=True)
class SourceSelection:
    source: Path
    source_toolchain: Path
    rustc: RustcInfo


@dataclass(frozen=True)
class CacheResult:
    locked: tuple[LockedPackage, ...]
    staged: tuple[LockedPackage, ...]
    downloaded: tuple[LockedPackage, ...]

    @property
    def missing(self) -> tuple[LockedPackage, ...]:
        return tuple(package for package in self.locked if package not in self.staged)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as exc:
        raise PrepareError(f"cannot read cache file {path}: {exc}") from exc
    return digest.hexdigest()


def write_if_changed(path: Path, content: str | bytes, *, mode: int | None = None) -> None:
    """Write a file atomically only when its bytes differ.

    All callers pass paths below the project artifact directory.  The helper
    still creates the parent explicitly and never follows a pre-existing
    symlink for an output file.
    """

    data = content.encode() if isinstance(content, str) else content
    if path.exists() or path.is_symlink():
        if path.is_symlink() or not path.is_file():
            raise PrepareError(f"refusing to replace non-regular output {path}")
        try:
            if path.read_bytes() == data:
                if mode is not None:
                    path.chmod(mode)
                return
        except OSError as exc:
            raise PrepareError(f"cannot inspect output {path}: {exc}") from exc
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        temporary = Path(temporary_name)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if mode is not None:
            temporary.chmod(mode)
        os.replace(temporary, path)
        temporary = None
    except OSError as exc:
        raise PrepareError(f"cannot write {path}: {exc}") from exc
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def _safe_relative(relative: str, *, allow_dot: bool = False) -> PurePosixPath:
    """Validate a POSIX archive/checksum path and return its components."""

    if "\\" in relative or "\x00" in relative:
        raise PrepareError(f"unsafe package path {relative!r}")
    path = PurePosixPath(relative)
    windows_path = PureWindowsPath(relative)
    if (
        path.is_absolute()
        or windows_path.is_absolute()
        or windows_path.drive
        or (not allow_dot and str(path) in {"", "."})
    ):
        raise PrepareError(f"unsafe package path {relative!r}")
    if any(part in {"", ".", ".."} for part in path.parts):
        raise PrepareError(f"unsafe package path {relative!r}")
    return path


def _ensure_no_symlink_components(path: Path, stop: Path) -> None:
    """Reject a path whose existing component is a symlink."""

    try:
        relative = path.relative_to(stop)
    except ValueError as exc:
        raise PrepareError(f"path escapes cache directory: {path}") from exc
    current = stop
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise PrepareError(f"symlink path component is not allowed: {current}")


def _ensure_regular_tree(directory: Path, *, expected_package: str | None = None) -> None:
    """Reject symlinks/special files in a vendor directory."""

    if not directory.is_dir() or directory.is_symlink():
        raise PrepareError(f"vendor package directory is not a real directory: {directory}")
    root = directory.parent.resolve()
    try:
        directory.resolve().relative_to(root)
    except ValueError as exc:
        raise PrepareError(f"vendor package directory escapes vendor root: {directory}") from exc
    if expected_package is not None and directory.name != expected_package:
        raise PrepareError(f"unexpected vendor directory name {directory.name!r}")
    for item in directory.rglob("*"):
        try:
            item.relative_to(directory)
        except ValueError as exc:
            raise PrepareError(f"vendor path escapes package directory: {item}") from exc
        item_stat = item.lstat()
        if stat.S_ISLNK(item_stat.st_mode):
            raise PrepareError(f"vendor symlink is not allowed: {item}")
        if not (stat.S_ISREG(item_stat.st_mode) or stat.S_ISDIR(item_stat.st_mode)):
            raise PrepareError(f"vendor special file is not allowed: {item}")


def parse_locked_packages(lock_paths: Iterable[Path]) -> tuple[LockedPackage, ...]:
    """Read registry packages from one or more Cargo.lock files."""

    packages: dict[tuple[str, str], LockedPackage] = {}
    for lock_path in lock_paths:
        if not lock_path.is_file():
            raise PrepareError(f"Cargo.lock is missing: {lock_path}")
        try:
            document = tomllib.loads(lock_path.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError) as exc:
            raise PrepareError(f"cannot parse {lock_path}: {exc}") from exc
        for entry in document.get("package", []):
            source = entry.get("source", "")
            if not isinstance(source, str) or not source.startswith("registry+"):
                continue
            if source not in CANONICAL_REGISTRY_SOURCES:
                raise PrepareError(f"unsupported non-crates.io registry source in {lock_path}: {source}")
            try:
                name = str(entry["name"])
                version = str(entry["version"])
                checksum = str(entry["checksum"])
            except (KeyError, TypeError) as exc:
                raise PrepareError(f"registry package in {lock_path} has no checksum") from exc
            if (
                not name
                or not version
                or "/" in name
                or "\\" in name
                or "/" in version
                or "\\" in version
                or not _HEX64.fullmatch(checksum)
            ):
                raise PrepareError(f"invalid checksum-locked package in {lock_path}: {entry!r}")
            package = LockedPackage(name, version, checksum)
            key = (name, version)
            previous = packages.get(key)
            if previous is not None and previous != package:
                raise PrepareError(f"conflicting checksum for locked package {name} {version}")
            packages[key] = package
    if not packages:
        raise PrepareError("no checksum-locked registry packages were found")
    return tuple(packages[key] for key in sorted(packages))


def parse_rustc_info(output: str) -> RustcInfo:
    values: dict[str, str] = {}
    for line in output.splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            values[key.strip()] = value.strip()
    if not values.get("release") and output.startswith("rustc "):
        first = output.splitlines()[0].split()
        if len(first) > 1:
            values["release"] = first[1]
    required = {key: values.get(key, "") for key in ("release", "commit-hash", "host")}
    if not all(required.values()):
        raise PrepareError("rustc -vV output is missing release, commit-hash, or host")
    return RustcInfo(required["release"], required["commit-hash"], required["host"])


def rustc_info(rustc: Path) -> RustcInfo:
    if not rustc.is_file():
        raise PrepareError(f"pinned rustc is missing: {rustc}")
    try:
        completed = subprocess.run(
            [str(rustc), "-vV"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={"PATH": os.environ.get("PATH", "")},
        )
    except OSError as exc:
        raise PrepareError(f"cannot inspect rustc {rustc}: {exc}") from exc
    if completed.returncode != 0:
        detail = completed.stderr.strip() or "no diagnostic"
        raise PrepareError(f"rustc -vV failed for {rustc}: {detail}")
    return parse_rustc_info(completed.stdout)


def rust_src_manifest(path: Path) -> dict[str, Any]:
    """Return the rust-src package section from a local channel manifest."""

    candidates = (
        path / "lib" / "rustlib" / "multirust-channel-manifest.toml",
        path / "lib" / "rustlib" / "channel-manifest.toml",
        path / "multirust-channel-manifest.toml",
    )
    manifest_path = next((candidate for candidate in candidates if candidate.is_file()), None)
    if manifest_path is None:
        raise PrepareError(f"rust-src channel manifest is missing near {path}")
    try:
        document = tomllib.loads(manifest_path.read_text(encoding="utf-8"))
        section = document["pkg"]["rust-src"]
        target = section["target"][EXPECTED_RUST_SRC_HOST]
    except (OSError, KeyError, TypeError, tomllib.TOMLDecodeError) as exc:
        raise PrepareError(f"rust-src package section is invalid in {manifest_path}: {exc}") from exc
    if not isinstance(section, dict) or not isinstance(target, dict):
        raise PrepareError(f"rust-src package section is invalid in {manifest_path}")
    return {"version": section.get("version"), "target": dict(target)}


def _manifest_matches(expected: Mapping[str, Any], actual: Mapping[str, Any]) -> bool:
    return json.dumps(expected, sort_keys=True, separators=(",", ":")) == json.dumps(
        actual, sort_keys=True, separators=(",", ":")
    )


def _source_toolchain_root(source: Path) -> Path:
    """Infer a rustup-style toolchain root from ``lib/rustlib/src/rust``."""

    resolved = source.resolve()
    if len(resolved.parents) < 4 or resolved.parent.name != "src" or resolved.parent.parent.name != "rustlib":
        raise PrepareError(f"rust-src path is not a rustup-style source tree: {source}")
    return resolved.parents[3]


def _validate_source(
    source: Path,
    *,
    source_toolchain: Path,
    expected_rustc: RustcInfo,
    expected_manifest: Mapping[str, Any],
    source_rustc: Path | None = None,
) -> SourceSelection:
    source = source.resolve()
    if not source.is_dir():
        raise PrepareError(f"rust-src directory is missing: {source}")
    if not (source / "library" / "Cargo.lock").is_file():
        raise PrepareError(f"rust-src source tree has no library/Cargo.lock: {source}")
    compiler = source_rustc or source_toolchain / "bin" / "rustc"
    actual_rustc = rustc_info(compiler)
    if actual_rustc != expected_rustc:
        raise PrepareError(
            "rust-src candidate rustc does not match pinned toolchain: "
            f"expected {expected_rustc.release}/{expected_rustc.commit_hash}/{expected_rustc.host}, "
            f"got {actual_rustc.release}/{actual_rustc.commit_hash}/{actual_rustc.host}"
        )
    actual_manifest = rust_src_manifest(source_toolchain)
    if not _manifest_matches(expected_manifest, actual_manifest):
        raise PrepareError("rust-src candidate does not match the pinned public channel manifest")
    return SourceSelection(source, source_toolchain.resolve(), actual_rustc)


def _candidate_source_paths(toolchain_roots: Iterable[Path]) -> Iterable[tuple[Path, Path]]:
    seen: set[Path] = set()
    for root in toolchain_roots:
        try:
            root = root.resolve()
        except OSError:
            continue
        source = root / "lib" / "rustlib" / "src" / "rust"
        if source in seen:
            continue
        seen.add(source)
        yield source, root


def select_rust_source(
    *,
    toolchain: Path,
    pinned_rustc: Path,
    toolchains_root: Path | None = None,
    requested_source: Path | None = None,
) -> SourceSelection:
    """Select the pinned source or a locally installed, byte-matching source."""

    toolchain = toolchain.resolve()
    pinned_rustc = pinned_rustc.resolve()
    expected_rustc = rustc_info(pinned_rustc)
    try:
        expected_manifest = rust_src_manifest(toolchain)
    except PrepareError as exc:
        # rustup's minimal profile omits rust-src, but it still installs the
        # channel manifest.  Without that pinned package section there is no
        # safe basis for accepting another local source tree.
        raise PrepareError(f"pinned rust-src channel manifest is unavailable: {exc}") from exc

    pinned_source = toolchain / "lib" / "rustlib" / "src" / "rust"
    if pinned_source.exists() or pinned_source.is_symlink():
        if expected_manifest is None:
            raise PrepareError("pinned rust-src exists but the pinned channel manifest is missing")
        try:
            source_toolchain = _source_toolchain_root(pinned_source.resolve())
        except PrepareError:
            # A source copied directly into the project sysroot is still
            # pinned to that sysroot; external rustup-style links are checked
            # against their own compiler and public channel manifest below.
            source_toolchain = toolchain
        return _validate_source(
            pinned_source,
            source_toolchain=source_toolchain,
            expected_rustc=expected_rustc,
            expected_manifest=expected_manifest,
        )

    candidates: list[tuple[Path, Path]] = []
    if requested_source is not None:
        requested = requested_source.resolve()
        candidates.append((requested, _source_toolchain_root(requested)))

    roots: list[Path] = []
    if toolchains_root is not None:
        roots.append(toolchains_root)
    else:
        rustup_home = Path(os.environ.get("RUSTUP_HOME", str(Path.home() / ".rustup")))
        roots.append(rustup_home / "toolchains")
    if roots:
        root = roots[0]
        if root.is_dir():
            try:
                for candidate_root in sorted(root.iterdir()):
                    if candidate_root.is_dir():
                        candidates.extend(_candidate_source_paths([candidate_root]))
            except OSError as exc:
                raise PrepareError(f"cannot inspect local Rust toolchains in {root}: {exc}") from exc

    # If the pinned artifact has a source link that disappeared between the
    # existence check and this point, still consider a source beside its root.
    candidates.extend(_candidate_source_paths([toolchain]))

    mismatch_reasons: list[str] = []
    for source, source_toolchain in candidates:
        try:
            candidate_rustc = source_toolchain / "bin" / "rustc"
            candidate_info = rustc_info(candidate_rustc)
            if candidate_info != expected_rustc:
                mismatch_reasons.append(
                    f"{source}: rustc {candidate_info.release}/{candidate_info.commit_hash}/{candidate_info.host}"
                )
                continue
            candidate_manifest = rust_src_manifest(source_toolchain)
            if not _manifest_matches(expected_manifest, candidate_manifest):
                mismatch_reasons.append(f"{source}: rust-src manifest mismatch")
                continue
            return _validate_source(
                source,
                source_toolchain=source_toolchain,
                expected_rustc=expected_rustc,
                expected_manifest=expected_manifest,
            )
        except PrepareError as exc:
            mismatch_reasons.append(f"{source}: {exc}")
    detail = "; ".join(mismatch_reasons[:3])
    if detail:
        detail = f" Candidates checked: {detail}"
    raise PrepareError(
        "matching rust-src is not installed; install the pinned source in the project EH sysroot "
        "or provide a locally installed source with matching rustc release/commit/host and manifest."
        + detail
    )


def _validate_package_archive(archive: Path, package: LockedPackage) -> None:
    if not archive.is_file() or archive.is_symlink():
        raise PrepareError(f"crate archive is missing or not a regular file: {archive}")
    actual = sha256_file(archive)
    if actual != package.checksum:
        raise PrepareError(
            f"crate archive checksum mismatch for {package.filename}: expected {package.checksum}, got {actual}"
        )


def _validate_checksum_file(directory: Path, package: LockedPackage) -> None:
    _ensure_regular_tree(directory, expected_package=package.directory)
    checksum_path = directory / ".cargo-checksum.json"
    if not checksum_path.is_file() or checksum_path.is_symlink():
        raise PrepareError(f"vendor package has no .cargo-checksum.json: {directory}")
    try:
        document = json.loads(checksum_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PrepareError(f"invalid {checksum_path}: {exc}") from exc
    if document.get("package") != package.checksum or not isinstance(document.get("files"), dict):
        raise PrepareError(f"vendor package checksum metadata does not match lock: {directory}")
    expected_files: dict[str, str] = {}
    for relative, checksum in document["files"].items():
        if not isinstance(relative, str) or not isinstance(checksum, str) or not _HEX64.fullmatch(checksum):
            raise PrepareError(f"invalid checksum entry in {checksum_path}: {relative!r}")
        relative_path = _safe_relative(relative)
        if relative_path.name == ".cargo-checksum.json":
            raise PrepareError(f"checksum metadata must not hash itself: {checksum_path}")
        expected_files[relative_path.as_posix()] = checksum
    actual_files: dict[str, str] = {}
    for item in directory.rglob("*"):
        if item.name == ".cargo-checksum.json":
            continue
        item_stat = item.lstat()
        if stat.S_ISREG(item_stat.st_mode):
            relative = item.relative_to(directory).as_posix()
            actual_files[relative] = sha256_file(item)
    if actual_files != expected_files:
        raise PrepareError(f"vendor package file checksums do not match metadata: {directory}")


def _extract_archive(archive: Path, package: LockedPackage, vendor: Path) -> Path:
    """Safely extract one crate into a temporary directory and publish it."""

    vendor.mkdir(parents=True, exist_ok=True)
    _ensure_no_symlink_components(vendor, vendor.parent)
    destination = vendor / package.directory
    if destination.exists() or destination.is_symlink():
        _validate_checksum_file(destination, package)
        return destination
    temporary_root = Path(tempfile.mkdtemp(prefix=f".{package.directory}.", dir=vendor))
    temporary_package = temporary_root / package.directory
    try:
        with tarfile.open(archive, mode="r:*") as tar:
            seen: set[str] = set()
            members = tar.getmembers()
            for member in members:
                relative_name = PurePosixPath(member.name)
                if "\\" in member.name or "\x00" in member.name:
                    raise PrepareError(f"unsafe archive member path in {archive}: {member.name!r}")
                if (
                    relative_name.is_absolute()
                    or not relative_name.parts
                    or any(part in {"", ".", ".."} for part in relative_name.parts)
                    or relative_name.parts[0] != package.directory
                    or member.name in seen
                ):
                    raise PrepareError(f"unsafe archive member path in {archive}: {member.name!r}")
                try:
                    _safe_relative(member.name)
                except PrepareError as exc:
                    raise PrepareError(f"unsafe archive member path in {archive}: {member.name!r}") from exc
                normalized_name = relative_name.as_posix()
                if normalized_name in seen:
                    raise PrepareError(f"duplicate archive member path in {archive}: {member.name!r}")
                seen.add(member.name)
                seen.add(normalized_name)
                if member.issym() or member.islnk() or not (member.isdir() or member.isreg()):
                    raise PrepareError(f"archive links or special files are not allowed: {member.name!r}")
                target = temporary_root.joinpath(*relative_name.parts)
                try:
                    target.resolve().relative_to(temporary_root.resolve())
                except ValueError as exc:
                    raise PrepareError(f"archive member escapes vendor directory: {member.name!r}") from exc
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                payload = tar.extractfile(member)
                if payload is None:
                    raise PrepareError(f"cannot read archive member {member.name!r}")
                with target.open("wb") as stream:
                    shutil.copyfileobj(payload, stream)
                try:
                    target.chmod(member.mode & 0o777)
                except OSError:
                    pass
        _ensure_regular_tree(temporary_package, expected_package=package.directory)
        files: dict[str, str] = {}
        for item in sorted(temporary_package.rglob("*")):
            if item.name == ".cargo-checksum.json":
                continue
            item_stat = item.lstat()
            if stat.S_ISREG(item_stat.st_mode):
                files[item.relative_to(temporary_package).as_posix()] = sha256_file(item)
        checksum = json.dumps(
            {"files": files, "package": package.checksum}, sort_keys=True, separators=(",", ":")
        ) + "\n"
        write_if_changed(temporary_package / ".cargo-checksum.json", checksum)
        _validate_checksum_file(temporary_package, package)
        try:
            os.replace(temporary_package, destination)
        except FileExistsError:
            _validate_checksum_file(destination, package)
        return destination
    except (OSError, tarfile.TarError) as exc:
        raise PrepareError(f"cannot safely extract {archive}: {exc}") from exc
    finally:
        shutil.rmtree(temporary_root, ignore_errors=True)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request: Request, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        raise PrepareError(f"crate download unexpectedly redirected to {newurl}")


def crate_url(package: LockedPackage) -> str:
    return f"{CRATES_BASE}/{quote(package.name, safe='')}/{quote(package.filename, safe='')}"


def download_archive(archive: Path, package: LockedPackage, *, timeout: float = 30.0) -> None:
    """Download one locked crate, with an allowlisted host and atomic publish."""

    url = crate_url(package)
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != CRATES_HOST or parsed.username or parsed.password:
        raise PrepareError(f"refusing non-allowlisted crate URL: {url}")
    archive.parent.mkdir(parents=True, exist_ok=True)
    request = Request(url, headers={"User-Agent": "barochart-wasm-eh-preparer/1"})
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    temporary: Path | None = None
    try:
        with opener.open(request, timeout=timeout) as response:
            final = urlparse(response.geturl())
            if final.scheme != "https" or final.hostname != CRATES_HOST or final.username or final.password:
                raise PrepareError(f"crate download redirected outside allowlist: {response.geturl()}")
            fd, temporary_name = tempfile.mkstemp(prefix=f".{archive.name}.", dir=archive.parent)
            temporary = Path(temporary_name)
            with os.fdopen(fd, "wb") as stream:
                for block in iter(lambda: response.read(1024 * 1024), b""):
                    stream.write(block)
                stream.flush()
                os.fsync(stream.fileno())
        actual = sha256_file(temporary)
        if actual != package.checksum:
            raise PrepareError(
                f"downloaded crate checksum mismatch for {package.filename}: expected {package.checksum}, got {actual}"
            )
        os.replace(temporary, archive)
        temporary = None
    except (HTTPError, URLError, OSError) as exc:
        raise PrepareError(f"could not download {package.filename} from {CRATES_HOST}: {exc}") from exc
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def stage_cache(
    packages: Sequence[LockedPackage],
    *,
    archives: Path,
    vendor: Path,
    download: bool,
) -> CacheResult:
    """Verify/archive-extract all packages, without consulting global Cargo state."""

    staged: list[LockedPackage] = []
    downloaded: list[LockedPackage] = []
    missing: list[LockedPackage] = []
    for package in packages:
        archive = archives / package.filename
        destination = vendor / package.directory
        if destination.exists() or destination.is_symlink():
            _validate_checksum_file(destination, package)
            if archive.exists() or archive.is_symlink():
                _validate_package_archive(archive, package)
            staged.append(package)
            continue
        if not archive.is_file():
            if not download:
                missing.append(package)
                continue
            download_archive(archive, package)
            downloaded.append(package)
        _validate_package_archive(archive, package)
        _extract_archive(archive, package, vendor)
        staged.append(package)
    if missing:
        names = ", ".join(package.filename for package in missing)
        raise PrepareError(
            f"offline cache is missing {len(missing)} locked crate(s): {names}. "
            "Populate artifacts/rust-wasm/stdlib-cache/archives or rerun explicitly with --download."
        )
    return CacheResult(tuple(packages), tuple(staged), tuple(downloaded))


def _rustup_proxy_bin(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    inherited = os.environ.get("BAROCHART_RUSTUP_BIN")
    if inherited:
        return Path(inherited).expanduser().resolve()
    cargo_home = os.environ.get("CARGO_HOME")
    if cargo_home:
        return (Path(cargo_home).expanduser() / "bin").resolve()
    return (Path.home() / ".cargo" / "bin").resolve()


def _toolchain_root_for_rustc(rustc: Path) -> Path:
    resolved = rustc.resolve()
    if resolved.parent.name != "bin" or not resolved.parent.parent.is_dir():
        raise PrepareError(f"pinned rustc is not inside a toolchain bin directory: {rustc}")
    return resolved.parent.parent


def _copy_if_changed(source: Path, destination: Path, *, mode: int | None = None) -> None:
    if not source.is_file() or source.is_symlink():
        raise PrepareError(f"pinned toolchain entry is not a regular file: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() or destination.is_symlink():
        if destination.is_symlink() or not destination.is_file():
            raise PrepareError(f"project toolchain entry is not a regular file: {destination}")
        try:
            if filecmp.cmp(source, destination, shallow=False):
                if mode is not None:
                    destination.chmod(mode)
                return
        except OSError as exc:
            raise PrepareError(f"cannot compare toolchain entry {destination}: {exc}") from exc
    temporary: Path | None = None
    try:
        fd, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
        temporary = Path(temporary_name)
        with os.fdopen(fd, "wb") as stream, source.open("rb") as input_stream:
            shutil.copyfileobj(input_stream, stream)
            stream.flush()
            os.fsync(stream.fileno())
        if mode is None:
            mode = stat.S_IMODE(source.stat().st_mode)
        temporary.chmod(mode)
        os.replace(temporary, destination)
        temporary = None
    except OSError as exc:
        raise PrepareError(f"cannot copy pinned toolchain entry {source} to {destination}: {exc}") from exc
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def _link_if_missing(source: Path, destination: Path) -> None:
    if not source.exists() and not source.is_symlink():
        raise PrepareError(f"pinned toolchain entry is missing: {source}")
    if destination.exists() or destination.is_symlink():
        if destination.is_symlink():
            if destination.resolve() == source.resolve():
                return
            raise PrepareError(f"project toolchain link points elsewhere: {destination}")
        # Existing regular files/directories are accepted as already prepared;
        # the RustcInfo/channel checks still guard the compiler selected below.
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.symlink_to(source.resolve(), target_is_directory=source.is_dir())


def assemble_project_sysroot(project: Path, distribution: Path) -> None:
    """Populate a project-local sysroot from one pinned installed toolchain."""

    if not distribution.is_dir():
        raise PrepareError(f"pinned toolchain root is missing: {distribution}")
    distribution_bin = distribution / "bin"
    distribution_lib = distribution / "lib"
    distribution_rustlib = distribution_lib / "rustlib"
    for path, label in (
        (distribution_bin, "bin"),
        (distribution_lib, "lib"),
        (distribution_rustlib, "lib/rustlib"),
    ):
        if not path.is_dir():
            raise PrepareError(f"pinned toolchain {label} directory is missing: {path}")

    project_bin = project / "bin"
    project_lib = project / "lib"
    project_rustlib = project_lib / "rustlib"
    _ensure_no_symlink_components(project, project.parent)
    _ensure_no_symlink_components(project_bin, project)
    _ensure_no_symlink_components(project_lib, project)
    _ensure_no_symlink_components(project_rustlib, project_lib)
    project_bin.mkdir(parents=True, exist_ok=True)
    project_lib.mkdir(parents=True, exist_ok=True)
    project_rustlib.mkdir(parents=True, exist_ok=True)

    for name in ("cargo", "rustc", "rustdoc"):
        _copy_if_changed(distribution_bin / name, project_bin / name)

    for entry in sorted(distribution_lib.iterdir(), key=lambda item: item.name):
        _link_if_missing(entry, project_lib / entry.name)

    source_directory = project_rustlib / "src"
    if source_directory.is_symlink():
        raise PrepareError(f"project rustlib/src must be a directory: {source_directory}")
    source_directory.mkdir(parents=True, exist_ok=True)
    for entry in sorted(distribution_rustlib.iterdir(), key=lambda item: item.name):
        if entry.name == "src":
            continue
        _link_if_missing(entry, project_rustlib / entry.name)


def _ensure_artifact_path(path: Path, artifacts: Path, *, label: str) -> Path:
    resolved = path.expanduser().resolve()
    try:
        resolved.relative_to(artifacts.resolve())
    except ValueError as exc:
        raise PrepareError(f"{label} must stay under {artifacts}: {resolved}") from exc
    return resolved


def _wrapper_text(compiler: Path, sysroot: Path) -> str:
    compiler = compiler.resolve()
    sysroot = sysroot.resolve()
    lib = sysroot / "lib"
    # Paths are single-quoted shell literals.  The helper only emits absolute
    # paths generated from local arguments, but reject the one shell character
    # that cannot be represented by this simple literal for defense in depth.
    for value in (compiler, sysroot, lib):
        if "'" in str(value):
            raise PrepareError(f"cannot create shell wrapper for path containing a quote: {value}")
    compiler_literal = f"'{compiler}'"
    sysroot_literal = f"'{sysroot}'"
    lib_literal = f"'{lib}'"
    return (
        "#!/bin/sh\n"
        "set -eu\n"
        "case \"$(uname -s 2>/dev/null || true)\" in\n"
        "  Darwin)\n"
        f"    export DYLD_LIBRARY_PATH={lib_literal}\n"
        f"    export DYLD_FALLBACK_LIBRARY_PATH={lib_literal}\n"
        "    ;;\n"
        "  Linux|FreeBSD|OpenBSD|NetBSD)\n"
        f"    export LD_LIBRARY_PATH={lib_literal}\n"
        "    ;;\n"
        "esac\n"
        f"exec {compiler_literal} --sysroot {sysroot_literal} \"$@\"\n"
    )


def generate_wrapper(toolchain: Path, compiler: Path) -> Path:
    wrapper = toolchain / "bin" / "rustc-with-sysroot"
    write_if_changed(wrapper, _wrapper_text(compiler, toolchain), mode=0o755)
    return wrapper


def generate_cargo_config(cargo_home: Path, vendor: Path) -> Path:
    config = cargo_home / "config.toml"
    content = (
        "[source.crates-io]\n"
        'replace-with = "barochart-stdlib-vendor"\n\n'
        "[source.barochart-stdlib-vendor]\n"
        f"directory = {json.dumps(str(vendor.resolve()))}\n\n"
        "[net]\n"
        "offline = true\n\n"
        "[unstable]\n"
        'build-std = ["std", "panic_unwind"]\n'
    )
    write_if_changed(config, content)
    return config


def _write_stage_metadata(cache: Path, result: CacheResult) -> None:
    staged = json.dumps([package.as_dict() for package in result.staged], indent=2) + "\n"
    write_if_changed(cache / "staged.json", staged)
    write_if_changed(cache / "missing.json", "[]\n")


def _discover_pinned_rustc(toolchain: Path, explicit: str | None, *, root: Path) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    candidate = toolchain / "bin" / "rustc"
    if candidate.is_file():
        return candidate.resolve()
    rustup_home = Path(os.environ.get("RUSTUP_HOME", str(Path.home() / ".rustup"))).expanduser()
    roots = [rustup_home / "toolchains"]
    for toolchains_directory in roots:
        if not toolchains_directory.is_dir():
            continue
        for candidate_root in sorted(toolchains_directory.iterdir()):
            candidate = candidate_root / "bin" / "rustc"
            if candidate.is_file():
                try:
                    info = rustc_info(candidate)
                except PrepareError:
                    continue
                if info.release == _pinned_release(root):
                    return candidate.resolve()
    raise PrepareError(f"pinned rustc is missing; expected {toolchain / 'bin' / 'rustc'} or a local rustup toolchain")


def _pinned_release(root: Path) -> str:
    toolchain_file = root / "rust" / "rust-toolchain.toml"
    try:
        document = tomllib.loads(toolchain_file.read_text(encoding="utf-8"))
        channel = str(document["toolchain"]["channel"])
    except (OSError, KeyError, TypeError, tomllib.TOMLDecodeError) as exc:
        raise PrepareError(f"cannot read pinned Rust channel from {toolchain_file}: {exc}") from exc
    return channel.split("-", 1)[0]


def _require_pinned_release(info: RustcInfo, root: Path, *, label: str) -> None:
    expected = _pinned_release(root)
    if info.release != expected:
        raise PrepareError(f"{label} release {info.release} does not match rust-toolchain.toml channel {expected}")


def prepare(
    *,
    root: Path = DEFAULT_ROOT,
    download: bool = False,
    toolchain_dir: Path | None = None,
    cargo_home: Path | None = None,
    rustup_bin: str | None = None,
    pinned_rustc: Path | None = None,
    requested_source: Path | None = None,
    toolchains_root: Path | None = None,
) -> dict[str, Any]:
    root = root.expanduser().resolve()
    artifacts = (root / "artifacts" / "rust-wasm").resolve()
    cache = artifacts / "stdlib-cache"
    toolchain = (toolchain_dir or artifacts / "eh-toolchain").expanduser().resolve()
    cargo_home_path = (cargo_home or cache / "cargo-home").expanduser().resolve()
    for path, label in ((toolchain, "toolchain"), (cargo_home_path, "CARGO_HOME")):
        _ensure_artifact_path(path, artifacts, label=label)
    _ensure_no_symlink_components(cache, artifacts)
    archives = cache / "archives"
    vendor = cache / "vendor"
    archives.mkdir(parents=True, exist_ok=True)
    vendor.mkdir(parents=True, exist_ok=True)
    rustc_path = (pinned_rustc or _discover_pinned_rustc(toolchain, None, root=root)).expanduser().resolve()
    selected_rustc = rustc_info(rustc_path)
    _require_pinned_release(selected_rustc, root, label="selected rustc")
    distribution = _toolchain_root_for_rustc(rustc_path)
    assemble_project_sysroot(toolchain, distribution)
    rustc_path = (toolchain / "bin" / "rustc").resolve()
    _require_pinned_release(rustc_info(rustc_path), root, label="cached rustc")
    selection = select_rust_source(
        toolchain=toolchain,
        pinned_rustc=rustc_path,
        toolchains_root=toolchains_root,
        requested_source=requested_source,
    )
    source_link = toolchain / "lib" / "rustlib" / "src" / "rust"
    _ensure_no_symlink_components(source_link.parent, toolchain)
    source_link.parent.mkdir(parents=True, exist_ok=True)
    if source_link.exists() or source_link.is_symlink():
        existing = source_link.resolve()
        if existing != selection.source.resolve():
            raise PrepareError(f"EH sysroot source points to a different tree: {source_link} -> {existing}")
    else:
        source_link.symlink_to(selection.source, target_is_directory=True)

    locked = parse_locked_packages((selection.source / "library" / "Cargo.lock", root / "rust" / "Cargo.lock"))
    cache_result = stage_cache(locked, archives=archives, vendor=vendor, download=download)
    _write_stage_metadata(cache, cache_result)
    config = generate_cargo_config(cargo_home_path, vendor)
    wrapper = generate_wrapper(toolchain, rustc_path)
    proxy_bin = _rustup_proxy_bin(rustup_bin)
    environment = {
        "RUSTC": str(wrapper),
        "RUSTC_BOOTSTRAP": "1",
        "RUSTFLAGS": RUSTFLAGS,
        "CARGO_INCREMENTAL": "0",
        "CARGO_HOME": str(cargo_home_path),
        "BAROCHART_RUSTUP_BIN": str(proxy_bin),
        "CARGO_NET_OFFLINE": "1",
    }
    return {
        "mode": "download" if download else "offline",
        "root": str(root),
        "toolchain": str(toolchain),
        "rustc": str(rustc_path),
        "rustcWrapper": str(wrapper),
        "rustSource": str(selection.source),
        "vendor": str(vendor),
        "cargoHome": str(cargo_home_path),
        "cargoConfig": str(config),
        "rustupBin": str(proxy_bin),
        "packages": {
            "locked": len(cache_result.locked),
            "cached": len(cache_result.staged),
            "staged": len(cache_result.staged),
            "downloaded": len(cache_result.downloaded),
            "missing": len(cache_result.missing),
        },
        "environment": environment,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="repository root (default: inferred)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--offline", action="store_true", help="use only project-local archives/vendor (default)")
    mode.add_argument("--download", action="store_true", help="download missing locked crates from static.crates.io")
    parser.add_argument("--toolchain-dir", type=Path, help="project EH sysroot under artifacts/rust-wasm")
    parser.add_argument("--cargo-home", type=Path, help="project CARGO_HOME under artifacts/rust-wasm")
    parser.add_argument("--rustup-bin", help="original rustup proxy bin directory for BAROCHART_RUSTUP_BIN")
    parser.add_argument("--rustc", type=Path, help="pinned rustc binary to inspect/use")
    parser.add_argument("--rust-src", type=Path, help="locally installed matching rust-src tree")
    parser.add_argument("--toolchains-root", type=Path, help="local rustup toolchains directory to search")
    parser.add_argument(
        "--json",
        action="store_true",
        help="emit the preparation result as JSON (the default and only output format)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = prepare(
            root=args.root,
            download=args.download,
            toolchain_dir=args.toolchain_dir,
            cargo_home=args.cargo_home,
            rustup_bin=args.rustup_bin,
            pinned_rustc=args.rustc,
            requested_source=args.rust_src,
            toolchains_root=args.toolchains_root,
        )
    except (PrepareError, OSError) as exc:
        print(f"prepare-wasm-eh: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
