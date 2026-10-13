import test from 'node:test';
import assert from 'node:assert/strict';
import {alignSeriesByTime} from '../src/core/markets.mjs';
test('alignment validates and joins the same once-read reference timestamp snapshot', () => {
  let reads=0;const reference=[1,2];
  Object.defineProperty(reference,0,{get(){reads++;return reads===1?1:2;}});
  assert.deepEqual(Array.from(alignSeriesByTime(reference,[{time:1,value:10},{time:2,value:20}])),[10,20]);
  assert.equal(reads,1);
});
