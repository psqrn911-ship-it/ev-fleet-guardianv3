'use strict';
// Turns one validated telemetry reading into: updated estimation state, estimates to store, and alert events.
// Pure (no database, no email): the server persists what this returns. That keeps every rule unit-testable.
const B = require('./battery');
const { isNum, round, median, clamp, CFG } = B;

const MIN = 6e4;
const LABEL = { voltage: 'Voltage', current: 'Current', temp: 'Temperature' };
const SOFTWARE_NOTE = ' This is a software monitoring alert only; it is not hardware protection.';

function haversineKm(a, b, c, d) { const R = 6371, r = x => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)); }
const validGps = (la, lo) => isNum(la) && isNum(lo) && !(la === 0 && lo === 0);

// Edge-triggered alert tracker. A condition must hold for `persist` consecutive readings before it raises,
// stays quiet inside the hysteresis band, only clears when `cleared` is true, and re-notifies at most every `remindMs`.
function track(alerts, key, o, now) {
  const a = alerts[key] = Object.assign({ active: false, cnt: 0, level: 0, since: null, sent: null }, alerts[key]), lvl = o.level || 1;
  if (o.raised) {
    a.cnt++;
    if (!a.active && a.cnt >= (o.persist || 1)) {
      if (o.cooldownMs && a.sent && now - a.sent < o.cooldownMs) return null;      // one-off shocks: avoid a burst of notifications
      Object.assign(a, { active: true, level: lvl, since: now, sent: now }); return 'raise'; }
    if (a.active) {
      if (lvl > a.level) { a.level = lvl; a.sent = now; return 'raise'; }
      if (lvl < a.level) a.level = lvl;
      if (o.remindMs && now - a.sent >= o.remindMs) { a.sent = now; return 'remind'; }
    }
    return null;
  }
  if (o.cleared) { a.cnt = 0; if (a.active) { a.active = false; a.level = 0; return 'clear'; } return null; }
  if (!a.active) a.cnt = 0;      // inside the hysteresis band: persistence has to be consecutive
  return null;
}

function process({ spec, state, reading, fence, name = 'Vehicle', now = Date.now() }) {
  const s = state && state.v === 1 ? JSON.parse(JSON.stringify(state)) : { v: 1 };
  for (const [k, d] of [['alerts', {}], ['thru', { dis: 0, ch: 0 }], ['caps', []], ['irs', []], ['irBuf', []], ['tempHist', []], ['seen', {}]]) s[k] = s[k] || d;
  const r = { ...reading }, t = r.t, last = s.last || null, invalid = [...(r.invalid || [])];
  const out = { state: s, estimates: [], events: [], limitations: [], skipped: null, est: {} };
  if (last && t <= last.t) { out.skipped = 'Out-of-order or duplicate timestamp ignored.'; return out; }
  const dt = last ? (t - last.t) / 1000 : null, gap = !last || dt > CFG.MAX_GAP_S;

  // DS18B20 quirk: it reports exactly 85.0 °C after a power-on reset. A jump to 85 from a cool pack is a sensor artefact, not heat.
  if (r.temp === 85 && last && isNum(last.temp) && last.temp < 70) { r.temp = undefined; invalid.push('temp'); }

  const ev = (key, kind, severity, type, title, message, extra) => out.events.push({ key, kind, severity: kind === 'clear' ? 'info' : severity, type, title: `${name}: ${title}`, message, ...extra });
  const rule = (key, o) => {
    const res = track(s.alerts, key, o, now); if (!res) return;
    if (res === 'clear') { if (!o.silentClear) ev(key, 'clear', 'info', o.type, o.clearTitle || `${o.title} (resolved)`, o.clearMsg || 'The condition has cleared.'); return; }
    ev(key, res, o.severity, o.type, o.title, o.message, o.extra);
  };

  // 1) Sensor health: invalid and missing readings
  for (const f of ['voltage', 'current', 'temp']) {
    const present = isNum(r[f]), bad = invalid.includes(f); if (present) s.seen[f] = true;
    rule('sensor_bad_' + f, { raised: bad, cleared: present, persist: 3, severity: 'warning', type: 'sensor', title: `${LABEL[f]} sensor reading invalid`,
      message: `The device sent an out-of-range ${LABEL[f].toLowerCase()} value. Check the sensor and its wiring (a disconnected DS18B20 reads -127 °C).`, clearTitle: `${LABEL[f]} sensor reading restored`, clearMsg: 'Valid readings are being received again.' });
    if (s.seen[f]) rule('sensor_missing_' + f, { raised: !present && !bad, cleared: present, persist: 5, severity: 'warning', type: 'sensor', title: `${LABEL[f]} readings missing`,
      message: `The device stopped sending ${LABEL[f].toLowerCase()} values although it sent them before. Estimates that depend on it are paused.`, clearTitle: `${LABEL[f]} readings received again` });
  }
  if (isNum(r.temp)) { s.tempHist.push({ t, v: r.temp }); s.tempHist = s.tempHist.filter(h => t - h.t <= 10 * MIN).slice(-20); }

  // 2) SOC by coulomb counting (persisted, never reset on restart)
  const sr = B.socStep(s.soc, last, r, spec);
  if (sr.soc) s.soc = sr.soc; else if (!s.soc) s.soc = null;
  if (sr.limitation) out.limitations.push(sr.limitation);
  if (s.soc) { out.est.socEst = round(s.soc.value, 2); out.est.socMethod = s.soc.method; }

  // 3) Throughput, equivalent full cycles (discharge Ah ÷ rated Ah), capacity observations and SOH
  if (spec.ratedAh > 0 && !gap && sr.ahDelta) { if (sr.ahDelta > 0) s.thru.dis += sr.ahDelta; else s.thru.ch += -sr.ahDelta; }
  const efc = spec.ratedAh > 0 ? s.thru.dis / spec.ratedAh : null;
  const cs = B.capStep(s.seg, r, sr.ahDelta || 0, gap, spec); s.seg = cs.seg;
  if (cs.est) {
    s.caps.push({ t: cs.est.t, ah: cs.est.ah, efc: round(efc, 3) }); s.caps = s.caps.slice(-60);
    out.estimates.push({ kind: 'capacity', value: cs.est.ah, unit: 'Ah', method: 'Segment coulomb counting against device-reported SOC', quality: cs.est.quality,
      meta: { deltaSoc: cs.est.deltaSoc, throughputAh: cs.est.throughputAh, direction: cs.est.direction, efc: round(efc, 3) }, time: cs.est.t });
    const h = B.sohFrom(s.caps, spec);
    if (h.status === 'ok') out.estimates.push({ kind: 'soh', value: h.pct, unit: '%', method: h.method, quality: h.quality, meta: { n: h.n, capacityAh: h.capacityAh, efc: round(efc, 3), spreadPct: h.spreadPct }, time: cs.est.t });
  }

  // 4) Internal resistance from consecutive load steps
  const m = B.irPair(last, r, spec);
  if (m != null) { s.irBuf.push({ t, m, temp: r.temp }); s.irBuf = s.irBuf.slice(-15); }
  if (s.irBuf.length >= 5 && (!s.irLastStore || (t - s.irLastStore) / 1000 >= CFG.IR_STORE_EVERY_S)) {
    const temps = s.irBuf.map(x => x.temp).filter(isNum), tempC = temps.length ? round(temps.reduce((a, b) => a + b, 0) / temps.length, 1) : null, val = round(median(s.irBuf.map(x => x.m)), 1);
    s.irs.push({ t, m: val, temp: tempC }); s.irs = s.irs.slice(-60); out.estimates.push({ kind: 'resistance', value: val, unit: 'mΩ', method: 'ΔV/ΔI between consecutive samples (median of ≥5 valid load steps)', quality: 'fair', meta: { pairs: s.irBuf.length, tempC }, time: t });
    s.irBuf = []; s.irLastStore = t;
  }

  // 5) Alert rules
  const charging = isNum(r.current) && r.current < -1;
  const socRef = isNum(r.battery) ? r.battery : (s.soc && !s.soc.stale ? s.soc.value : null), socSrc = isNum(r.battery) ? 'reported by the device' : 'estimated by coulomb counting';

  const f = fence;
  if (f && f.enabled && isNum(f.lat) && isNum(f.lng) && f.radiusKm > 0 && validGps(r.lat, r.lon)) {
    const d = haversineKm(r.lat, r.lon, f.lat, f.lng); s.geo = { dist: round(d, 3), t };
    rule('geofence', { raised: d > f.radiusKm, cleared: d <= f.radiusKm * 0.97, persist: 2, remindMs: 60 * MIN, severity: 'critical', type: 'geofence', title: 'left its geofence',
      message: `Now ${d.toFixed(2)} km from the geofence centre (allowed radius ${f.radiusKm} km). Position ${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}.`, clearTitle: 'back inside its geofence', clearMsg: `Now ${d.toFixed(2)} km from the centre (radius ${f.radiusKm} km).` });
  } else if (s.alerts.geofence && s.alerts.geofence.active && !(f && f.enabled)) Object.assign(s.alerts.geofence, { active: false, cnt: 0, level: 0 });   // fence turned off: drop silently

  if (isNum(r.temp)) {
    const lvl = r.temp >= spec.tempCritC ? 2 : r.temp >= spec.tempWarnC ? 1 : 0, prov = spec.provisional.includes('tempWarnC') ? ' Thresholds are provisional defaults: enter the manufacturer limits for this battery.' : '';
    rule('thermal', { raised: lvl > 0, level: lvl, cleared: r.temp <= spec.tempWarnC - 3, persist: lvl === 2 ? 2 : 3, remindMs: (lvl === 2 ? 15 : 30) * MIN, severity: lvl === 2 ? 'critical' : 'warning', type: 'thermal',
      title: lvl === 2 ? 'battery critically hot' : 'battery temperature high', message: `Battery temperature is ${r.temp.toFixed(1)} °C (warning at ${spec.tempWarnC} °C, critical at ${spec.tempCritC} °C).${prov}${SOFTWARE_NOTE}`,
      clearTitle: 'battery temperature back to normal', clearMsg: `Battery temperature is ${r.temp.toFixed(1)} °C.` });
    const hr = B.heatRate(s.tempHist.slice(0, -1), t, r.temp);
    if (hr != null) rule('thermal_rate', { raised: hr >= 3 && r.temp >= 30, cleared: hr < 1 || r.temp < 30, persist: 1, severity: 'warning', type: 'thermal', title: 'abnormal heating rate',
      message: `Temperature is rising at ${hr.toFixed(1)} °C/min and has reached ${r.temp.toFixed(1)} °C.${SOFTWARE_NOTE}`, clearTitle: 'heating rate back to normal' });
  }

  if (socRef != null) {
    const lvl = socRef < spec.lowSocCrit ? 2 : socRef < spec.lowSocWarn ? 1 : 0;
    rule('soc_low', { raised: lvl > 0 && !charging, level: lvl, cleared: charging || socRef >= spec.lowSocWarn + 3, persist: 2, remindMs: 120 * MIN, severity: lvl === 2 ? 'critical' : 'warning', type: 'soc',
      title: lvl === 2 ? 'battery critically low' : 'battery low', message: `State of charge is ${socRef.toFixed(0)} % (${socSrc}).`, clearTitle: charging ? 'charging started' : 'battery recovered', clearMsg: `State of charge is ${socRef.toFixed(0)} %.` });
    rule('advice', { raised: !charging && socRef < spec.adviceTriggerSoc, cleared: charging || socRef >= spec.adviceTriggerSoc + 10, persist: 2, remindMs: 360 * MIN, severity: 'info', type: 'advice', title: 'charging advice', message: '', silentClear: true, extra: { needsAdvice: true, soc: socRef } });
  }

  if (isNum(r.voltage)) {
    if (isNum(spec.vMin)) rule('voltage_low', { raised: r.voltage < spec.vMin, cleared: r.voltage >= spec.vMin * 1.01, persist: 3, remindMs: 30 * MIN, severity: 'critical', type: 'voltage', title: 'pack voltage too low', message: `Pack voltage is ${r.voltage.toFixed(1)} V, below the ${spec.provisional.includes('vMin') ? 'provisional' : 'configured'} minimum of ${spec.vMin} V.${spec.provisional.includes('vMin') ? ' This limit is derived from the battery chemistry and cell count: enter the manufacturer value.' : ''}${SOFTWARE_NOTE}`, clearTitle: 'pack voltage back in range' });
    if (isNum(spec.vMax)) rule('voltage_high', { raised: r.voltage > spec.vMax, cleared: r.voltage <= spec.vMax * 0.99, persist: 3, remindMs: 30 * MIN, severity: 'critical', type: 'voltage', title: 'pack voltage too high', message: `Pack voltage is ${r.voltage.toFixed(1)} V, above the ${spec.provisional.includes('vMax') ? 'provisional' : 'configured'} maximum of ${spec.vMax} V.${spec.provisional.includes('vMax') ? ' This limit is derived from the battery chemistry and cell count: enter the manufacturer value.' : ''}${SOFTWARE_NOTE}`, clearTitle: 'pack voltage back in range' });
  }
  if (isNum(r.current)) {
    if (isNum(spec.maxDischargeA)) rule('current_high', { raised: r.current > spec.maxDischargeA, cleared: r.current <= spec.maxDischargeA * 0.95, persist: 3, remindMs: 30 * MIN, severity: 'warning', type: 'current', title: 'discharge current above limit', message: `Discharge current is ${r.current.toFixed(1)} A (limit ${spec.maxDischargeA} A).`, clearTitle: 'discharge current back in range' });
    if (isNum(spec.maxChargeA)) rule('current_charge_high', { raised: -r.current > spec.maxChargeA, cleared: -r.current <= spec.maxChargeA * 0.95, persist: 3, remindMs: 30 * MIN, severity: 'warning', type: 'current', title: 'charge current above limit', message: `Charge current is ${(-r.current).toFixed(1)} A (limit ${spec.maxChargeA} A).`, clearTitle: 'charge current back in range' });
  }
  if (isNum(r.cellMin) && isNum(r.cellMax)) {
    const spread = r.cellMax - r.cellMin, thr = spec.imbalanceWarnV, prov = spec.provisional.includes('imbalanceWarnV') ? ' (provisional default threshold)' : '';
    rule('imbalance', { raised: spread >= thr, cleared: spread < thr * 0.8, persist: 3, severity: 'warning', type: 'imbalance', title: 'cell voltage imbalance', message: `Highest and lowest cell differ by ${(spread * 1000).toFixed(0)} mV; threshold ${(thr * 1000).toFixed(0)} mV${prov}.`, clearTitle: 'cell imbalance back in range' });
  }
  if (isNum(r.insKohm) && isNum(spec.insulationMinKohm)) rule('insulation', { raised: r.insKohm < spec.insulationMinKohm, cleared: r.insKohm >= spec.insulationMinKohm * 1.1, persist: 2, remindMs: 30 * MIN, severity: 'critical', type: 'insulation', title: 'insulation resistance low', message: `Insulation resistance is ${r.insKohm.toFixed(0)} kΩ, below the configured minimum of ${spec.insulationMinKohm} kΩ. Isolate the vehicle and inspect it.`, clearTitle: 'insulation resistance back in range' });


  // MPU6050: sudden acceleration / braking / impact (g-force) and violent rotation (deg/s)
  const mprov = k => spec.provisional.includes(k) ? ' (provisional default threshold)' : '';
  if (isNum(r.gForce)) {
    const lvl = r.gForce >= spec.accelCritG ? 2 : r.gForce >= spec.accelWarnG ? 1 : 0;
    rule('accel', { raised: lvl > 0, level: lvl, cleared: r.gForce < spec.accelWarnG * 0.5, persist: 1, cooldownMs: 30000, silentClear: true, severity: lvl === 2 ? 'critical' : 'warning', type: 'motion',
      title: lvl === 2 ? 'severe impact or very hard acceleration' : 'sudden acceleration or braking',
      message: `Peak ${r.gForce.toFixed(2)} g (warning at ${spec.accelWarnG} g, critical at ${spec.accelCritG} g${mprov('accelWarnG') ? ', provisional defaults' : ''}). The sensor measures how hard, not which direction.${lvl === 2 ? ' Check the vehicle and driver.' : ''}` });
  }
  if (isNum(r.gyroDps)) {
    const lvl = r.gyroDps >= spec.gyroCritDps ? 2 : r.gyroDps >= spec.gyroWarnDps ? 1 : 0;
    rule('gyro', { raised: lvl > 0, level: lvl, cleared: r.gyroDps < spec.gyroWarnDps * 0.5, persist: 1, cooldownMs: 30000, silentClear: true, severity: lvl === 2 ? 'critical' : 'warning', type: 'motion',
      title: lvl === 2 ? 'violent rotation (possible spin or rollover)' : 'sharp turn or rapid rotation',
      message: `Rotation rate ${r.gyroDps.toFixed(0)} °/s (warning at ${spec.gyroWarnDps} °/s, critical at ${spec.gyroCritDps} °/s${mprov('gyroWarnDps') ? ', provisional defaults' : ''}).` });
  }

  // health rules (only meaningful once estimates exist)
  const soh = B.sohFrom(s.caps, spec);
  if (soh.status === 'ok') rule('soh_eol', { raised: soh.pct <= spec.eolPct, cleared: soh.pct > spec.eolPct + 1, persist: 1, severity: 'warning', type: 'health', title: 'battery reached end-of-life threshold', message: `Estimated capacity is ${soh.pct}% of rated, at or below the configured ${spec.eolPct}% end-of-life threshold.`, clearTitle: 'capacity above end-of-life threshold' });
  const recent = s.caps.filter(c => c.t >= t - 30 * 864e5);
  if (spec.ratedAh > 0 && recent.length >= 6) {
    const drop = (median(recent.slice(0, 3).map(c => c.ah)) - median(recent.slice(-3).map(c => c.ah))) / spec.ratedAh * 100;
    rule('capacity_drop', { raised: drop >= 5, cleared: drop < 3, persist: 1, severity: 'warning', type: 'health', title: 'unusually fast capacity loss', message: `Estimated capacity fell by ${drop.toFixed(1)} percentage points of rated capacity in the last 30 days. Investigate cell health and charging habits.`, clearTitle: 'capacity loss rate back to normal' });
  }
  const ru = B.rul(s.caps, spec, efc || 0);
  if (ru.status === 'ok') rule('rul_low', { raised: ru.cycles < spec.rulWarnCycles, cleared: ru.cycles > spec.rulWarnCycles * 1.2, persist: 1, severity: 'warning', type: 'health', title: 'remaining useful life is short', message: `Estimated ${ru.cycles} equivalent full cycles remain before ${spec.eolPct}% capacity (statistical baseline estimate).`, clearTitle: 'remaining life estimate recovered' });
  const tr = B.irTrend(s.irs);
  if (tr.status === 'ok') rule('resistance_rise', { raised: tr.changePct >= spec.resistanceRiseWarnPct, cleared: tr.changePct < spec.resistanceRiseWarnPct * 0.6, persist: 1, severity: 'warning', type: 'health', title: 'internal resistance has risen', message: `Estimated pack resistance is ${tr.changePct}% above its baseline (${tr.baseline} → ${tr.current} mΩ). Compared only at similar temperatures; this is an estimate, not a lab measurement.`, clearTitle: 'internal resistance back near baseline' });

  rule('offline', { raised: false, cleared: true, type: 'offline', title: 'back online', clearTitle: 'back online', clearMsg: 'Telemetry is being received again.' });

  s.last = { t, i: isNum(r.current) ? r.current : null, v: isNum(r.voltage) ? r.voltage : null, temp: isNum(r.temp) ? r.temp : (last ? last.temp : null), battery: isNum(r.battery) ? r.battery : null, lat: validGps(r.lat, r.lon) ? r.lat : (last ? last.lat : null), lon: validGps(r.lat, r.lon) ? r.lon : (last ? last.lon : null) };
  s.firstSeen = s.firstSeen || t;
  return out;
}

// What the dashboard shows. Every value carries its provenance so estimates are never presented as measurements.
function summarize(spec, state, latest, now = Date.now()) {
  const s = state && state.v === 1 ? state : { v: 1, alerts: {}, thru: { dis: 0, ch: 0 }, caps: [], irs: [] }, caps = s.caps || [], irs = s.irs || [];
  const missing = [];
  if (!(spec.ratedAh > 0)) missing.push({ field: 'ratedAh', why: 'Needed for SOC estimation, SOH, equivalent cycles and RUL.' });
  if (!(spec.nominalV > 0)) missing.push({ field: 'nominalV', why: 'Needed to show energy (kWh).' });
  if (!spec.chemistry) missing.push({ field: 'chemistry', why: 'Needed to judge safe limits; the resting-voltage SOC correction only supports NMC/NCA.' });
  if (!(spec.cellsSeries > 0)) missing.push({ field: 'cellsSeries', why: 'Needed for the resting-voltage SOC correction.' });
  if (!isNum(spec.vMin) || !isNum(spec.vMax)) missing.push({ field: 'vMin/vMax', why: 'Pack voltage alerts stay off until the voltage limits are set (or chemistry and series cell count are entered so standard limits can be derived).' });
  if (!isNum(spec.maxDischargeA)) missing.push({ field: 'maxDischargeA', why: 'Over-current alerts stay off until the current limits are set.' });
  const efc = spec.ratedAh > 0 ? (s.thru.dis || 0) / spec.ratedAh : null, soh = B.sohFrom(caps, spec), L = latest || {};
  const rep = isNum(L.battery) ? L.battery : null, est = s.soc && isNum(s.soc.value) ? s.soc.value : null;
  const active = Object.entries(s.alerts || {}).filter(([, a]) => a.active).map(([key, a]) => ({ key, level: a.level, since: a.since }));
  const spread = isNum(L.cellMax) && isNum(L.cellMin) ? L.cellMax - L.cellMin : null;
  const quality = [];
  if (!latest) quality.push('No telemetry received yet.');
  if (latest && !isNum(L.current)) quality.push('Current is not being reported: SOC estimation, capacity, cycles and resistance are unavailable.');
  if (latest && !isNum(L.battery)) quality.push('The device does not report SOC: capacity and SOH observations need a device-reported SOC as their reference.');
  if (spec.provisional.length) quality.push('Some safety thresholds are provisional defaults. Enter the manufacturer limits.');
  return {
    specComplete: missing.length === 0, missing, provisional: spec.provisional,
    soc: { reported: rep, estimated: est == null ? null : round(est, 1), method: s.soc ? s.soc.method : null, stale: !!(s.soc && s.soc.stale), driftPct: rep != null && est != null ? round(est - rep, 1) : null,
      limitation: !(spec.ratedAh > 0) ? 'Set the rated capacity (Ah) to enable SOC estimation.' : (!s.soc ? 'Waiting for a valid starting SOC.' : null) },
    soh, capacity: { latestAh: caps.length ? caps[caps.length - 1].ah : null, observations: caps.length, lastAt: caps.length ? caps[caps.length - 1].t : null, ratedAh: spec.ratedAh || null,
      energyKwh: soh.status === 'ok' && spec.nominalV > 0 ? round(soh.capacityAh * spec.nominalV / 1000, 2) : null, ratedKwh: spec.ratedAh > 0 && spec.nominalV > 0 ? round(spec.ratedAh * spec.nominalV / 1000, 2) : null },
    eqCycles: efc == null ? null : round(efc, 2), throughput: { dischargeAh: round(s.thru.dis || 0, 1), chargeAh: round(s.thru.ch || 0, 1) },
    rul: B.rul(caps, spec, efc || 0), resistance: B.irTrend(irs),
    thermal: { tempC: isNum(L.temp) ? L.temp : null, warnC: spec.tempWarnC, critC: spec.tempCritC, provisional: spec.provisional.includes('tempWarnC') },
    imbalance: { cellMinV: isNum(L.cellMin) ? L.cellMin : null, cellMaxV: isNum(L.cellMax) ? L.cellMax : null, spreadV: spread, thresholdV: spec.imbalanceWarnV, supported: spread != null },
    insulation: { kohm: isNum(L.insKohm) ? L.insKohm : null, minKohm: isNum(spec.insulationMinKohm) ? spec.insulationMinKohm : null, supported: isNum(L.insKohm) },
    motion: { gForce: isNum(L.gForce) ? L.gForce : null, gyroDps: isNum(L.gyroDps) ? L.gyroDps : null, supported: isNum(L.gForce) || isNum(L.gyroDps), warnG: spec.accelWarnG, critG: spec.accelCritG, warnDps: spec.gyroWarnDps, critDps: spec.gyroCritDps, provisional: spec.provisional.includes('accelWarnG') },
    activeAlerts: active, quality, lastSeen: s.last ? s.last.t : null,
  };
}

module.exports = { process, summarize, track, haversineKm, validGps };
