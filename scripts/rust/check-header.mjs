// 커밋한 C 헤더가 고정 cbindgen 출력과 바이트 단위로 같은지 검사한다.
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {ROOT} from './cbindgen-tool.mjs';
import {generateHeader} from './cbindgen.mjs';

/** 헤더 freshness 검사 종료 코드를 돌려준다. */
export async function checkHeader(){
 const directory=await mkdtemp(join(tmpdir(),'barochart-cbindgen-'));
 const generated=join(directory,'barochart_core.h');
 try{
  const code=generateHeader(generated);
  if(code!==0)return code;
  const [actual,expected]=await Promise.all([
   readFile(generated),
   readFile(resolve(ROOT,'rust/include/barochart_core.h')),
  ]);
  if(!actual.equals(expected)){
   console.error('check-header: rust/include/barochart_core.h is stale; run node scripts/rust/cbindgen.mjs');
   return 1;
  }
  console.log('check-header: generated header is current');
  return 0;
 }finally{
  await rm(directory,{recursive:true,force:true});
 }
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)process.exitCode=await checkHeader();
