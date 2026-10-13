// Private functional APK only. Fixed malformed cases; no eval or public SDK hook.
const packetFixtureOriginal=globalThis.nativeScenePacket;
let packetFixtureMode='ok';
const packetFixtureModes=new Set(['ok','float32','missing-numbers','missing-metadata','metadata-type','metadata-budget','number-budget','record','nonfinite','color','throw','offset','unicode']);
globalThis.nativePacketFixtureMode=function(mode){if(!packetFixtureModes.has(mode))throw new TypeError('Fixture mode');packetFixtureMode=mode;return true;};
globalThis.nativeScenePacket=function(...args){
 const packet=packetFixtureOriginal(...args);
 if(packetFixtureMode==='throw')throw new Error('Fixed packet fixture error 한글 😀');
 if(packetFixtureMode==='float32')return {...packet,numbers:new Float32Array(packet.numbers)};
 if(packetFixtureMode==='missing-numbers')return {metadata:packet.metadata};
 if(packetFixtureMode==='missing-metadata')return {numbers:packet.numbers};
 if(packetFixtureMode==='metadata-type')return {...packet,metadata:{}};
 if(packetFixtureMode==='metadata-budget')return {...packet,metadata:' '.repeat(1048577)};
 if(packetFixtureMode==='number-budget')return {...packet,numbers:new Float64Array(8388609)};
 if(packetFixtureMode==='offset'){const view=new Float64Array(new ArrayBuffer(packet.numbers.byteLength+16),8,packet.numbers.length);view.set(packet.numbers);return {...packet,numbers:view};}
 if(packetFixtureMode==='record'&&packet.numbers.length){packet.numbers[1]=packet.numbers.length+1;return packet;}
 if(packetFixtureMode==='nonfinite'&&packet.numbers.length>15){packet.numbers[15]=NaN;return packet;}
 if(packetFixtureMode==='color'){const meta=JSON.parse(packet.metadata);if(packet.numbers.length)meta.strings[packet.numbers[2]]='not-a-color';packet.metadata=JSON.stringify(meta);return packet;}
 if(packetFixtureMode==='unicode'){const meta=JSON.parse(packet.metadata);meta.strings.push('A\u0000\n"한글 😀\ud800');packet.metadata=JSON.stringify(meta);return packet;}
 return packet;
};
