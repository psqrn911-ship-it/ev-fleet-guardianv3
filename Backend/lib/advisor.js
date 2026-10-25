'use strict';
// Charging advisor. A transparent statistical baseline over the vehicle's own hourly history.
// It is NOT a trained machine-learning model and says so. The interface (advise(input) -> advice) is deliberately small
// so a validated ML model can replace it later without touching the server or the dashboard.
const { isNum, round, median, clamp } = require('./battery');

const NEED_BUCKETS = 72;     // at least 3 days of hourly history with SOC
const NEED_DRIVE_PAIRS = 5;  // at least this many hours of observed driving
const NEED_DAYS_USED = 3;    // and usage seen on at least 3 different days
const METHOD = 'Statistical baseline: medians of this vehicle’s own hourly history (usage per day, discharge and charge rates, usual departure hour). Not a trained machine-learning model.';

function localParts(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute };
}
const hh = h => String(h).padStart(2, '0') + ':00';

// buckets: [{ t: ms (start of hour), soc: avg %, cur: avg A (+ = discharging), n: readings }]
function advise({ spec, buckets, socNow, charging, capacityAh, now = Date.now(), tz = 'Asia/Kolkata' }) {
  const base = { method: METHOD, computedAt: now };
  const b = (buckets || []).filter(x => isNum(x.soc) && x.n >= 3).sort((x, y) => x.t - y.t);
  if (!isNum(socNow)) return { ...base, status: 'unavailable', message: 'No current state of charge is available for this vehicle.' };
  if (b.length < NEED_BUCKETS) return { ...base, status: 'collecting', message: `Still learning this vehicle’s pattern: ${b.length} of ${NEED_BUCKETS} hours of data collected.`, have: { hours: b.length }, need: { hours: NEED_BUCKETS } };

  const drive = [], chg = [], dayDrop = {}, starts = {}, activeDays = new Set(), days = new Set();
  for (let i = 0; i < b.length; i++) {
    const lp = localParts(b[i].t, tz); days.add(lp.date);
    if (isNum(b[i].cur) && b[i].cur > 1) { activeDays.add(lp.date); if (i === 0 || b[i - 1].t !== b[i].t - 36e5 || !(b[i - 1].cur > 1)) starts[lp.hour] = (starts[lp.hour] || 0) + 1; }
    const nx = b[i + 1]; if (!nx || nx.t - b[i].t !== 36e5) continue;
    const dSoc = b[i].soc - nx.soc;
    if (b[i].cur > 1 && dSoc > 0) { drive.push(dSoc); dayDrop[lp.date] = (dayDrop[lp.date] || 0) + dSoc; }
    if (b[i].cur < -1 && dSoc < 0) chg.push(-dSoc);
  }
  const usedDays = Object.values(dayDrop);
  if (drive.length < NEED_DRIVE_PAIRS || usedDays.length < NEED_DAYS_USED)
    return { ...base, status: 'collecting', message: `Not enough driving observed yet to predict usage (${drive.length} driving hours over ${usedDays.length} days; need ${NEED_DRIVE_PAIRS} hours over ${NEED_DAYS_USED} days).`, have: { drivingHours: drive.length, days: usedDays.length } };

  const dischargeRate = median(drive), chargeRate = chg.length >= 2 ? median(chg) : null, dailyUsage = median(usedDays.slice(-7));
  const top = Object.entries(starts).sort((x, y) => y[1] - x[1])[0], departure = top && top[1] >= 3 ? +top[0] : null;
  const reserve = isNum(spec.reserveSoc) ? spec.reserveSoc : 20, cap = isNum(spec.targetSoc) ? spec.targetSoc : (spec.chemistry === 'LFP' ? 100 : 90);
  // target = reserve + 125 % of the usual daily use + a 15-point buffer for unplanned trips, rounded up to 5, never below reserve + 30
  let target = clamp(Math.ceil((reserve + dailyUsage * 1.25 + 15) / 5) * 5, Math.min(reserve + 30, cap), cap);
  const needPct = Math.max(0, target - socNow), runwayH = dischargeRate > 0 ? Math.max(0, (socNow - reserve) / dischargeRate) : null;
  const kwh = needPct > 0 && isNum(capacityAh) && spec.nominalV > 0 ? round(needPct / 100 * capacityAh * spec.nominalV / 1000, 1) : null;
  const hoursToCharge = needPct > 0 && chargeRate ? round(needPct / chargeRate, 1) : null;
  let startInH = 0, ready = null;
  if (needPct > 0 && departure != null) {
    const lp = localParts(now, tz), untilDep = ((departure - lp.hour - lp.minute / 60) + 24) % 24 || 24;
    ready = hh(departure); startInH = Math.max(0, untilDep - (hoursToCharge || 0) - 0.5);
  }
  const startBy = needPct > 0 ? new Date(now + startInH * 36e5).toISOString() : null;
  const base2 = { ...base, status: 'ok', socNow: round(socNow, 0), targetSoc: target, needPct: round(needPct, 0), energyKwh: kwh, hoursToCharge, startBy, startNow: needPct > 0 && startInH === 0, readyBy: ready,
    dailyUsagePct: round(dailyUsage, 0), dischargeRatePctPerH: round(dischargeRate, 1), chargeRatePctPerH: chargeRate ? round(chargeRate, 1) : null, runwayHours: runwayH == null ? null : round(runwayH, 1), departureHour: departure,
    basis: { hoursOfData: b.length, days: days.size, drivingHours: drive.length, reserveSoc: reserve }, charging: !!charging };
  let msg;
  if (needPct <= 0) msg = `No charge needed: ${round(socNow, 0)}% already covers the usual daily use of about ${round(dailyUsage, 0)}%.`;
  else {
    msg = `Charge to ${target}% (+${round(needPct, 0)}%${kwh != null ? `, about ${kwh} kWh` : ''}).`;
    if (hoursToCharge) msg += ` Expected charging time is about ${hoursToCharge} h at the usual charging rate.`;
    msg += base2.startNow ? ' Start charging now' + (ready ? ` to be ready for the usual ${ready} departure.` : '.') : ` Start by ${new Date(startBy).toLocaleTimeString('en-IN', { timeZone: tz, hour: '2-digit', minute: '2-digit' })} to be ready for the usual ${ready} departure.`;
    if (runwayH != null && runwayH < 3) msg += ` At the usual driving rate the battery reaches the ${reserve}% reserve in about ${round(runwayH, 1)} h.`;
  }
  return { ...base2, message: msg };
}

module.exports = { advise, localParts, METHOD, NEED_BUCKETS };
