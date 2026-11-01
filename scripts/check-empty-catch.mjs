// 오류를 조용히 버리는 빈 catch 블록을 찾는다.
// 본문이 비었거나 주석만 있는 catch를 금지한다. 의도적으로 무시하는 경우도 주석 대신
// 카운터·진단 값·로그·addSuppressed 같은 관찰 가능한 기록을 남겨야 한다.
// 범위: 네이티브 SDK 소스(Java·Kotlin·Swift·C). vendored QuickJS와 생성 번들은 제외한다.
import {readdir,readFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const EMPTY_CATCH=/catch(\s+let\s+\w+|\s*\([^)]*\))?\s*\{\s*((\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*)*\}/g;
const SOURCE=/\.(java|kt|swift|c)$/;
const SKIPPED=['native/android/quickjs','native/Resources','native/android/library/build','native/android/library/.gradle','native/android/library/.cxx'];

/**
 * 소스 텍스트에서 빈 catch 블록을 찾는다.
 * @param {string} text 소스 내용
 * @returns {{line: number, text: string}[]} 1부터 시작하는 줄 번호와 일치한 코드 앞부분
 */
export function findEmptyCatches(text){
 return [...text.matchAll(EMPTY_CATCH)].map(match=>({line:text.slice(0,match.index).split('\n').length,text:match[0].slice(0,80)}));
}

/** 디렉터리를 재귀로 돌며 검사 대상 파일 경로를 모은다 */
async function sourceFiles(directory){
 const out=[];
 for(const entry of await readdir(directory,{withFileTypes:true})){
  const path=join(directory,entry.name),rel=relative(root,path);
  if(SKIPPED.some(skip=>rel===skip||rel.startsWith(skip+'/')))continue;
  if(entry.isDirectory())out.push(...await sourceFiles(path));
  else if(SOURCE.test(entry.name))out.push(path);
 }
 return out;
}

/**
 * 네이티브 SDK 소스 전체를 검사한다.
 * @returns {Promise<{file: string, line: number, text: string}[]>} 발견 목록(없으면 빈 배열)
 */
export async function scanNativeSources(){
 const findings=[];
 for(const path of await sourceFiles(join(root,'native')))
  for(const finding of findEmptyCatches(await readFile(path,'utf8')))findings.push({file:relative(root,path),...finding});
 return findings;
}

// CLI: node scripts/check-empty-catch.mjs → 발견 목록 JSON, 하나라도 있으면 exit 1
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const findings=await scanNativeSources();
 console.log(JSON.stringify(findings,null,1));
 if(findings.length)process.exit(1);
}
