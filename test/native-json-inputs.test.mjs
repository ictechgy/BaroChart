import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const swift=readFileSync(new URL('../native/AsterNative.swift',import.meta.url),'utf8');

function method(source,marker){
 const start=source.indexOf(marker);assert.ok(start>=0,marker);
 const begin=source.indexOf('{',start);let depth=1,i=begin+1;
 for(;depth&&i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}')depth--;}
 assert.equal(depth,0);return source.slice(begin+1,i-1);
}

for(const [name,marker,object,message] of [
 ['params','public func setIndicatorParamsAsync(','params','Params request must be valid JSON'],
 ['workspace','public func restoreWorkspaceAsync(','datasetBinding','Workspace binding must be valid JSON'],
 ['event','public func applyDataEventAsync(','event','Data event must be valid JSON']
])test(`Swift ${name} async input rejects non-JSON values before serialization`,()=>{
 const body=method(swift,marker),guardText=`JSONSerialization.isValidJSONObject(${object})`;
 const guardAt=body.indexOf(guardText),serializeAt=body.indexOf('JSONSerialization.data(withJSONObject:');
 assert.ok(guardAt>=0,guardText);assert.ok(serializeAt>guardAt,`${name} guard must precede serialization`);
 assert.match(body,new RegExp(`AsterAsyncError\\.invalidProtocol\\("${message}"\\)`));
});

test('Swift JSON input probe covers all public async APIs and required invalid cases',()=>{
 const probe=readFileSync(new URL('../examples/native/json-input-verification.swift',import.meta.url),'utf8');
 for(const text of ['Double.nan','Double.infinity','-Double.infinity','Date(timeIntervalSince1970: 0)','UnsupportedJSONValue()','Int64(4294967296)','UInt64(9007199254740991)','NSNumber(value: 1.25)'])assert.match(probe,new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),text);
 for(const text of ['setIndicatorParamsAsync','restoreWorkspaceAsync','applyDataEventAsync'])assert.match(probe,new RegExp(`engine\\.${text}`),text);
});
