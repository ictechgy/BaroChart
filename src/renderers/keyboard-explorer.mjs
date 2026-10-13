import {BarStore} from '../core/data.mjs';
const lowerBound=BarStore.prototype.lowerBound;
// DOM-free keyboard selection. Only read() invokes potentially expensive dataAt.
const LIMIT=4096;
const stale=()=>{const error=new Error('Keyboard exploration owner changed');error.name='StaleSourceError';return error;};
const number=value=>Object.is(value,-0)?'-0':String(value);
export class KeyboardDataExplorer {
 constructor(api){this.api=api;this.model=api.model;this.active=false;this.time=null;this.seriesId=null;this.phase='off';this.text='';this.generation=0;this.busy=false;this.disposed=false;}
 owner(){if(this.disposed||this.model.disposed)throw new Error('Chart disposed');if(this.api.model!==this.model)throw stale();return this.model;}
 rows(){const rows=this.model.series.filter(s=>s.visible!==false);if(rows.length>256)throw new RangeError('Exploration series limit');return rows;}
 index(){const store=this.model.store;if(this.time===null)return -1;const index=lowerBound.call(store,this.time);return index<store.length&&store.columns.time[index]===this.time?index:-1;}
 selectionText(){const index=this.index();if(!this.model.store.length)return 'No stored bars. Home or End selects a bar after data arrives.';if(index<0)return 'Selected bar is no longer available. Press Home or End to select a stored bar.';const rows=this.rows(),row=rows.find(s=>s.id===this.seriesId);return `Bar ${index+1} of ${this.model.store.length}; stored time ${this.time} UTC ms. ${row?`Series ${row.id}; panel ${row.panel}; axis ${row.axisId??'default'}.`:'No visible series.'} ${this.phase==='changed'?'Data or display changed. ':''}Press Enter to read current plotted values.`.slice(0,LIMIT);}
 snapshot(){return {active:this.active,time:this.time,index:this.active?this.index():null,seriesId:this.seriesId,phase:this.phase,text:this.text};}
 setActive(active){this.owner();if(typeof active!=='boolean')throw new TypeError('Exploration mode boolean');this.generation++;this.active=active;this.phase=active?'selected':'off';this.time=null;this.seriesId=null;this.text='';if(active){const n=this.model.store.length;if(n){const index=Math.max(0,Math.min(n-1,Math.floor(this.model.view.to)));this.time=this.model.store.columns.time[index];}this.seriesId=this.rows()[0]?.id??null;this.text=this.selectionText();}return this.snapshot();}
 changed(){if(!this.active||this.disposed)return false;this.owner();this.generation++;const rows=this.rows();if(!rows.some(s=>s.id===this.seriesId))this.seriesId=rows[0]?.id??null;this.phase=this.index()<0?'missing':'changed';this.text=this.selectionText();return true;}
 key(key){this.owner();if(!this.active)return false;if(key==='Escape'){this.setActive(false);return true;}if(key==='Enter'){this.read();return true;}
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(key))return false;
  this.generation++;const store=this.model.store,rows=this.rows(),index=this.index();
  if(key==='Home'||key==='End'){this.time=store.length?store.columns.time[key==='Home'?0:store.length-1]:null;}
  else if(key==='ArrowLeft'||key==='ArrowRight'){if(index>=0)this.time=store.columns.time[Math.max(0,Math.min(store.length-1,index+(key==='ArrowLeft'?-1:1)))];}
  else{const at=rows.findIndex(s=>s.id===this.seriesId),next=Math.max(0,Math.min(rows.length-1,Math.max(0,at)+(key==='ArrowUp'?-1:1)));this.seriesId=rows[next]?.id??null;}
  if(!rows.some(s=>s.id===this.seriesId))this.seriesId=rows[0]?.id??null;
  this.phase=this.index()<0?'missing':'selected';this.text=this.selectionText();return true;
 }
 read(){this.owner();if(!this.active)throw new Error('Enable data exploration first');if(this.busy)throw new Error('Exploration read already running');const generation=this.generation;
  if(this.index()<0){this.phase='missing';this.text=this.selectionText();return this.snapshot();}
  this.busy=true;try{const result=this.api.dataAt({time:this.time,match:'exact'});this.owner();if(!this.active||this.generation!==generation)throw stale();if(!result){this.phase='missing';this.text=this.selectionText();return this.snapshot();}
   const row=result.series.find(s=>s.id===this.seriesId),b=result.primary.bar;
   const symbol=result.primary.symbol;
   const text=`${symbol?`${symbol.id}; currency ${symbol.currency}; volume unit ${symbol.volumeUnit}. `:''}Bar ${result.index+1}; stored time ${result.time} UTC ms. Open ${number(b.open)}; high ${number(b.high)}; low ${number(b.low)}; close ${number(b.close)}; volume ${number(b.volume)}. ${row?`Series ${row.id}; panel ${row.panel}; axis ${row.axisId??'default'}; ${row.status}; value ${row.value===null?'unavailable':number(row.value)}; plot offset ${row.offset}; source index ${row.sourceIndex??'none'}; source time ${row.sourceTime??'none'} UTC ms.`:'No visible series.'} Current plotted values, cutoff ${result.asOfIndex}; revised data, not historical arrival-time truth.`;
   this.phase='read';this.text=text.slice(0,LIMIT);return this.snapshot();
  }catch(error){if(!this.disposed&&this.active&&this.generation===generation){this.phase='error';this.text='Value read failed. Press Enter to retry.';}throw error;}finally{this.busy=false;}
 }
 dispose(){if(this.disposed)return;this.disposed=true;this.generation++;this.active=false;this.time=null;this.seriesId=null;this.phase='off';this.text='';this.api=null;this.model=null;}
}
export function explorerInputAllowed(event,canvas){return event.target===canvas&&!event.defaultPrevented&&!event.isComposing&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey;}
