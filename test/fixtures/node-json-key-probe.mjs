// 런타임의 JSON 키 보존을 관찰하는 최소 재현기. Rust나 저장소 모듈을 불러오지 않는다.
const target=String.raw`{"-0":0,"\uD800":0}`;
const units=()=>Object.keys(JSON.parse(target)).map(key=>Array.from({length:key.length},(_,index)=>key.charCodeAt(index)));
const before=units();
JSON.parse(String.raw`{"-0":{},"\\":0}`);
const after=units();
const valid=before[1]?.[0]===0xd800&&after[1]?.[0]===0xd800;
console.log(JSON.stringify({node:process.version,v8:process.versions.v8,unicode:process.versions.unicode,before,after,valid}));
process.exitCode=valid?0:2;
