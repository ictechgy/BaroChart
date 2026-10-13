// Untimed read-only fixture/lifetime probes, inserted inside the private bundle
// closure. No production operation is replaced in the clean variant.
globalThis.__nativeProfileFrameHandles=function(){return nativeFrameCaches.size;};
globalThis.__nativeProfileDigest=function(){
 const digest=array=>{const bits=new Uint32Array(array.buffer,array.byteOffset,nativeModel.store.length*2);let a=2166136261,b=2246822519;for(const word of bits){a=Math.imul(a^word,16777619)>>>0;b=(Math.imul(b^word,3266489917)+374761393)>>>0;}return [a,b];};
 const vectors={};for(const [name,array] of Object.entries(nativeModel.store.columns))vectors['store:'+name]=digest(array);for(const s of nativeModel.series)if(s.values)vectors['series:'+s.id]=digest(s.values);
 const indices=[0,1,42,50000,99999],raw=indices.map(index=>({index,bar:nativeModel.store.at(index),series:nativeModel.series.filter(s=>s.values).map(s=>({id:s.id,value:s.values[index]}))}));
 const expected=nativeAPI.crosshairValues(1200,700),accessibility=nativeAccessibility(true),full=accessibility.crosshair!==undefined;
 if(accessibility.bars!==100000||accessibility.close!==nativeModel.store.at(99999).close.toPrecision(15))throw new Error('Accessibility primary readout mismatch');
 if(full&&JSON.stringify(accessibility.crosshair)!==JSON.stringify(expected))throw new Error('Cached accessibility crosshair mismatch');
 if(full&&(!accessibility.readout.includes(new Date(expected.time).toISOString())||!expected.axes.every(a=>accessibility.readout.includes(a.formatted))||!expected.series.every(s=>accessibility.readout.includes(s.label))))throw new Error('Accessibility full values missing');
 return {vectors,hashScope:'two UInt32 FNV-style digests of every Float64 vector bit; not cryptographic',raw,length:nativeModel.store.length,view:{...nativeModel.view},follow:nativeModel.follow,document:nativeModel.drawings.save(),expectedCrosshair:expected,accessibility,accessibilityMode:full?'full-cached-readout':'legacy-summary',accessibilityCorrect:true,frameHandles:nativeFrameCaches.size};
};
