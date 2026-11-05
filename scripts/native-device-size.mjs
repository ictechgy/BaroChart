/** Linked Swift SDK and Rust archive bytes; excludes app/system and dead-stripped symbols. */
export function sdkCodeBytesFromLinkMap(text){
 const files=new Map(),ranges=[];let section='';
 const sdkObject=path=>/(?:\/BaroChart\.build\/|\/BaroChart\.o$|(?:^|\/)libbarochart_ffi(?:-macos-universal)?\.a(?:\(|\[|$))/.test(path);
 for(const line of text.split('\n')){
  if(line.startsWith('#')){
   if(line.endsWith(':'))section=line.startsWith('# Object files:')?'objects':line.startsWith('# Symbols:')?'symbols':'';
   continue;
  }
  if(section==='objects'){
   const match=/^\[\s*(\d+)\]\s+(.*)$/.exec(line);
   if(match)files.set(match[1],match[2]);
  }else if(section==='symbols'){
   const match=/^0x([0-9a-f]+)\s+0x([0-9a-f]+)\s+\[\s*(\d+)\]/i.exec(line);
   if(match&&sdkObject(files.get(match[3])??'')){
    const start=BigInt('0x'+match[1]),size=BigInt('0x'+match[2]);
    if(size>0n)ranges.push([start,start+size]);
   }
  }
 }
 ranges.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
 let total=0n,end=0n;
 for(const [start,limit] of ranges){
  if(limit>end){total+=limit-(start>end?start:end);end=limit;}
 }
 if(total>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('SDK link-map size exceeds safe integer range');
 return Number(total);
}
