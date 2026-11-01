// Android 15+ 16 KiB 페이지 기기 호환: SDK .so의 모든 PT_LOAD 세그먼트 정렬이 16 KiB 이상인지 판정하는 검사기 테스트
import test from 'node:test';
import assert from 'node:assert/strict';
import {checkElfAlignment} from '../scripts/check-elf-alignment.mjs';

/** 지정한 PT_LOAD 정렬값들을 가진 최소 ELF64 little-endian 헤더를 만든다 */
function syntheticElf(aligns){
 const phoff=64,phentsize=56,bytes=new Uint8Array(phoff+phentsize*aligns.length),view=new DataView(bytes.buffer);
 bytes.set([0x7f,0x45,0x4c,0x46,2,1,1],0);
 view.setBigUint64(0x20,BigInt(phoff),true);view.setUint16(0x36,phentsize,true);view.setUint16(0x38,aligns.length,true);
 aligns.forEach((align,i)=>{const at=phoff+i*phentsize;view.setUint32(at,1,true);view.setBigUint64(at+48,BigInt(align),true);});
 return bytes;
}

test('16 KiB aligned load segments pass',()=>{
 const result=checkElfAlignment(syntheticElf([0x4000,0x4000]));
 assert.equal(result.ok,true);
 assert.deepEqual(result.segments.map(s=>s.align),[0x4000,0x4000]);
});

test('a 4 KiB aligned load segment fails',()=>{
 assert.equal(checkElfAlignment(syntheticElf([0x4000,0x1000])).ok,false);
});

test('non-ELF input is rejected with a reason',()=>{
 assert.throws(()=>checkElfAlignment(new Uint8Array(64)),/Not an ELF64 little-endian file/);
});
