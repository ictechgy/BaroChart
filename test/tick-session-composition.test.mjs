import test from 'node:test';
import assert from 'node:assert/strict';
import {BarStore, SessionCalendar, TickAggregator, applyDataEvent} from '../src/core/index.mjs';

const utc = Date.parse, minute = 60000;
// Synthetic New York 00:00–04:00 windows, including the 3-hour spring and
// 5-hour autumn sessions. All expected UTC boundaries and period anchors are
// literals, never obtained from SessionCalendar, zonedEpoch or Intl.
const sessions = [
  ['2026-03-07', '2026-03-07T05:00Z', '2026-03-07T09:00Z', '2026-03-02T05:00Z', '2026-03-01T05:00Z'],
  ['2026-03-08', '2026-03-08T05:00Z', '2026-03-08T08:00Z', '2026-03-02T05:00Z', '2026-03-01T05:00Z'],
  ['2026-03-09', '2026-03-09T04:00Z', '2026-03-09T08:00Z', '2026-03-09T04:00Z', '2026-03-01T05:00Z'],
  ['2026-10-31', '2026-10-31T04:00Z', '2026-10-31T08:00Z', '2026-10-26T04:00Z', '2026-10-01T04:00Z'],
  ['2026-11-01', '2026-11-01T04:00Z', '2026-11-01T09:00Z', '2026-10-26T04:00Z', '2026-11-01T04:00Z'],
  ['2026-11-02', '2026-11-02T05:00Z', '2026-11-02T09:00Z', '2026-11-02T05:00Z', '2026-11-01T04:00Z']
].map(([date, open, close, week, month]) => ({date, open: utc(open), close: utc(close), day: utc(open), week: utc(week), month: utc(month)}));
const dates = new Set(sessions.map(session => session.date));
const accepted = new Set(['append', 'update', 'correction']);
const aggregate = (time, ticks) => {
  const sorted = ticks.map((tick, arrival) => ({...tick, arrival})).sort((a, b) => a.time - b.time || a.arrival - b.arrival);
  return {time, open: sorted[0].price, high: Math.max(...sorted.map(tick => tick.price)), low: Math.min(...sorted.map(tick => tick.price)),
    close: sorted.at(-1).price, volume: sorted.reduce((sum, tick) => sum + tick.volume, 0)};
};

// Admission and OHLCV come only from the fixed tape and this ledger, including
// rejected/duplicate outcomes. A blanket rejection therefore cannot pass.
function oracle(interval, maxBuckets, latePolicy) {
  const history = new Map(); let latest = -Infinity;
  return {
    rows: () => [...history].sort(([a], [b]) => a - b).map(([time, ticks]) => aggregate(time, ticks)),
    reset() {history.clear(); latest = -Infinity;},
    push(tick) {
      const session = sessions.find(row => tick.time >= row.open && tick.time < row.close);
      if (!session) return {status: 'outside-session'};
      const time = typeof interval === 'number' ? session.open + Math.floor((tick.time - session.open) / interval) * interval : session[interval];
      const retained = [...history.keys()].sort((a, b) => b - a).slice(0, maxBuckets).includes(time), ticks = history.get(time) ?? [];
      if (retained && ticks.some(previous => previous.id === tick.id)) return {status: 'duplicate'};
      if (tick.time < latest && latePolicy === 'reject') return {status: 'late-rejected'};
      if (tick.time < latest && !retained) return {status: 'outside-correction-window'};
      const status = tick.time < latest ? 'correction' : ticks.length ? 'update' : 'append';
      history.set(time, [...ticks, {...tick}]); latest = Math.max(latest, tick.time);
      return {status, bar: aggregate(time, history.get(time)), sessionDate: session.date, sessionKind: 'regular'};
    }
  };
}

function tape() {
  const result = [], add = (time, price, volume, id) => result.push({time, price, volume, id});
  sessions.forEach((s, i) => {
    add(s.open - 1, 999, 99, `before-${i}`);
    add(s.open + 100, 100 + i, 2, `first-${i}`); add(s.open + 100, 100 + i, 2, `first-${i}`);
    add(s.open + 100, 106 + i, 1, `same-time-${i}`);
    add(s.open + 1, 90 + i, 3, `late-open-${i}`);
    add(s.open + 35 * minute + 100, 110 + i, 4, `next-${i}`);
    add(s.open + 300, 92 + i, 2, `late-old-${i}`);
    add(s.open + 20 * minute, 120 + i, 0, `late-gap-${i}`);
    if (i === 1) {add(utc('2026-03-08T06:59:59.999Z'), 130, 1, 'spring-before'); add(utc('2026-03-08T07:00Z'), 131, 2, 'spring-after');}
    if (i === 4) {add(utc('2026-11-01T05:30Z'), 140, 1, 'fall-first-0130'); add(utc('2026-11-01T06:30Z'), 141, 2, 'fall-second-0130');}
    add(s.close - 1, 80 + i, 5, `last-${i}`); add(s.close, 999, 99, `closed-${i}`);
  });
  add(sessions[0].open + 500, 77, 2, 'old-history');
  return result;
}

function runTape(interval, maxBuckets, latePolicy, {alter = () => {}, apply = applyDataEvent} = {}) {
  const calendar = new SessionCalendar('America/New_York', date => dates.has(date) ? [{open: '00:00', close: '04:00'}] : [], {maxCachedDays: 2});
  const aggregator = new TickAggregator({calendar, interval, maxBuckets, latePolicy}), store = new BarStore(), expected = oracle(interval, maxBuckets, latePolicy);
  const counts = {}; let notifications = 0, acceptedCount = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  const submit = (tick, label) => {
    const want = expected.push(tick), version = store.version, result = aggregator.push(tick);
    alter(result, tick);
    assert.equal(result.status, want.status, label + ': status');
    assert.deepEqual(result, want, label + ': literal UTC/OHLCV');
    counts[want.status] = (counts[want.status] ?? 0) + 1;
    if (accepted.has(want.status)) {apply(store, {kind: result.status, bar: result.bar}); acceptedCount++;}
    assert.equal(store.version, version + (accepted.has(want.status) ? 1 : 0), label + ': publication count');
    assert.equal(notifications, acceptedCount, label + ': notifications');
    assert.deepEqual(Array.from({length: store.length}, (_, i) => store.at(i)), expected.rows(), label + ': downstream store');
    assert.deepEqual(store.listenerErrors, [], label + ': listener errors');
  };
  try {
    for (const [i, tick] of tape().entries()) submit(tick, `${interval}/${maxBuckets}/${latePolicy} tick ${i} (${tick.id})`);
    for (const status of ['append', 'update', 'duplicate', 'outside-session', latePolicy === 'correct' ? 'correction' : 'late-rejected'])
      assert.ok(counts[status] > 0, 'Required outcome not reached: ' + status);
    if (typeof interval === 'number' && latePolicy === 'correct') assert.ok(counts['outside-correction-window'] > 0);
    aggregator.reset(); expected.reset(); store.setData([]); notifications = acceptedCount = 0;
    submit({time: sessions[0].open + 100, price: 55, volume: 0, id: 'first-0'}, 'after explicit reset');
    assert.equal(store.length, 1); assert.equal(store.at(0).close, 55);
    return counts;
  } finally {unsubscribe(); assert.equal(store.listeners.size, 0);}
}

for (const interval of [minute, 30 * minute, 'day', 'week', 'month']) for (const maxBuckets of [1, 3]) for (const latePolicy of ['correct', 'reject'])
  test(`literal DST tick→store oracle: ${interval}, retained ${maxBuckets}, ${latePolicy}`, () => runTape(interval, maxBuckets, latePolicy));

for (const [label, changes, expected] of [
  ['blanket rejection', {alter: result => {result.status = 'outside-session';}}, /first-0.*status/],
  ['false duplicate', {alter: result => {if (result.status === 'append') result.status = 'duplicate';}}, /first-0.*status/],
  ['wrong UTC anchor', {alter: result => {if (result.bar) result.bar.time += 3600000;}}, /literal UTC\/OHLCV/],
  ['wrong aggregated volume', {alter: result => {if (result.status === 'correction') result.bar.volume++;}}, /late-open-0.*literal UTC\/OHLCV/],
  ['corrupted downstream correction', {apply: (store, event) => {applyDataEvent(store, event); if (event.kind === 'correction') store.columns.volume[0]++;}}, /late-open-0.*downstream store/]
]) test('negative control: ' + label, t => {
  assert.throws(() => runTape(30 * minute, 3, 'correct', changes), error => {t.diagnostic(error.stack); return error instanceof assert.AssertionError && expected.test(error.message);});
});
