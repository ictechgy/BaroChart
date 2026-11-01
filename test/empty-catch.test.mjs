// 오류를 무시하는 빈 catch(주석만 있는 경우 포함)를 네이티브 SDK 소스에서 금지한다(설계 §5.3)
import test from 'node:test';
import assert from 'node:assert/strict';
import {findEmptyCatches,scanNativeSources} from '../scripts/check-empty-catch.mjs';

test('empty and comment-only catch blocks are detected in Java, Swift and JavaScript',()=>{
 assert.equal(findEmptyCatches('try{a();}catch(Exception e){}').length,1);
 assert.equal(findEmptyCatches('do { try f() } catch {}').length,1);
 assert.equal(findEmptyCatches('do { try f() } catch let error {}').length,1);
 assert.equal(findEmptyCatches('try{a()}catch(e){ /* reason */ }').length,1);
 assert.equal(findEmptyCatches('try{a()}catch(e){ // reason\n }').length,1);
});

test('catch blocks that log, rethrow or record are allowed',()=>{
 assert.equal(findEmptyCatches('try{a();}catch(Exception e){log(e);}').length,0);
 assert.equal(findEmptyCatches('do { try f() } catch { throw error }').length,0);
 assert.equal(findEmptyCatches('try{a()}catch(e){failures.push(e);}').length,0);
});

test('findings report the line of each empty catch',()=>{
 assert.deepEqual(findEmptyCatches('a();\nb();\ntry{c();}catch(Exception e){}').map(f=>f.line),[3]);
});

test('native SDK sources contain no empty catch blocks',async()=>{
 assert.deepEqual(await scanNativeSources(),[]);
});
