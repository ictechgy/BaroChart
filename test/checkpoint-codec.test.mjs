import test from 'node:test';import assert from 'node:assert/strict';import {encodeCheckpoints,LazyCheckpoints} from '../src/web/checkpoint-codec.mjs';
test('compact checkpoints preserve NaN/Infinity, nested arrays and sparse Map mutation',()=>{
 const source=new Map([[0,{previous:NaN,n:[Infinity,-Infinity,0,null]}],[256,{previous:1,n:[2,3]}]]),lazy=new LazyCheckpoints(encodeCheckpoints(source));assert.equal(lazy.cache.size,0);assert.deepEqual(lazy.get(0),source.get(0));assert.deepEqual(lazy.get(256),source.get(256));lazy.set(512,{n:[4]});assert.equal(lazy.size,3);lazy.delete(256);assert.equal(lazy.size,2);lazy.set(0,{previous:5});assert.equal(lazy.size,2);assert.deepEqual([...lazy.keys()],[0,512]);const reloaded=new LazyCheckpoints(encodeCheckpoints(lazy));assert.deepEqual(reloaded.get(0),{previous:5});reloaded.clear();assert.equal(reloaded.size,0);
});
test('checkpoint stream validation rejects malformed offsets before decoding',()=>{
 const p=encodeCheckpoints(new Map([[0,{x:1}]]));p.offsets[1]--;assert.throws(()=>new LazyCheckpoints(p));
});
