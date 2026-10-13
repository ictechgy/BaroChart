import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {auditAar} from '../../../scripts/build-android-library.mjs';

const aar=process.env.ASTER_AUDIT_AAR,core=process.env.ASTER_AUDIT_CORE;
if(!aar||!core)throw new Error('Set ASTER_AUDIT_AAR and ASTER_AUDIT_CORE to the selected built artifact');
const output=await mkdtemp(join(tmpdir(),'aster-aar-audit-'));
test('Complete production AAR exports resources, licenses, JNI and public API',()=>assert.equal(auditAar(aar,core).minSDK,26));
const components=['AndroidManifest.xml','classes.jar','assets/aster-core.js','jni/arm64-v8a/libaster.so','proguard.txt','public.txt','res/values/values.xml','assets/licenses/QUICKJS-LICENSE.txt','assets/licenses/LICENSE.txt','assets/licenses/NOTICE.txt'];
for(const [index,missing] of components.entries())test('Reject omitted '+missing,()=>{
    const file=join(output,`missing-${index}.aar`);
    const result=spawnSync('python3',['-c','import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1]) as source,zipfile.ZipFile(sys.argv[2],"w") as target:\n for name in source.namelist():\n  if name!=sys.argv[3]:target.writestr(name,source.read(name))',aar,file,missing],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.throws(()=>auditAar(file,core),/Missing AAR component/);
});
test('Reject missing public View class inside classes.jar',()=>{
    const file=join(output,'missing-view.aar');
    const result=spawnSync('python3',['-c','import zipfile,io,sys\nwith zipfile.ZipFile(sys.argv[1]) as source,zipfile.ZipFile(sys.argv[2],"w") as target:\n for name in source.namelist():\n  data=source.read(name)\n  if name=="classes.jar":\n   buffer=io.BytesIO()\n   with zipfile.ZipFile(io.BytesIO(data)) as classes,zipfile.ZipFile(buffer,"w") as changed:\n    for entry in classes.namelist():\n     if entry!="dev/aster/charts/AsterChartView.class":changed.writestr(entry,classes.read(entry))\n   data=buffer.getvalue()\n  target.writestr(name,data)',aar,file],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.throws(()=>auditAar(file,core),/Missing SDK class: AsterChartView/);
});
test('Reject a core asset that differs from the frozen source',()=>{
    const file=join(output,'wrong-core.aar');
    const result=spawnSync('python3',['-c','import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1]) as source,zipfile.ZipFile(sys.argv[2],"w") as target:\n for name in source.namelist():target.writestr(name,b"wrong core" if name=="assets/aster-core.js" else source.read(name))',aar,file],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.throws(()=>auditAar(file,core),/Bundled core differs/);
});
test('Reject JNI rules that omit Java timezone callback preservation',()=>{
    const file=join(output,'wrong-rules.aar');
    const result=spawnSync('python3',['-c','import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1]) as source,zipfile.ZipFile(sys.argv[2],"w") as target:\n for name in source.namelist():target.writestr(name,b"-keep class dev.aster.charts.AsterEngine { native <methods>; }\\n-keep class dev.aster.charts.AsterColumns { native <methods>; }" if name=="proguard.txt" else source.read(name))',aar,file],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.throws(()=>auditAar(file,core),/JNI consumer rules missing/);
});
test('Reject JNI rules that omit the Columns native class',()=>{
    const file=join(output,'wrong-column-rules.aar');
    const result=spawnSync('python3',['-c','import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1]) as source,zipfile.ZipFile(sys.argv[2],"w") as target:\n for name in source.namelist():target.writestr(name,b"-keep class dev.aster.charts.AsterEngine { native <methods>; public static java.lang.String zonedParts(long, java.lang.String); }" if name=="proguard.txt" else source.read(name))',aar,file],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.throws(()=>auditAar(file,core),/JNI consumer rules missing/);
});

for(const [asset,content,message] of [
    ['assets/licenses/LICENSE.txt','UNLICENSED','Apache-2.0 project license incomplete'],
    ['assets/licenses/NOTICE.txt','BaroChart','Project or QuickJS attribution notice incomplete'],
    ['assets/licenses/QUICKJS-LICENSE.txt','MIT','QuickJS MIT notice incomplete'],
])test('Reject incomplete license/notice in '+asset,()=>{
    const file=join(output,'invalid-'+asset.split('/').at(-1)+'.aar');
    const result=spawnSync('python3',['-c','import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1]) as source,zipfile.ZipFile(sys.argv[2],"w") as target:\n for name in source.namelist():target.writestr(name,sys.argv[4].encode() if name==sys.argv[3] else source.read(name))',aar,file,asset,content],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.throws(()=>auditAar(file,core),new RegExp(message));
});
