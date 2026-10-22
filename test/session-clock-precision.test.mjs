import test from 'node:test';import assert from 'node:assert/strict';
import {SessionCalendar,TickAggregator,zonedEpoch} from '../src/core/index.mjs';
const date='2026-01-01',day=86400000;
for(const open of ['00:00','00:00:00'])for(const close of ['00:00','00:00:00'])test(`equal midnight clocks ${open} to ${close} mean next local day`,()=>{
 const calendar=new SessionCalendar('UTC',d=>d===date?[{open,close}]:[]),window=calendar.sessions(date)[0],start=Date.parse(date+'T00:00:00Z');
 assert.equal(window.open,start);assert.equal(window.close,start+day);assert.equal(calendar.at(start+day-1),window);assert.equal(calendar.at(start+day),null);
 const tick=new TickAggregator({calendar});assert.equal(tick.push({time:start+1,price:1,volume:0}).bar.time,start);
});
for(const [open,close,expected] of [['09:30','16:00:00',6.5],['09:30:00','16:00',6.5],['22:00','02:00:00',4],['22:00:00','02:00',4],['09:30','09:30:01',1/3600],['09:30:01','09:30',24-1/3600]])test(`mixed clock precision preserves ordering ${open} to ${close}`,()=>{
 const calendar=new SessionCalendar('UTC',()=>[{open,close}]),window=calendar.sessions(date)[0];assert.equal(window.close-window.open,Math.round(expected*3600000));
});
for(const [date,hours] of [['2026-03-08',23],['2026-11-01',25]])test(`mixed midnight clocks preserve ${hours}-hour DST local day`,()=>{
 for(const open of ['00:00','00:00:00'])for(const close of ['00:00','00:00:00']){
  const c=new SessionCalendar('America/New_York',()=>[{open,close}]),s=c.sessions(date)[0];assert.equal(s.close-s.open,hours*3600000);assert.equal(s.open,zonedEpoch(date,'00:00',c.timezone));
 }
});
test('mixed precision keeps strict nonexistent clocks and overlapping windows rejected',()=>{
 assert.throws(()=>new SessionCalendar('America/New_York',()=>[{open:'02:30',close:'03:30:00'}]).sessions('2026-03-08'),/Nonexistent/);
 assert.throws(()=>new SessionCalendar('UTC',()=>[{open:'09:00',close:'12:00:00'},{open:'11:59:59',close:'13:00'}]).sessions(date),/nonoverlapping/);
});
