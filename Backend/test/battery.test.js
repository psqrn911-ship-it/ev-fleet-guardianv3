'use strict';
// Run with: npm test   (Node's built-in test runner, no extra packages)
// The synthetic readings below exist only inside these tests to check the maths against known answers.
const test = require('node:test'), assert = require('node:assert/strict');
const B = require('../lib/battery'), P = require('../lib/pipeline'), A = require('../lib/advisor');

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`);
// Feed readings one by one the way the server does, round-tripping the state through JSON like the database does.
function run(spec, readings, opts = {}) {
  let state = {}; const events = [], estimates = []; let last;
  for (const r of readings) { last = P.process({ spec, state: JSON.parse(JSON.stringify(state)), reading: r, fence: opts.fence, name: 'EV1', now: r.t }); state = last.state; events.push(...last.events); estimates.push(...last.estimates); }
  return { state, events, estimates, last };
}
const spec100 = B.resolveSpec({ ratedAh: 100, nominalV: 360, chemistry: 'NMC', cellsSeries: 96 });

test('SOC: coulomb counting matches a known discharge (50 A for 1 h on 100 Ah = 50 points)', () => {
  const rs = []; for (let i = 0; i <= 360; i++) rs.push({ t: T0 + i * 10000, current: 50, voltage: 350, ...(i === 0 ? { battery: 100 } : {}) });
  const { state } = run(spec100, rs); near(state.soc.value, 50, 0.1, 'SOC after 1 h');
  near(state.thru.dis, 50, 0.1, 'discharged Ah');
});
test('SOC: charging raises SOC and is clamped at 100 %', () => {
  const rs = []; for (let i = 0; i <= 400; i++) rs.push({ t: T0 + i * 10000, current: -60, voltage: 380, ...(i === 0 ? { battery: 90 } : {}) });
  assert.equal(run(spec100, rs).state.soc.value, 100);
});
test('SOC: survives a server restart (state is persisted, never reset to 100 %)', () => {
  const a = run(spec100, [{ t: T0, current: 50, voltage: 350, battery: 80 }, { t: T0 + 10000, current: 50, voltage: 350 }]);
  const restored = JSON.parse(JSON.stringify(a.state)), r = P.process({ spec: spec100, state: restored, reading: { t: T0 + 20000, current: 50, voltage: 350 }, name: 'EV1', now: T0 + 20000 });
  assert.ok(r.state.soc.value < 80 && r.state.soc.value > 79, 'continues from persisted value ' + r.state.soc.value);
});
test('SOC: never integrates across a long gap and flags stale data', () => {
  const { state, last } = run(spec100, [{ t: T0, current: 50, voltage: 350, battery: 80 }, { t: T0 + 600000, current: 50, voltage: 350 }]);
  assert.equal(state.soc.value, 80); assert.ok(state.soc.stale); assert.match(last.limitations.join(' '), /held/);
});
test('SOC: unavailable (not invented) without rated capacity or a starting value', () => {
  const none = B.resolveSpec({}), a = run(none, [{ t: T0, current: 10, voltage: 350, battery: 70 }]);
  assert.equal(a.state.soc, null); assert.match(a.last.limitations[0], /Rated capacity/); assert.equal(a.estimates.length, 0);
  const b = run(spec100, [{ t: T0, current: 50, voltage: 350 }]); assert.equal(b.state.soc, null); assert.match(b.last.limitations[0], /No valid starting SOC/);
});
test('SOC: implausible current is ignored rather than integrated', () => {
  const { state } = run(B.resolveSpec({ ratedAh: 50 }), [{ t: T0, current: 10, voltage: 350, battery: 80 }, { t: T0 + 10000, current: 1900, voltage: 350 }]); assert.equal(state.soc.value, 80);
});
test('SOH: known capacities give the expected percentage', () => {
  const caps = [{ ah: 90 }, { ah: 90 }, { ah: 90 }]; const h = B.sohFrom(caps, spec100);
  assert.equal(h.status, 'ok'); assert.equal(h.pct, 90); assert.equal(h.capacityAh, 90);
  assert.equal(B.sohFrom([{ ah: 90 }], spec100).status, 'insufficient');
  assert.equal(B.sohFrom(caps, B.resolveSpec({})).status, 'unavailable');
});
test('Capacity: a full discharge run recovers the true capacity within 3 %', () => {
  const TRUE = 90, rs = []; let ah = 0;
  for (let i = 0; i <= 300; i++) { rs.push({ t: T0 + i * 10000, current: 45, voltage: 350, battery: Math.round(100 - ah / TRUE * 100) }); ah += 45 * 10 / 3600; }
  rs.push({ t: T0 + 301 * 10000, current: 0, voltage: 360, battery: rs[rs.length - 1].battery });      // run ends -> observation is finalised
  const { estimates, state } = run(spec100, rs), cap = estimates.find(e => e.kind === 'capacity');
  assert.ok(cap, 'a capacity estimate was produced'); near(cap.value, TRUE, TRUE * 0.03, 'capacity'); assert.equal(state.caps.length, 1);
});
test('Capacity: a small SOC swing does not produce an observation', () => {
  const rs = []; let ah = 0;
  for (let i = 0; i <= 40; i++) { rs.push({ t: T0 + i * 10000, current: 45, voltage: 350, battery: Math.round(100 - ah / 90 * 100) }); ah += 45 * 10 / 3600; }
  rs.push({ t: T0 + 41 * 10000, current: 0, voltage: 360, battery: 95 }); assert.equal(run(spec100, rs).estimates.length, 0);
});
test('RUL: refuses to predict with little or short history', () => {
  const r = B.rul([{ t: T0, ah: 95, efc: 10 }, { t: T0 + 864e5, ah: 94, efc: 12 }], spec100, 12);
  assert.equal(r.status, 'insufficient'); assert.equal(r.message, 'Insufficient data for reliable RUL prediction');
  assert.equal(B.rul([], spec100, 0).status, 'insufficient');
});
test('RUL: a clean linear decline gives the known cycles remaining', () => {
  // 100 Ah -> loses 0.02 Ah per cycle; EOL (80 %) = 80 Ah is reached at cycle 1000; now at cycle 200 -> 800 remain
  const caps = []; for (let i = 0; i < 10; i++) caps.push({ t: T0 + i * 3 * 864e5, efc: 20 * i + 20, ah: 100 - 0.02 * (20 * i + 20) });
  const r = B.rul(caps, spec100, 200); assert.equal(r.status, 'ok'); near(r.cycles, 800 + 0, 5); assert.ok(r.r2 > 0.99); assert.match(r.method, /not a machine-learning/);
});
test('RUL: noisy data is reported as unreliable, not extrapolated', () => {
  const ys = [95, 70, 99, 72, 98, 71, 97, 73, 96, 70], caps = ys.map((ah, i) => ({ t: T0 + i * 3 * 864e5, efc: 10 * i + 10, ah }));
  assert.equal(B.rul(caps, spec100, 100).status, 'unreliable');
});
test('Resistance: known step gives the known value and bad steps are rejected', () => {
  const last = { t: T0, i: 20, v: 360, temp: 25 };
  near(B.irPair(last, { t: T0 + 2000, current: 50, voltage: 357, temp: 25 }, spec100), 100, 0.01, '30 A step, 3 V drop = 100 mΩ');
  assert.equal(B.irPair(last, { t: T0 + 2000, current: 22, voltage: 359.9 }, spec100), null, 'current step too small');
  assert.equal(B.irPair(last, { t: T0 + 60000, current: 50, voltage: 357 }, spec100), null, 'samples too far apart');
  assert.equal(B.irPair(last, { t: T0 + 2000, current: 50, voltage: 365 }, spec100), null, 'voltage rose under more load: non-physical');
  assert.equal(B.irPair(last, { t: T0 + 2000, current: 50, voltage: 357, temp: 35 }, spec100), null, 'temperature moved too much');
  assert.equal(B.irPair(last, { t: T0 + 2000, current: 50 }, spec100), null, 'missing voltage');
});
test('Thermal: needs persistence, then raises once, holds inside hysteresis, clears below warn-3', () => {
  const spec = B.resolveSpec({ ratedAh: 100, tempWarnC: 45, tempCritC: 55 }), rs = [];
  const temps = [30, 46, 46, 46, 46, 44, 43, 41, 40];            // 3rd consecutive hot reading raises; 44 and 43 are inside the band; 41 clears
  temps.forEach((tc, i) => rs.push({ t: T0 + i * 10000, temp: tc, current: 5, voltage: 350 }));
  const ev = run(spec, rs).events.filter(e => e.key === 'thermal');
  assert.deepEqual(ev.map(e => e.kind), ['raise', 'clear']); assert.equal(ev[0].severity, 'warning'); assert.match(ev[0].message, /software monitoring alert only/);
});
test('Thermal: critical escalates once and a single spike does not alert', () => {
  const spec = B.resolveSpec({ ratedAh: 100 }), mk = tc => tc.map((x, i) => ({ t: T0 + i * 10000, temp: x, current: 5, voltage: 350 }));
  assert.equal(run(spec, mk([30, 60, 30, 30])).events.filter(e => e.key === 'thermal').length, 0);
  const kinds = run(spec, mk([30, 46, 46, 46, 56, 56, 56])).events.filter(e => e.key === 'thermal');
  assert.deepEqual(kinds.map(e => e.severity), ['warning', 'critical']);
  assert.match(kinds[0].message, /provisional/);
});
test('Heating rate: a fast rise raises an abnormal-heating alert', () => {
  const rs = []; for (let i = 0; i < 20; i++) rs.push({ t: T0 + i * 10000, temp: 30 + i * 0.8, current: 5, voltage: 350 });     // 4.8 °C/min
  assert.ok(run(B.resolveSpec({ ratedAh: 100 }), rs).events.some(e => e.key === 'thermal_rate' && e.kind === 'raise'));
});
test('Sensors: disconnected probe (-127) and missing values raise sensor alerts', () => {
  const rs = []; for (let i = 0; i < 6; i++) rs.push({ t: T0 + i * 10000, current: 5, voltage: 350, invalid: ['temp'] });
  assert.ok(run(B.resolveSpec({ ratedAh: 100 }), rs).events.some(e => e.key === 'sensor_bad_temp'));
  const ms = [{ t: T0, temp: 30, current: 5, voltage: 350 }]; for (let i = 1; i <= 6; i++) ms.push({ t: T0 + i * 10000, current: 5, voltage: 350 });
  assert.ok(run(B.resolveSpec({ ratedAh: 100 }), ms).events.some(e => e.key === 'sensor_missing_temp'));
});
test('Sensors: the DS18B20 power-on value 85 °C after a cool reading is not treated as heat', () => {
  const ev = run(B.resolveSpec({ ratedAh: 100 }), [30, 85, 85, 85, 85].map((tc, i) => ({ t: T0 + i * 10000, temp: tc, current: 5, voltage: 350 }))).events;
  assert.equal(ev.filter(e => e.key === 'thermal').length, 0);
});
test('Geofence: raises after 2 consecutive outside readings, once, and clears on return', () => {
  const fence = { enabled: true, lat: 12.97, lng: 77.59, radiusKm: 2 }, far = { lat: 13.1, lon: 77.59 }, near2 = { lat: 12.97, lon: 77.59 };
  const rs = [near2, far, far, far, far, near2, near2].map((p, i) => ({ t: T0 + i * 10000, current: 5, voltage: 350, ...p }));
  const ev = run(B.resolveSpec({ ratedAh: 100 }), rs, { fence }).events.filter(e => e.key === 'geofence');
  assert.deepEqual(ev.map(e => e.kind), ['raise', 'clear']); assert.equal(ev[0].severity, 'critical');
  assert.equal(run(B.resolveSpec({ ratedAh: 100 }), [{ t: T0, lat: 0, lon: 0, current: 5, voltage: 350 }, { t: T0 + 10000, lat: 0, lon: 0, current: 5, voltage: 350 }], { fence }).events.length, 0, '(0,0) is "no fix", not a breach');
});
test('Alerts: low SOC, voltage limits only when configured, and over-current', () => {
  const rs = []; for (let i = 0; i < 6; i++) rs.push({ t: T0 + i * 10000, battery: 8, current: 5, voltage: 300 });
  assert.ok(run(B.resolveSpec({ ratedAh: 100 }), rs).events.some(e => e.key === 'soc_low' && e.severity === 'critical'));
  assert.ok(!run(B.resolveSpec({ ratedAh: 100 }), rs).events.some(e => e.key === 'voltage_low'), 'no limit configured -> no voltage alert');
  assert.ok(run(B.resolveSpec({ ratedAh: 100, vMin: 320, vMax: 400 }), rs).events.some(e => e.key === 'voltage_low'));
  const oc = []; for (let i = 0; i < 5; i++) oc.push({ t: T0 + i * 10000, battery: 60, current: 200, voltage: 340 });
  assert.ok(run(B.resolveSpec({ ratedAh: 100, maxDischargeA: 150 }), oc).events.some(e => e.key === 'current_high'));
});
test('Cell imbalance and insulation: only evaluated when the device reports them', () => {
  const rs = []; for (let i = 0; i < 5; i++) rs.push({ t: T0 + i * 10000, current: 5, voltage: 350, cellMin: 3.60, cellMax: 3.78, insKohm: 100 });
  const ev = run(B.resolveSpec({ ratedAh: 100, insulationMinKohm: 500 }), rs).events;
  assert.ok(ev.some(e => e.key === 'imbalance') && ev.some(e => e.key === 'insulation'));
  const plain = []; for (let i = 0; i < 5; i++) plain.push({ t: T0 + i * 10000, current: 5, voltage: 350 });
  const s = P.summarize(spec100, run(spec100, plain).state, { voltage: 350 });
  assert.equal(s.imbalance.supported, false); assert.equal(s.insulation.supported, false);
});
test('Pipeline: duplicate or out-of-order timestamps are ignored', () => {
  const a = run(spec100, [{ t: T0, current: 50, voltage: 350, battery: 80 }]), r = P.process({ spec: spec100, state: a.state, reading: { t: T0 - 1000, current: 50, voltage: 350 }, name: 'x' });
  assert.ok(r.skipped);
});
test('Summary: reports measured vs estimated SOC separately and lists missing specs', () => {
  const run1 = run(spec100, [{ t: T0, current: 50, voltage: 350, battery: 80 }, { t: T0 + 10000, current: 50, voltage: 350, battery: 80 }]);
  const s = P.summarize(spec100, run1.state, { battery: 80, voltage: 350, current: 50 });
  assert.equal(s.soc.reported, 80); assert.ok(s.soc.estimated < 80); assert.equal(s.soh.status, 'insufficient'); assert.equal(s.rul.status, 'insufficient');
  assert.ok(!s.missing.some(m => m.field === 'vMin/vMax'), 'derived from chemistry + cells');
  assert.ok(P.summarize(B.resolveSpec({ ratedAh: 100 }), {}, null).missing.some(m => m.field === 'vMin/vMax'));
  assert.equal(P.summarize(B.resolveSpec({}), {}, null).missing[0].field, 'ratedAh');
});

// ── Advisor ──
function hourly(days, { cur = 40, drop = 4, dep = 7 }) {          // synthetic week: drive 2 h each morning, charge overnight
  const b = []; let soc = 90;
  for (let d = 0; d < days; d++) for (let h = 0; h < 24; h++) {
    const t = Date.UTC(2026, 0, 1 + d, h - 5, -30), driving = h === dep || h === dep + 1, charging = h >= 20 || h < 4;      // local = UTC + 5:30
    b.push({ t, soc, cur: driving ? cur : charging ? -20 : 0, n: 10 }); soc = Math.max(10, Math.min(95, soc + (driving ? -drop : charging ? 5 : 0)));
  }
  return b;
}
test('Advisor: says it is still learning when there is not enough data', () => {
  const r = A.advise({ spec: spec100, buckets: hourly(1, {}).slice(0, 20), socNow: 50, now: T0 }); assert.equal(r.status, 'collecting'); assert.match(r.message, /Still learning/);
  assert.equal(A.advise({ spec: spec100, buckets: [], socNow: null }).status, 'unavailable');
});
test('Advisor: with a week of history it recommends a target, energy and a start time, and labels itself a baseline', () => {
  const now = Date.UTC(2026, 0, 8, 12, 0), r = A.advise({ spec: spec100, buckets: hourly(7, {}), socNow: 30, capacityAh: 90, now, tz: 'Asia/Kolkata' });
  assert.equal(r.status, 'ok'); assert.ok(r.targetSoc >= 40 && r.targetSoc <= 90); assert.ok(r.needPct > 0); assert.ok(r.energyKwh > 0); assert.ok(r.startBy);
  assert.match(r.method, /not a trained machine-learning model/i); assert.match(r.message, /Charge to/);
  assert.equal(A.advise({ spec: spec100, buckets: hourly(7, {}), socNow: 95, now }).needPct, 0);
});

test('Offline tracker (used by the scheduled check) raises once, reminds rarely, and tolerates a partial stored record', () => {
  const alerts = { offline: {} }, H = 36e5;     // a record written by an older version may lack fields
  assert.equal(P.track(alerts, 'offline', { raised: true, persist: 1, remindMs: 6 * H }, T0), 'raise');
  assert.equal(P.track(alerts, 'offline', { raised: true, persist: 1, remindMs: 6 * H }, T0 + H), null);
  assert.equal(P.track(alerts, 'offline', { raised: true, persist: 1, remindMs: 6 * H }, T0 + 7 * H), 'remind');
  assert.equal(P.track(alerts, 'offline', { raised: false, cleared: true }, T0 + 8 * H), 'clear');
});

// ── MPU6050 motion and standard voltage limits ──
test('Motion: gravity is removed, any orientation, units converted, peak values honoured', () => {
  near(B.motion({ ax: 0, ay: 0, az: 1 }).gForce, 0, 0.001, 'at rest, flat');
  near(B.motion({ ax: 1, ay: 0, az: 0 }).gForce, 0, 0.001, 'at rest, on its side');
  near(B.motion({ ax: 0.6, ay: 0, az: 1.2 }).gForce, Math.hypot(0.6, 1.2) - 1, 0.001, 'moving');
  near(B.motion({ ax: 0, ay: 0, az: 19.6133, accel_unit: 'ms2' }).gForce, 1, 0.001, 'm/s² input');
  assert.equal(B.motion({ ax: 0, ay: 0, az: 1, g_peak: 0.9 }).gForce, 0.9);
  assert.equal(B.motion({ gx: 3, gy: 4, gz: 0 }).gyroDps, 5);
  assert.deepEqual(B.motion({}), {}); assert.ok(B.motion({ ax: 90, ay: 0, az: 0 }).invalid, 'beyond sensor range');
});
test('Motion: thresholds raise a warning, escalate to critical, and obey the cooldown', () => {
  const spec = B.resolveSpec({ ratedAh: 100 }), mk = gs => gs.map((g, i) => ({ t: T0 + i * 10000, current: 5, voltage: 350, gForce: g }));
  const ev = run(spec, mk([0.05, 0.5, 0.05, 0.05, 1.2, 0.05])).events.filter(e => e.key === 'accel');
  assert.deepEqual(ev.map(e => e.severity), ['warning', 'critical']);
  assert.match(ev[0].message, /provisional/); assert.equal(ev[0].type, 'motion');
  // a second spike inside the 30 s cooldown is suppressed
  assert.equal(run(spec, mk([0.5, 0.05, 0.5, 0.05])).events.filter(e => e.key === 'accel').length, 1);
  // below warning -> nothing
  assert.equal(run(spec, mk([0.1, 0.3, 0.2])).events.filter(e => e.key === 'accel').length, 0);
});
test('Motion: custom thresholds replace the provisional defaults', () => {
  const spec = B.resolveSpec({ ratedAh: 100, accelWarnG: 0.2, accelCritG: 0.5, gyroWarnDps: 60, gyroCritDps: 100 });
  assert.ok(!spec.provisional.includes('accelWarnG'));
  const rs = [{ t: T0, current: 5, voltage: 350, gForce: 0.25, gyroDps: 150 }];
  const ev = run(spec, rs).events; assert.ok(ev.some(e => e.key === 'accel' && e.severity === 'warning')); assert.ok(ev.some(e => e.key === 'gyro' && e.severity === 'critical'));
  assert.doesNotMatch(ev.find(e => e.key === 'accel').message, /provisional/);
});
test('Voltage: standard limits are derived from chemistry and cell count, labelled provisional, and user values win', () => {
  const s = B.resolveSpec({ ratedAh: 100, chemistry: 'NMC', cellsSeries: 96 });
  near(s.vMax, 4.2 * 96 * 1.01, 0.1); near(s.vMin, 3.0 * 96 * 0.99, 0.1); assert.ok(s.provisional.includes('vMax') && s.provisional.includes('vMin'));
  const own = B.resolveSpec({ ratedAh: 100, chemistry: 'NMC', cellsSeries: 96, vMax: 400, vMin: 300 }); assert.equal(own.vMax, 400); assert.ok(!own.provisional.includes('vMax'));
  assert.equal(B.resolveSpec({ ratedAh: 100 }).vMax, undefined, 'unknown chemistry: no guessed limit');
  assert.equal(B.resolveSpec({ ratedAh: 100, chemistry: 'LEAD_ACID', cellsSeries: 6 }).vMax, undefined);
  const hi = []; for (let i = 0; i < 5; i++) hi.push({ t: T0 + i * 10000, current: 5, voltage: 430, battery: 60 });
  const ev = run(s, hi).events.find(e => e.key === 'voltage_high'); assert.ok(ev); assert.equal(ev.severity, 'critical'); assert.match(ev.message, /provisional/);
  const ok = []; for (let i = 0; i < 5; i++) ok.push({ t: T0 + i * 10000, current: 5, voltage: 403, battery: 100 });     // 96 × 4.2 V = 403 V: a full pack is not an alarm
  assert.ok(!run(s, ok).events.some(e => e.key === 'voltage_high'));
});
