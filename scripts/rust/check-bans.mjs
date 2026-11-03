// Rust 이식 코드 금지 패턴 검사기(설계 §6.4, 이식 지도 §3.1, M1 계획 Global Constraints).
// JS와 의미가 다른 Rust 표준 기능을 이식 코드(barochart-core, barochart-bridge)에서 막는다.
// - 정밀도·지수 포맷({:.N}, {:e}): 동률을 짝수 쪽으로 반올림하고 -0.00을 낸다
// - f64::min/max/round/signum, mul_add: NaN·-0·동률·반올림 규칙이 JS Math와 다르다
// - str::trim 계열: 공백 표가 JS와 다르다(U+FEFF는 JS만 공백, U+0085는 Rust만 공백)
// - serde: 기본 동작(중복 키, 1e400, 단독 서로게이트, 재귀 한도)이 JSON.parse·JSON.stringify와 다르다
// 커널(barochart-js)은 JS 의미를 직접 구현하는 곳이라 f64 도우미는 쓰되, 형식은 정확한 자릿수용 {:.766e}만 허용하고
// serde·mul_add는 막는다. ffi·wasm·tools 크레이트는 이식 코드가 아니라 검사하지 않는다.
// grep 대신 토큰 단위로 읽는다. 주석·문자열·문자 리터럴 안의 글자는 코드가 아니고, 형식 문자열은
// 매크로 호출 안의 문자열 리터럴만 std::fmt 문법으로 읽는다(그래야 JSON 텍스트나 이스케이프한 중괄호를 오탐하지 않는다).
// 사용법: node scripts/rust/check-bans.mjs [--root <Rust 워크스페이스>] → 위반이 있으면 exit 1, 인자·루트가 잘못되면 exit 2
import {readdir,readFile} from 'node:fs/promises';
import {join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

/** 기본 검사 루트: 저장소의 Rust 워크스페이스 */
const DEFAULT_ROOT=fileURLToPath(new URL('../../rust/',import.meta.url));

/** CLI 사용법(잘못된 인자일 때 보여 준다) */
const USAGE='Usage: node scripts/rust/check-bans.mjs [--root <Rust workspace directory>]';

/** 검사하는 크레이트와 규칙 묶음 이름. ported는 모든 규칙, kernel은 커널 규칙이다 */
export const CRATE_PROFILES=Object.freeze({'barochart-core':'ported','barochart-bridge':'ported','barochart-js':'kernel'});

/** 규칙 이름 → 개발자용 설명(원인과 대안). CLI가 위반마다 붙여 출력한다 */
export const RULES=Object.freeze({
 'float-format':'Rust {:.N} and {:e} round ties to even and print -0; call barochart_js::num::to_fixed, to_precision or to_exponential (the kernel may use only {:.766e} for exact digits)',
 'float-min-max':'f64::min and f64::max drop NaN and leave the sign of zero unspecified; call barochart_js::num::js_min or js_max, or std::cmp::min/max and Ord::min/max for integers',
 'float-round':'f64::round rounds -2.5 to -3 while Math.round gives -2; call barochart_js::num::js_round',
 'float-signum':'f64::signum returns 1 for +0 and -1 for -0 while Math.sign keeps the zero; call barochart_js::num::js_sign',
 'mul-add':'fused multiply-add rounds once and changes results; write the JS expression as is, left to right',
 'str-trim':'std trimming strips U+0085 and keeps U+FEFF unlike String.prototype.trim; call JsString::trim(&value)',
 'serde':'serde defaults differ from JSON.parse and JSON.stringify (duplicate keys, 1e400, lone surrogates, recursion limits); use barochart_js::json',
});

/** 묶음 이름 → 적용 규칙 집합 */
const PROFILE_RULES=new Map([
 ['ported',new Set(Object.keys(RULES))],
 ['kernel',new Set(['float-format','mul-add','serde'])],
]);

/** 공백을 JS 표와 다르게 다루는 std 다듬기 함수 이름 */
const TRIM_FUNCTIONS=['trim','trim_start','trim_end','trim_left','trim_right','trim_ascii','trim_ascii_start','trim_ascii_end'];

/** `.이름(` 메서드 호출 → 규칙. min·max는 인자가 있을 때만 건다(인자 없는 Iterator::max는 허용) */
const METHOD_RULES=new Map([
 ['min','float-min-max'],['max','float-min-max'],['round','float-round'],['signum','float-signum'],
 ...TRIM_FUNCTIONS.map(name=>[name,'str-trim']),
]);

/** `타입::이름` 경로 → 규칙. std::cmp::max, usize::max, JsString::trim 같은 다른 경로는 허용한다 */
const PATH_RULES=new Map([
 ...['f64','f32'].flatMap(type=>[...METHOD_RULES].filter(([,rule])=>rule!=='str-trim').map(([name,rule])=>[`${type}::${name}`,rule])),
 ...TRIM_FUNCTIONS.map(name=>[`str::${name}`,'str-trim']),
]);

/** serde 계열 식별자(serde, serde_json, serde_derive 등) */
const SERDE_IDENTIFIER=/^serde(?:_\w+)?$/;

/** 지정 위치에서만 맞추는(y 플래그) 토큰 정규식들 */
const WHITESPACE=/\s+/y,LINE_COMMENT=/\/\/[^\n]*/y,DOTS=/\.\.[.=]?/y,NUMBER=/[0-9][0-9A-Za-z_]*/y;
/** 원시 문자열 시작(r"…", r#"…"#, br"…", cr#"…"#): 1번 그룹이 닫는 쪽에 필요한 # */
const RAW_STRING=/[bc]?r(#*)"/y;
/** 일반·바이트·C 문자열 시작 */
const QUOTED_STRING=/[bc]?"/y;
/** 식별자(원시 식별자 r#name 포함) */
const IDENTIFIER=/(?:r#)?[\p{XID_Start}_]\p{XID_Continue}*/uy;

/** 형식 자리의 인자·너비·정밀도에 오는 이름이나 정수 */
const FORMAT_NAME='(?:[0-9]+|[\\p{XID_Start}_]\\p{XID_Continue}*)';
/** std::fmt 형식 자리 하나: {인자:[[채움]정렬][부호][#][0][너비][.정밀도][형식]} */
const PLACEHOLDER=new RegExp(
 `\\{(?<argument>${FORMAT_NAME})?`+
 `(?::(?:(?<fill>[^])?(?<align>[<^>]))?(?<sign>[+-])?(?<alternate>#)?(?<zero>0(?!\\$))?`+
 `(?<width>${FORMAT_NAME}\\$|[0-9]+)?(?:\\.(?<precision>\\*|${FORMAT_NAME}\\$|[0-9]+))?`+
 `(?<type>\\?|x\\?|X\\?|[\\p{XID_Start}_]\\p{XID_Continue}*)?)?\\s*\\}`,'uy');
/** 커널의 정확한 자릿수 형식({:.766e})에 없어야 하는 형식 자리 구성요소 */
const EXACT_DIGITS_ABSENT=['fill','align','sign','alternate','zero','width'];

/** 여는·닫는 괄호(매크로 호출 범위를 잴 때 쓴다) */
const OPENERS=new Set(['(','[','{']),CLOSERS=new Set([')',']','}']);

/** TOML 문자열과 주석. 문자열 안의 #은 주석이 아니다 */
const TOML_LEXEME=/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|#[^\n]*/g;
/** 다른 이름의 일부가 아닌 serde 계열 이름(serde, serde_json, serde-big-array 등) */
const MANIFEST_SERDE=/(?<![\w-])serde/g;

/**
 * 정규식을 지정 위치에서만 맞춘다.
 * @param {RegExp} pattern y 플래그 정규식
 * @param {string} text 대상 텍스트
 * @param {number} at 시작 위치
 * @returns {RegExpExecArray|null} 맞으면 결과
 */
function matchAt(pattern,text,at){
 pattern.lastIndex=at;
 return pattern.exec(text);
}

/**
 * 중첩을 허용하는 블록 주석의 끝을 찾는다(Rust의 블록 주석은 중첩된다).
 * @param {string} source 러스트 소스
 * @param {number} at `/*` 위치
 * @returns {number} 주석 바로 뒤 위치(닫히지 않으면 소스 끝)
 */
function blockCommentEnd(source,at){
 let depth=0;
 for(let index=at;index<source.length;index++){
  if(source.startsWith('/*',index)){depth++;index++;}
  else if(source.startsWith('*/',index)){depth--;index++;if(!depth)return index+1;}
 }
 return source.length;
}

/**
 * 공백과 주석을 읽는다.
 * @param {string} source 러스트 소스
 * @param {number} at 시작 위치
 * @returns {{kind: 'trivia', start: number, end: number}|null} 공백·주석이 아니면 null
 */
function readTrivia(source,at){
 if(source.startsWith('/*',at))return {kind:'trivia',start:at,end:blockCommentEnd(source,at)};
 const match=matchAt(WHITESPACE,source,at)??matchAt(LINE_COMMENT,source,at);
 return match&&{kind:'trivia',start:at,end:at+match[0].length};
}

/**
 * 백슬래시 이스케이프를 건너뛰며 일반 문자열의 닫는 따옴표를 찾는다.
 * @param {string} source 러스트 소스
 * @param {number} contentStart 여는 따옴표 바로 뒤
 * @returns {number} 닫는 따옴표 위치(닫히지 않으면 -1)
 */
function quotedEnd(source,contentStart){
 for(let index=contentStart;index<source.length;index++){
  if(source[index]==='\\')index++;
  else if(source[index]==='"')return index;
 }
 return -1;
}

/**
 * 문자열 토큰을 만든다. 형식 자리의 위치를 소스 위치로 되돌릴 수 있게 내용은 이스케이프를 풀지 않은 원문이다.
 * @param {string} source 러스트 소스
 * @param {number} start 접두어를 포함한 시작 위치
 * @param {number} contentStart 내용 시작 위치
 * @param {number} close 닫는 따옴표 위치(-1이면 닫히지 않음)
 * @param {number} hashes 닫는 따옴표 뒤의 # 개수(원시 문자열)
 * @returns {{kind: 'string', start: number, end: number, contentStart: number, content: string, isText: boolean}}
 *   문자열 토큰. isText는 str 리터럴(일반·원시)이면 true다. 바이트(b)·C(c) 문자열은 형식 문자열이 될 수 없다
 */
function stringToken(source,start,contentStart,close,hashes){
 const contentEnd=close<0?source.length:close,isText=source[start]!=='b'&&source[start]!=='c';
 return {kind:'string',start,end:close<0?source.length:close+1+hashes,contentStart,content:source.slice(contentStart,contentEnd),isText};
}

/**
 * 작은따옴표로 시작하는 문자 리터럴이나 라이프타임(레이블)을 읽는다.
 * @param {string} source 러스트 소스
 * @param {number} quoteAt 작은따옴표 위치
 * @param {number} start 토큰 시작 위치(바이트 문자면 b의 위치)
 * @returns {{kind: 'char'|'lifetime', start: number, end: number}} 토큰
 */
function readQuote(source,quoteAt,start){
 if(source[quoteAt+1]==='\\'){
  const close=source.indexOf('\'',quoteAt+3);
  return {kind:'char',start,end:close<0?source.length:close+1};
 }
 const width=(source.codePointAt(quoteAt+1)??0)>0xffff?2:1;
 if(source[quoteAt+1+width]==='\'')return {kind:'char',start,end:quoteAt+2+width};
 const label=matchAt(IDENTIFIER,source,quoteAt+1);
 return {kind:'lifetime',start,end:quoteAt+1+(label?label[0].length:0)};
}

/**
 * 문자열·문자 리터럴과 라이프타임을 읽는다.
 * @param {string} source 러스트 소스
 * @param {number} at 시작 위치
 * @returns {object|null} 리터럴 토큰, 리터럴이 아니면 null
 */
function readLiteral(source,at){
 const raw=matchAt(RAW_STRING,source,at);
 if(raw)return stringToken(source,at,at+raw[0].length,source.indexOf('"'+raw[1],at+raw[0].length),raw[1].length);
 const quoted=matchAt(QUOTED_STRING,source,at);
 if(quoted)return stringToken(source,at,at+quoted[0].length,quotedEnd(source,at+quoted[0].length),0);
 if(source[at]==='\'')return readQuote(source,at,at);
 return source.startsWith('b\'',at)?readQuote(source,at+1,at):null;
}

/**
 * 식별자나 숫자를 읽는다. 원시 식별자 r#name은 name으로 적는다.
 * @param {string} source 러스트 소스
 * @param {number} at 시작 위치
 * @returns {{kind: 'ident'|'number', start: number, end: number, text: string}|null} 토큰
 */
function readWord(source,at){
 const identifier=matchAt(IDENTIFIER,source,at);
 if(identifier)return {kind:'ident',start:at,end:at+identifier[0].length,text:identifier[0].replace(/^r#/,'')};
 const number=matchAt(NUMBER,source,at);
 return number&&{kind:'number',start:at,end:at+number[0].length,text:number[0]};
}

/**
 * 문장부호 하나를 읽는다. 범위 연산자(.., ..., ..=)는 한 토큰이라 메서드 호출의 점과 구분된다.
 * @param {string} source 러스트 소스
 * @param {number} at 시작 위치
 * @returns {{kind: 'punct', start: number, end: number, text: string}} 토큰
 */
function readPunct(source,at){
 const dots=matchAt(DOTS,source,at);
 const text=dots?dots[0]:String.fromCodePoint(source.codePointAt(at));
 return {kind:'punct',start:at,end:at+text.length,text};
}

/**
 * 러스트 소스를 토큰으로 나눈다. 공백과 주석은 버린다.
 * @param {string} source 러스트 소스
 * @returns {object[]} 토큰 목록(소스 순서)
 */
function tokenize(source){
 const tokens=[];
 for(let at=0;at<source.length;){
  const token=readTrivia(source,at)??readLiteral(source,at)??readWord(source,at)??readPunct(source,at);
  if(token.kind!=='trivia')tokens.push(token);
  at=token.end;
 }
 return tokens;
}

/**
 * 토큰이 주어진 문장부호인지 본다.
 * @param {object|undefined} token 토큰
 * @param {string} text 문장부호
 * @returns {boolean} 같으면 true
 */
const isPunct=(token,text)=>token?.kind==='punct'&&token.text===text;

/**
 * 토큰이 식별자인지 본다.
 * @param {object|undefined} token 토큰
 * @returns {boolean} 식별자면 true
 */
const isIdent=token=>token?.kind==='ident';

/**
 * `.이름(` 메서드 호출에 걸리는 규칙을 찾는다. 위치는 점이다.
 * @param {object[]} tokens 토큰 목록
 * @param {number} index 살펴볼 위치
 * @returns {string|null} 규칙 이름
 */
function methodRule(tokens,index){
 const [dot,name,open,next]=tokens.slice(index,index+4);
 if(!isPunct(dot,'.')||!isIdent(name)||!isPunct(open,'('))return null;
 const rule=METHOD_RULES.get(name.text)??null;
 return rule==='float-min-max'&&isPunct(next,')')?null:rule;
}

/**
 * `f64::max` 같은 경로에 걸리는 규칙을 찾는다. 위치는 타입 이름이다.
 * @param {object[]} tokens 토큰 목록
 * @param {number} index 살펴볼 위치
 * @returns {string|null} 규칙 이름
 */
function pathRule(tokens,index){
 const [type,first,second,name]=tokens.slice(index,index+4);
 if(!isIdent(type)||!isPunct(first,':')||!isPunct(second,':')||!isIdent(name))return null;
 return PATH_RULES.get(`${type.text}::${name.text}`)??null;
}

/**
 * 이름만으로 정해지는 규칙(mul_add, serde 계열)을 찾는다.
 * @param {object} token 토큰
 * @returns {string|null} 규칙 이름
 */
function identifierRule(token){
 if(!isIdent(token))return null;
 if(token.text==='mul_add')return 'mul-add';
 return SERDE_IDENTIFIER.test(token.text)?'serde':null;
}

/**
 * 코드 토큰에서 메서드·경로·이름 규칙 위반을 찾는다.
 * @param {object[]} tokens 토큰 목록
 * @returns {Generator<{rule: string, offset: number}>} 위반과 소스 위치
 */
function* codeHits(tokens){
 for(let index=0;index<tokens.length;index++){
  const rule=methodRule(tokens,index)??pathRule(tokens,index)??identifierRule(tokens[index]);
  if(rule)yield {rule,offset:tokens[index].start};
 }
}

/**
 * 여는 괄호가 매크로 호출을 시작하는지 본다. 이름과 !가 붙어 있어야 한다(`if !(…)`의 부정은 매크로가 아니다).
 * @param {object[]} tokens 토큰 목록
 * @param {number} index 여는 괄호 위치
 * @returns {boolean} `이름!(`, `이름![`, `이름!{`이면 true
 */
function opensMacro(tokens,index){
 const bang=tokens[index-1],name=tokens[index-2];
 return isPunct(bang,'!')&&isIdent(name)&&name.end===bang.start;
}

/**
 * 매크로 호출 안에 있는 str 리터럴만 고른다. 형식 문자열은 매크로 인자로 쓰는 str 리터럴뿐이기 때문이다.
 * @param {object[]} tokens 토큰 목록
 * @returns {Generator<object>} 문자열 토큰
 */
function* macroStrings(tokens){
 const macroDepths=[];
 let depth=0;
 for(const [index,token] of tokens.entries()){
  if(token.kind==='string'){if(token.isText&&macroDepths.length)yield token;}
  else if(token.kind==='punct'&&OPENERS.has(token.text)){depth++;if(opensMacro(tokens,index))macroDepths.push(depth);}
  else if(token.kind==='punct'&&CLOSERS.has(token.text)){if(macroDepths.at(-1)===depth)macroDepths.pop();depth--;}
 }
}

/**
 * 문자열 내용에서 형식 자리를 찾는다. `{{`는 이스케이프한 중괄호라 건너뛴다.
 * @param {string} content 문자열 원문 내용
 * @returns {Generator<{index: number, groups: Record<string, string|undefined>}>} 내용 안 위치와 구성요소
 */
function* formatPlaceholders(content){
 for(let index=content.indexOf('{');index>=0;index=content.indexOf('{',index+1)){
  if(content[index+1]==='{'){index++;continue;}
  const match=matchAt(PLACEHOLDER,content,index);
  if(match)yield {index,groups:match.groups};
 }
}

/**
 * 형식 자리가 금지 형식인지 판정한다. 정밀도가 있거나 지수 형식(e, E)이면 금지다.
 * @param {Record<string, string|undefined>} groups 형식 자리 구성요소
 * @param {string} profile 규칙 묶음 이름
 * @returns {boolean} 금지면 true(커널의 {:.766e}는 허용)
 */
function isBannedFormat(groups,profile){
 if(groups.precision===undefined&&groups.type!=='e'&&groups.type!=='E')return false;
 const isExactDigits=groups.precision==='766'&&groups.type==='e'&&EXACT_DIGITS_ABSENT.every(name=>groups[name]===undefined);
 return !(profile==='kernel'&&isExactDigits);
}

/**
 * 매크로 안 문자열의 금지 형식 자리를 찾는다. 위치는 형식 자리의 여는 중괄호다.
 * @param {object[]} tokens 토큰 목록
 * @param {string} profile 규칙 묶음 이름
 * @returns {Generator<{rule: string, offset: number}>} 위반과 소스 위치
 */
function* formatHits(tokens,profile){
 for(const token of macroStrings(tokens))
  for(const {index,groups} of formatPlaceholders(token.content))
   if(isBannedFormat(groups,profile))yield {rule:'float-format',offset:token.contentStart+index};
}

/**
 * 소스 위치를 1부터 세는 줄·열로 바꾼다. 열은 rustc처럼 코드 포인트로 센다.
 * @param {string} text 소스
 * @param {number} offset UTF-16 위치
 * @returns {{line: number, column: number}} 줄과 열
 */
function positionOf(text,offset){
 const before=text.slice(0,offset),lineStart=before.lastIndexOf('\n')+1;
 return {line:before.split('\n').length,column:[...before.slice(lineStart)].length+1};
}

/**
 * 규칙 묶음 이름을 규칙 집합으로 바꾼다.
 * @param {string} profile 규칙 묶음 이름(ported 또는 kernel)
 * @returns {Set<string>} 적용 규칙
 * @throws {TypeError} 모르는 묶음 이름일 때
 */
function rulesOf(profile){
 const rules=PROFILE_RULES.get(profile);
 if(!rules)throw new TypeError(`Unknown check-bans profile "${profile}"; use "ported" or "kernel"`);
 return rules;
}

/**
 * 러스트 소스에서 금지 패턴을 찾는다.
 * @param {string} source 러스트 소스
 * @param {'ported'|'kernel'} profile 규칙 묶음. ported는 이식 코드, kernel은 JS 의미 커널
 * @returns {{rule: string, line: number, column: number}[]} 위반 목록(소스 순서)
 * @throws {TypeError} 모르는 묶음 이름일 때
 */
export function findBans(source,profile){
 const rules=rulesOf(profile),tokens=tokenize(source);
 const hits=[...codeHits(tokens),...formatHits(tokens,profile)].filter(hit=>rules.has(hit.rule));
 return hits.sort((a,b)=>a.offset-b.offset).map(hit=>({rule:hit.rule,...positionOf(source,hit.offset)}));
}

/**
 * Cargo.toml에서 serde 의존성과 기능을 찾는다. 주석은 무시하고, 문자열(기능 이름 등)은 읽는다.
 * @param {string} text Cargo.toml 내용
 * @returns {{rule: string, line: number, column: number}[]} 위반 목록
 */
export function findManifestBans(text){
 const code=text.replace(TOML_LEXEME,lexeme=>lexeme.startsWith('#')?' '.repeat(lexeme.length):lexeme);
 return [...code.matchAll(MANIFEST_SERDE)].map(match=>({rule:'serde',...positionOf(text,match.index)}));
}

/**
 * 디렉터리 항목을 이름순으로 읽는다.
 * @param {string} directory 디렉터리
 * @returns {Promise<import('node:fs').Dirent[]|null>} 항목, 디렉터리가 없으면 null
 * @throws {Error} 권한 등 다른 이유로 읽지 못할 때
 */
async function readEntries(directory){
 try{
  return (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
 }catch(error){
  if(error.code==='ENOENT'||error.code==='ENOTDIR')return null;
  throw error;
 }
}

/**
 * 크레이트 디렉터리의 검사 대상(.rs, Cargo.toml)을 모은다. 빌드 산출물(target)과 숨김 디렉터리는 건너뛴다.
 * @param {string} directory 크레이트 디렉터리
 * @returns {Promise<string[]|null>} 파일 경로 목록, 크레이트가 없으면 null
 */
async function crateFiles(directory){
 const entries=await readEntries(directory);
 if(!entries)return null;
 const files=[];
 for(const entry of entries){
  const path=join(directory,entry.name);
  if(entry.isDirectory()&&entry.name!=='target'&&!entry.name.startsWith('.'))files.push(...(await crateFiles(path))??[]);
  else if(entry.isFile()&&(entry.name.endsWith('.rs')||entry.name==='Cargo.toml'))files.push(path);
 }
 return files;
}

/**
 * 파일 하나를 검사한다.
 * @param {string} root 워크스페이스 루트
 * @param {string} path 파일 경로
 * @param {string} profile 규칙 묶음 이름
 * @returns {Promise<{file: string, rule: string, line: number, column: number}[]>} 위반 목록(경로는 루트 기준, / 구분)
 */
async function scanFile(root,path,profile){
 const text=await readFile(path,'utf8'),file=relative(root,path).split(sep).join('/');
 const findings=path.endsWith('.rs')?findBans(text,profile):findManifestBans(text).filter(finding=>rulesOf(profile).has(finding.rule));
 return findings.map(finding=>({file,...finding}));
}

/**
 * 워크스페이스의 검사 대상 크레이트를 모두 검사한다.
 * @param {string} root Rust 워크스페이스 루트(crates/가 있는 곳)
 * @returns {Promise<{crates: {name: string, profile: string, files: number|null}[], findings: object[]}>}
 *   크레이트별 파일 수(없는 크레이트는 null)와 위반 목록
 */
export async function scanWorkspace(root){
 const crates=[],findings=[];
 for(const [name,profile] of Object.entries(CRATE_PROFILES)){
  const files=await crateFiles(join(root,'crates',name));
  crates.push({name,profile,files:files?files.length:null});
  for(const path of files??[])findings.push(...await scanFile(root,path,profile));
 }
 return {crates,findings};
}

/**
 * CLI 인자에서 검사 루트를 읽는다.
 * @param {string[]} args CLI 인자
 * @returns {string|null} 절대 경로, 인자가 잘못되면 null
 */
function parseRoot(args){
 if(!args.length)return DEFAULT_ROOT;
 if(args.length===2&&args[0]==='--root')return resolve(args[1]);
 return args.length===1&&args[0].startsWith('--root=')?resolve(args[0].slice('--root='.length)):null;
}

/**
 * 크레이트 검사 요약 한 조각을 만든다.
 * @param {{name: string, profile: string, files: number|null}} crate 크레이트 요약
 * @returns {string} 예: `barochart-js 2 files (kernel)`, `barochart-core absent`
 */
function describeCrate({name,profile,files}){
 return files===null?`${name} absent`:`${name} ${files} file${files===1?'':'s'} (${profile})`;
}

/**
 * CLI 본체. 요약은 stdout, 위반과 오류는 stderr에 쓴다.
 * @param {string[]} args CLI 인자
 * @returns {Promise<number>} 종료 코드: 0 통과, 1 위반, 2 인자 오류 또는 검사할 크레이트 없음
 */
async function main(args){
 const root=parseRoot(args);
 if(!root){console.error(USAGE);return 2;}
 const {crates,findings}=await scanWorkspace(root);
 console.log(`check-bans: ${crates.map(describeCrate).join(', ')}`);
 if(crates.every(crate=>!crate.files)){console.error(`check-bans: no Rust files in ${Object.keys(CRATE_PROFILES).join(', ')} under ${join(root,'crates')}; pass --root <Rust workspace directory>`);return 2;}
 for(const finding of findings)console.error(`${finding.file}:${finding.line}:${finding.column} ${finding.rule}: ${RULES[finding.rule]}`);
 if(findings.length)console.error(`check-bans: ${findings.length} banned pattern${findings.length===1?'':'s'}; see docs/superpowers/specs/2026-11-02-rust-core-design.md §6.4`);
 return findings.length?1:0;
}

// CLI: node scripts/rust/check-bans.mjs [--root <dir>]. exitCode를 써서 파이프로 나가는 출력이 잘리지 않게 한다.
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 try{process.exitCode=await main(process.argv.slice(2));}
 catch(error){console.error(`check-bans: could not scan the Rust workspace: ${error.message}`);process.exitCode=2;}
}
