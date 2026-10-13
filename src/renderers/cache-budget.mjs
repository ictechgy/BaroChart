// Explicit retained raster capacity, not process RSS or measured GPU VRAM.
export class LayerCacheBudget {
  constructor(maxBytes=134217728){this.entries=new Map();this.usedBytes=0;this.generation=0;this.setLimit(maxBytes);}
  setLimit(maxBytes){if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>1073741824)throw new RangeError('Layer cache budget');this.maxBytes=maxBytes;this.generation++;for(const [owner] of [...this.entries].reverse()){if(this.usedBytes<=maxBytes)break;const entry=this.entries.get(owner);if(!entry)continue;this.entries.delete(owner);this.usedBytes-=entry.bytes;entry.trim();}return this;}
  reserve(owner,bytes,trim){if(!Number.isSafeInteger(bytes)||bytes<0||typeof trim!=='function')throw new TypeError('Cache reservation');const previous=this.entries.get(owner)?.bytes??0;if(this.usedBytes-previous+bytes>this.maxBytes)return false;this.entries.set(owner,{bytes,trim});this.usedBytes+=bytes-previous;return true;}
  release(owner){const entry=this.entries.get(owner);if(entry){this.entries.delete(owner);this.usedBytes-=entry.bytes;}}
}
export class CacheAllocationError extends Error {}
export const defaultLayerCacheBudget=new LayerCacheBudget();
