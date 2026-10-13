import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url),text=p=>readFile(new URL(p,root),'utf8');
test('BaroChart local package and example agree without npm publication',async()=>{
 const pkg=JSON.parse(await text('package.json')),example=JSON.parse(await text('examples/react-web/package.json')),lock=JSON.parse(await text('examples/react-web/package-lock.json'));
 assert.equal(pkg.name,'barochart');assert.equal(pkg.license,'Apache-2.0');assert.equal(pkg.private,true);assert.equal(example.dependencies.barochart,'file:../..');assert.equal(lock.packages['../..'].name,'barochart');assert.equal(lock.packages['../..'].license,'Apache-2.0');assert.equal(Object.keys(pkg.dependencies??{}).length,0);
 for(const name of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md'])assert(pkg.files.includes(name));
 assert.match(await text('LICENSE'),/Apache License[\s\S]*Version 2\.0, January 2004/);assert.match(await text('NOTICE'),/BaroChart/);
});
test('legacy API and portable identifiers remain compatible',async()=>{
 assert.match(await text('src/react/index.mjs'),/export.*AsterChart/);
 assert.match(await text('Package.swift'),/AsterNative/);
 assert.match(await text('native/android/java/dev/aster/charts/AsterEngine.java'),/package dev\.aster\.charts/);
 assert.match(await text('src/core/workspace.mjs'),/aster\.workspace/);
});
