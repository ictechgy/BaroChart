import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDemoServer} from '../scripts/serve.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
async function fixture(t){
 const publicRoot=join(root,'src/web/wasm');await mkdir(publicRoot,{recursive:true});
 const directory=await mkdtemp(join(publicRoot,'serve-test-'));
 const server=createDemoServer();await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
 t.after(async()=>{await new Promise((yes,no)=>server.close(error=>error?no(error):yes()));await rm(directory,{recursive:true,force:true});});
 const asset=join(directory,'minimal.wasm'),bytes=Uint8Array.of(0,97,115,109,1,0,0,0);await writeFile(asset,bytes);
 return {directory,bytes,origin:`http://127.0.0.1:${server.address().port}`,path:'/'+relative(root,asset).split('\\').join('/')};
}

test('public WASM asset has streaming MIME and narrow compile permission with JS eval still disabled',async t=>{
 const f=await fixture(t),response=await fetch(f.origin+f.path);
 assert.equal(response.status,200);
 assert.equal(response.headers.get('content-type'),'application/wasm');
 assert.deepEqual(new Uint8Array(await response.arrayBuffer()),f.bytes);
 const policy=response.headers.get('content-security-policy');
 const scriptSources=policy.match(/(?:^|;)\s*script-src\s+([^;]+)/)?.[1].split(/\s+/);
 assert.ok(scriptSources?.includes("'self'"));
 assert.ok(scriptSources.includes("'wasm-unsafe-eval'"));
 assert.ok(!scriptSources.includes("'unsafe-eval'"));
 assert.match(policy,/object-src 'none'/);
 assert.match(policy,/base-uri 'none'/);
 assert.match(policy,/frame-ancestors 'none'/);
 const head=await fetch(f.origin+f.path,{method:'HEAD'});
 assert.equal(head.status,200);assert.equal(head.headers.get('content-type'),'application/wasm');assert.equal((await head.arrayBuffer()).byteLength,0);
});

test('WASM serving retains method, private-path and realpath escape protection',async t=>{
 const f=await fixture(t),privateRoot=join(root,'artifacts/web-rust-wasm');await mkdir(privateRoot,{recursive:true});
 const outside=await mkdtemp(join(privateRoot,'private-serving-test-'));
 t.after(()=>rm(outside,{recursive:true,force:true}));
 const target=join(outside,'private.wasm');await writeFile(target,'private test payload');
 const escaped=join(f.directory,'escape.wasm');await symlink(resolve(target),escaped);
 const escapedPath='/'+relative(root,escaped).split('\\').join('/');
 assert.equal((await fetch(f.origin+escapedPath)).status,403);
 assert.equal((await fetch(f.origin+'/artifacts/web-rust-wasm/private.wasm')).status,403);
 assert.equal((await fetch(f.origin+'/src/web/wasm/.private.wasm')).status,403);
 assert.equal((await fetch(f.origin+f.path,{method:'POST'})).status,405);
});
