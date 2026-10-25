'use strict';
// Pure battery-estimation maths. No I/O, no database, no clock: everything is a function of its inputs.
// Sign convention (same as the existing project): current > 0 = discharging, current < 0 = charging.

const CFG = {
  MAX_GAP_S: 120,          // never integrate current across a gap longer than this
  REST_MIN_S: 1200,        // pack must be at rest this long before resting-voltage correction is trusted
  MIN_SEG_DELTA_SOC: 30,   // a capacity observation needs at least this much SOC swing (percentage points)
  IR_MAX_DT_S: 15,         // voltage/current pair must be this close in time to estimate resistance
  IR_STORE_EVERY_S: 600,   // store at most one resistance estimate per 10 minutes
  SOH_MIN_POINTS: 3,
  SOH_WINDOW: 5,
  RUL_MIN_POINTS: 8,
  RUL_MIN_SPAN_DAYS: 14,
  RUL_MIN_R2: 0.5,
};

const isNum = x => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round = (x, d = 1) => { const k = 10 ** d; return Math.round(x * k) / k; };
const median = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

// ── Battery specification ──
const NUM_FIELDS = ['ratedAh', 'nominalV', 'cellsSeries', 'eolPct', 'tempWarnC', 'tempCritC', 'vMin', 'vMax', 'maxDischargeA', 'maxChargeA',
  'imbalanceWarnV', 'insulationMinKohm', 'lowSocWarn', 'lowSocCrit', 'reserveSoc', 'targetSoc', 'adviceTriggerSoc', 'rulWarnCycles', 'resistanceRiseWarnPct', 'accelWarnG', 'accelCritG', 'gyroWarnDps', 'gyroCritDps'];
const DEFAULTS = { chemistry: null, eolPct: 80, lowSocWarn: 20, lowSocCrit: 10, reserveSoc: 20, adviceTriggerSoc: 35, rulWarnCycles: 50, resistanceRiseWarnPct: 25 };
// Provisional limits are used ONLY when the manufacturer value has not been entered, and are always labelled as provisional.
const PROVISIONAL = { tempWarnC: 45, tempCritC: 55, imbalanceWarnV: 0.1, accelWarnG: 0.4, accelCritG: 1.0, gyroWarnDps: 120, gyroCritDps: 250 };
// Typical per-cell operating window (V) by chemistry. Used ONLY to derive provisional pack voltage limits when the user has not entered
// the manufacturer's values, and only when both chemistry and the series cell count are known.
const CELL_WINDOW = { NMC: [3.0, 4.2], NCA: [3.0, 4.2], LCO: [3.0, 4.2], LFP: [2.5, 3.65], LTO: [1.5, 2.8] };

function resolveSpec(raw) {
  const s = { ...DEFAULTS }; raw = raw || {};
  for (const k of NUM_FIELDS) if (raw[k] !== null && raw[k] !== undefined && raw[k] !== '' && isNum(Number(raw[k]))) s[k] = Number(raw[k]);
  if (raw.chemistry) s.chemistry = String(raw.chemistry).toUpperCase();
  s.provisional = [];
  for (const k of Object.keys(PROVISIONAL)) if (!isNum(s[k])) { s[k] = PROVISIONAL[k]; s.provisional.push(k); }
  const w = CELL_WINDOW[s.chemistry];
  if (w && s.cellsSeries > 0) {   // 1 % tolerance so a fully charged pack at rest is not flagged
    if (!isNum(s.vMin)) { s.vMin = round(w[0] * s.cellsSeries * 0.99, 1); s.provisional.push('vMin'); }
    if (!isNum(s.vMax)) { s.vMax = round(w[1] * s.cellsSeries * 1.01, 1); s.provisional.push('vMax'); }
  }
  return s;
}

// ── MPU6050 motion: dynamic g-force (gravity removed) and rotation rate ──
// Orientation-independent: |a| - 1 g. It cannot tell braking from acceleration or a bump from an impact; it measures how hard.
function motion(b) {
  const k = String(b.accel_unit || 'g').toLowerCase() === 'ms2' ? 9.80665 : 1, f = x => (x === undefined || x === null || x === '' ? NaN : Number(x));
  const a = [f(b.ax), f(b.ay), f(b.az)], g = [f(b.gx), f(b.gy), f(b.gz)], out = {};
  if (a.every(Number.isFinite)) out.gForce = Math.abs(Math.hypot(...a) / k - 1);
  const pk = f(b.g_peak); if (Number.isFinite(pk) && pk >= 0) out.gForce = Math.max(out.gForce || 0, pk / k);       // strongest value since the previous post, measured on the device
  if (g.every(Number.isFinite)) out.gyroDps = Math.hypot(...g);
  const gp = f(b.gyro_peak); if (Number.isFinite(gp) && gp >= 0) out.gyroDps = Math.max(out.gyroDps || 0, gp);
  if ((out.gForce !== undefined && out.gForce > 50) || (out.gyroDps !== undefined && out.gyroDps > 4000)) return { invalid: true };   // beyond the MPU6050's range: sensor fault
  if (out.gForce !== undefined) out.gForce = round(out.gForce, 3); if (out.gyroDps !== undefined) out.gyroDps = round(out.gyroDps, 1);
  return out;
}

// ── Generic per-cell open-circuit-voltage curves (provisional; replace with manufacturer data for accuracy) ──
const OCV = { NMC: [[0, 3.00], [10, 3.40], [20, 3.55], [30, 3.63], [40, 3.69], [50, 3.74], [60, 3.80], [70, 3.88], [80, 3.97], [90, 4.07], [100, 4.17]] };
OCV.NCA = OCV.NMC;   // LFP/LTO/lead-acid curves are too flat or too uncertain for a voltage-to-SOC lookup, so they are deliberately not offered.
function ocvSoc(spec, packV) {
  const tab = OCV[spec.chemistry]; if (!tab || !(spec.cellsSeries > 0) || !isNum(packV)) return null;
  const v = packV / spec.cellsSeries; if (v < tab[0][1] - 0.05 || v > tab[tab.length - 1][1] + 0.05) return null;
  for (let i = 1; i < tab.length; i++) if (v <= tab[i][1]) { const [s0, v0] = tab[i - 1], [s1, v1] = tab[i]; return clamp(s0 + (s1 - s0) * (v - v0) / (v1 - v0), 0, 100); }
  return 100;
}

// ── SOC: coulomb counting with a persisted state ──
function socStep(prev, last, r, spec) {
  const rated = spec.ratedAh;
  if (!(rated > 0)) return { soc: null, ahDelta: 0, limitation: 'Rated capacity (Ah) is not set for this vehicle, so SOC cannot be estimated by coulomb counting.' };
  const restI = Math.max(1, 0.01 * rated), haveI = isNum(r.current), atRest = haveI && Math.abs(r.current) < restI;
  const dt = last ? (r.t - last.t) / 1000 : null;
  let s = prev && isNum(prev.value) ? { ...prev } : null;

  if (!s) {   // never reset to an arbitrary value: start from a measurement or stay unavailable
    if (isNum(r.battery)) s = { value: clamp(r.battery, 0, 100), method: 'initialised from device-reported SOC' };
    else { const o = atRest ? ocvSoc(spec, r.voltage) : null; if (o != null) s = { value: o, method: 'initialised from resting voltage (generic OCV curve)' }; }
    if (!s) return { soc: null, ahDelta: 0, limitation: 'No valid starting SOC: the device does not report SOC and the resting-voltage method needs chemistry NMC/NCA, a series cell count and a resting pack.' };
    s.t = r.t; s.restSince = atRest ? r.t : null; return { soc: s, ahDelta: 0, limitation: null };
  }
  s.restSince = atRest ? (s.restSince || r.t) : null;
  if (dt == null || dt <= 0) { s.t = r.t; return { soc: s, ahDelta: 0, limitation: null }; }
  if (dt > CFG.MAX_GAP_S) {
    if (isNum(r.battery)) { s.value = clamp(r.battery, 0, 100); s.method = 'resynced from device-reported SOC after a data gap'; delete s.stale; s.t = r.t; return { soc: s, ahDelta: 0, limitation: null }; }
    s.method = 'held across a data gap'; s.stale = true; s.t = r.t;
    return { soc: s, ahDelta: 0, limitation: `No readings for ${Math.round(dt)} s: SOC was held and may be out of date.` };
  }
  if (!haveI || Math.abs(r.current) > rated * 20) { s.method = 'held (current missing or implausible)'; s.t = r.t; return { soc: s, ahDelta: 0, limitation: 'Current reading missing or implausible: SOC was held.' }; }
  const i0 = last && isNum(last.i) ? last.i : r.current, ah = ((i0 + r.current) / 2) * dt / 3600;   // trapezoidal; + = discharged
  s.value = clamp(s.value - ah / rated * 100, 0, 100); s.method = 'coulomb counting'; delete s.stale;
  if (atRest && s.restSince && (r.t - s.restSince) / 1000 >= CFG.REST_MIN_S) {
    const o = ocvSoc(spec, r.voltage);
    if (o != null) { s.value = clamp(s.value + clamp(0.2 * (o - s.value), -2, 2), 0, 100); s.method = 'coulomb counting + resting-voltage correction'; }
  }
  s.t = r.t; return { soc: s, ahDelta: ah, limitation: null };
}

// ── Capacity observations: whole charge/discharge runs measured against the device-reported SOC ──
function finishSeg(s, spec) {
  const d = s.dir === 1 ? s.startSoc - s.endSoc : s.endSoc - s.startSoc;
  if (!(d >= CFG.MIN_SEG_DELTA_SOC) || !(s.ah > 0)) return null;
  const cap = s.ah / (d / 100);
  if (cap < 0.3 * spec.ratedAh || cap > 1.3 * spec.ratedAh) return null;   // physically implausible: discard rather than store
  return { t: s.lastT, ah: round(cap, 2), deltaSoc: round(d, 1), throughputAh: round(s.ah, 2), direction: s.dir === 1 ? 'discharge' : 'charge', quality: d >= 60 ? 'good' : 'fair' };
}
function capStep(seg, r, ahDelta, gap, spec) {
  if (!(spec.ratedAh > 0)) return { seg: null, est: null };
  const minI = Math.max(1, 0.02 * spec.ratedAh), dir = !isNum(r.current) || Math.abs(r.current) < minI ? 0 : (r.current > 0 ? 1 : -1), ref = isNum(r.battery) ? r.battery : null;
  let s = seg || null, est = null;
  if (s && (dir !== s.dir || gap || ref == null)) { est = finishSeg(s, spec); s = null; }
  if (s) { s.ah += Math.abs(ahDelta); s.endSoc = ref; s.lastT = r.t; }
  else if (dir !== 0 && ref != null) s = { dir, startSoc: ref, endSoc: ref, startT: r.t, lastT: r.t, ah: 0 };
  return { seg: s, est };
}

// ── SOH (capacity based) ──
function sohFrom(caps, spec) {
  if (!(spec.ratedAh > 0)) return { status: 'unavailable', reason: 'Rated capacity is not set.' };
  const n = caps.length;
  if (n < CFG.SOH_MIN_POINTS) return { status: 'insufficient', have: n, need: CFG.SOH_MIN_POINTS,
    reason: `Capacity-based SOH needs ${CFG.SOH_MIN_POINTS} charge or discharge runs with at least ${CFG.MIN_SEG_DELTA_SOC}% SOC swing and a device-reported SOC; ${n} observed so far.` };
  const use = caps.slice(-CFG.SOH_WINDOW).map(c => c.ah), med = median(use), spread = (Math.max(...use) - Math.min(...use)) / med;
  const quality = use.length >= 5 && spread <= 0.05 && n >= 10 ? 'good' : use.length >= 5 && spread <= 0.1 ? 'fair' : 'low';
  return { status: 'ok', pct: round(med / spec.ratedAh * 100, 1), capacityAh: round(med, 2), n: use.length, observations: n, spreadPct: round(spread * 100, 1), quality,
    method: 'Capacity-based: median of the latest coulomb-counted capacity observations ÷ rated capacity. Not derived from voltage, current or temperature alone.' };
}

// ── RUL: transparent statistical baseline ──
function ols(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0; for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2; }
  if (sxx < 1e-9) return null; const b1 = sxy / sxx, b0 = my - b1 * mx;
  return { b0, b1, r2: syy < 1e-12 ? 0 : (sxy * sxy) / (sxx * syy) };
}
const RUL_METHOD = 'Linear regression of estimated capacity against equivalent full cycles. This is a statistical baseline, not a machine-learning prediction; real degradation is usually non-linear.';
function rul(caps, spec, efcNow) {
  const base = { method: RUL_METHOD, eolPct: spec.eolPct }, MSG = 'Insufficient data for reliable RUL prediction';
  if (!(spec.ratedAh > 0)) return { ...base, status: 'unavailable', message: MSG, reason: 'Rated capacity is not set.' };
  const pts = caps.slice(-60), n = pts.length, spanDays = n > 1 ? (pts[n - 1].t - pts[0].t) / 864e5 : 0, spanCycles = n > 1 ? pts[n - 1].efc - pts[0].efc : 0;
  if (n < CFG.RUL_MIN_POINTS || spanDays < CFG.RUL_MIN_SPAN_DAYS || spanCycles < 3)
    return { ...base, status: 'insufficient', message: MSG, have: { observations: n, spanDays: round(spanDays, 1), spanCycles: round(spanCycles, 1) },
      reason: `Needs at least ${CFG.RUL_MIN_POINTS} capacity observations over ${CFG.RUL_MIN_SPAN_DAYS}+ days and 3+ equivalent cycles. Have ${n} observations over ${round(spanDays, 1)} days and ${round(spanCycles, 1)} cycles.` };
  const fit = ols(pts.map(p => p.efc), pts.map(p => p.ah)), target = spec.ratedAh * spec.eolPct / 100;
  if (!fit || fit.r2 < CFG.RUL_MIN_R2) return { ...base, status: 'unreliable', message: MSG, reason: `The capacity trend is too noisy to extrapolate (R² = ${fit ? round(fit.r2, 2) : 'n/a'}).` };
  const nowCap = fit.b0 + fit.b1 * efcNow;
  if (nowCap <= target) return { ...base, status: 'eol_reached', cycles: 0, r2: round(fit.r2, 2), n, message: `Estimated capacity is at or below the ${spec.eolPct}% end-of-life threshold.` };
  if (fit.b1 >= -1e-9) return { ...base, status: 'no_trend', r2: round(fit.r2, 2), n, message: 'No measurable capacity loss trend yet, so no end-of-life date can be estimated.' };
  const cycles = (target - fit.b0) / fit.b1 - efcNow, recent = pts.filter(p => p.t >= pts[n - 1].t - 30 * 864e5), rd = (recent[recent.length - 1].t - recent[0].t) / 864e5;
  const perDay = recent.length > 1 && rd >= 3 ? (recent[recent.length - 1].efc - recent[0].efc) / rd : null;
  return { ...base, status: 'ok', cycles: Math.round(cycles), days: perDay > 0 ? Math.round(cycles / perDay) : null, cyclesPerDay: perDay > 0 ? round(perDay, 2) : null,
    r2: round(fit.r2, 2), n, spanDays: round(spanDays, 1), spanCycles: round(spanCycles, 1), extrapolating: cycles > 2 * spanCycles,
    fit: { b0: fit.b0, b1: fit.b1, xEol: (target - fit.b0) / fit.b1, xNow: efcNow, targetAh: round(target, 2) },
    caveat: cycles > 2 * spanCycles ? 'The forecast reaches far beyond the observed data; treat it as a rough indication only.' : null };
}

// ── Internal resistance (pack level) ──
function irPair(last, r, spec) {
  if (!last || ![last.i, last.v, r.current, r.voltage].every(isNum)) return null;
  const dt = (r.t - last.t) / 1000; if (!(dt > 0 && dt <= CFG.IR_MAX_DT_S)) return null;
  const dI = r.current - last.i; if (Math.abs(dI) < Math.max(10, 0.05 * (spec.ratedAh || 0))) return null;     // too small a load step to be meaningful
  if (isNum(last.temp) && isNum(r.temp) && Math.abs(r.temp - last.temp) > 2) return null;
  const m = -(r.voltage - last.v) / dI * 1000;      // discharge-positive: more current must lower voltage; the opposite is non-physical and rejected
  return m > 0 && m <= 1000 ? m : null;
}
function irTrend(irs) {
  if (irs.length < 8) return { status: 'insufficient', n: irs.length, latest: irs.length ? irs[irs.length - 1].m : null, reason: 'Needs at least 8 stored resistance estimates (valid load steps) to show a trend.' };
  const base = median(irs.slice(0, 5).map(x => x.m)), bt = irs.slice(0, 5).map(x => x.temp).filter(isNum), baseT = bt.length ? bt.reduce((a, b) => a + b, 0) / bt.length : null;
  const comparable = irs.slice(-6).filter(x => baseT == null || !isNum(x.temp) || Math.abs(x.temp - baseT) <= 10).slice(-3);   // compare like with like: resistance rises sharply when cold
  const latest = irs[irs.length - 1].m;
  if (!comparable.length) return { status: 'temperature_mismatch', n: irs.length, latest, baseline: round(base, 1), reason: 'Recent estimates were taken at a very different temperature from the baseline, so they are not compared.' };
  const cur = median(comparable.map(x => x.m));
  return { status: 'ok', n: irs.length, latest, baseline: round(base, 1), current: round(cur, 1), changePct: round((cur - base) / base * 100, 1) };
}
function heatRate(hist, t, temp) {
  const old = hist.find(h => t - h.t >= 60000 && t - h.t <= 300000);
  return old ? (temp - old.v) / ((t - old.t) / 60000) : null;
}

module.exports = { motion, CELL_WINDOW, CFG, isNum, clamp, round, median, resolveSpec, ocvSoc, socStep, capStep, sohFrom, rul, ols, irPair, irTrend, heatRate, NUM_FIELDS };
