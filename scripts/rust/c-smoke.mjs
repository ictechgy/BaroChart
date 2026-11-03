// 생성 C 헤더를 실제 C11 번역기로 컴파일하고 Rust staticlib에 링크해 호출한다.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {toolEnvironment} from './cbindgen-tool.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const cargo=join(root,'scripts/rust/cargo.mjs');

function run(command,args,options={}){
 const result=spawnSync(command,args,{cwd:root,encoding:'utf8',...options});
 if(result.error)throw new Error(`${command} could not start: ${result.error.message}`);
 if(result.status!==0)throw new Error(`${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

run(process.execPath,[cargo,'build','--locked','-p','barochart-ffi'],{
 env:toolEnvironment(true),
});
const directory=mkdtempSync(join(tmpdir(),'barochart-ffi-smoke-'));
try{
 const executable=join(directory,process.platform==='win32'?'c-smoke.exe':'c-smoke');
 const library=join(root,'rust','target','debug',process.platform==='win32'?'barochart_ffi.lib':'libbarochart_ffi.a');
 const links=process.platform==='darwin'?['-liconv','-lm']:process.platform==='linux'?['-ldl','-lpthread','-lm','-lrt','-lutil']:[];
 if(!links.length)throw new Error(`unsupported C smoke platform: ${process.platform}`);
 run(process.env.CC||'cc',[
  '-std=c11','-Wall','-Wextra','-Werror',
  '-I',join(root,'rust','include'),
  join(root,'rust','crates','barochart-ffi','tests','c_smoke.c'),
  library,'-o',executable,...links,
 ]);
 run(executable,[]);
 console.log('c-smoke: generated header compiled, staticlib linked, executable passed');
}finally{
 rmSync(directory,{recursive:true,force:true});
}
