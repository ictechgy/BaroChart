import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {cp, mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const swift = process.env.SWIFT_EXECUTABLE ?? '/usr/bin/swift';
const swiftAvailable = existsSync(swift);
if(process.env.REQUIRE_SWIFTPM==='1') assert.ok(swiftAvailable,'SwiftPM is required for the native manifest gate');
const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function fixturePackage(run) {
  const temp = await mkdtemp(join(tmpdir(), 'barochart-swiftpm-manifest-'));
  const packageRoot = join(temp, 'FixturePackage');
  const outsideCWD = join(temp, 'OutsideCWD');
  await Promise.all([mkdir(packageRoot), mkdir(outsideCWD)]);
  await cp(join(repositoryRoot, 'Package.swift'), join(packageRoot, 'Package.swift'));
  try {await run({temp, packageRoot, outsideCWD})} finally {await rm(temp, {recursive: true, force: true})}
}

function dumpPackage(packageRoot, outsideCWD, rustPath) {
  const env = {...process.env};
  if (rustPath === undefined) delete env.BAROCHART_RUST_XCFRAMEWORK;
  else env.BAROCHART_RUST_XCFRAMEWORK = rustPath;
  return spawnSync(swift, ['package', 'dump-package', '--package-path', packageRoot], {
    cwd: outsideCWD,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

const skip = swiftAvailable ? false : `SwiftPM manifest subprocess checks skipped: Swift executable unavailable at ${swift}`;

test('SwiftPM manifest stays JS-only when the Rust framework variable is unset', {skip}, async () => {
  await fixturePackage(({packageRoot, outsideCWD}) => {
    const result = dumpPackage(packageRoot, outsideCWD, undefined);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.targets.some(target => target.name === 'BaroChartCoreRust'), false);
  });
});

test('SwiftPM resolves an in-package relative framework from a different working directory', {skip}, async () => {
  await fixturePackage(async ({packageRoot, outsideCWD}) => {
    const framework = join(packageRoot, 'artifacts/rust/Fixture.xcframework');
    await mkdir(framework, {recursive: true});
    const result = dumpPackage(packageRoot, outsideCWD, 'artifacts/rust/Fixture.xcframework');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const manifest = JSON.parse(result.stdout);
    const target = manifest.targets.find(target => target.name === 'BaroChartCoreRust');
    assert.ok(target, 'expected a binary Rust target');
    assert.equal(target.path, 'artifacts/rust/Fixture.xcframework');
  });
});

test('SwiftPM rejects missing and non-XCFramework paths instead of omitting the Rust target', {skip}, async () => {
  await fixturePackage(async ({packageRoot, outsideCWD}) => {
    const missing = 'artifacts/rust/DefinitelyMissing.xcframework';
    const missingResult = dumpPackage(packageRoot, outsideCWD, missing);
    const missingDiagnostic = `${missingResult.stdout}\n${missingResult.stderr}`;
    assert.notEqual(missingResult.status, 0, 'a configured but missing framework must fail');
    assert.match(missingDiagnostic, /BAROCHART_RUST_XCFRAMEWORK.*existing.*\.xcframework/i);
    assert.doesNotMatch(missingDiagnostic, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    await mkdir(join(packageRoot, 'artifacts/rust'), {recursive: true});
    await writeFile(join(packageRoot, 'artifacts/rust/not-a-framework.txt'), 'fixture');
    const invalid = 'artifacts/rust/not-a-framework.txt';
    const invalidResult = dumpPackage(packageRoot, outsideCWD, invalid);
    const invalidDiagnostic = `${invalidResult.stdout}\n${invalidResult.stderr}`;
    assert.notEqual(invalidResult.status, 0, 'a configured non-XCFramework must fail');
    assert.match(invalidDiagnostic, /BAROCHART_RUST_XCFRAMEWORK.*\.xcframework/i);
    assert.doesNotMatch(invalidDiagnostic, new RegExp(invalid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('SwiftPM rejects absolute external frameworks and symlinks escaping the package root', {skip}, async () => {
  await fixturePackage(async ({temp, packageRoot, outsideCWD}) => {
    const external = join(temp, 'External.xcframework');
    await mkdir(external);
    const externalResult = dumpPackage(packageRoot, outsideCWD, external);
    const externalDiagnostic = `${externalResult.stdout}\n${externalResult.stderr}`;
    assert.notEqual(externalResult.status, 0, 'absolute external framework must fail');
    assert.match(externalDiagnostic, /BAROCHART_RUST_XCFRAMEWORK.*inside.*package root/i);
    assert.doesNotMatch(externalDiagnostic, new RegExp(external.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const escape = join(packageRoot, 'artifacts/rust/Escape.xcframework');
    await mkdir(join(packageRoot, 'artifacts/rust'), {recursive: true});
    await symlink(external, escape, 'dir');
    const symlinkResult = dumpPackage(packageRoot, outsideCWD, 'artifacts/rust/Escape.xcframework');
    const symlinkDiagnostic = `${symlinkResult.stdout}\n${symlinkResult.stderr}`;
    assert.notEqual(symlinkResult.status, 0, 'symlink escaping the package root must fail');
    assert.match(symlinkDiagnostic, /BAROCHART_RUST_XCFRAMEWORK.*inside.*package root/i);
    assert.doesNotMatch(symlinkDiagnostic, new RegExp(external.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});
