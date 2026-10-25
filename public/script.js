// EV Fleet Monitor — frontend. All data comes from the API; nothing here is simulated.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TABS = { overview: 'Overview', battery: 'Battery', maps: 'Map & geofence' };
const OFFLINE_MS = 120000, LOW_SOC = 20, HOT_C = 45;
let token = localStorage.getItem('ev_token'), me = null, cfg = { map: { provider: 'osm' } }, vehicles = [], selId = null, lastId = null, filter = 'all', query = '', mode = 'login', tick = 0, pollTimer = null, curTab = 'fleet', pendingUsers = [];

async function api(path, opt = {}, retry = true) {
  let r; try { r = await fetch(path, { method: opt.method || 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined }); }
  catch (e) { if (retry && !opt.method) { await new Promise(x => setTimeout(x, 1500)); return api(path, opt, false); } throw new Error('Cannot reach the server. Check your connection.'); }
  if (r.status === 503 && retry) { await new Promise(x => setTimeout(x, 1500)); return api(path, opt, false); }
  let d = {}; try { d = await r.json(); } catch {}
  if (r.status === 401 && token) { logout(true); throw new Error('Session expired. Please sign in again.'); }
  if (!r.ok) throw new Error(d.error || 'Request failed (' + r.status + ')');
  return d;
}
function showNotif(icon, msg) { $('notif-icon').textContent = icon; $('notif-msg').textContent = msg; $('notif').classList.add('show'); clearTimeout(showNotif.t); showNotif.t = setTimeout(() => $('notif').classList.remove('show'), 4500); }
function setMsg(id, text, ok) { const e = $(id); e.textContent = text || ''; e.className = 'form-msg' + (ok ? ' ok' : ''); }
const curV = () => vehicles.find(v => v.vehicle_id === selId);
const fmt = x => x === null || x === undefined ? '—' : Math.round(x);
const timeOf = v => v.latest ? new Date(v.latest.time).getTime() : 0;
const rel = t => { if (!t) return 'No readings yet'; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return (s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd') + ' ago'; };
const ago = t => t ? 'Updated ' + rel(t) : 'No readings yet';
const when = d => new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
function haversine(a, b, c, d) { const R = 6371, r = x => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)); }
const isHost = () => me && me.role === 'host', canEdit = () => me && me.role !== 'viewer';
const ROLE_TXT = { host: 'Host', manager: 'Manager', viewer: 'Viewer' };

// ── Sign in / request access ──
function setMode(m) {
  mode = m; const reg = m === 'register';
  $('f-name').hidden = !reg; $('auth-title').textContent = reg ? 'Request access' : 'Sign in';
  $('auth-sub').textContent = reg ? 'The host reviews every request. Once approved you sign in to the same shared dashboard with your own login.' : 'Monitor your electric vehicles in real time.';
  $('auth-btn').textContent = reg ? 'Send request' : 'Sign in'; $('sw-text').textContent = reg ? 'Already approved?' : 'New here?'; $('sw-link').textContent = reg ? 'Sign in' : 'Request access'; setMsg('auth-msg', '');
}
$('sw-link').addEventListener('click', e => { e.preventDefault(); setMode(mode === 'login' ? 'register' : 'login'); });
$('auth-form').addEventListener('submit', async e => {
  e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)), btn = $('auth-btn'); btn.disabled = true; setMsg('auth-msg', '');
  try {
    if (mode === 'register') { const r = await api('/api/auth/register', { method: 'POST', body: f }); setMode('login'); e.target.reset(); setMsg('auth-msg', r.message, true); }
    else { const r = await api('/api/auth/login', { method: 'POST', body: { email: f.email, password: f.password } }); token = r.token; localStorage.setItem('ev_token', token); me = r.user; e.target.reset(); startApp(); }
  } catch (err) { setMsg('auth-msg', err.message); } finally { btn.disabled = false; }
});
function logout(expired) {
  token = null; me = null; vehicles = []; selId = null; localStorage.removeItem('ev_token'); clearInterval(pollTimer); resetNotes();
  $('fleet-grid').innerHTML = ''; document.body.dataset.view = 'auth'; document.body.dataset.role = ''; $('menu').hidden = true; $('bell-panel').hidden = true; location.hash = '#/'; setMode('login');
  if (expired) setMsg('auth-msg', 'Your session expired. Please sign in again.');
}
$('logout-btn').addEventListener('click', () => logout(false));
$('profile-btn').addEventListener('click', e => { e.stopPropagation(); $('bell-panel').hidden = true; const m = $('menu'); m.hidden = !m.hidden; $('profile-btn').setAttribute('aria-expanded', !m.hidden); });
document.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) { $('menu').hidden = true; $('bell-panel').hidden = true; } });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('menu').hidden = true; $('bell-panel').hidden = true; closeModal(); } });

async function startApp() {
  const initials = me.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  $('profile-btn').textContent = initials; $('m-name').textContent = me.name; $('m-email').textContent = me.email; $('m-role').textContent = ROLE_TXT[me.role];
  $('nav-admin').hidden = !isHost(); document.body.dataset.role = me.role; document.body.dataset.view = 'fleet';
  try { cfg = await api('/api/config'); } catch {}
  clearInterval(pollTimer); tick = 0; resetNotes(); poll(); pollTimer = setInterval(poll, 5000); route();
}

// ── Polling real data ──
async function poll() {
  try {
    vehicles = await api('/api/vehicles'); $('conn-dot').classList.remove('disconnected'); $('conn-label').textContent = 'Live data connected';
    $('topnav-updated').textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (e) { if (!token) return; $('conn-dot').classList.add('disconnected'); $('conn-label').textContent = 'Server unreachable'; return; }
  renderFleet(); pollNotes();
  if (selId) {
    const v = curV(); if (!v) { location.hash = '#/'; return; }
    paintDetail(v); if (curTab === 'maps') updateMap(false); if (curTab === 'battery' && tick % 3 === 0) refreshBattery();
  }
  if (isHost() && tick % 6 === 0) refreshPending();
  tick++;
}
function statusOf(v) {
  const l = v.latest; if (!l) return { k: 'wait', t: 'Awaiting data' };
  if (Date.now() - timeOf(v) > OFFLINE_MS) return { k: 'offline', t: 'Offline' };
  if (l.current != null && l.current < 0) return { k: 'charging', t: 'Charging' };
  const soc = socOf(v); if (soc != null && soc < LOW_SOC) return { k: 'low', t: 'Low battery' };
  return { k: 'online', t: 'Online' };
}
// Reported SOC is a device measurement; the server estimate is only used when the device does not report one.
const socOf = v => v.latest ? (v.latest.battery ?? v.latest.socEst ?? null) : null;
function geoOf(v) {
  const f = v.fence, l = v.latest; if (!f || !f.enabled || f.lat == null || !l || l.lat == null) return 'none';
  const d = haversine(l.lat, l.lon, f.lat, f.lng); return d > f.radiusKm ? 'breach' : (f.radiusKm - d < Math.max(.5, f.radiusKm * .1) ? 'warn' : 'ok');
}
const GEO_TXT = { none: 'No geofence', ok: 'Inside geofence', warn: 'Near boundary', breach: 'Outside geofence' };

// ── Fleet home ──
function blockHTML(v) {
  return `<a class="veh-block" href="#/vehicle/${v.vehicle_id}" data-id="${v.vehicle_id}" data-lvl="none">
    <div class="vb-top"><div><div class="vb-name">${esc(v.name)}</div><div class="vb-plate">${esc(v.plate || v.vehicle_id)}</div></div><span class="status-chip" data-k="status"></span></div>
    <div class="vb-soc"><div class="vb-pct"><span data-k="soc">—</span><small>%</small></div><div class="batt" role="img" aria-label="Charge level"><div class="batt-fill" data-k="fill"></div></div></div>
    <dl class="vb-metrics"><div><dt>Voltage</dt><dd><span data-k="voltage">—</span> V</dd></div><div><dt>Current</dt><dd><span data-k="current">—</span> A</dd></div><div><dt>Temperature</dt><dd><span data-k="temp">—</span> °C</dd></div></dl>
    <div class="vb-health" data-k="health"></div>
    <div class="vb-foot"><span data-k="seen"></span><span data-k="geo"></span></div></a>`;
}
function renderFleet() {
  const grid = $('fleet-grid'); let online = 0, charging = 0, alerts = 0, sum = 0, n = 0, shown = 0; const ids = new Set(vehicles.map(v => v.vehicle_id));
  grid.querySelectorAll('.veh-block').forEach(el => { if (!ids.has(el.dataset.id)) el.remove(); });
  vehicles.forEach(v => {
    let el = grid.querySelector(`[data-id="${v.vehicle_id}"]`); if (!el) { grid.insertAdjacentHTML('beforeend', blockHTML(v)); el = grid.lastElementChild; }
    const l = v.latest || {}, st = statusOf(v), geo = geoOf(v), soc = socOf(v), h = v.health || {}, q = k => el.querySelector(`[data-k="${k}"]`), live = st.k !== 'wait' && st.k !== 'offline';
    el.querySelector('.vb-name').textContent = v.name;
    q('status').textContent = st.t; q('status').className = 'status-chip st-' + st.k; q('soc').textContent = fmt(soc); q('voltage').textContent = fmt(l.voltage);
    q('current').textContent = l.current == null ? '—' : Math.abs(Math.round(l.current)); q('temp').textContent = fmt(l.temp); q('fill').style.width = (soc ?? 0) + '%';
    const bits = []; if (h.sohPct != null) bits.push(`SOH ${h.sohPct}% <i>est.</i>`); if (h.alerts) bits.push(`<b class="hl-warn">${h.alerts} active alert${h.alerts > 1 ? 's' : ''}</b>`); q('health').innerHTML = bits.join(' · ');
    q('seen').textContent = ago(timeOf(v)); q('geo').textContent = geo === 'none' ? '' : GEO_TXT[geo];
    el.dataset.lvl = soc == null ? 'none' : soc < LOW_SOC ? 'low' : soc < 50 ? 'mid' : 'ok'; el.dataset.hot = l.temp != null && l.temp >= HOT_C; el.dataset.geo = geo;
    const show = (filter === 'all' || (filter === 'online' && live) || (filter === 'charging' && st.k === 'charging') || (filter === 'low' && soc != null && soc < LOW_SOC) || (filter === 'offline' && !live)) &&
      (!query || (v.name + ' ' + (v.plate || '')).toLowerCase().includes(query));
    el.hidden = !show; if (show) shown++; if (live) online++; if (st.k === 'charging') charging++; if (soc != null) { sum += soc; n++; }
    if ((soc != null && soc < LOW_SOC) || el.dataset.hot === 'true' || geo === 'breach' || h.alerts) alerts++;
  });
  $('fleet-total').textContent = vehicles.length; $('fleet-online').textContent = online; $('fleet-charging').textContent = charging; $('fleet-alerts').textContent = alerts; $('fleet-soc').textContent = n ? Math.round(sum / n) + '%' : '—';
  const em = $('fleet-empty'); em.hidden = shown > 0;
  em.innerHTML = vehicles.length ? 'No vehicles match. Clear the search or pick All.' : 'No vehicles yet.' + (canEdit() ? '<br>Add the first vehicle to start receiving live data.<br><button class="btn primary" onclick="openAdd()" style="margin-top:14px">Add vehicle</button>' : ' Ask the host to add one.');
  const bar = $('geo-alert-bar'), list = vehicles.filter(v => geoOf(v) === 'breach');
  if (list.length) { bar.className = 'geo-alert-bar show breach'; $('geo-alert-msg').textContent = 'Geofence breach: ' + list.map(v => v.plate || v.name).join(', '); $('geo-alert-dist').textContent = list.length + (list.length > 1 ? ' vehicles' : ' vehicle'); } else bar.className = 'geo-alert-bar';
}
$('fleet-search').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); renderFleet(); });
$('filters').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b) return; filter = b.dataset.f; document.querySelectorAll('#filters .chip').forEach(c => c.classList.toggle('on', c === b)); renderFleet(); });

// ── Routing ──
const PAGES = { fleet: 'Fleet overview', profile: 'Profile', admin: 'Team & settings', notifications: 'Notifications' };
function showSection(id) {
  curTab = id; document.querySelectorAll('.section').forEach(s => s.classList.remove('active')); $('sec-' + id).classList.add('active');
  document.body.dataset.view = id === 'fleet' ? 'fleet' : TABS[id] ? 'vehicle' : 'page';
  document.querySelectorAll('.tab').forEach(t => { const on = t.dataset.go === id; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.go === (id === 'overview' ? 'fleet' : id)));
  const v = curV(); $('page-crumb').textContent = TABS[id] && v ? v.name + ' · ' + TABS[id] : (PAGES[id] || '');
}
function goTo(t) {
  if (t === 'fleet') { location.hash = '#/'; return; } if (t === 'admin' || t === 'notifications') { location.hash = '#/' + t; return; }
  const v = curV() || vehicles.find(x => x.vehicle_id === lastId) || vehicles[0];
  if (!v) { showNotif('ℹ', 'Add a vehicle first'); location.hash = '#/'; return; } location.hash = `#/vehicle/${v.vehicle_id}/${t}`;
}
document.addEventListener('click', e => { const a = e.target.closest('[data-go]'); if (a) { e.preventDefault(); $('bell-panel').hidden = true; goTo(a.dataset.go); } });
function route() {
  if (!me) return; const h = location.hash, m = h.match(/^#\/vehicle\/([A-Z0-9]+)(?:\/(\w+))?/i);
  if (h === '#/profile') { selId = null; fillProfile(); showSection('profile'); }
  else if (h === '#/admin' && isHost()) { selId = null; showSection('admin'); loadAdmin(); }
  else if (h === '#/notifications') { selId = null; showSection('notifications'); loadNotePage(true); }
  else if (m) { selId = m[1].toUpperCase(); lastId = selId; const tab = TABS[m[2]] ? m[2] : 'overview'; showSection(tab); const v = curV(); if (v) paintDetail(v);
    if (tab === 'battery') openBattery(); if (tab === 'maps') setTimeout(() => updateMap(true), 60); }
  else { selId = null; showSection('fleet'); renderFleet(); }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ── Vehicle detail ──
function paintDetail(v) {
  const l = v.latest || {}, st = statusOf(v), geo = geoOf(v), set = (id, t) => { $(id).textContent = t; }, rep = l.battery != null, soc = socOf(v);
  set('vh-name', v.name); set('vh-plate', v.plate || v.vehicle_id); $('vh-status').textContent = st.t; $('vh-status').className = 'status-chip st-' + st.k;
  set('kpi-soc', fmt(soc)); $('soc-bar').style.width = (soc ?? 0) + '%'; set('kpi-voltage', fmt(l.voltage)); set('kpi-current', l.current == null ? '—' : Math.abs(Math.round(l.current))); set('kpi-temp', fmt(l.temp));
  const tag = $('ov-soc-tag'); tag.textContent = soc == null ? 'Unavailable' : rep ? 'Measured' : 'Estimated'; tag.className = 'tag ' + (soc == null ? 't-na' : rep ? 't-measured' : 't-estimate');
  set('kpi-soc-sub', soc == null ? 'No state of charge reported, and not enough information to estimate it.' : rep ? (l.socEst != null ? `Reported by the device. Server estimate: ${l.socEst.toFixed(1)}%` : 'Reported by the device') : 'Estimated by coulomb counting (the device does not report SOC)');
  const cb = $('c-badge'); cb.textContent = l.current == null ? '' : l.current < 0 ? 'Charging' : 'Discharging'; cb.className = 'card-badge ' + (l.current < 0 ? 'badge-ok' : ''); cb.style.cssText = l.current >= 0 ? 'background:var(--surface3);color:var(--text2)' : '';
  set('ov-pos', l.lat == null ? 'No GPS fix yet' : l.lat.toFixed(5) + ', ' + l.lon.toFixed(5)); set('ov-geo', GEO_TXT[geo]);
  const gb = $('ov-geo-badge'); gb.textContent = geo === 'none' ? '' : GEO_TXT[geo]; gb.className = 'card-badge ' + ({ ok: 'badge-ok', warn: 'badge-warn', breach: 'badge-crit' }[geo] || '');
  set('d-id', v.vehicle_id); set('d-seen', ago(timeOf(v))); $('d-owner-row').hidden = !v.owner; set('d-owner', v.owner || '');
}
$('rename-btn').addEventListener('click', async () => { const v = curV(), n = prompt('Vehicle name', v.name); if (!n || !n.trim()) return; try { const u = await api('/api/vehicles/' + v.vehicle_id, { method: 'PATCH', body: { name: n } }); Object.assign(v, u); paintDetail(v); renderFleet(); showSection(curTab); showNotif('✅', 'Renamed'); } catch (e) { showNotif('⚠', e.message); } });
$('del-btn').addEventListener('click', async () => { const v = curV(); if (!confirm(`Remove ${v.name}? Its stored readings and estimates will be deleted for everyone.`)) return; try { await api('/api/vehicles/' + v.vehicle_id, { method: 'DELETE' }); vehicles = vehicles.filter(x => x !== v); selId = null; location.hash = '#/'; showNotif('✅', 'Vehicle removed'); } catch (e) { showNotif('⚠', e.message); } });
$('key-btn').addEventListener('click', async () => { const v = curV(); if (!confirm('Create a new device key? The current key stops working immediately.')) return; try { const r = await api(`/api/vehicles/${v.vehicle_id}/key`, { method: 'POST' }); showKey(v.vehicle_id, r.deviceKey, 'New device key'); } catch (e) { showNotif('⚠', e.message); } });

// ── Modal, add vehicle, device key ──
function modal(title, html, wide) { $('modal-title').textContent = title; $('modal-body').innerHTML = html; $('modal').hidden = false; $('modal').querySelector('.modal-card').classList.toggle('wide', !!wide); const i = $('modal-body').querySelector('input,select,button'); if (i) i.focus(); }
function closeModal() { $('modal').hidden = true; }
$('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
function openAdd() {
  modal('Add vehicle', `<form id="add-form" class="stack"><label>Vehicle name<input name="name" placeholder="Tata Nexon EV"/></label><label>Plate or vehicle ID<input name="plate" placeholder="KA 01 EV 2341"/></label><div class="form-msg" id="add-msg" role="alert"></div><div class="btn-row"><button class="btn primary" type="submit">Add vehicle</button><button class="btn" type="button" onclick="closeModal()">Cancel</button></div></form>`);
  $('add-form').addEventListener('submit', async e => { e.preventDefault(); try { const r = await api('/api/vehicles', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); vehicles.push(r.vehicle); renderFleet(); showKey(r.vehicle.vehicle_id, r.deviceKey, 'Vehicle added'); } catch (err) { setMsg('add-msg', err.message); } });
}
function showKey(id, key, title) {
  modal(title, `<p class="hint">Put this device key in your microcontroller now. It is shown only once.</p><pre class="code" id="key-val">${esc(key)}</pre><p class="hint">Send readings every 5–10 seconds to <b>POST ${esc(location.origin)}/data</b> as JSON:</p><pre class="code">{ "vehicle_id": "${esc(id)}", "key": "…", "battery": 0-100, "voltage": V, "current": A, "temp": °C, "lat": …, "lon": … }</pre><p class="hint">Motion (MPU6050): <code>"ax","ay","az"</code> in g, <code>"gx","gy","gz"</code> in °/s, and <code>"g_peak"</code> = strongest g since the last post. Optional, if your BMS provides them: <code>"cells": [3.71, 3.70, …]</code> (cell voltages, V) and <code>"insulation_kohm": …</code>. Positive current = discharging, negative = charging. Then open the Battery tab and enter the battery specification.</p><div class="btn-row"><button class="btn primary" id="copy-key">Copy key</button><button class="btn" onclick="closeModal()">Done</button></div>`);
  $('copy-key').addEventListener('click', () => navigator.clipboard.writeText(key).then(() => showNotif('✅', 'Key copied'), () => showNotif('⚠', 'Copy failed — select the key and copy it')));
}

// ═══ Battery intelligence ═══
const TAGS = { measured: ['Measured', 't-measured'], estimate: ['Estimated', 't-estimate'], predict: ['Prediction', 't-predict'], na: ['Unavailable', 't-na'] };
const tagHTML = k => `<span class="tag ${TAGS[k][1]}">${TAGS[k][0]}</span>`;
const ALERT_LABEL = { geofence: 'Outside geofence', thermal: 'Battery temperature', thermal_rate: 'Abnormal heating rate', soc_low: 'Low charge', voltage_low: 'Pack voltage too low', voltage_high: 'Pack voltage too high', current_high: 'Discharge current above limit',
  current_charge_high: 'Charge current above limit', imbalance: 'Cell voltage imbalance', insulation: 'Insulation resistance low', soh_eol: 'End-of-life threshold reached', capacity_drop: 'Fast capacity loss', rul_low: 'Short remaining life', resistance_rise: 'Internal resistance rise', offline: 'No data received', accel: 'Sudden acceleration / impact', gyro: 'Sharp turn / rapid rotation' };
const alertLabel = k => ALERT_LABEL[k] || (k.startsWith('sensor_bad_') ? k.slice(11) + ' sensor invalid' : k.startsWith('sensor_missing_') ? k.slice(15) + ' readings missing' : k);
let bat = null, histMin = 60; const charts = {};

function kpi(title, value, unit, tag, sub, cls = '', extra = '') {
  return `<div class="card kpi ${cls}"><div class="card-header"><span class="card-title">${title}</span>${tagHTML(tag)}</div><div><span class="card-value">${value}</span>${unit ? `<span class="card-unit">${unit}</span>` : ''}</div>${extra}<div class="card-sub">${sub || ''}</div></div>`;
}
function openBattery() { bat = null; $('bi-kpis').innerHTML = '<div class="fleet-empty" style="grid-column:1/-1">Loading battery data…</div>'; $('advice-body').innerHTML = ''; $('diag-body').innerHTML = ''; document.querySelectorAll('#range-chips .chip').forEach(c => c.classList.toggle('on', +c.dataset.m === histMin)); refreshBattery(); }
async function refreshBattery() {
  const v = curV(); if (!v) return; let r;
  try { r = await api(`/api/vehicles/${v.vehicle_id}/battery`); } catch (e) { $('bi-kpis').innerHTML = `<div class="fleet-empty" style="grid-column:1/-1">${esc(e.message)}</div>`; return; }
  if (selId !== v.vehicle_id) return; bat = r; renderBattery(v, r); loadHistory(); loadEstimates();
}
function renderBattery(v, r) {
  const s = r.summary, sp = r.spec, k = [], soc = s.soc, soh = s.soh, rul = s.rul, ir = s.resistance, cap = s.capacity, th = s.thermal;
  // SOC
  const gauge = p => `<div class="gauge-wrap"><div class="gauge-bar"><div class="gauge-fill gauge-fill-green" style="width:${p}%"></div></div></div>`;
  if (soc.reported != null) k.push(kpi('State of charge', Math.round(soc.reported), '%', 'measured', soc.estimated != null ? `Reported by the device.<br>Server estimate (coulomb counting): <b>${soc.estimated}%</b>${soc.driftPct != null ? ` · differs by ${soc.driftPct > 0 ? '+' : ''}${soc.driftPct} points` : ''}${soc.stale ? ' · stale' : ''}` : 'Reported by the device.', '', gauge(soc.reported)));
  else if (soc.estimated != null) k.push(kpi('State of charge', Math.round(soc.estimated), '%', 'estimate', `${esc(soc.method || 'Coulomb counting')}${soc.stale ? ' · <b>stale: no recent readings</b>' : ''}. The device does not report SOC.`, '', gauge(soc.estimated)));
  else k.push(kpi('State of charge', '—', '', 'na', esc(soc.limitation || 'No state of charge reported.'), 'muted'));
  // SOH
  if (soh.status === 'ok') k.push(kpi('State of health', soh.pct, '%', 'estimate', `Capacity-based: ${soh.capacityAh} Ah of ${sp.ratedAh} Ah rated.<br>${soh.n} recent runs · data quality: <b>${soh.quality}</b>${soh.quality === 'low' ? ' (treat as rough)' : ''}`, soh.pct <= sp.eolPct ? 'crit' : ''));
  else k.push(kpi('State of health', '—', '', 'na', esc(soh.reason || 'Not available.'), 'muted'));
  // RUL
  if (rul.status === 'ok') k.push(kpi('Remaining useful life', rul.cycles, 'cycles', 'predict', `Until ${rul.eolPct}% capacity${rul.days ? ` · about ${rul.days} days at ${rul.cyclesPerDay} cycles/day` : ''}.<br>Linear trend baseline, R² ${rul.r2}, ${rul.n} observations. Not an ML model.${rul.caveat ? '<br><b>' + esc(rul.caveat) + '</b>' : ''}`));
  else if (rul.status === 'eol_reached') k.push(kpi('Remaining useful life', 0, 'cycles', 'predict', esc(rul.message), 'crit'));
  else if (rul.status === 'no_trend') k.push(kpi('Remaining useful life', '—', '', 'na', esc(rul.message), 'muted'));
  else k.push(kpi('Remaining useful life', '—', '', 'na', `<b>${esc(rul.message || 'Insufficient data for reliable RUL prediction')}</b><br>${esc(rul.reason || '')}`, 'muted'));
  // Temperature
  const lvl = th.tempC == null ? '' : th.tempC >= th.critC ? 'crit' : th.tempC >= th.warnC ? 'warn' : '';
  k.push(kpi('Battery temperature', th.tempC == null ? '—' : th.tempC.toFixed(1), th.tempC == null ? '' : '°C', th.tempC == null ? 'na' : 'measured', `Warning ≥ ${th.warnC} °C · critical ≥ ${th.critC} °C${th.provisional ? ' <b>(provisional defaults, set the manufacturer limits)</b>' : ''}`, lvl));
  // Internal resistance
  if (ir.latest != null) k.push(kpi('Internal resistance', ir.latest, 'mΩ', 'estimate', ir.status === 'ok' ? `Baseline ${ir.baseline} mΩ · now ${ir.changePct > 0 ? '+' : ''}${ir.changePct}%.<br>Pack-level estimate from load steps, not a lab measurement.` : `${ir.n} estimate${ir.n === 1 ? '' : 's'} stored. ${esc(ir.reason || '')}`));
  else k.push(kpi('Internal resistance', '—', '', 'na', 'Needs the current to change by 10 A or more within a few seconds while voltage is logged. Estimates appear automatically.', 'muted'));
  // Capacity
  if (soh.status === 'ok') k.push(kpi('Remaining capacity', soh.capacityAh, 'Ah', 'estimate', `${cap.energyKwh != null ? `≈ ${cap.energyKwh} kWh of ${cap.ratedKwh} kWh rated` : 'Add the nominal voltage to see kWh'}.<br>${cap.observations} capacity observation${cap.observations === 1 ? '' : 's'} stored.`));
  else if (cap.latestAh != null) k.push(kpi('Remaining capacity', cap.latestAh, 'Ah', 'estimate', `Latest single observation (${cap.observations} so far). More are needed for a stable value.`));
  else k.push(kpi('Remaining capacity', '—', '', 'na', 'Appears after a charge or discharge run covering at least 30% of SOC with the device reporting SOC.', 'muted'));
  // Cycles
  if (s.eqCycles != null && s.throughput.dischargeAh > 0) k.push(kpi('Equivalent full cycles', s.eqCycles, 'cycles', 'estimate', `Discharged ${s.throughput.dischargeAh} Ah ÷ rated capacity. Counts continuous data only, so it can under-count after outages.`));
  else k.push(kpi('Equivalent full cycles', '—', '', 'na', 'Needs current readings and the rated capacity.', 'muted'));
  const mo = s.motion;
  if (mo.supported) k.push(kpi('Motion (MPU6050)', mo.gForce != null ? mo.gForce.toFixed(2) : '—', 'g', 'measured', `${mo.gyroDps != null ? `Rotation ${Math.round(mo.gyroDps)} °/s. ` : ''}Alerts: ${mo.warnG} g warning · ${mo.critG} g critical${mo.warnDps ? ` · ${mo.warnDps}/${mo.critDps} °/s` : ''}${mo.provisional ? '.<br><b>Provisional defaults: tune them to your vehicle.</b>' : ''}`, mo.gForce != null && mo.gForce >= mo.critG ? 'crit' : mo.gForce != null && mo.gForce >= mo.warnG ? 'warn' : ''));
  if (s.imbalance.supported) k.push(kpi('Cell voltage spread', (s.imbalance.spreadV * 1000).toFixed(0), 'mV', 'measured', `Highest minus lowest cell (${s.imbalance.cellMaxV.toFixed(3)} / ${s.imbalance.cellMinV.toFixed(3)} V). Alert at ${(s.imbalance.thresholdV * 1000).toFixed(0)} mV.`, s.imbalance.spreadV >= s.imbalance.thresholdV ? 'warn' : ''));
  if (s.insulation.supported) k.push(kpi('Insulation resistance', Math.round(s.insulation.kohm), 'kΩ', 'measured', s.insulation.minKohm ? `Alert below ${s.insulation.minKohm} kΩ.` : 'Set a minimum in the battery specification to enable an alert.'));
  $('bi-kpis').innerHTML = k.join('');

  const ban = $('spec-banner');
  if (!s.specComplete) { ban.hidden = false; ban.innerHTML = `<b>${s.missing.some(m => m.field === 'ratedAh') ? 'Battery specification needed.' : 'Battery specification incomplete.'}</b> Estimates stay off rather than guessing.<ul>${s.missing.map(m => `<li><code>${esc(m.field)}</code> — ${esc(m.why)}</li>`).join('')}</ul>${canEdit() ? '<button class="btn primary" onclick="openSpec()">Enter specification</button>' : '<span class="hint">Ask a manager or the host to enter it.</span>'}`; } else ban.hidden = true;
  renderAdvice(r.advice); renderDiag(r);
}
function renderAdvice(a) {
  const el = $('advice-body'); if (!a) { el.innerHTML = '<div class="hint">Advice appears once the vehicle reports a state of charge.</div>'; return; }
  const meta = `<div class="hint" style="margin-top:12px">${esc(a.method)} Computed ${rel(a.computedAt)}.</div>`;
  if (a.status === 'collecting') { const p = a.have && a.have.hours ? Math.min(100, Math.round(a.have.hours / a.need.hours * 100)) : 0; el.innerHTML = `<p>${esc(a.message)}</p>${a.need ? `<div class="gauge-bar" style="margin:12px 0"><div class="gauge-fill gauge-fill-blue" style="width:${p}%"></div></div>` : ''}<div class="hint">Advice starts once the system has enough real history of this vehicle (about 3 days of regular use). Nothing is guessed before that.</div>${meta}`; return; }
  if (a.status !== 'ok') { el.innerHTML = `<p>${esc(a.message)}</p>`; return; }
  const cell = (l, v) => `<div class="adv-cell"><span>${l}</span><b>${v}</b></div>`;
  const start = a.needPct <= 0 ? '—' : a.startNow ? 'Now' : new Date(a.startBy).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `<p class="adv-msg ${a.needPct > 0 ? 'need' : ''}">${esc(a.message)}</p><div class="adv-grid">${cell('Charge to', a.needPct > 0 ? a.targetSoc + '%' : '—')}${cell('Add', a.needPct > 0 ? '+' + a.needPct + '%' : '—')}${cell('Energy', a.energyKwh != null ? a.energyKwh + ' kWh' : '—')}${cell('Takes about', a.hoursToCharge != null ? a.hoursToCharge + ' h' : '—')}${cell('Start by', start)}${cell('Ready for', a.readyBy || '—')}</div>
    <div class="hint" style="margin-top:10px">Based on ${a.basis.days} days of data: usual daily use ${a.dailyUsagePct}% · driving uses ${a.dischargeRatePctPerH}%/h${a.runwayHours != null ? ` · ${a.runwayHours} h of driving left above the ${a.basis.reserveSoc}% reserve` : ''}.</div>${meta}`;
}
function renderDiag(r) {
  const s = r.summary, act = s.activeAlerts.filter(a => a.key !== 'advice'), parts = [];
  parts.push(act.length ? `<div class="diag-group"><div class="diag-h">Active now</div>${act.map(a => `<div class="diag-item ${a.level === 2 ? 'crit' : 'warn'}"><span class="ndot"></span><b>${esc(alertLabel(a.key))}</b><small>since ${when(a.since)}</small></div>`).join('')}</div>` : '<div class="diag-ok">✓ No active alerts</div>');
  if (r.recentAlerts.length) parts.push(`<div class="diag-group"><div class="diag-h">Last 7 days</div>${r.recentAlerts.slice(0, 6).map(n => `<div class="diag-item sev-${n.severity}"><span class="ndot"></span><b>${esc(n.title.replace(/^[^:]+: /, ''))}</b><small>${rel(new Date(n.time).getTime())}</small></div>`).join('')}</div>`);
  const notes = [...s.quality];
  if (!s.motion.supported) notes.push('No MPU6050 motion data is being received, so sudden-acceleration and impact alerts are off. Send ax, ay, az (g) and gx, gy, gz (°/s), plus g_peak for the strongest value between posts.');
  if (!s.imbalance.supported) notes.push('Cell-level voltages are not reported by this device, so cell imbalance cannot be monitored. A BMS that exposes per-cell voltages is needed.');
  if (!s.insulation.supported) notes.push('Insulation resistance is not reported, so it is not shown. It needs a BMS or insulation monitor that provides it.');
  if (r.spec.vMin == null || r.spec.vMax == null) notes.push('Pack voltage alerts are off until minimum and maximum voltage are set.');
  notes.push('Dashboard alerts are software monitoring only. They do not replace hardware battery protection.');
  parts.push(`<div class="diag-group"><div class="diag-h">Data quality &amp; limitations</div><ul class="diag-notes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>`);
  $('diag-body').innerHTML = parts.join('');
}

// ── Charts (actual stored data only) ──
function chartColors() { const d = document.body.dataset.theme === 'dark'; return { grid: d ? '#2a3048' : '#dde3ec', txt: d ? '#9aa3be' : '#8a92a8' }; }
function drawChart(key, id, data, o = {}) {
  const el = $(id), empty = el.parentElement.querySelector('.chart-empty'), type = o.type || 'line';
  if (typeof Chart === 'undefined') { empty.hidden = false; empty.textContent = 'Charts could not load. Check your connection.'; el.style.visibility = 'hidden'; return; }
  const has = data.datasets.some(d => d.data.some(p => p != null && (typeof p !== 'object' || p.y != null)));
  if (!has) { empty.hidden = false; empty.textContent = o.empty || 'No readings in this period.'; el.style.visibility = 'hidden'; if (charts[key]) { charts[key].destroy(); charts[key] = null; } return; }
  empty.hidden = true; el.style.visibility = 'visible';
  if (charts[key] && charts[key].vid === selId && charts[key].config.type === type) { charts[key].data.labels = data.labels; charts[key].data.datasets = data.datasets; charts[key].update('none'); return; }
  if (charts[key]) charts[key].destroy();
  const c = chartColors(), xt = { color: c.txt, font: { size: 10 }, maxTicksLimit: 6 }, x = { grid: { color: c.grid }, ticks: xt };
  if (o.linearX) { x.type = 'linear'; if (o.xTime) xt.callback = v => new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); if (o.xTitle) x.title = { display: true, text: o.xTitle, color: c.txt, font: { size: 10 } }; }
  const scales = { x, y: { grid: { color: c.grid }, ticks: { color: c.txt, font: { size: 10 } }, ...(o.y || {}) } };
  if (o.y1) scales.y1 = { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: c.txt, font: { size: 10 } }, ...o.y1 };
  charts[key] = new Chart(el, { type, data, options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'nearest', intersect: false }, plugins: { legend: { display: data.datasets.filter(d => !d.hidden).length > 1, labels: { color: c.txt, boxWidth: 10, font: { size: 10 } } } }, scales } });
  charts[key].vid = selId;
}
const ds = (label, data, color, extra = {}) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, tension: .3, spanGaps: true, ...extra });
const limitLine = (label, n, val, color) => ds(label, Array(n).fill(val), color, { borderWidth: 1, borderDash: [3, 4] });
async function loadHistory() {
  const v = curV(); if (!v) return; let h; try { h = await api(`/api/vehicles/${v.vehicle_id}/history?minutes=${histMin}`); } catch { return; } if (selId !== v.vehicle_id) return;
  const labels = h.map(r => { const d = new Date(r.time); return histMin > 1440 ? d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit' }) : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); }), col = f => h.map(r => r[f] ?? null), sp = (bat && bat.spec) || v.spec || {}, n = h.length, none = 'No readings in this period.';
  drawChart('soc', 'ch-soc', { labels, datasets: [ds('Reported by device', col('battery'), '#00c48c'), ds('Estimated by server', col('socEst'), '#0084ff', { borderDash: [5, 4] })] }, { y: { min: 0, max: 100 }, empty: none });
  drawChart('volt', 'ch-volt', { labels, datasets: [ds('Voltage', col('voltage'), '#0084ff'), ...(sp.vMin != null ? [limitLine('Minimum', n, sp.vMin, '#e84646')] : []), ...(sp.vMax != null ? [limitLine('Maximum', n, sp.vMax, '#e84646')] : [])] }, { empty: none });
  drawChart('curr', 'ch-curr', { labels, datasets: [ds('Current', col('current'), '#ff7b54')] }, { empty: none });
  drawChart('temp', 'ch-temp', { labels, datasets: [ds('Temperature', col('temp'), '#e84646'), limitLine('Warning', n, sp.tempWarnC, '#ffb347'), limitLine('Critical', n, sp.tempCritC, '#e84646')] }, { empty: none });
  drawChart('motion', 'ch-motion', { labels, datasets: [ds('g-force (peak)', col('gForce'), '#ff7b54'), limitLine('g warning', n, sp.accelWarnG, '#ffb347'), limitLine('g critical', n, sp.accelCritG, '#e84646'), ds('Rotation (°/s)', col('gyroDps'), '#8a5cff', { yAxisID: 'y1', borderWidth: 1 })] }, { y: { min: 0 }, y1: { min: 0 }, empty: 'No MPU6050 data yet. The device must send ax, ay, az (g) and gx, gy, gz (°/s).' });
  drawChart('cell', 'ch-cell', { labels, datasets: [ds('Max − min cell', h.map(r => r.cellMax != null && r.cellMin != null ? (r.cellMax - r.cellMin) * 1000 : null), '#8a5cff')] }, { empty: 'This device does not report cell voltages. A BMS that exposes them is needed.' });
}
async function loadEstimates() {
  const v = curV(); if (!v) return; let cap, soh, res;
  try { [cap, soh, res] = await Promise.all(['capacity', 'soh', 'resistance'].map(k => api(`/api/vehicles/${v.vehicle_id}/estimates?kind=${k}&days=365`))); } catch { return; } if (selId !== v.vehicle_id) return;
  const pt = r => ({ x: new Date(r.time).getTime(), y: r.value });
  drawChart('res', 'ch-res', { datasets: [ds('Estimated pack resistance', res.map(pt), '#8a5cff', { showLine: true, pointRadius: 3 })] }, { type: 'line', linearX: true, xTime: true, empty: 'No valid load steps yet. Needs current changing by 10 A or more within seconds.' });
  drawChart('cap', 'ch-cap', { datasets: [ds('Capacity (Ah)', cap.map(pt), '#00c48c', { pointRadius: 3, yAxisID: 'y' }), ds('SOH (%)', soh.map(pt), '#0084ff', { pointRadius: 3, yAxisID: 'y1', borderDash: [5, 4] })] }, { linearX: true, xTime: true, y1: {}, empty: 'No capacity observations yet. They appear after a charge or discharge run covering at least 30% SOC with the device reporting SOC.' });
  const rul = bat && bat.summary.rul, pts = cap.filter(r => r.meta && r.meta.efc != null).map(r => ({ x: r.meta.efc, y: r.value })), sets = [{ label: 'Observed capacity (Ah)', data: pts, borderColor: '#00c48c', backgroundColor: '#00c48c', pointRadius: 3, showLine: false }];
  if (rul && rul.status === 'ok' && rul.fit && pts.length) { const x0 = Math.min(...pts.map(p => p.x)), x1 = rul.fit.xEol, f = x => rul.fit.b0 + rul.fit.b1 * x;
    sets.push({ label: 'Trend (statistical baseline)', data: [{ x: x0, y: f(x0) }, { x: x1, y: f(x1) }], borderColor: '#8a5cff', borderDash: [6, 4], borderWidth: 2, pointRadius: 0, showLine: true }, { label: `End-of-life (${rul.eolPct}%)`, data: [{ x: x0, y: rul.fit.targetAh }, { x: x1, y: rul.fit.targetAh }], borderColor: '#e84646', borderWidth: 1, pointRadius: 0, showLine: true }); }
  drawChart('rul', 'ch-rul', { datasets: sets }, { type: 'scatter', linearX: true, xTitle: 'Equivalent full cycles', empty: 'No capacity observations yet.' });
  $('rul-note').textContent = rul ? (rul.status === 'ok' ? 'The dashed trend is a straight-line extrapolation of this vehicle’s own capacity history, not a trained model.' : `${rul.message || ''} ${rul.reason || ''}`.trim()) : '';
}
$('range-chips').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (!b) return; histMin = +b.dataset.m; document.querySelectorAll('#range-chips .chip').forEach(c => c.classList.toggle('on', c === b)); loadHistory(); });

// ── Battery specification form ──
const SPEC_FIELDS = [['ratedAh', 'Rated capacity (Ah)', 'from the datasheet'], ['nominalV', 'Nominal pack voltage (V)', ''], ['cellsSeries', 'Cells in series', ''], ['eolPct', 'End-of-life threshold (% of rated)', 'default 80'],
  ['tempWarnC', 'Temperature warning (°C)', 'provisional 45'], ['tempCritC', 'Temperature critical (°C)', 'provisional 55'], ['vMin', 'Minimum pack voltage (V)', 'standard for chemistry × cells'], ['vMax', 'Maximum pack voltage (V)', 'standard for chemistry × cells'],
  ['maxDischargeA', 'Max discharge current (A)', ''], ['maxChargeA', 'Max charge current (A)', ''], ['imbalanceWarnV', 'Cell imbalance warning (V)', 'provisional 0.10'], ['insulationMinKohm', 'Min insulation resistance (kΩ)', ''],
  ['lowSocWarn', 'Low charge warning (%)', 'default 20'], ['lowSocCrit', 'Low charge critical (%)', 'default 10'], ['accelWarnG', 'Acceleration warning (g)', 'provisional 0.4'], ['accelCritG', 'Acceleration critical (g)', 'provisional 1.0'], ['gyroWarnDps', 'Rotation warning (°/s)', 'provisional 120'], ['gyroCritDps', 'Rotation critical (°/s)', 'provisional 250'], ['reserveSoc', 'Reserve charge for advice (%)', 'default 20'], ['targetSoc', 'Highest daily charge target (%)', 'default 90 (100 for LFP)']];
function openSpec() {
  const v = curV(); if (!v) return; const s = v.battery || {};
  modal('Battery specification', `<p class="hint">Use the manufacturer’s datasheet. Leave a field empty if you do not know it: features that depend on it stay off instead of using a guess.</p><form id="spec-form" class="stack"><label>Chemistry<select name="chemistry"><option value="">Not set</option>${['NMC', 'NCA', 'LFP', 'LCO', 'LTO', 'LEAD_ACID', 'OTHER'].map(c => `<option ${s.chemistry === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    <div class="grid2">${SPEC_FIELDS.map(([k, l, ph]) => `<label>${l}<input name="${k}" type="number" step="any" value="${s[k] ?? ''}" placeholder="${ph}"/></label>`).join('')}</div><div class="form-msg" id="spec-msg" role="alert"></div><div class="btn-row"><button class="btn primary" type="submit">Save specification</button><button class="btn" type="button" onclick="closeModal()">Cancel</button></div></form>`, true);
  $('spec-form').addEventListener('submit', async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)), b = {}; Object.entries(f).forEach(([k, x]) => { if (String(x).trim() !== '') b[k] = x; });
    try { const u = await api('/api/vehicles/' + v.vehicle_id, { method: 'PATCH', body: { battery: b } }); Object.assign(v, u); closeModal(); showNotif('✅', 'Battery specification saved'); refreshBattery(); } catch (err) { setMsg('spec-msg', err.message); } });
}
$('spec-btn').addEventListener('click', openSpec);

// ═══ Map: Google Maps when a key is configured, otherwise OpenStreetMap (Leaflet). Falls back automatically. ═══
const MapX = { kind: null, map: null, veh: null, fence: null, chg: [], layer: null, info: null, loading: null, onClick: null };
const mapMsg = t => { const m = $('map-msg'); m.hidden = !t; m.textContent = t || ''; };
const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('blocked ' + src)); document.head.appendChild(s); });
const loadCss = href => new Promise(res => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.onload = res; l.onerror = res; document.head.appendChild(l); });
function initGoogle() {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Google Maps timed out')), 12000);
    window.gm_authFailure = () => { mapMsg('Google Maps rejected the API key (check the key, billing and allowed website addresses). Using OpenStreetMap instead.'); mapFallback(); };
    window.__gmReady = () => { clearTimeout(t); try {
      MapX.kind = 'google'; MapX.map = new google.maps.Map($('map-canvas'), { center: { lat: 20.59, lng: 78.96 }, zoom: 5, mapTypeControl: false, streetViewControl: false, clickableIcons: false });
      MapX.map.addListener('click', e => MapX.onClick && MapX.onClick(e.latLng.lat(), e.latLng.lng())); MapX.info = new google.maps.InfoWindow(); resolve(); } catch (e) { reject(e); } };
    loadScript(`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.map.googleKey)}&callback=__gmReady&v=weekly`).catch(e => { clearTimeout(t); reject(e); });
  });
}
async function initLeaflet() {
  if (typeof L === 'undefined') { await loadCss('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'); await loadScript('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'); }
  const m = L.map('map-canvas').setView([20.59, 78.96], 5); MapX.kind = 'leaflet'; MapX.map = m;
  const carto = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd', attribution: '© OpenStreetMap contributors © CARTO' }),
    osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }); let errs = 0;
  carto.on('tileerror', () => { if (++errs === 6) { m.removeLayer(carto); osm.addTo(m); } });     // basemap blocked on this network: switch tile provider
  carto.addTo(m); MapX.layer = L.layerGroup().addTo(m); m.on('click', e => MapX.onClick && MapX.onClick(e.latlng.lat, e.latlng.lng));
}
async function mapEnsure() {
  if (MapX.map) { mapResize(); return true; }
  if (!MapX.loading) MapX.loading = (async () => {
    if (cfg.map.provider === 'google') { try { await initGoogle(); return true; } catch (e) { $('map-canvas').innerHTML = ''; MapX.map = null; } }
    try { await initLeaflet(); return true; } catch (e) { mapMsg('The map could not load. Check your internet connection or ad blocker and reload the page.'); return false; }
  })();
  const ok = await MapX.loading; if (!ok) MapX.loading = null; return ok;
}
async function mapFallback() { if (MapX.kind === 'leaflet') return; Object.assign(MapX, { map: null, veh: null, fence: null, chg: [], loading: null }); $('map-canvas').innerHTML = ''; cfg.map.provider = 'osm'; if (await mapEnsure()) { mapMsg(''); updateMap(true); } }
function mapResize() { if (!MapX.map) return; if (MapX.kind === 'google') google.maps.event.trigger(MapX.map, 'resize'); else MapX.map.invalidateSize(); }
function mapCursor(on) { if (MapX.kind === 'google') MapX.map.setOptions({ draggableCursor: on ? 'crosshair' : null }); else $('map-canvas').style.cursor = on ? 'crosshair' : ''; }
function mapFocus(lat, lng, z) { if (MapX.kind === 'google') { MapX.map.setCenter({ lat, lng }); MapX.map.setZoom(z); } else MapX.map.setView([lat, lng], z); }
function mapSetVehicle(p, html, center) {
  if (!p) { if (MapX.veh) { MapX.kind === 'google' ? MapX.veh.setMap(null) : MapX.veh.remove(); MapX.veh = null; } return; }
  if (MapX.kind === 'google') {
    if (!MapX.veh) { MapX.veh = new google.maps.Marker({ map: MapX.map, position: { lat: p[0], lng: p[1] }, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#00c48c', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 } }); MapX.veh.addListener('click', () => { MapX.info.setContent(MapX.vehHtml); MapX.info.open(MapX.map, MapX.veh); }); }
    else MapX.veh.setPosition({ lat: p[0], lng: p[1] }); MapX.vehHtml = html;
  } else {
    if (!MapX.veh) MapX.veh = L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="veh-pin"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(MapX.map).bindPopup(html); else { MapX.veh.setLatLng(p); MapX.veh.setPopupContent(html); }
  }
  if (center) mapFocus(p[0], p[1], 14);
}
function mapSetFence(f, fit) {
  if (!f || f.lat == null) { if (MapX.fence) { MapX.kind === 'google' ? MapX.fence.setMap(null) : MapX.fence.remove(); MapX.fence = null; } return; }
  const col = f.enabled ? '#00c48c' : '#8a92a8';
  if (MapX.kind === 'google') {
    const o = { strokeColor: col, strokeOpacity: .9, strokeWeight: 2, fillColor: col, fillOpacity: .08, center: { lat: f.lat, lng: f.lng }, radius: f.radiusKm * 1000, clickable: false };
    if (!MapX.fence) MapX.fence = new google.maps.Circle({ map: MapX.map, ...o }); else MapX.fence.setOptions(o); if (fit) MapX.map.fitBounds(MapX.fence.getBounds());
  } else {
    const o = { color: col, fillColor: col, fillOpacity: .08, weight: 2, dashArray: '8 5' };
    if (!MapX.fence) MapX.fence = L.circle([f.lat, f.lng], { ...o, radius: f.radiusKm * 1000 }).addTo(MapX.map); else { MapX.fence.setLatLng([f.lat, f.lng]); MapX.fence.setRadius(f.radiusKm * 1000); MapX.fence.setStyle(o); }
    if (fit) MapX.map.fitBounds(MapX.fence.getBounds(), { padding: [30, 30] });
  }
}
function mapSetChargers(list) {
  if (MapX.kind === 'google') { MapX.chg.forEach(m => m.setMap(null)); MapX.chg = list.map(c => { const m = new google.maps.Marker({ map: MapX.map, position: { lat: c.lat, lng: c.lon }, label: { text: '⚡', fontSize: '12px' }, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 12, fillColor: '#0084ff', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 } });
    m.addListener('click', () => { MapX.info.setContent(`${esc(c.name)}${c.operator ? '<br>' + esc(c.operator) : ''}<br>${c.distKm.toFixed(1)} km away`); MapX.info.open(MapX.map, m); }); return m; }); }
  else { MapX.layer.clearLayers(); list.forEach(c => L.marker([c.lat, c.lon], { icon: L.divIcon({ className: '', html: '<div class="chg-pin">⚡</div>', iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(MapX.layer).bindPopup(esc(c.name) + (c.operator ? '<br>' + esc(c.operator) : '') + '<br>' + c.distKm.toFixed(1) + ' km away')); }
}
let editing = false, mapFor = null, chgFor = null, draft = { enabled: false, lat: null, lng: null, radiusKm: 5 };
MapX.onClick = (lat, lng) => { if (!editing) return; draft.lat = lat; draft.lng = lng; setEditing(false); mapSetFence(draft, true); syncFenceUI(); };
function setEditing(on) { editing = on; $('fence-place').textContent = on ? 'Click the map…' : 'Pick centre on map'; if (MapX.map) mapCursor(on); }
function syncFenceUI() {
  $('fence-on').checked = draft.enabled; $('fence-on').disabled = !canEdit(); $('fence-radius').value = draft.radiusKm; $('fence-radius').disabled = !canEdit(); $('fence-centre').textContent = draft.lat == null ? 'Not set' : draft.lat.toFixed(5) + ', ' + draft.lng.toFixed(5);
  const l = (curV() || {}).latest; $('fence-dist').textContent = draft.lat != null && l && l.lat != null ? haversine(l.lat, l.lon, draft.lat, draft.lng).toFixed(2) + ' km' : '—';
}
async function updateMap(first) {
  const v = curV(); if (!v) return; if (!(await mapEnsure())) return; if (curV() !== v) return;
  if (mapFor !== v.vehicle_id) { mapFor = v.vehicle_id; first = true; const f = v.fence || {}; draft = { enabled: !!f.enabled, lat: f.lat ?? null, lng: f.lng ?? null, radiusKm: f.radiusKm || 5 }; setEditing(false); mapSetFence(null); mapSetVehicle(null); chgFor = null; }
  syncFenceUI(); const l = v.latest, gps = l && l.lat != null && !(l.lat === 0 && l.lon === 0);
  if (gps) { mapSetVehicle([l.lat, l.lon], `<b>${esc(v.name)}</b><br>${l.lat.toFixed(5)}, ${l.lon.toFixed(5)}`, first); $('map-sub').textContent = `${l.lat.toFixed(5)}, ${l.lon.toFixed(5)} · ${ago(timeOf(v))}`; mapMsg(''); }
  else { mapSetVehicle(null); $('map-sub').textContent = 'No GPS fix yet — the vehicle appears here once it reports a position.'; }
  mapSetFence(draft.lat != null ? draft : null, first && !gps && draft.lat != null);
  const geo = geoOf(v), gb = $('geo-status-badge'); gb.textContent = GEO_TXT[geo]; gb.className = 'card-badge ' + ({ ok: 'badge-ok', warn: 'badge-warn', breach: 'badge-crit' }[geo] || '');
  loadChargers(v);
}
$('fence-on').addEventListener('change', e => { draft.enabled = e.target.checked; mapSetFence(draft.lat != null ? draft : null); });
$('fence-radius').addEventListener('input', e => { const r = parseFloat(e.target.value); if (r > 0) { draft.radiusKm = r; mapSetFence(draft.lat != null ? draft : null); syncFenceUI(); } });
$('fence-place').addEventListener('click', () => { setEditing(!editing); if (editing) showNotif('📍', 'Click the map to set the geofence centre'); });
$('fence-here').addEventListener('click', () => { const l = (curV() || {}).latest; if (!l || l.lat == null) { showNotif('ℹ', 'The vehicle has not reported a GPS position yet'); return; } draft.lat = l.lat; draft.lng = l.lon; mapSetFence(draft, true); syncFenceUI(); });
$('fence-save').addEventListener('click', async () => {
  const v = curV(); if (draft.enabled && draft.lat == null) { showNotif('⚠', 'Pick a centre on the map first'); return; }
  try { const u = await api('/api/vehicles/' + v.vehicle_id, { method: 'PATCH', body: { fence: draft } }); v.fence = u.fence; showNotif('✅', draft.enabled ? 'Geofence saved. Crossing it will alert the dashboard and email.' : 'Geofence turned off'); updateMap(false); renderFleet(); } catch (e) { showNotif('⚠', e.message); }
});
async function loadChargers(v) {
  const list = $('chg-list'), l = v.latest;
  if (!l || l.lat == null) { list.innerHTML = '<div class="fleet-empty" style="padding:20px 0">Nearby chargers appear once the vehicle reports a GPS position.</div>'; mapSetChargers([]); chgFor = null; return; }
  if (chgFor && chgFor.id === v.vehicle_id && haversine(chgFor.lat, chgFor.lon, l.lat, l.lon) < 1) return;
  chgFor = { id: v.vehicle_id, lat: l.lat, lon: l.lon }; list.innerHTML = '<div class="fleet-empty" style="padding:20px 0">Looking up chargers near the vehicle…</div>'; mapSetChargers([]);
  try {
    const d = await api(`/api/chargers?lat=${l.lat}&lon=${l.lon}`);
    if (!d.length) { list.innerHTML = '<div class="fleet-empty" style="padding:20px 0">No charging stations found within 15 km of the vehicle.</div>'; return; }
    list.innerHTML = d.map((c, i) => `<div class="cs-item" data-i="${i}"><span class="cs-dot cs-avail"></span><span class="cs-name">${esc(c.name)}</span><span class="cs-dist">${c.distKm.toFixed(1)} km</span>${c.capacity ? `<span class="cs-type">${esc(c.capacity)} points</span>` : ''}</div>`).join('');
    mapSetChargers(d); list.onclick = e => { const it = e.target.closest('[data-i]'); if (it) mapFocus(d[it.dataset.i].lat, d[it.dataset.i].lon, 16); };
  } catch (e) { list.innerHTML = `<div class="fleet-empty" style="padding:20px 0">${esc(e.message)}<br><button class="btn" style="margin-top:12px" onclick="chgFor=null;updateMap(false)">Try again</button></div>`; }
}

// ═══ Notification centre ═══
const SEV_ICON = { critical: '🚨', warning: '⚠️', info: 'ℹ️' };
let noteSeen = null, noteUnread = 0, noteItems = [], noteFilter = 'all', notePage = { items: [], more: false };
function resetNotes() { noteSeen = null; noteUnread = 0; noteItems = []; notePage = { items: [], more: false }; updateBell(); }
function updateBell() { const t = noteUnread > 99 ? '99+' : noteUnread; ['bell-count', 'note-count'].forEach(id => { const e = $(id); e.hidden = !noteUnread; e.textContent = t; }); document.title = (noteUnread ? `(${t}) ` : '') + 'EV Fleet Monitor'; }
function emailBadge(n) { return n.emailStatus === 'sent' ? ' · ✉ emailed' : n.emailStatus === 'failed' ? ' · ✉ email failed' : n.emailStatus === 'skipped' ? ' · ✉ not sent (email not configured)' : n.emailStatus === 'pending' ? ' · ✉ sending' : ''; }
function noteRow(n) { return `<div class="nrow ${n.read ? '' : 'unread'} sev-${n.severity}" data-id="${n.id}"><span class="ndot"></span><div class="nbody"><b>${esc(n.title)}</b><span>${esc(n.message).replace(/\n/g, '<br>')}</span><small>${rel(new Date(n.time).getTime())}${n.vehicle_name ? ' · ' + esc(n.vehicle_name) : ''}${isHost() ? emailBadge(n) : ''}</small></div></div>`; }
async function pollNotes() {
  let r; try { r = await api('/api/notifications?limit=30'); } catch { return; }
  const first = noteSeen === null; if (first) noteSeen = new Set(); const fresh = r.items.filter(n => !noteSeen.has(n.id)); r.items.forEach(n => noteSeen.add(n.id));
  noteItems = r.items; noteUnread = r.unread; updateBell(); if (!$('bell-panel').hidden) renderBell();
  if (!first && fresh.length) { announce(fresh); if (curTab === 'notifications' && noteFilter === 'all') loadNotePage(true); }
}
function announce(fresh) {
  const top = fresh.find(n => n.severity === 'critical') || fresh.find(n => n.severity === 'warning') || fresh[0];
  showNotif(SEV_ICON[top.severity], fresh.length > 1 ? `${top.title} (+${fresh.length - 1} more)` : top.title);
  if (top.severity !== 'info' && document.hidden && 'Notification' in window && Notification.permission === 'granted') { try { new Notification(top.title, { body: top.message }); } catch {} }
}
function renderBell() { $('bp-list').innerHTML = noteItems.length ? noteItems.slice(0, 8).map(noteRow).join('') : '<div class="fleet-empty" style="padding:28px 0">Nothing yet. Alerts appear here as they happen.</div>'; }
$('bell-btn').addEventListener('click', e => { e.stopPropagation(); $('menu').hidden = true; const p = $('bell-panel'); p.hidden = !p.hidden; $('bell-btn').setAttribute('aria-expanded', !p.hidden); if (!p.hidden) renderBell(); });
async function markRead(body) { try { await api('/api/notifications/read', { method: 'POST', body }); } catch {} }
function noteTarget(n) {
  const v = n.vehicle_id && vehicles.find(x => x.vehicle_id === n.vehicle_id);
  if (v) location.hash = `#/vehicle/${v.vehicle_id}/${n.type === 'geofence' ? 'maps' : ['system', 'security'].includes(n.type) ? 'overview' : 'battery'}`;
  else if (n.type === 'access' && isHost()) location.hash = '#/admin'; else if (!location.hash.startsWith('#/notifications')) location.hash = '#/notifications';
}
function onNoteClick(e) {
  const row = e.target.closest('.nrow'); if (!row) return; const id = row.dataset.id, n = [...noteItems, ...notePage.items].find(x => x.id === id); if (!n) return;
  if (!n.read) { n.read = true; noteUnread = Math.max(0, noteUnread - 1); updateBell(); row.classList.remove('unread'); markRead({ ids: [id] }); } $('bell-panel').hidden = true; noteTarget(n);
}
$('bp-list').addEventListener('click', onNoteClick); $('note-list').addEventListener('click', onNoteClick);
async function readAll() { await markRead({ all: true }); noteItems.forEach(n => n.read = true); notePage.items.forEach(n => n.read = true); noteUnread = 0; updateBell(); renderBell(); renderNotePage(); }
$('bp-readall').addEventListener('click', e => { e.stopPropagation(); readAll(); }); $('readall-btn').addEventListener('click', readAll);
async function loadNotePage(reset) {
  const qs = new URLSearchParams({ limit: '30' }); if (noteFilter === 'unread') qs.set('unread', '1'); else if (noteFilter !== 'all') qs.set('severity', noteFilter);
  if (!reset && notePage.items.length) qs.set('before', notePage.items[notePage.items.length - 1].time);
  let r; try { r = await api('/api/notifications?' + qs); } catch (e) { showNotif('⚠', e.message); return; }
  notePage.items = reset ? r.items : notePage.items.concat(r.items); notePage.more = r.items.length === 30; renderNotePage();
}
function renderNotePage() { $('note-list').innerHTML = notePage.items.map(noteRow).join(''); $('note-empty').hidden = notePage.items.length > 0; $('note-more').hidden = !notePage.more; }
$('note-more').addEventListener('click', () => loadNotePage(false));
$('note-filters').addEventListener('click', e => { const b = e.target.closest('[data-n]'); if (!b) return; noteFilter = b.dataset.n; document.querySelectorAll('#note-filters .chip').forEach(c => c.classList.toggle('on', c === b)); loadNotePage(true); });
$('desk-btn').addEventListener('click', async () => { if (!('Notification' in window)) { showNotif('ℹ', 'This browser does not support desktop alerts'); return; } const p = await Notification.requestPermission(); showNotif(p === 'granted' ? '✅' : 'ℹ', p === 'granted' ? 'Desktop alerts on while this tab stays open' : 'Desktop alerts were not allowed'); });

// ── Profile ──
function fillProfile() {
  const f = $('prof-form'); f.name.value = me.name; $('prof-email').value = me.email; $('prof-role').textContent = ROLE_TXT[me.role]; $('prof-since').textContent = new Date(me.createdAt).toLocaleDateString('en-IN', { dateStyle: 'long' });
  f.emailAlerts.checked = isHost() || me.emailAlerts; f.emailAlerts.disabled = isHost(); f.emailAlerts.nextElementSibling.textContent = isHost() ? 'As host you always receive every notification by email' : 'Email me warnings, critical alerts and charging advice'; setMsg('prof-msg', ''); setMsg('pw-msg', '');
}
$('prof-form').addEventListener('submit', async e => { e.preventDefault(); try { me = await api('/api/me', { method: 'PATCH', body: { name: e.target.name.value, emailAlerts: e.target.emailAlerts.checked } }); $('m-name').textContent = me.name; $('profile-btn').textContent = me.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase(); setMsg('prof-msg', 'Saved', true); } catch (err) { setMsg('prof-msg', err.message); } });
$('pw-form').addEventListener('submit', async e => { e.preventDefault(); const f = e.target; try { await api('/api/me', { method: 'PATCH', body: { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value } }); f.reset(); setMsg('pw-msg', 'Password updated', true); } catch (err) { setMsg('pw-msg', err.message); } });

// ── Host: team, roles, system status ──
async function refreshPending() { try { pendingUsers = (await api('/api/admin/users')).filter(u => u.status === 'pending'); const b = $('req-count'); b.hidden = !pendingUsers.length; b.textContent = pendingUsers.length; } catch {} }
const roleSel = (u, cur) => `<select data-role-for="${u.id}" aria-label="Role"><option value="viewer" ${cur === 'viewer' ? 'selected' : ''}>Viewer · view only</option><option value="manager" ${cur === 'manager' ? 'selected' : ''}>Manager · add &amp; edit vehicles</option></select>`;
async function loadAdmin() {
  let us; try { us = await api('/api/admin/users'); } catch (e) { $('pending-list').textContent = e.message; return; }
  pendingUsers = us.filter(u => u.status === 'pending'); const b = $('req-count'); b.hidden = !pendingUsers.length; b.textContent = pendingUsers.length;
  const day = d => new Date(d).toLocaleDateString('en-IN', { dateStyle: 'medium' }), btn = (u, a, t, c = '') => `<button class="btn ${c}" data-act="${a}" data-id="${u.id}">${t}</button>`;
  const row = (u, acts) => `<div class="urow"><div><b>${esc(u.name)}</b><span>${esc(u.email)} · requested ${day(u.createdAt)}${u.status !== 'pending' ? ' · added ' + u.vehicles + ' vehicle' + (u.vehicles === 1 ? '' : 's') : ''}</span></div><div class="btn-row">${acts}</div></div>`;
  $('pending-list').innerHTML = pendingUsers.length ? pendingUsers.map(u => row(u, roleSel(u, 'viewer') + btn(u, 'approve', 'Approve', 'primary') + btn(u, 'reject', 'Reject'))).join('') : '<div class="fleet-empty" style="padding:24px 0">No requests are waiting.</div>';
  const rest = us.filter(u => u.status !== 'pending');
  $('user-list').innerHTML = rest.length ? rest.map(u => row(u, (u.status === 'approved' ? roleSel(u, u.role) : '') + `<span class="status-chip st-${u.status === 'approved' ? 'online' : u.status === 'suspended' ? 'low' : 'offline'}">${u.status[0].toUpperCase() + u.status.slice(1)}</span>` +
    (u.status === 'approved' ? btn(u, 'suspend', 'Suspend') : btn(u, 'restore', u.status === 'rejected' ? 'Approve' : 'Restore')))).join('') : '<div class="fleet-empty" style="padding:24px 0">No other users yet. People who request access appear above.</div>';
  try {
    const s = await api('/api/admin/status'), line = (l, ok, t) => `<div class="veh-row"><span>${l}</span><strong class="${ok ? 'ok-t' : 'warn-t'}">${t}</strong></div>`;
    $('sys-status').innerHTML = line('Email notifications', s.email.configured, s.email.configured ? 'Active · sent to ' + esc(s.email.to) : 'Not configured · set SMTP_USER and SMTP_PASS') + line('Map', true, s.maps === 'google' ? 'Google Maps' : 'OpenStreetMap') +
      line('Scheduled checks', s.cron.secretSet && s.cron.lastTick, !s.cron.secretSet ? 'CRON_SECRET not set' : s.cron.lastTick ? 'Last run ' + when(s.cron.lastTick) : 'Not run yet') + line('Offline alert after', true, s.offlineMinutes + ' min without data') + line('Time zone', true, esc(s.timezone));
  } catch (e) { $('sys-status').textContent = e.message; }
}
$('sec-admin').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return; b.disabled = true; const sel = b.closest('.urow').querySelector('select');
  try { await api(`/api/admin/users/${b.dataset.id}/${b.dataset.act}`, { method: 'POST', body: sel ? { role: sel.value } : {} }); await loadAdmin(); showNotif('✅', 'Updated'); } catch (err) { showNotif('⚠', err.message); b.disabled = false; }
});
$('sec-admin').addEventListener('change', async e => { const s = e.target.closest('[data-role-for]'); if (!s || s.closest('#pending-list')) return; try { await api(`/api/admin/users/${s.dataset.roleFor}/role`, { method: 'POST', body: { role: s.value } }); showNotif('✅', 'Role updated'); } catch (err) { showNotif('⚠', err.message); loadAdmin(); } });
$('test-mail').addEventListener('click', async () => { const m = $('test-mail-msg'); m.textContent = 'Sending…'; try { await api('/api/admin/test-email', { method: 'POST' }); m.textContent = 'Sent. Check the inbox of the host address.'; } catch (e) { m.textContent = 'Failed: ' + e.message; } });

// ── Theme ──
function toggleTheme() {
  const d = document.body.dataset.theme !== 'dark'; document.body.dataset.theme = d ? 'dark' : 'light'; localStorage.setItem('ev_theme', d ? 'dark' : 'light');
  Object.keys(charts).forEach(k => { if (charts[k]) charts[k].destroy(); charts[k] = null; }); if (curTab === 'battery') { loadHistory(); loadEstimates(); }
}
if (localStorage.getItem('ev_theme') === 'dark') document.body.dataset.theme = 'dark';

// ── Boot ──
setMode('login');
async function boot(n = 0) {
  try { me = await api('/api/me'); startApp(); }
  catch (e) {
    if (!token) { document.body.dataset.view = 'auth'; return; }   // 401: api() already signed out
    if (n < 2) { setTimeout(() => boot(n + 1), 2000); return; }      // server hiccup: keep the session, retry
    document.body.dataset.view = 'auth'; setMsg('auth-msg', 'The server is not responding. Reload to try again — your session is kept.');
  }
}
if (token) boot();
