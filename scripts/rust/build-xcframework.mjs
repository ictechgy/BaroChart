#!/usr/bin/env node
// Build the local, untracked iOS/macOS Rust binary slices and package them as an XCFramework.
import {spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = join(root, 'artifacts/rust');
const targetDir = join(artifacts, 'cargo-target');
const framework = join(artifacts, 'BaroChartCoreRust.xcframework');
const header = join(root, 'rust/include/barochart_core.h');
const moduleMap = 'module BaroChartCoreRust {\n  header "barochart_core.h"\n  export *\n}\n';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}

function rustBuild(target) {
  run(process.execPath, [
    'scripts/rust/cargo.mjs', 'build', '--locked', '--offline', '--release', '-j2', '-p', 'barochart-ffi', '--target', target,
  ], {env: {...process.env, CARGO_TARGET_DIR: targetDir}});
  return join(targetDir, target, 'release/libbarochart_ffi.a');
}

function prepareSlice(name, library) {
  const directory = join(artifacts, `slice-${name}`);
  mkdirSync(directory, {recursive: true});
  const include = join(directory, 'Headers');
  mkdirSync(include, {recursive: true});
  writeFileSync(join(include, 'barochart_core.h'), readFileSync(header));
  writeFileSync(join(include, 'module.modulemap'), moduleMap);
  return {library, headers: include};
}

try {
  mkdirSync(artifacts, {recursive: true});
  rmSync(framework, {recursive: true, force: true});
  const ios = prepareSlice('ios-arm64', rustBuild('aarch64-apple-ios'));
  const simulator = prepareSlice('ios-simulator-arm64', rustBuild('aarch64-apple-ios-sim'));
  const macArm = rustBuild('aarch64-apple-darwin');
  const macIntel = rustBuild('x86_64-apple-darwin');
  const macUniversal = join(artifacts, 'libbarochart_ffi-macos-universal.a');
  run('lipo', ['-create', macArm, macIntel, '-output', macUniversal]);
  const macos = prepareSlice('macos-universal', macUniversal);
  run('xcodebuild', [
    '-create-xcframework',
    '-library', ios.library, '-headers', ios.headers,
    '-library', simulator.library, '-headers', simulator.headers,
    '-library', macos.library, '-headers', macos.headers,
    '-output', framework,
  ]);
  console.log(`Created ${framework}`);
} catch (error) {
  console.error(`build-xcframework: ${error.message}`);
  process.exitCode = 1;
}
