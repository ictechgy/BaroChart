import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {previewScene,PREVIEW_SIZE,PREVIEW_SOURCE} from '../scripts/readme-previews.mjs';
import {createChartUIPreset} from '../src/renderers/canvas.mjs';

const root=resolve(import.meta.dirname,'..');
const read=path=>readFile(resolve(root,path),'utf8');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

test('mobile preview manifest separates illustrations from actual browser/native captures',async()=>{
  const manifest=JSON.parse(await read('assets/previews/manifest.json'));
  assert.equal(manifest.schema,'barochart.documentation-previews');
  assert.equal(manifest.version,1);assert.equal(manifest.sourceCommit,PREVIEW_SOURCE);
  assert.equal(manifest.browserScreenshot,false);assert.equal(manifest.nativeSDKExecution,false);
  assert.match(manifest.chrome,/Schematic/);assert.match(manifest.limitations,/No browser\/device/);
  assert.deepEqual(manifest.size,PREVIEW_SIZE);
  const current=createChartUIPreset('mobile'),{labels,...toolbar}=current.toolbar;
  assert.deepEqual(labels,{}); // Empty caption overrides do not change the archived controls.
  assert.deepEqual(manifest.mobilePreset,{...current,toolbar});
  assert.deepEqual(manifest.images.map(image=>image.theme),['dark','light']);
});

test('archived mobile preview provenance and images stay intact; current chart scene still matches',async t=>{
  const manifestText=await read('assets/previews/manifest.json'),manifest=JSON.parse(manifestText);
  // This archive describes PREVIEW_SOURCE, not the evolving working tree.
  assert.equal(hash(manifestText),'5590981483a6cd26b075494b9446caaadc796482fa441709be7480b2769572ed');
  const sourceAvailable=spawnSync('git',['cat-file','-e',`${PREVIEW_SOURCE}^{commit}`],{cwd:root,stdio:'ignore'}).status===0;
  if(!sourceAvailable)t.diagnostic('Archived source commit unavailable in this checkout; provenance digest, PNG bytes and current scene verified, historical source bytes not reverified.');
  assert.equal(manifest.sources.length,8);
  for(const source of manifest.sources){
    assert(!source.path.startsWith('/')&&!source.path.includes('..'));
    assert.match(source.sha256,/^[0-9a-f]{64}$/);
    await access(resolve(root,source.path));
    if(sourceAvailable){
      const archived=spawnSync('git',['show',`${PREVIEW_SOURCE}:${source.path}`],{cwd:root,maxBuffer:4*1024*1024});
      assert.equal(archived.status,0,source.path);
      assert.equal(hash(archived.stdout),source.sha256,source.path);
    }
  }
  for(const image of manifest.images){
    const bytes=await readFile(resolve(root,'assets/previews',image.file));
    assert.equal(bytes.length,image.bytes);assert.equal(hash(bytes),image.sha256);
    assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16),780);assert.equal(bytes.readUInt32BE(20),1792);
    assert.equal(image.logicalWidth,390);assert.equal(image.logicalHeight,896);
    let offset=8;while(offset<bytes.length){
      const size=bytes.readUInt32BE(offset),kind=bytes.toString('ascii',offset+4,offset+8);
      assert(['IHDR','IDAT','IEND','sRGB','sBIT'].includes(kind),'No text, EXIF or private metadata');
      offset+=size+12;
    }
    assert.equal(offset,bytes.length);
    const scene=previewScene(image.theme);
    assert.equal(hash(JSON.stringify(scene)),image.sceneSha256);
    assert.deepEqual(scene.stats,image.stats);
    assert.equal(scene.stats.storedBars,512);assert.equal(scene.stats.visibleSourceBars,69);
    assert.equal(scene.width,366);assert.equal(scene.height,460);
  }
  assert.throws(()=>previewScene('unknown'),TypeError);
});

test('both READMEs embed and clearly distinguish mobile previews from historical web screenshots',async()=>{
  for(const file of ['README.md','README.ko.md']){
    const text=await read(file);
    for(const theme of ['dark','light'])assert(text.includes(`src="assets/previews/mobile-web-${theme}-preview.png" width="390"`));
    assert(text.includes('01e4e1a')||text.includes('docs/EXAMPLE-SCREENSHOTS.md'));
    assert(text.includes('2026-10-14')&&text.includes('e3284e54'));
    assert.match(text,/Not browser screenshots|브라우저 스크린샷이나 네이티브 화면/);
    assert.match(text,/No automatic persistence|자동 저장은 없으며/);
    assert.match(text,/not shortcut remapping|단축키 재매핑이 아닙니다/);
    assert.match(text,/not a browser screenshot|실제 브라우저 캡처 아님/);
  }
});

test('new gallery links, assets and public documentation contain no private paths or account metadata',async()=>{
  for(const file of ['README.md','README.ko.md','docs/EXAMPLE-SCREENSHOTS.md','assets/previews/manifest.json','scripts/readme-previews.mjs']){
    const text=await read(file);
    assert(!/\/Users\/|\/workspace\/|libfile_[0-9a-f]+|file_000000|https?:\/\/[^/\s]+@/i.test(text));
    if(file.endsWith('.md'))for(const match of text.matchAll(/(?:\]\(|src=")([^)"]+)[)"]/g)){
      const path=match[1];if(!/^https?:|^#/.test(path))await access(resolve(root,dirname(file),path.split('#')[0]));
    }
  }
  const generator=await read('scripts/readme-previews.mjs');
  for(const label of ['not a browser screenshot','Not an iOS or Android native screen.','Touch / browser layout remain unverified.'])assert(generator.includes(label));
  const pkg=JSON.parse(await read('package.json'));
  assert(!pkg.files.includes('assets'));assert(!pkg.dependencies?.['@napi-rs/canvas']);
});
