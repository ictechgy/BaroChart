import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionCalendar,TickAggregator,zonedEpoch,marketDate} from '../src/core/markets.mjs';

const utc=text=>Date.parse(text);
const regular=()=>[{open:'09:00',close:'16:00'}];
const transitions=[
 {zone:'America/Santiago',date:'2026-09-06',tick:'2026-09-06T13:00:00Z',interval:'day',anchor:'2026-09-06T04:00:00Z',periodDate:'2026-09-06'},
 {zone:'Asia/Tehran',date:'2021-03-23',tick:'2021-03-23T05:30:00Z',interval:'week',anchor:'2021-03-21T20:30:00Z',periodDate:'2021-03-22'},
 {zone:'America/Asuncion',date:'2023-10-15',tick:'2023-10-15T13:00:00Z',interval:'month',anchor:'2023-10-01T04:00:00Z',periodDate:'2023-10-01'},
];
for(const fixture of transitions)test(`${fixture.interval} anchor survives missing midnight in ${fixture.zone}`,()=>{
 const {zone,date,tick,interval,anchor,periodDate}=fixture,calendar=new SessionCalendar(zone,regular),time=utc(tick),expected=utc(anchor);
 assert.equal(calendar.at(time).date,date);
 assert.throws(()=>zonedEpoch(periodDate,'00:00',zone),/Nonexistent/,'explicit clock conversion remains strict');
 assert.equal(marketDate(expected,zone),periodDate);
 assert.notEqual(marketDate(expected-1,zone),periodDate,'fixed UTC anchor is the first instant of the local day');
 assert.deepEqual(calendar.bucket(time,interval),{time:expected,sessionDate:date,kind:'regular'});
 const agg=new TickAggregator({calendar,interval});
 assert.deepEqual(agg.push({time,price:12,volume:3}).bar,{time:expected,open:12,high:12,low:12,close:12,volume:3});
});
test('repeated midnight uses the earlier instant and invalidation retains the anchor contract',()=>{
 const c=new SessionCalendar('America/Havana',regular,{maxCachedDays:2}),time=utc('2026-11-01T15:00:00Z');
 assert.equal(c.bucket(time,'day').time,utc('2026-11-01T04:00:00Z'));
 assert.equal(zonedEpoch('2026-11-01','00:00',c.timezone,'later'),utc('2026-11-01T05:00:00Z'));
 c.bucket(utc('2026-11-02T15:00:00Z'),'day');c.bucket(utc('2026-11-03T15:00:00Z'),'day');c.invalidate();
 assert.equal(c.bucket(time,'day').time,utc('2026-11-01T04:00:00Z'));
});
test('split/irregular sessions anchor intraday buckets at each open and omit closed gaps',()=>{
 const c=new SessionCalendar('UTC',date=>date==='2026-02-02'?[{open:'09:15',close:'11:45'},{open:'13:00',close:'16:15'}]:date==='2026-02-03'?[{open:'09:15',close:'13:00'}]:[]);
 assert.equal(c.bucket(utc('2026-02-02T09:14:59Z'),3600000),null);
 assert.equal(c.bucket(utc('2026-02-02T11:44:59Z'),3600000).time,utc('2026-02-02T11:15:00Z'));
 assert.equal(c.bucket(utc('2026-02-02T11:45:00Z'),3600000),null);
 assert.equal(c.bucket(utc('2026-02-02T12:30:00Z'),3600000),null);
 assert.equal(c.bucket(utc('2026-02-02T13:40:00Z'),3600000).time,utc('2026-02-02T13:00:00Z'));
 assert.equal(c.at(utc('2026-02-03T13:00:00Z')),null);
 const agg=new TickAggregator({calendar:c});
 agg.push({time:utc('2026-02-02T09:15:00Z'),price:10,volume:1});agg.push({time:utc('2026-02-02T13:00:00Z'),price:20,volume:2});
 assert.deepEqual([...agg.buckets.keys()],[utc('2026-02-02T09:15:00Z'),utc('2026-02-02T13:00:00Z')]);
});
test('overnight session retains its opening date across day/week/month boundaries',()=>{
 const c=new SessionCalendar('UTC',date=>date==='2026-01-31'?[{open:'22:00',close:'02:00'}]:[]),time=utc('2026-02-01T01:00:00Z');
 assert.equal(c.at(time).date,'2026-01-31');
 for(const [interval,anchor] of [['day','2026-01-31T00:00:00Z'],['week','2026-01-26T00:00:00Z'],['month','2026-01-01T00:00:00Z']])assert.equal(c.bucket(time,interval).time,utc(anchor));
 assert.equal(c.at(utc('2026-02-01T02:00:00Z')),null);
});
