import {RangeIndex} from './data.mjs';
// A tree over 32-value blocks bounds edge scans and reduces large-series trees.
export class BlockRangeIndex {
 constructor(length,values,capacity=length,blockSize=32) {
  this.size=capacity;this.length=length;this.blockSize=blockSize;this.finiteCounts=true;
  this.values=new Float64Array(values.buffer,values.byteOffset,Math.min(capacity,(values.buffer.byteLength-values.byteOffset)/8));
  const count=Math.ceil(length/blockSize),blocks=Math.ceil(capacity/blockSize),min=new Float64Array(count),max=new Float64Array(count),finite=new Float64Array(count);
  for(let b=0;b<count;b++){const q=this.scan(b*blockSize,Math.min(length,(b+1)*blockSize),true);min[b]=q.min;max[b]=q.max;finite[b]=q.sum;}
  this.tree=new RangeIndex(count,min,max,finite,blocks);
 }
 scan(from,to,countFinite=false){let min=Infinity,max=-Infinity,count=0;for(let i=from,end=Math.min(to,this.length,this.values.length);i<end;i++){const value=this.values[i];if(Number.isFinite(value)){if(value<min)min=value;if(value>max)max=value;if(countFinite)count++;}}return {min,max,sum:count};}
 query(from,to){if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<from||to>this.size)throw new RangeError('Block index bounds');if(to<=from)return {min:Infinity,max:-Infinity,sum:0};const first=Math.ceil(from/this.blockSize),last=Math.floor(to/this.blockSize);if(first>=last)return this.scan(from,to);const left=this.scan(from,first*this.blockSize),right=this.scan(last*this.blockSize,to),middle=this.tree.query(first,last);return {min:Math.min(left.min,middle.min,right.min),max:Math.max(left.max,middle.max,right.max),sum:0};}
 scanCount(from,to){let count=0;for(let i=from;i<Math.min(to,this.length);i++)if(Number.isFinite(this.values[i]))count++;return count;}
 finiteCount(from,to){if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<from||to>this.size)throw new RangeError('Block index bounds');const first=Math.ceil(from/this.blockSize),last=Math.floor(to/this.blockSize);if(first>=last)return this.scanCount(from,to);return this.scanCount(from,first*this.blockSize)+this.tree._sumRange(first,last)+this.scanCount(last*this.blockSize,to);}
 hasGaps(from,to){return this.finiteCount(from,to)!==to-from;}
 update(i){if(!Number.isInteger(i)||i<0||i>=this.size)throw new RangeError('Block update bounds');this.length=Math.max(this.length,i+1);const block=Math.floor(i/this.blockSize),from=block*this.blockSize,to=Math.min(this.length,(block+1)*this.blockSize),q=this.scan(from,to,true);this.tree.update(block,q.min,q.max,q.sum);}
 get bytes(){return this.tree.bytes;}
}
