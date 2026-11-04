// Node 22 ECMAScript oracle for the Rust JSON-value coercion leaf.
// Usage: ~/.nvm/versions/node/v22.20.0/bin/node test/fixtures/rust-core-vectors/generate-coercion.mjs [--check]
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const directory=fileURLToPath(new URL('.',import.meta.url));
const root=new URL('../../../',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',import.meta.url),'utf8'));
const bundle=await readFile(new URL('../../../native/Resources/aster-core.js',import.meta.url));
const numberBits=value=>{const bytes=new ArrayBuffer(8),view=new DataView(bytes);view.setFloat64(0,value,false);return view.getBigUint64(0,false).toString(16).padStart(16,'0');};
const stringUnits=value=>Array.from({length:value.length},(_,index)=>value.charCodeAt(index));
const encode=value=>{
 if(value===undefined)return {$undefined:true};
 if(typeof value==='number')return {$number:numberBits(value)};
 if(typeof value==='string')return {$string:stringUnits(value)};
 if(typeof value==='boolean'||value===null)return value;
 if(Array.isArray(value))return {$array:value.map(encode)};
 return {$object:Object.keys(value).map(key=>[stringUnits(key),encode(value[key])])};
};
const outcome=run=>{try{return {value:encode(run())};}catch(error){return {error:{name:error.name,message:error.message}};}};

const lone=String.fromCharCode(0xd800),seed=20261104;
const numberCases=[
 ['number-negative-zero',-0],['number-nan',NaN],['number-infinity',Infinity],
 ['undefined',undefined],['null',null],['true',true],['false',false],
 ['empty',''],['ascii-whitespace',' \t\n\r '],['ecma-whitespace','\ufeff\u00a0\u2028-0\u3000'],
 ['nel-is-not-whitespace','\u00851'],['lone-surrogate',lone],
 ['decimal-plus','+12'],['decimal-minus-zero','-0'],['decimal-dot-leading','.5'],
 ['decimal-dot-trailing','12.'],['decimal-leading-zeroes','0000012.50'],
 ['decimal-exponent','-001.25e+3'],['decimal-subnormal','5e-324'],
 ['decimal-half-subnormal-low','2.4703282292062327e-324'],
 ['decimal-half-subnormal-high','2.4703282292062328e-324'],
 ['decimal-overflow','1.7976931348623159e308'],['decimal-underflow-negative','-1e-1000000'],
 ['decimal-long-ecma','1.00000000000000011102230246251565404236316680908203125001'],
 ['decimal-quickjs-cutoff','9007199254740993.'+'0'.repeat(22)+'1'],
 ['infinity','Infinity'],['infinity-plus','+Infinity'],['infinity-minus','-Infinity'],
 ['invalid-lower-infinity','infinity'],['invalid-nan','NaN'],['invalid-multidot','1.2.3'],
 ['invalid-exponent','1e+'],['invalid-internal-space','1 2'],
 ['hex','0x10'],['hex-uppercase','0XfF'],['octal','0o777'],['binary','0b101010'],
 ['radix-leading-zeroes','  0x00000000000001  '],['invalid-signed-hex','-0x1'],
 ['invalid-plus-binary','+0b1'],['invalid-radix-empty','0x'],['invalid-radix-digit','0b102'],
 ['binary-tie-even-down','0b1'+'0'.repeat(52)+'1'],
 ['binary-tie-odd-up','0b1'+'0'.repeat(51)+'11'],
 ['binary-above-tie','0b1'+'0'.repeat(51)+'101'],
 ['binary-max-finite-exact','0b'+'1'.repeat(53)+'0'.repeat(971)],
 ['binary-overflow-midpoint-below','0b'+'1'.repeat(53)+'0'+'1'.repeat(970)],
 ['binary-overflow-midpoint','0b'+'1'.repeat(54)+'0'.repeat(970)],
 ['hex-max-width-rounds-infinity','0x'+'f'.repeat(256)],
 ['hex-overflow','0x1'+'0'.repeat(300)],
 ['octal-long','0o7'.repeat(1)+ '0'.repeat(400)],
 ['array-empty',[]],['array-null',[null]],['array-undefined',[undefined]],
 ['array-single-number',[12]],['array-single-hex',[' 0x10 ']],['array-many',[1,2]],
 ['array-nested',[[['-0']]]],['object-plain',{}],['object-tostring-shadow',{toString:0}],
];

const addCases=[
 ['add-number',1,2],['add-negative-zero',-0,-0],['add-undefined',1,undefined],
 ['add-null',1,null],['add-bool',1,true],['add-string',1,'2'],['add-negative-zero-string',-0,'x'],
 ['add-empty-array',1,[]],['add-single-array',1,[2]],['add-many-array',1,[2,3]],
 ['add-nested-array',1,[[2,3]]],['add-object',1,{}],
 ['add-object-tostring-shadow',1,{toString:0}],['add-lone-surrogate',1,lone],
];

const metadata={schema:'aster.rust-coercion-leaf',version:1,authority:'ECMAScript builtin coercion evaluated by Node',
 oracleCommit:manifest.oracleCommit,bundleSha256:createHash('sha256').update(bundle).digest('hex'),seed,dialect:'Ecma',
 runtime:{node:process.version,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,tz:process.versions.tz,platform:process.platform,arch:process.arch},
 scope:'JSON-value ToNumber and numeric-left addition; no callable, Symbol, Proxy, or opaque host objects'};
const rows=[{metadata},
 ...numberCases.map(([name,input])=>({suite:'to-number',name,input:encode(input),expected:outcome(()=>Number(input))})),
 ...addCases.map(([name,left,right])=>({suite:'add-number-left',name,left:encode(left),right:encode(right),expected:outcome(()=>left+right)})),
];
const text=rows.map(row=>JSON.stringify(row)).join('\n')+'\n',path=directory+'coercion.leaf.jsonl';
if(process.argv.includes('--check')){
 const stored=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse),current=text.trim().split('\n').map(JSON.parse);
 current[0].metadata.runtime=stored[0].metadata.runtime;
 if(JSON.stringify(current)!==JSON.stringify(stored))throw new Error('Coercion vectors are stale');
}else await writeFile(path,text);
process.stdout.write(`Coercion oracle: ${numberCases.length} ToNumber and ${addCases.length} addition cases\n`);
