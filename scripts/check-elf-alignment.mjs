// SDK가 싣는 Android .so의 PT_LOAD 세그먼트 정렬을 검사한다.
// Android 15+ 16 KiB 페이지 기기는 정렬이 16 KiB 미만인 라이브러리를 로드하지 못한다.
// 외부 도구(readelf 등) 없이 ELF64 program header를 직접 읽어 CI·로컬 어디서나 같은 판정을 낸다.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

/** 요구 정렬 크기(16 KiB) */
export const REQUIRED_ALIGNMENT=16384;
const PT_LOAD=1;

/**
 * ELF64 little-endian 바이트에서 PT_LOAD 정렬을 읽고 판정한다.
 * @param {Uint8Array} bytes .so 파일 내용
 * @returns {{ok: boolean, segments: {align: number}[]}} 모든 PT_LOAD가 16 KiB 이상이면 ok
 * @throws {TypeError} ELF64 little-endian이 아니거나 program header가 파일 밖을 가리킬 때
 */
export function checkElfAlignment(bytes){
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 const isElf64LE=bytes.length>=64&&bytes[0]===0x7f&&bytes[1]===0x45&&bytes[2]===0x4c&&bytes[3]===0x46&&bytes[4]===2&&bytes[5]===1;
 if(!isElf64LE)throw new TypeError('Not an ELF64 little-endian file; pass a shared library built for arm64-v8a or x86_64');
 const phoff=Number(view.getBigUint64(0x20,true)),phentsize=view.getUint16(0x36,true),phnum=view.getUint16(0x38,true);
 if(phentsize<56||phoff+phentsize*phnum>bytes.length)throw new TypeError('ELF program header table is outside the file; the library may be truncated');
 const segments=[];
 for(let i=0;i<phnum;i++){const at=phoff+i*phentsize;if(view.getUint32(at,true)===PT_LOAD)segments.push({align:Number(view.getBigUint64(at+48,true))});}
 return {ok:segments.length>0&&segments.every(s=>s.align>=REQUIRED_ALIGNMENT),segments};
}

// CLI: node scripts/check-elf-alignment.mjs <lib.so>... → JSON 판정, 하나라도 실패하면 exit 1
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const results=process.argv.slice(2).map(path=>({path,...checkElfAlignment(readFileSync(path))}));
 console.log(JSON.stringify(results,null,1));
 if(!results.length||results.some(r=>!r.ok))process.exit(1);
}
