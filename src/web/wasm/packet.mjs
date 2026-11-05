// Display wire v1. These limits match the native encoder; source data never enters this transport.
const LIMITS={numbers:8388608,metadataBytes:1048576,commands:65536,strings:65536};
const OPS=['','lines','rects','path','box','ellipse','text'];
const encoder=new TextEncoder();
function invalid(reason){throw new TypeError(`Rust packet ${reason}`);}
function finite(value,label){if(typeof value!=='number'||!Number.isFinite(value))invalid(label);return value;}
function integer(value,min,max,label){if(!Number.isSafeInteger(value)||Object.is(value,-0)||value<min||value>max)invalid(label);return value;}

/** Decode owned display coordinates; no returned view points into WASM linear memory. */
export function decodeRustPacket({metadata,numbers}){
 let text;
 try{text=typeof metadata==='string'?metadata:JSON.stringify(metadata);}catch{invalid('metadata');}
 if(typeof text!=='string'||text.length>LIMITS.metadataBytes||encoder.encode(text).length>LIMITS.metadataBytes)invalid('metadata capacity');
 let meta;try{meta=JSON.parse(text);}catch{invalid('metadata JSON');}
 if(!meta||meta.schema!=='aster.native.commands'||meta.version!==1||!['scene','frame'].includes(meta.mode))invalid('schema/version/mode');
 finite(meta.width,'width');finite(meta.height,'height');
 if(typeof meta.background!=='string'||!Array.isArray(meta.strings)||meta.strings.length>LIMITS.strings||!meta.strings.every(value=>typeof value==='string'))invalid('strings');
 if(!(numbers instanceof Float64Array)||numbers.length>LIMITS.numbers)invalid('numbers');
 if(!Array.isArray(meta.layers)||meta.layers.length!==(meta.mode==='scene'?1:3)||meta.layers.at(-1)===null)invalid('layer count');
 const string=(value,optional=false)=>optional&&value===-1?null:meta.strings[integer(value,0,meta.strings.length-1,'string index')];
 let cursor=0,totalCommands=0;
 const layers=meta.layers.map(layer=>{
  if(layer===null)return null;
  if(!layer||typeof layer!=='object')invalid('layer');
  const count=integer(layer.commands,0,LIMITS.commands,'command count');totalCommands+=count;
  if(totalCommands>LIMITS.commands)invalid('command capacity');
  const commands=[];
  for(let index=0;index<count;index++){
   if(numbers.length-cursor<15)invalid('short header');
   const start=cursor,h=numbers.subarray(start,start+15);
   const op=integer(h[0],1,6,'opcode'),length=integer(h[1],15,numbers.length-start,'record length');
   const color=string(h[2]),width=finite(h[3],'stroke');if(width<0)invalid('negative stroke');
   const hasClip=integer(h[4],0,1,'clip flag');for(let i=5;i<9;i++)finite(h[i],'clip');
   const dashCount=integer(h[9],0,LIMITS.numbers,'dash count'),fill=string(h[10],true),baseline=finite(h[11],'baseline');
   const textValue=string(h[12],true),font=string(h[13],true),geometryCount=integer(h[14],0,LIMITS.numbers,'geometry count');
   if(length!==15+dashCount+geometryCount||dashCount%2)invalid('record arity');
   if(op<=2&&geometryCount%4||op===3&&geometryCount%2||op>=4&&op<=5&&geometryCount!==4||op===6&&geometryCount!==2)invalid('geometry arity');
   if(op===6&&(textValue===null||font===null)||op!==6&&(textValue!==null||font!==null))invalid('text header');
   if((op!==3||fill===null)&&!Object.is(baseline,0))invalid('unused baseline');
   const dash=numbers.subarray(start+15,start+15+dashCount),geometry=numbers.subarray(start+15+dashCount,start+length);
   for(const value of dash)if(!Number.isFinite(value)||value<=0)invalid('positive dash');
   for(const value of geometry)finite(value,'geometry');
   const command={op:OPS[op],color,width,clip:hasClip?Array.from(h.subarray(5,9)):null,dash:dashCount?dash:null,fill};
   if(op<=2)command.coords=geometry;
   else if(op===3){command.points=geometry;if(fill!==null)command.baseline=baseline;}
   else if(op<=5)[command.x,command.y,command.w,command.h]=geometry;
   else{[command.x,command.y]=geometry;command.text=textValue;command.font=font;}
   commands.push(command);cursor=start+length;
  }
  return {width:meta.width,height:meta.height,background:meta.background,stats:meta.stats,commands};
 });
 if(cursor!==numbers.length)invalid('trailing numbers');
 return {mode:meta.mode,width:meta.width,height:meta.height,background:meta.background,stats:meta.stats,layers};
}
