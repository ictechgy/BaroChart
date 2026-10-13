import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionCalendar,resampleOHLCV,alignConfirmedByTime} from '../src/core/index.mjs';
const FIELDS = ['time', 'open', 'high', 'low', 'close', 'volume'];
const M = 60000, H = 60 * M, DAY = 24 * H;
const ts = value => typeof value === 'number' ? value : Date.parse(value);
const T = ts('2026-03-09T09:30:00Z');
function row(time, n = 0, volume = n + 1) {
  return {time: ts(time), open: 100 + n, high: 103 + n, low: 98 + n, close: 101 + n, volume};
}
function input(rows, capacity = rows.length) {
  const columns = Object.fromEntries(FIELDS.map(k => [k, new Float64Array(capacity).fill(NaN)]));
  rows.forEach((bar, i) => FIELDS.forEach(k => columns[k][i] = bar[k]));
  return {columns, length: rows.length};
}
function fixedCalendar(windows = [{open: '09:30', close: '10:00', kind: 'regular'}], dates = ['2026-03-09'], timezone = 'UTC', config) {
  const selected = new Set(dates);
  return new SessionCalendar(timezone, date => selected.has(date) ? windows.map(window => ({...window})) : [], config);
}
function options(patch = {}) {
  return {sourceIntervalMs: M, targetIntervalMs: 5 * M, calendar: fixedCalendar(), kinds: ['regular'], asOf: T + 30 * M, partialTarget: 'include-unconfirmed', ...patch};
}
function plain(result) {
  return {
    columns: Object.fromEntries(FIELDS.map(k => [k, [...result.columns[k]]])),
    length: result.length, endTime: [...result.endTime], availableAt: [...result.availableAt],
    sourceFrom: [...result.sourceFrom], sourceTo: [...result.sourceTo], complete: [...result.complete], confirmed: [...result.confirmed],
    asOf: result.asOf, sourceIntervalMs: result.sourceIntervalMs, targetIntervalMs: result.targetIntervalMs
  };
}
function checkShape(result) {
  assert.ok(Number.isSafeInteger(result.length) && result.length >= 0);
  for (const k of FIELDS) { assert.ok(result.columns[k] instanceof Float64Array, k); assert.equal(result.columns[k].length, result.length, k); }
  for (const k of ['endTime', 'availableAt']) { assert.ok(result[k] instanceof Float64Array, k); assert.equal(result[k].length, result.length, k); }
  for (const k of ['sourceFrom', 'sourceTo']) { assert.ok(result[k] instanceof Uint32Array, k); assert.equal(result[k].length, result.length, k); }
  for (const k of ['complete', 'confirmed']) { assert.ok(result[k] instanceof Uint8Array, k); assert.equal(result[k].length, result.length, k); }
}
function cacheSnapshot(calendar) {
  return {cache: calendar.cache, entries: [...calendar.cache].map(([date, windows]) => ({date, windows, records: windows.map(window => ({reference: window, data: {...window}}))})), timezone: calendar.timezone, provider: calendar.provider, maxCachedDays: calendar.maxCachedDays};
}
function assertCacheUnchanged(calendar, before) {
  assert.equal(calendar.cache, before.cache);
  assert.deepEqual([...calendar.cache.keys()], before.entries.map(entry => entry.date));
  for (const entry of before.entries) {
    assert.equal(calendar.cache.get(entry.date), entry.windows);
    assert.equal(entry.windows.length, entry.records.length);
    entry.records.forEach((record, i) => {assert.equal(entry.windows[i], record.reference); assert.deepEqual(entry.windows[i], record.data);});
  }
  for (const key of ['timezone', 'provider', 'maxCachedDays']) assert.equal(calendar[key], before[key]);
}

// Deliberately does not call SessionCalendar.at/bucket/sessions, nor copy a
// streaming production grouping algorithm. Enumerate literal target windows,
// then compare the entire expected source-slot list against observed indices.
function oracle(rows, literalSessions, opts) {
  const output = [];
  for (const session of literalSessions) {
    if (!opts.kinds.includes(session.kind)) continue;
    for (let start = session.open; start < session.close; start += opts.targetIntervalMs) {
      const end = Math.min(start + opts.targetIntervalMs, session.close);
      const observed = rows.map((bar, i) => ({bar, i})).filter(({bar}) => bar.time >= start && bar.time < end && bar.time + opts.sourceIntervalMs <= opts.asOf);
      if (!observed.length) continue;
      const expectedTimes = [];
      for (let source = start; source < end; source += opts.sourceIntervalMs) expectedTimes.push(source);
      const complete = end - start === expectedTimes.length * opts.sourceIntervalMs && observed.length === expectedTimes.length && observed.every(({bar}, i) => bar.time === expectedTimes[i]);
      if (!complete && opts.partialTarget === 'reject') throw new RangeError('oracle partial group');
      if (!complete && opts.partialTarget === 'omit') continue;
      const bars = observed.map(({bar}) => bar), confirmed = complete && end <= opts.asOf;
      output.push({time: start, open: bars[0].open, high: Math.max(...bars.map(bar => bar.high)), low: Math.min(...bars.map(bar => bar.low)), close: bars.at(-1).close, volume: bars.reduce((sum, bar) => sum + bar.volume, 0), end, from: observed[0].i, to: observed.at(-1).i + 1, complete: Number(complete), confirmed: Number(confirmed), available: confirmed ? end : NaN});
    }
  }
  output.sort((a, b) => a.time - b.time);
  return {columns: Object.fromEntries(FIELDS.map(k => [k, output.map(bar => bar[k])])), length: output.length, endTime: output.map(bar => bar.end), availableAt: output.map(bar => bar.available), sourceFrom: output.map(bar => bar.from), sourceTo: output.map(bar => bar.to), complete: output.map(bar => bar.complete), confirmed: output.map(bar => bar.confirmed), asOf: opts.asOf, sourceIntervalMs: opts.sourceIntervalMs, targetIntervalMs: opts.targetIntervalMs};
}
function compareOracle(rows, sessions, opts) {
  const expected = oracle(rows, sessions, opts), actual = resampleOHLCV(input(rows), opts);
  checkShape(actual); assert.deepEqual(plain(actual), expected); return actual;
}
function generator(seed = 0x9e3779b9) {return () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32;};}

// Resampling: boundaries, metadata, source validity, and pure ownership.
test('complete five-minute bars have literal OHLCV, UTC close availability, and half-open source bounds', () => {
  const rows = Array.from({length: 10}, (_, i) => row(T + i * M, i));
  const result = resampleOHLCV(input(rows), options()); checkShape(result);
  assert.deepEqual(plain(result), {
    columns: {time: [T, T + 5 * M], open: [100, 105], high: [107, 112], low: [98, 103], close: [105, 110], volume: [15, 40]}, length: 2,
    endTime: [T + 5 * M, T + 10 * M], availableAt: [T + 5 * M, T + 10 * M], sourceFrom: [0, 5], sourceTo: [5, 10], complete: [1, 1], confirmed: [1, 1],
    asOf: T + 30 * M, sourceIntervalMs: M, targetIntervalMs: 5 * M
  });
});

test('open-labelled source bars participate exactly at source close, never at source open', () => {
  const rows = Array.from({length: 6}, (_, i) => row(T + i * M, i));
  for (const [asOf, count, complete] of [[T - 1, 0, []], [T, 0, []], [T + M - 1, 0, []], [T + M, 1, [0]], [T + 5 * M - 1, 1, [0]], [T + 5 * M, 1, [1]], [T + 6 * M, 2, [1, 0]]]) {
    const actual = resampleOHLCV(input(rows), options({asOf}));
    assert.equal(actual.length, count, `asOf ${asOf}`); assert.deepEqual([...actual.complete], complete);
    for (let i = 0; i < actual.length; i++) assert.equal(actual.sourceTo[i], Math.min(5 * (i + 1), Math.floor((asOf - T) / M)));
  }
});

test('all populated partial policies are explicit; wholly empty target windows are never synthesized', () => {
  const rows = [row(T), row(T + 2 * M, 2), ...Array.from({length: 5}, (_, i) => row(T + (10 + i) * M, 10 + i))];
  const included = resampleOHLCV(input(rows), options());
  assert.deepEqual([...included.columns.time], [T, T + 10 * M]); assert.deepEqual([...included.complete], [0, 1]);
  assert.deepEqual([...included.confirmed], [0, 1]); assert.ok(Number.isNaN(included.availableAt[0]));
  assert.deepEqual([...included.sourceFrom], [0, 2]); assert.deepEqual([...included.sourceTo], [2, 7]);
  const omitted = resampleOHLCV(input(rows), options({partialTarget: 'omit'}));
  assert.deepEqual([...omitted.columns.time], [T + 10 * M]); assert.deepEqual([...omitted.sourceFrom], [2]); assert.deepEqual([...omitted.sourceTo], [7]);
  assert.throws(() => resampleOHLCV(input(rows), options({partialTarget: 'reject'})));
  assert.equal(resampleOHLCV(input([]), options({partialTarget: 'reject'})).length, 0);
  assert.equal(resampleOHLCV(input([row(T)]), options({asOf: T, partialTarget: 'reject'})).length, 0);
});

test('a missing leading, middle, or trailing source slot prevents completeness even after target close', () => {
  for (const missing of [0, 2, 4]) {
    const rows = Array.from({length: 5}, (_, i) => row(T + i * M, i)).filter((_, i) => i !== missing);
    const included = resampleOHLCV(input(rows), options());
    assert.deepEqual([...included.complete], [0]); assert.deepEqual([...included.confirmed], [0]); assert.ok(Number.isNaN(included.availableAt[0]));
    assert.equal(included.columns.time[0], T, 'target open stays anchored even if first source slot is missing');
    assert.equal(resampleOHLCV(input(rows), options({partialTarget: 'omit'})).length, 0);
    assert.throws(() => resampleOHLCV(input(rows), options({partialTarget: 'reject'})));
  }
});

test('future source prices and appends cannot alter an earlier as-of snapshot', () => {
  const rows = Array.from({length: 15}, (_, i) => row(T + i * M, i));
  const opts = options({asOf: T + 5 * M, partialTarget: 'reject'});
  const expected = plain(resampleOHLCV(input(rows.slice(0, 5)), opts));
  assert.deepEqual(plain(resampleOHLCV(input(rows), opts)), expected);
  const changed = rows.map((bar, i) => i < 5 ? bar : {...bar, open: 1e200, high: 2e200, low: -1e200, close: 0, volume: 1e300});
  assert.deepEqual(plain(resampleOHLCV(input(changed), opts)), expected);
});

test('every future row is validated despite being ineligible at asOf', () => {
  const good = Array.from({length: 6}, (_, i) => row(T + i * M, i));
  const opts = options({asOf: T + 5 * M, partialTarget: 'reject'});
  for (const patch of [{open: NaN}, {close: Infinity}, {low: 1000}, {high: -1000}, {volume: -1}, {time: T + 5 * M + 1}, {time: T + 30 * M}, {time: T + 4 * M}]) {
    const bad = good.map(bar => ({...bar})); Object.assign(bad[5], patch);
    assert.throws(() => resampleOHLCV(input(bad), opts), JSON.stringify(patch));
  }
});

test('strict time, finite OHLCV envelope, and source columns are required', () => {
  for (const patch of [{time: NaN}, {time: Infinity}, {time: T + .5}, {time: 8640000000000001}, {open: NaN}, {high: Infinity}, {low: -Infinity}, {close: NaN}, {volume: Infinity}, {volume: -1}, {high: 99}, {low: 102}]) assert.throws(() => resampleOHLCV(input([{...row(T), ...patch}]), options()));
  assert.throws(() => resampleOHLCV(input([row(T), row(T)]), options()));
  assert.throws(() => resampleOHLCV(input([row(T + M), row(T)]), options()));
  for (const key of FIELDS) {
    const absent = input([row(T)]); delete absent.columns[key]; assert.throws(() => resampleOHLCV(absent, options()));
    const wrong = input([row(T)]); wrong.columns[key] = [wrong.columns[key][0]]; assert.throws(() => resampleOHLCV(wrong, options()));
    const short = input([row(T)]); short.columns[key] = new Float64Array(); assert.throws(() => resampleOHLCV(short, options()));
  }
  for (const length of [-1, .5, NaN, Infinity, 2, '1']) assert.throws(() => resampleOHLCV({...input([row(T)]), length}, options()));
});

test('only the active length is interpreted, preserving BarStore capacity semantics', () => {
  const rows = Array.from({length: 5}, (_, i) => row(T + i * M, i));
  assert.deepEqual(plain(resampleOHLCV(input(rows, 16), options())), plain(resampleOHLCV(input(rows), options())));
});

test('every option is required and numeric intervals are safe positive intraday multiples', () => {
  const empty = input([]), valid = options();
  for (const key of ['sourceIntervalMs', 'targetIntervalMs', 'calendar', 'kinds', 'asOf', 'partialTarget']) {const opts = {...valid}; delete opts[key]; assert.throws(() => resampleOHLCV(empty, opts), key);}
  for (const key of ['sourceIntervalMs', 'targetIntervalMs']) for (const value of [0, -1, .5, NaN, Infinity, '60000', null, DAY + 1, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => resampleOHLCV(empty, {...valid, [key]: value}), `${key} ${value}`);
  assert.throws(() => resampleOHLCV(empty, {...valid, sourceIntervalMs: 2 * M, targetIntervalMs: 3 * M}));
  assert.throws(() => resampleOHLCV(empty, {...valid, sourceIntervalMs: 5 * M, targetIntervalMs: M}));
  for (const value of [NaN, Infinity, T + .5, '0', null, 8640000000000001]) assert.throws(() => resampleOHLCV(empty, {...valid, asOf: value}));
  for (const value of [[], [''], ['regular', null], 'regular', null]) assert.throws(() => resampleOHLCV(empty, {...valid, kinds: value}));
  for (const value of ['', 'include', null, false]) assert.throws(() => resampleOHLCV(empty, {...valid, partialTarget: value}));
  for (const value of [null, {}, {at() {return null;}}]) assert.throws(() => resampleOHLCV(empty, {...valid, calendar: value}));
  const day = fixedCalendar([{open: '00:00', close: '00:00'}]);
  const oneDay = input([row('2026-03-09T00:00:00Z')]);
  assert.equal(resampleOHLCV(oneDay, options({calendar: day, sourceIntervalMs: DAY, targetIntervalMs: DAY, asOf: ts('2026-03-10T00:00:00Z'), partialTarget: 'reject'})).confirmed[0], 1);
});

test('lunch windows reset their own target grid, including short session-end targets', () => {
  const calendar = fixedCalendar([{open: '09:30', close: '09:37'}, {open: '12:02', close: '12:09'}]);
  const sessions = [{open: T, close: T + 7 * M, kind: 'regular'}, {open: ts('2026-03-09T12:02:00Z'), close: ts('2026-03-09T12:09:00Z'), kind: 'regular'}];
  const rows = sessions.flatMap(session => Array.from({length: 7}, (_, i) => row(session.open + i * M, i)));
  const result = compareOracle(rows, sessions, options({calendar, asOf: sessions[1].close, partialTarget: 'reject'}));
  assert.deepEqual([...result.columns.time], [T, T + 5 * M, sessions[1].open, sessions[1].open + 5 * M]);
  assert.deepEqual([...result.endTime], [T + 5 * M, sessions[0].close, sessions[1].open + 5 * M, sessions[1].close]);
  assert.deepEqual([...result.complete], [1, 1, 1, 1]);
  assert.throws(() => resampleOHLCV(input([row(T + 7 * M)]), options({calendar})));
  assert.throws(() => resampleOHLCV(input([row(ts('2026-03-09T12:00:00Z'))]), options({calendar})));
});

test('source grid is session-relative, and a non-minute session anchor remains exact', () => {
  const calendar = fixedCalendar([{open: '09:30:15', close: '09:40:15'}]);
  const start = T + 15000, rows = Array.from({length: 5}, (_, i) => row(start + i * M, i));
  assert.equal(resampleOHLCV(input(rows), options({calendar, partialTarget: 'reject'})).columns.time[0], start);
  assert.throws(() => resampleOHLCV(input([row(T + M)]), options({calendar})));
});

test('source bars may not cross session end and are never cropped to fit an early close', () => {
  const calendar = fixedCalendar([{open: '09:30', close: '09:37:30'}]);
  const rows = Array.from({length: 7}, (_, i) => row(T + i * M, i));
  const result = resampleOHLCV(input(rows), options({calendar}));
  assert.deepEqual([...result.endTime], [T + 5 * M, T + 7.5 * M]); assert.deepEqual([...result.complete], [1, 0]); assert.deepEqual([...result.confirmed], [1, 0]);
  assert.ok(Number.isNaN(result.availableAt[1]));
  assert.equal(resampleOHLCV(input(rows), options({calendar, partialTarget: 'omit'})).length, 1);
  assert.throws(() => resampleOHLCV(input(rows), options({calendar, partialTarget: 'reject'})));
  const overrun = [...rows, row(T + 7 * M, 7)];
  for (const asOf of [T, T + 30 * M]) assert.throws(() => resampleOHLCV(input(overrun), options({calendar, asOf})));
});

test('source crossing a target edge is rejected rather than split', () => {
  // Off-grid source at 09:34:30 would straddle the 09:35 target edge.
  assert.throws(() => resampleOHLCV(input([row(T + 4.5 * M)]), options()));
});

test('selected kinds reject outside rows and never blend adjoining sessions', () => {
  const calendar = fixedCalendar([{open: '09:00', close: '09:30', kind: 'extended'}, {open: '09:30', close: '09:35', kind: 'regular'}]);
  assert.throws(() => resampleOHLCV(input([row(T - M)]), options({calendar})));
  const rows = [row(T - M), ...Array.from({length: 5}, (_, i) => row(T + i * M, i + 1))];
  const result = resampleOHLCV(input(rows), options({calendar, kinds: ['regular', 'extended']}));
  assert.deepEqual([...result.columns.time], [T - 5 * M, T]); assert.deepEqual([...result.complete], [0, 1]);
  assert.deepEqual([...result.sourceFrom], [0, 1]); assert.deepEqual([...result.sourceTo], [1, 6]);
});

test('overnight sessions use the preceding trading-date anchor across midnight', () => {
  const calendar = fixedCalendar([{open: '22:00', close: '02:00'}], ['2026-03-09']);
  const start = ts('2026-03-09T22:00:00Z'), rows = Array.from({length: 4}, (_, i) => row(start + i * H, i));
  const result = compareOracle(rows, [{open: start, close: start + 4 * H, kind: 'regular'}], options({calendar, sourceIntervalMs: H, targetIntervalMs: 3 * H, asOf: start + 4 * H, partialTarget: 'reject'}));
  assert.deepEqual([...result.columns.time], [start, start + 3 * H]); assert.deepEqual([...result.endTime], [start + 3 * H, start + 4 * H]);
});

test('literal spring-forward and fall-back sessions aggregate real elapsed UTC slots', () => {
  for (const fixture of [
    {date: '2026-03-08', start: '2026-03-08T05:00:00Z', end: '2026-03-08T08:00:00Z', hours: 3},
    {date: '2026-11-01', start: '2026-11-01T04:00:00Z', end: '2026-11-01T09:00:00Z', hours: 5}
  ]) {
    const calendar = fixedCalendar([{open: '00:00', close: '04:00'}], [fixture.date], 'America/New_York');
    const start = ts(fixture.start), end = ts(fixture.end), rows = Array.from({length: fixture.hours}, (_, i) => row(start + i * H, i));
    compareOracle(rows, [{open: start, close: end, kind: 'regular'}], options({calendar, sourceIntervalMs: H, targetIntervalMs: 2 * H, asOf: end, partialTarget: 'reject'}));
  }
});

test('selected sessions overlapping across previous/current/next dates are rejected', () => {
  const calendar = new SessionCalendar('UTC', date => date === '2026-03-08' ? [{open: '22:00', close: '10:00'}] : date === '2026-03-09' ? [{open: '09:00', close: '11:00'}] : []);
  for (const time of ['2026-03-08T23:00:00Z', '2026-03-09T09:30:00Z']) {
    const before = cacheSnapshot(calendar);
    assert.throws(() => resampleOHLCV(input([row(time)]), options({calendar, asOf: ts('2026-03-10T00:00:00Z')})));
    assertCacheUnchanged(calendar, before);
  }
});

test('overlap in an unselected adjacent-day kind does not poison selected-session membership', () => {
  const calendar = new SessionCalendar('UTC', date => date === '2026-03-08' ? [{open: '22:00', close: '10:00', kind: 'extended'}] : date === '2026-03-09' ? [{open: '09:30', close: '10:00', kind: 'regular'}] : []);
  const rows = Array.from({length: 5}, (_, i) => row(T + i * M, i));
  assert.deepEqual([...resampleOHLCV(input(rows), options({calendar, partialTarget: 'reject'})).confirmed], [1]);
});

test('resampling does not warm, evict, replace, or mutate the caller calendar cache or input', () => {
  const calendar = fixedCalendar(undefined, ['2026-03-09'], 'UTC', {maxCachedDays: 2});
  calendar.sessions('2026-03-01'); calendar.sessions('2026-03-02');
  const source = input(Array.from({length: 5}, (_, i) => row(T + i * M, i)), 8);
  const beforeColumns = Object.fromEntries(FIELDS.map(key => [key, [...source.columns[key]]])), beforeRefs = {...source.columns};
  const before = cacheSnapshot(calendar), kinds = Object.freeze(['regular']); Object.freeze(source.columns); Object.freeze(source);
  resampleOHLCV(source, options({calendar, kinds, partialTarget: 'reject'}));
  assertCacheUnchanged(calendar, before);
  for (const key of FIELDS) {assert.equal(source.columns[key], beforeRefs[key]); assert.deepEqual([...source.columns[key]], beforeColumns[key]);}
  assert.deepEqual(kinds, ['regular']);
});

test('validation and aggregation failures preserve the caller cache and OHLCV exactly', () => {
  const calendar = fixedCalendar(); calendar.sessions('2026-03-09');
  const before = cacheSnapshot(calendar);
  const rows = Array.from({length: 5}, (_, i) => row(T + i * M, i, Number.MAX_VALUE));
  const source = input(rows), snapshot = Object.fromEntries(FIELDS.map(key => [key, [...source.columns[key]]]));
  assert.throws(() => resampleOHLCV(source, options({calendar, partialTarget: 'reject'})));
  assertCacheUnchanged(calendar, before); for (const key of FIELDS) assert.deepEqual([...source.columns[key]], snapshot[key]);
  assert.throws(() => resampleOHLCV(input([row(T + 1)]), options({calendar})));
  assertCacheUnchanged(calendar, before);
});

test('sum overflow rejects within a populated group, while finite maximum values and zero volume are valid', () => {
  const calendar = fixedCalendar([{open: '09:30', close: '09:32'}]);
  const opts = options({calendar, targetIntervalMs: 2 * M, partialTarget: 'reject'});
  assert.throws(() => resampleOHLCV(input([row(T, 0, Number.MAX_VALUE), row(T + M, 1, Number.MAX_VALUE)]), opts));
  assert.equal(resampleOHLCV(input([row(T, 0, Number.MAX_VALUE), row(T + M, 1, 0)]), opts).columns.volume[0], Number.MAX_VALUE);
  assert.equal(resampleOHLCV(input([row(T, 0, 0), row(T + M, 1, 0)]), opts).columns.volume[0], 0);
  assert.throws(() => resampleOHLCV(input([row(8640000000000000)]), opts));
});

test('deterministic enumeration oracle covers gaps, as-of cuts, lunch, early closes, and every partial policy', () => {
  const random = generator(), sessions = [{open: T, close: T + 11 * M, kind: 'regular'}, {open: T + 157 * M, close: T + 170 * M, kind: 'regular'}];
  const calendar = fixedCalendar([{open: '09:30', close: '09:41'}, {open: '12:07', close: '12:20'}]);
  for (let trial = 0; trial < 64; trial++) {
    const rows = sessions.flatMap(session => Array.from({length: (session.close - session.open) / M}, (_, i) => row(session.open + i * M, Math.floor(random() * 50), Math.floor(random() * 10))).filter(() => random() > .23));
    const asOf = [T - 1, T + M, T + 5 * M - 1, T + 11 * M, T + 160 * M, T + 170 * M][trial % 6];
    for (const partialTarget of ['include-unconfirmed', 'omit', 'reject']) {
      const opts = options({calendar, targetIntervalMs: [2, 3, 5][trial % 3] * M, asOf, partialTarget});
      let expected;
      try {expected = oracle(rows, sessions, opts);} catch {assert.throws(() => resampleOHLCV(input(rows), opts), `oracle rejection trial ${trial}`); continue;}
      const result = resampleOHLCV(input(rows), opts); checkShape(result); assert.deepEqual(plain(result), expected, `oracle trial ${trial} ${partialTarget}`);
    }
  }
});

// Alignment: information availability rather than a price-open timestamp join.
function timing(endTime, {confirmed = endTime.map(() => 1), complete = endTime.map(() => 1), availableAt, asOf = endTime.at(-1) ?? T} = {}) {
  return {length: endTime.length, endTime: Float64Array.from(endTime), availableAt: Float64Array.from(availableAt ?? endTime.map((end, i) => confirmed[i] ? end : NaN)), complete: Uint8Array.from(complete), confirmed: Uint8Array.from(confirmed), asOf};
}
function cloneTiming(source) {return {...source, endTime: source.endTime.slice(), availableAt: source.availableAt.slice(), complete: source.complete.slice(), confirmed: source.confirmed.slice()};}
function alignmentOracle(decisions, values, meta) {
  return decisions.map(decision => {
    let value = NaN;
    for (let i = 0; i < meta.length; i++) if (meta.confirmed[i] && meta.availableAt[i] <= decision && meta.availableAt[i] <= meta.asOf) value = values[i];
    return value;
  });
}

test('confirmed alignment becomes visible exactly at close, carries over gaps, and ignores incomplete targets', () => {
  const ends = [T + 5 * M, T + 10 * M, T + 15 * M, T + 20 * M];
  const meta = timing(ends, {confirmed: [1, 0, 1, 0], complete: [1, 0, 1, 0], asOf: T + 17 * M});
  const decisions = Float64Array.from([T, ends[0] - 1, ends[0], ends[1], ends[2] - 1, ends[2], ends[3], ends[3] + DAY]);
  const result = alignConfirmedByTime(decisions, Float64Array.from([10, 999, 30, 888]), meta);
  assert.ok(result instanceof Float64Array); assert.deepEqual([...result], [NaN, NaN, 10, 10, 10, 30, 30, 30]);
});

test('confirmed NaN is an explicit reset; unconfirmed NaN never resets prior carry', () => {
  const ends = Array.from({length: 5}, (_, i) => T + (i + 1) * M);
  const meta = timing(ends, {confirmed: [1, 0, 1, 0, 1], complete: [1, 0, 1, 0, 1]});
  const values = Float64Array.from([10, NaN, NaN, 999, 50]);
  const decisions = Float64Array.from([T, ...ends, ends.at(-1) + M]);
  assert.deepEqual([...alignConfirmedByTime(decisions, values, meta)], [NaN, 10, 10, NaN, NaN, 50, 50]);
});

test('aligned resampled bars preserve no-lookahead behavior at every source and target boundary', () => {
  const rows = Array.from({length: 15}, (_, i) => row(T + i * M, i));
  const decisions = Float64Array.from(Array.from({length: 18}, (_, i) => T + i * M));
  for (const asOf of [T, T + 4 * M, T + 5 * M, T + 10 * M, T + 15 * M]) {
    const resampled = resampleOHLCV(input(rows), options({asOf}));
    const actual = alignConfirmedByTime(decisions, resampled.columns.close, resampled);
    assert.deepEqual([...actual], alignmentOracle([...decisions], resampled.columns.close, resampled));
    for (let i = 0; i < decisions.length; i++) if (Math.min(asOf, decisions[i]) < T + 5 * M) assert.ok(Number.isNaN(actual[i]));
  }
});

test('empty timings and empty decision vectors return typed empty/gap outputs', () => {
  const empty = timing([], {asOf: T});
  assert.deepEqual([...alignConfirmedByTime(Float64Array.from([T, T + M]), new Float64Array(), empty)], [NaN, NaN]);
  const result = alignConfirmedByTime(new Float64Array(), Float64Array.from([1]), timing([T])); assert.ok(result instanceof Float64Array); assert.equal(result.length, 0);
});

test('alignment validates all decision times and all values, including future and unconfirmed entries', () => {
  const meta = timing([T, T + M], {confirmed: [1, 0], complete: [1, 0], asOf: T});
  for (const decisions of [Float64Array.from([T, T]), Float64Array.from([T + M, T]), Float64Array.from([T + .5]), Float64Array.from([NaN]), Float64Array.from([Infinity]), Float64Array.from([8640000000000001])]) assert.throws(() => alignConfirmedByTime(decisions, Float64Array.from([1, 2]), meta));
  for (const values of [Float64Array.from([1, Infinity]), Float64Array.from([1, -Infinity]), Float64Array.from([1]), Float64Array.from([1, 2, 3]), [1, null], [1, 2], null]) assert.throws(() => alignConfirmedByTime(Float64Array.from([T]), values, meta));
  assert.deepEqual([...alignConfirmedByTime(Float64Array.from([T]), Float64Array.from([1, NaN]), meta)], [1]);
});

test('alignment rejects corrupt flags, end ordering, availability, lengths, and asOf metadata', () => {
  const valid = timing([T + M, T + 2 * M, T + 3 * M], {confirmed: [1, 0, 1], complete: [1, 0, 1]});
  const changes = [
    meta => meta.length = -1, meta => meta.length = .5, meta => meta.length = 4,
    meta => meta.endTime = new Float64Array(2), meta => meta.availableAt = new Float64Array(2), meta => meta.complete = new Uint8Array(2), meta => meta.confirmed = new Uint8Array(2),
    meta => meta.endTime[1] = meta.endTime[0], meta => meta.endTime[1] = meta.endTime[0] - 1, meta => meta.endTime[1] = NaN, meta => meta.endTime[1] += .5,
    meta => meta.complete[1] = 2, meta => meta.confirmed[1] = 2, meta => meta.complete[0] = 0,
    meta => meta.availableAt[0] = NaN, meta => meta.availableAt[0] = meta.endTime[0] - 1, meta => meta.availableAt[0] = Infinity,
    meta => meta.availableAt[1] = meta.endTime[1], meta => meta.asOf = meta.endTime[2] - 1,
    meta => meta.asOf = NaN, meta => meta.asOf = Infinity, meta => meta.asOf = T + .5, meta => meta.asOf = '0'
  ];
  for (const change of changes) {const meta = cloneTiming(valid); change(meta); assert.throws(() => alignConfirmedByTime(Float64Array.from([T]), Float64Array.from([1, 2, 3]), meta), change.toString());}
  for (const key of ['length', 'endTime', 'availableAt', 'complete', 'confirmed', 'asOf']) {const meta = cloneTiming(valid); delete meta[key]; assert.throws(() => alignConfirmedByTime(Float64Array.from([T]), Float64Array.from([1, 2, 3]), meta), key);}
  // Even empty decisions cannot hide a corrupted future/unconfirmed timing.
  const badFuture = cloneTiming(valid); badFuture.endTime[1] = NaN;
  assert.throws(() => alignConfirmedByTime(new Float64Array(), Float64Array.from([1, 2, 3]), badFuture));
});

test('alignment leaves decisions, values, and timing unchanged on success and rejection', () => {
  const decisions = Float64Array.from([T, T + M, T + 2 * M]), values = Float64Array.from([10, NaN]);
  const meta = timing([T + M, T + 2 * M]), snapshot = cloneTiming(meta), beforeDecisions = decisions.slice(), beforeValues = values.slice();
  Object.freeze(meta); alignConfirmedByTime(decisions, values, meta);
  assert.deepEqual(decisions, beforeDecisions); assert.deepEqual(values, beforeValues); assert.deepEqual(meta, snapshot);
  const bad = cloneTiming(meta); bad.availableAt[0] = NaN; const badSnapshot = cloneTiming(bad);
  assert.throws(() => alignConfirmedByTime(decisions, values, bad)); assert.deepEqual(bad, badSnapshot); assert.deepEqual(decisions, beforeDecisions); assert.deepEqual(values, beforeValues);
});

test('deterministic independent alignment oracle checks all prior confirmations and NaN resets', () => {
  const random = generator(0xabcdef01);
  for (let trial = 0; trial < 64; trial++) {
    const ends = Array.from({length: 12}, (_, i) => T + (i + 1) * 3 * M), confirmed = ends.map(() => Number(random() > .3));
    const meta = timing(ends, {confirmed, complete: confirmed.map(flag => flag || Number(random() > .5)), asOf: ends.at(-1)});
    const values = Float64Array.from(ends.map(() => random() < .2 ? NaN : Math.floor(random() * 1000)));
    const decisions = Float64Array.from(Array.from({length: 42}, (_, i) => T + i * M));
    assert.deepEqual([...alignConfirmedByTime(decisions, values, meta)], alignmentOracle([...decisions], values, meta), `trial ${trial}`);
  }
});

test('result owns its typed arrays instead of aliasing input storage or sibling results', () => {
  const source = input(Array.from({length: 5}, (_, i) => row(T + i * M, i)));
  const first = resampleOHLCV(source, options()), second = resampleOHLCV(source, options());
  const before = Object.fromEntries(FIELDS.map(key => [key, [...source.columns[key]]]));
  const secondBefore = plain(second);
  for (const key of FIELDS) {assert.notEqual(first.columns[key].buffer, source.columns[key].buffer); first.columns[key][0] = 777;}
  for (const key of ['endTime', 'availableAt', 'sourceFrom', 'sourceTo', 'complete', 'confirmed']) first[key][0] = 0;
  for (const key of FIELDS) assert.deepEqual([...source.columns[key]], before[key]);
  assert.deepEqual(plain(second), secondBefore);
});

test('one-millisecond source and target boundaries retain exact integer UTC precision', () => {
  const start = T, rows = Array.from({length: 8}, (_, i) => row(start + i, i));
  const opts = options({sourceIntervalMs: 1, targetIntervalMs: 4, asOf: start + 8, partialTarget: 'reject'});
  const actual = resampleOHLCV(input(rows), opts);
  assert.deepEqual([...actual.columns.time], [start, start + 4]); assert.deepEqual([...actual.endTime], [start + 4, start + 8]);
  assert.deepEqual([...actual.sourceFrom], [0, 4]); assert.deepEqual([...actual.sourceTo], [4, 8]); assert.deepEqual([...actual.confirmed], [1, 1]);
  const decisions = Float64Array.from([start + 3, start + 4, start + 7, start + 8]);
  assert.deepEqual([...alignConfirmedByTime(decisions, actual.columns.close, actual)], [NaN, 104, 104, 108]);
});

test('equal source and target intervals confirm each supplied slot without synthesizing gaps', () => {
  const rows = [row(T, 0), row(T + 10 * M, 1), row(T + 29 * M, 2)];
  const actual = resampleOHLCV(input(rows), options({targetIntervalMs: M, partialTarget: 'reject'}));
  assert.deepEqual([...actual.columns.time], rows.map(bar => bar.time)); assert.deepEqual([...actual.confirmed], [1, 1, 1]); assert.deepEqual([...actual.sourceFrom], [0, 1, 2]); assert.deepEqual([...actual.sourceTo], [1, 2, 3]);
});

test('each consulted calendar date is captured once per invocation without touching prior cache entries', () => {
  const calls = [], calendar = new SessionCalendar('UTC', date => {calls.push(date); return date === '2026-03-09' ? [{open: '09:30', close: '10:00'}] : [];});
  calendar.sessions('2026-02-01'); calls.length = 0;
  const before = cacheSnapshot(calendar), source = input(Array.from({length: 10}, (_, i) => row(T + i * M, i)));
  resampleOHLCV(source, options({calendar, partialTarget: 'reject'}));
  assert.ok(calls.includes('2026-03-09')); assert.equal(calls.length, new Set(calls).size); assertCacheUnchanged(calendar, before);
});

test('shared mutable backing stores are rejected for source columns and alignment buffers', () => {
  if (typeof SharedArrayBuffer === 'undefined') return;
  const shared = (Constructor, array) => {const copy = new Constructor(new SharedArrayBuffer(Constructor.BYTES_PER_ELEMENT * array.length)); copy.set(array); return copy;};
  const validSource = input([row(T)]);
  for (const key of FIELDS) {
    const source = {columns: {...validSource.columns, [key]: shared(Float64Array, validSource.columns[key])}, length: 1};
    assert.throws(() => resampleOHLCV(source, options()), `shared source ${key}`);
  }
  const valid = timing([T]);
  assert.throws(() => alignConfirmedByTime(shared(Float64Array, [T]), Float64Array.from([1]), valid));
  assert.throws(() => alignConfirmedByTime(Float64Array.from([T]), shared(Float64Array, [1]), valid));
  for (const key of ['endTime', 'availableAt', 'complete', 'confirmed']) {
    const Constructor = key === 'complete' || key === 'confirmed' ? Uint8Array : Float64Array;
    const meta = {...valid, [key]: shared(Constructor, valid[key])};
    assert.throws(() => alignConfirmedByTime(Float64Array.from([T]), Float64Array.from([1]), meta), `shared timing ${key}`);
  }
});
