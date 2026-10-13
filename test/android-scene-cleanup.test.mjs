import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmOwnedPackageAbsent} from '../scripts/android-scene-cleanup.mjs';

const pkg='dev.aster.charts.packet.pressure';
const response=stdout=>({status:0,error:null,signal:null,stdout,stderr:''});
test('successful inventory confirms no owned app process',()=>{
 const result=confirmOwnedPackageAbsent(response('  PID NAME\n1 init\n125 dev.aster.other\n'),pkg);
 assert.equal(result.status,0);assert.equal(result.error,null);
});
test('own main process invalidates successful ps exit',()=>{
 const result=confirmOwnedPackageAbsent(response(`PID NAME\n125 ${pkg}\n`),pkg);
 assert.equal(result.status,0);assert.match(String(result.error),/Owned package process remains/);
});
test('own colon subprocess invalidates successful ps exit',()=>{
 assert.match(String(confirmOwnedPackageAbsent(response(`PID NAME\n125 ${pkg}:worker\n`),pkg).error),/Owned package process remains/);
});
test('unrelated similar prefix remains outside cleanup ownership',()=>{
 assert.equal(confirmOwnedPackageAbsent(response(`PID NAME\n125 ${pkg}extra\n`),pkg).error,null);
});
test('inventory needs recognizable PID NAME header',()=>{
 assert.match(String(confirmOwnedPackageAbsent(response('ps: unsupported option\n'),pkg).error),/inventory header/);
});
test('inventory rejects malformed row rather than claiming absence',()=>{
 assert.match(String(confirmOwnedPackageAbsent(response('PID NAME\n? unknown\n'),pkg).error),/inventory row/);
});
test('nonzero, missing status, execution error and signal remain failures',()=>{
 for(const fault of [{status:1},{status:null},{error:new Error('transport closed')},{signal:'SIGTERM'}]){
  const result=confirmOwnedPackageAbsent({...response('PID NAME\n'),...fault},pkg);
  assert(result.status!==0||result.error!==null||result.signal!==null);
 }
});
test('full inventory bytes remain available as cleanup evidence',()=>{
 const original=response('PID NAME\n1 init\n');
 assert.equal(confirmOwnedPackageAbsent(original,pkg).stdout,original.stdout);
});
