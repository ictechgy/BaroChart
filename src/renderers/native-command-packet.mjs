// Private native display transport. Source OHLCV/indicator arrays are never
// converted or transferred here; these are renderer-neutral CSS coordinates.
const nativePacketLimits={numbers:8388608,metadataBytes:1048576,commands:65536,strings:65536};
const nativePacketOps={lines:1,rects:2,path:3,box:4,ellipse:5,text:6};
function nativePacketFinite(value,label){if(typeof value!=='number'||!Number.isFinite(value))throw new TypeError('Native packet finite '+label);return value;}
function nativePacketArray(value,label){if(!Array.isArray(value)&&!(value instanceof Float64Array))throw new TypeError('Native packet '+label+' array');return value;}
function nativePacketUTF8Bytes(text){let bytes=0;for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c<128)bytes++;else if(c<2048)bytes+=2;else if(c>=0xd800&&c<=0xdbff&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff){bytes+=4;i++;}else bytes+=3;}return bytes;}

/** Internal wire v1: 15 F64 header values, then dash and ordered geometry.
 * Private limits trigger an explicit caller-owned legacy fallback. They never
 * truncate commands, source history, coordinates or strings.
 */
export function packNativeCommands(layers,{mode,width,height,background,stats}){
 if(!['scene','frame'].includes(mode)||!Array.isArray(layers)||layers.length!==(mode==='scene'?1:3)||layers.at(-1)===null)throw new TypeError('Native packet mode/layers');
 nativePacketFinite(width,'width');nativePacketFinite(height,'height');
 if(typeof background!=='string')throw new TypeError('Native packet background string');
 const strings=[],dictionary=new Map(),records=[],layerMetadata=[];let total=0,commandCount=0,stringBytes=0;
 const string=value=>{
  if(typeof value!=='string')throw new TypeError('Native packet string');
  if(dictionary.has(value))return dictionary.get(value);
  if(strings.length>=nativePacketLimits.strings)throw new RangeError('Native packet string limit');
  stringBytes+=nativePacketUTF8Bytes(value);if(stringBytes>nativePacketLimits.metadataBytes)throw new RangeError('Native packet metadata byte limit');
  const index=strings.length;dictionary.set(value,index);strings.push(value);return index;
 };
 for(const layer of layers){
  if(layer===null){layerMetadata.push(null);continue;}
  if(!layer||!Array.isArray(layer.commands))throw new TypeError('Native packet commands array');
  commandCount+=layer.commands.length;if(commandCount>nativePacketLimits.commands)throw new RangeError('Native packet command limit');
  layerMetadata.push({commands:layer.commands.length});
  for(const c of layer.commands){
   const op=nativePacketOps[c?.op];if(!Object.hasOwn(nativePacketOps,c?.op))throw new TypeError('Native packet unsupported operation');
   const color=string(c.color),stroke=nativePacketFinite(c.width??1,'stroke');if(stroke<0)throw new RangeError('Native packet stroke');
   const clip=c.clip==null?null:nativePacketArray(c.clip,'clip');if(clip&&clip.length!==4)throw new TypeError('Native packet clip arity');
   const clipValues=clip?Array.from(clip,v=>nativePacketFinite(v,'clip')):[0,0,0,0];
   const dash=c.dash==null?[]:nativePacketArray(c.dash,'dash');if(c.dash!=null&&(!dash.length||dash.length%2))throw new TypeError('Native packet dash arity');
   const fill=c.fill==null?-1:string(c.fill),baseline=op===3&&fill!==-1?nativePacketFinite(c.baseline,'area baseline'):0;
   const text=op===6?string(c.text):-1,font=op===6?string(c.font??'12px monospace'):-1;
   const geometry=op<=2?nativePacketArray(c.coords,'coords'):op===3?nativePacketArray(c.points,'points'):op<=5?[c.x,c.y,c.w,c.h]:[c.x,c.y];
   if(op<=2&&geometry.length%4||op===3&&geometry.length%2)throw new TypeError('Native packet geometry arity');
   const recordLength=15+dash.length+geometry.length;
   if(!Number.isSafeInteger(recordLength)||total+recordLength>nativePacketLimits.numbers)throw new RangeError('Native packet number limit');
   total+=recordLength;
   records.push({header:[op,recordLength,color,stroke,clip?1:0,...clipValues,dash.length,fill,baseline,text,font,geometry.length],dash,geometry});
  }
 }
 const metadata=JSON.stringify({schema:'aster.native.commands',version:1,mode,width,height,background,stats,strings,layers:layerMetadata});
 if(nativePacketUTF8Bytes(metadata)>nativePacketLimits.metadataBytes)throw new RangeError('Native packet metadata byte limit');
 const numbers=new Float64Array(total);let cursor=0;
 for(const {header,dash,geometry} of records){
  numbers.set(header,cursor);cursor+=15;
  for(const value of dash){nativePacketFinite(value,'dash');if(value<=0)throw new RangeError('Native packet positive dash');numbers[cursor++]=value;}
  for(const value of geometry)numbers[cursor++]=nativePacketFinite(value,'geometry');
 }
 if(cursor!==total)throw new TypeError('Native packet geometry changed during encoding');
 return {metadata,numbers};
}
