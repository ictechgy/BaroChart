// Task 6 헤더 도구: cbindgen을 저장소 전용 경로에 고정하고 최소 환경으로 실행한다.
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {delimiter,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {exitCodeOf,runCargo,rustupBinDirectory} from './cargo.mjs';

/** 공식 mozilla/cbindgen 릴리스와 Crates.io 크레이트에서 확인한 고정 버전 */
export const CBINDGEN_VERSION='0.29.4';
/** 저장소 루트 */
export const ROOT=fileURLToPath(new URL('../../',import.meta.url));
/** 버전별 로컬 설치 루트 */
export const TOOL_ROOT=join(ROOT,'rust','.tools',`cbindgen-${CBINDGEN_VERSION}`);
/** 네트워크 설치에만 쓰는 새 로컬 Cargo 홈 */
export const TOOL_CARGO_HOME=join(TOOL_ROOT,'cargo-home');
/** 고정 cbindgen 실행 파일 */
export const CBINDGEN=join(TOOL_ROOT,'bin',process.platform==='win32'?'cbindgen.exe':'cbindgen');

/**
 * 호스트 비밀값 환경을 상속하지 않는 cbindgen 자식 환경을 만든다.
 * @param {boolean} offline 네트워크 금지 여부
 * @param {NodeJS.ProcessEnv} source rustup 위치를 찾을 호스트 환경
 * @returns {NodeJS.ProcessEnv} 명시적으로 허용한 항목만 담은 환경
 */
export function toolEnvironment(offline,source=process.env){
 const rustupBin=rustupBinDirectory(source);
 const nodeBin=dirname(process.execPath);
 const systemBins=process.platform==='win32'?[]:['/usr/bin','/bin'];
 return {
  PATH:[rustupBin,nodeBin,...systemBins].join(delimiter),
  BAROCHART_RUSTUP_BIN:rustupBin,
  CARGO_HOME:TOOL_CARGO_HOME,
  RUSTUP_HOME:resolve(source.RUSTUP_HOME||join(homedir(),'.rustup')),
  CARGO_BUILD_JOBS:'2',
  CARGO_NET_OFFLINE:offline?'true':'false',
 };
}

/** 설치된 도구가 정확한 버전인지 확인한다. */
export function installedVersion(){
 if(!existsSync(CBINDGEN))return null;
 const result=spawnSync(CBINDGEN,['--version'],{cwd:ROOT,env:toolEnvironment(true),encoding:'utf8'});
 if(result.status!==0)return null;
 return result.stdout.trim();
}

/** 실제 설치 프로세스를 실행하고 종료 코드를 돌려준다. */
export function installCbindgen(){
 const expected=`cbindgen ${CBINDGEN_VERSION}`;
 const current=installedVersion();
 if(current===expected){
  console.log(`install-cbindgen: ${expected} already installed at ${CBINDGEN}`);
  const fetch=runCargo(['fetch','--locked'],toolEnvironment(false));
  if(fetch!==0)return fetch;
  console.log('install-cbindgen: workspace metadata sources are ready for offline generation');
  return 0;
 }
 if(current){console.error(`install-cbindgen: expected ${expected}, found ${current} at ${CBINDGEN}; remove only this versioned tool directory and retry`);return 2;}
 const code=runCargo(['install','--locked','--version',`=${CBINDGEN_VERSION}`,'--root',TOOL_ROOT,'cbindgen'],toolEnvironment(false));
 if(code!==0)return code;
 const installed=installedVersion();
 if(installed!==expected){console.error(`install-cbindgen: expected ${expected} after install, found ${installed??'no executable'}`);return 2;}
 const fetch=runCargo(['fetch','--locked'],toolEnvironment(false));
 if(fetch!==0)return fetch;
 console.log(`install-cbindgen: installed ${installed} at ${CBINDGEN}`);
 console.log('install-cbindgen: workspace metadata sources are ready for offline generation');
 return 0;
}

/** 오프라인 cbindgen 프로세스를 실행한다. */
export function runCbindgen(args){
 const version=installedVersion();
 if(version!==`cbindgen ${CBINDGEN_VERSION}`){
  console.error(`cbindgen: pinned tool missing; run node scripts/rust/install-cbindgen.mjs (expected cbindgen ${CBINDGEN_VERSION})`);
  return 127;
 }
 const result=spawnSync(CBINDGEN,args,{cwd:ROOT,env:toolEnvironment(true),stdio:'inherit'});
 if(result.error){console.error(`cbindgen: could not start ${CBINDGEN}: ${result.error.message}`);return 126;}
 return exitCodeOf(result);
}
