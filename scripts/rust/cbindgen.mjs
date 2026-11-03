// 고정된 cbindgen으로 Task 6 C 헤더를 생성한다. 도구 실행은 오프라인이다.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {ROOT,runCbindgen} from './cbindgen-tool.mjs';

/**
 * 헤더를 생성한다.
 * @param {string} output 출력 파일
 * @returns {number} cbindgen 종료 코드
 */
export function generateHeader(output){
 return runCbindgen([
  '--config',resolve(ROOT,'rust/cbindgen.toml'),
  '--quiet',
  '--crate','barochart-ffi',
  '--output',resolve(output),
  resolve(ROOT,'rust/crates/barochart-ffi'),
 ]);
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const output=process.argv[2]||resolve(ROOT,'rust/include/barochart_core.h');
 process.exitCode=generateHeader(output);
}
