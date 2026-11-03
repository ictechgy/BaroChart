// cargo 래퍼: rustup의 cargo를 rust/ 워크스페이스에서 실행한다.
// 이 Mac은 Homebrew rustc가 PATH 앞에 있어 rustup 프록시를 가린다. cargo는 PATH에서 rustc를 찾으므로
// rustup bin 디렉터리를 PATH 맨 앞에 두고, cwd를 rust/로 바꿔 rust-toolchain.toml(채널 고정)이 적용되게 한다.
// Homebrew cargo로 물러서지 않는다. rust-toolchain.toml을 따르지 않아 다른 컴파일러로 조용히 빌드하기 때문이다.
// 사용법: node scripts/rust/cargo.mjs <cargo 인자...> → 인자는 셸 없이 그대로, 종료 코드도 그대로 돌려준다.
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {constants,homedir} from 'node:os';
import {delimiter,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

/** Rust 워크스페이스 디렉터리. rust-toolchain.toml이 여기 있어 cwd로 쓰면 고정 채널이 적용된다 */
export const WORKSPACE=fileURLToPath(new URL('../../rust/',import.meta.url));

/** cwd를 rust/로 옮기면 뜻이 바뀌는 상대 경로 환경 변수. 실행 전에 절대 경로로 바꾼다 */
const HOME_VARIABLES=['CARGO_HOME','RUSTUP_HOME'];

/**
 * rustup이 cargo 프록시를 두는 bin 디렉터리를 정한다.
 * @param {NodeJS.ProcessEnv} env 래퍼가 받은 환경
 * @returns {string} BAROCHART_RUSTUP_BIN, `$CARGO_HOME/bin`, `$HOME/.cargo/bin` 순으로 고른 절대 경로
 */
export function rustupBinDirectory(env){
 if(env.BAROCHART_RUSTUP_BIN)return resolve(env.BAROCHART_RUSTUP_BIN);
 if(env.CARGO_HOME)return join(resolve(env.CARGO_HOME),'bin');
 return join(env.HOME||homedir(),'.cargo','bin');
}

/**
 * cargo에 넘길 환경을 만든다. rustup bin을 PATH 맨 앞에 두어 cargo가 찾는 rustc도 rustup 프록시가 되게 한다.
 * @param {NodeJS.ProcessEnv} env 래퍼가 받은 환경
 * @param {string} binDirectory rustup bin 디렉터리
 * @returns {NodeJS.ProcessEnv} 새 환경(입력은 바꾸지 않는다)
 */
export function cargoEnvironment(env,binDirectory){
 const next={...env,PATH:[binDirectory,env.PATH].filter(Boolean).join(delimiter)};
 for(const name of HOME_VARIABLES)if(env[name])next[name]=resolve(env[name]);
 return next;
}

/**
 * 자식 프로세스 결과를 셸 관례의 종료 코드로 바꾼다.
 * @param {{status: number|null, signal: NodeJS.Signals|null}} result spawnSync 결과
 * @returns {number} 정상 종료면 그 코드, 시그널로 끝나면 128+시그널 번호
 */
export function exitCodeOf(result){
 if(result.signal)return 128+(constants.signals[result.signal]??0);
 return result.status??1;
}

/**
 * rustup cargo를 실행하고 종료 코드를 돌려준다. cargo가 없으면 원인과 해결 방법을 알린다.
 * @param {string[]} args cargo 인자(셸을 거치지 않는다)
 * @param {NodeJS.ProcessEnv} [env] 래퍼 환경
 * @returns {number} cargo 종료 코드. cargo가 없으면 127, 실행하지 못하면 126
 */
export function runCargo(args,env=process.env){
 const binDirectory=rustupBinDirectory(env),cargo=join(binDirectory,'cargo');
 if(!existsSync(cargo)){
  console.error(`cargo.mjs: rustup cargo not found at ${cargo}. Install rustup (https://rustup.rs), set BAROCHART_RUSTUP_BIN to rustup's bin directory, or set CARGO_HOME to the directory that holds bin/cargo. Homebrew cargo is not used because it ignores rust/rust-toolchain.toml.`);
  return 127;
 }
 const result=spawnSync(cargo,args,{cwd:WORKSPACE,env:cargoEnvironment(env,binDirectory),stdio:'inherit'});
 if(!result.error)return exitCodeOf(result);
 console.error(`cargo.mjs: could not start ${cargo} in ${WORKSPACE}: ${result.error.message}. Check that the file is executable and that the rust/ workspace exists.`);
 return 126;
}

// CLI: node scripts/rust/cargo.mjs <cargo 인자...>. exitCode를 써서 파이프로 나가는 오류 문구가 잘리지 않게 한다.
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)process.exitCode=runCargo(process.argv.slice(2));
