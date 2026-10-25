// EV Fleet Monitor v2 — API + static server. Configuration comes from Backend/.env or Vercel environment variables (see .env.example).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const express = require('express'), mongoose = require('mongoose'), cors = require('cors');
const B = require('./lib/battery'), P = require('./lib/pipeline'), A = require('./lib/advisor'), mailer = require('./lib/mailer');
// Some home/college networks block MongoDB's SRV DNS lookup; use public DNS locally (Vercel has working DNS).
if (!process.env.VERCEL) { try { require('dns').setServers(['8.8.8.8', '1.1.1.1']); } catch {} }

const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).forEach(l => {
  const m = l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
});
// Tolerate common paste mistakes: surrounding quotes/spaces or a leading "MONGO_URI=".
if (process.env.MONGO_URI) process.env.MONGO_URI = process.env.MONGO_URI.trim().replace(/^MONGO_URI\s*=\s*/i, '').replace(/^["']+|["']+$/g, '').trim();
let configError = '';
if (!process.env.MONGO_URI) configError = 'Missing MONGO_URI';
else if (!/^mongodb(\+srv)?:\/\//.test(process.env.MONGO_URI)) configError = 'MONGO_URI must start with mongodb:// or mongodb+srv://';
if (!process.env.JWT_SECRET) {
  if (process.env.VERCEL) configError = configError || 'Missing JWT_SECRET';   // serverless cannot persist a generated secret
  else { process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex'); try { fs.appendFileSync(ENV_FILE, `\nJWT_SECRET=${process.env.JWT_SECRET}\n`); } catch {} }
}
if (configError) { console.error(configError + '. Copy Backend/.env.example to Backend/.env (or set it in Vercel > Settings > Environment Variables).'); if (!process.env.VERCEL) process.exit(1); }

const E = process.env, SECRET = E.JWT_SECRET || 'unset', HOST_EMAIL = (E.HOST_EMAIL || 'psqrn.911@gmail.com').toLowerCase(), PORT = E.PORT || 3000, TZ = E.APP_TIMEZONE || 'Asia/Kolkata';
const INGEST_MIN_S = Number(E.INGEST_MIN_INTERVAL_S) || 2, OFFLINE_MIN = Number(E.OFFLINE_ALERT_MIN) || 10, MIN = 6e4;
const appUrl = () => E.APP_URL || (E.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + E.VERCEL_PROJECT_PRODUCTION_URL : '');

// ── Auth helpers (Node crypto only: scrypt hashing + HMAC-signed tokens) ──
const sign = p => { const b = Buffer.from(JSON.stringify({ ...p, exp: Date.now() + 7 * 864e5 })).toString('base64url'); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); };
const verify = t => {
  const [b, s] = String(t).split('.'); if (!s) return null;
  const ok = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (s.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(ok))) return null;
  try { const p = JSON.parse(Buffer.from(b, 'base64url')); return p.exp > Date.now() ? p : null; } catch { return null; }
};
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') });
const checkPw = (pw, u) => { const h = crypto.scryptSync(pw, u.salt, 64), s = Buffer.from(u.hash, 'hex'); return s.length === h.length && crypto.timingSafeEqual(h, s); };
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const normId = s => String(s || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
const num = (x, lo, hi) => { if (x === null || x === undefined || x === '') return undefined; x = Number(x); return Number.isFinite(x) && x >= lo && x <= hi ? x : undefined; };
const bad = (res, m, c = 400) => res.status(c).json({ error: m });
const tries = new Map();
const limited = k => { const n = Date.now(), a = (tries.get(k) || []).filter(t => n - t < 9e5); tries.set(k, a); return a.length >= 8; };
const roleOf = u => u.role === 'host' ? 'host' : u.role === 'viewer' ? 'viewer' : 'manager';   // legacy role "user" keeps its old abilities as "manager"

// ── Models (existing fields are unchanged; new fields are optional so existing records keep working) ──
const { Schema } = mongoose;
const User = mongoose.model('User', new Schema({ name: String, email: { type: String, unique: true, lowercase: true, trim: true }, salt: String, hash: String,
  role: { type: String, default: 'viewer' }, status: { type: String, default: 'pending' }, emailAlerts: { type: Boolean, default: false }, createdAt: { type: Date, default: Date.now } }));
const Vehicle = mongoose.model('Vehicle', new Schema({ vehicle_id: { type: String, unique: true }, name: String, plate: String, owner: { type: Schema.Types.ObjectId, ref: 'User' },
  keyHash: String, fence: { enabled: { type: Boolean, default: false }, lat: Number, lng: Number, radiusKm: { type: Number, default: 5 } }, createdAt: { type: Date, default: Date.now },
  battery: { type: Schema.Types.Mixed, default: {} },      // battery specification entered by the user (rated Ah, chemistry, limits…)
  state: { type: Schema.Types.Mixed, default: {} },        // persisted estimation + alert state (SOC, capacity history, alert flags)
  stateRev: { type: Number, default: 0 },                  // optimistic-concurrency counter for `state`
  advice: { type: Schema.Types.Mixed, default: null } }, { minimize: false }));
const dataSchema = new Schema({ vehicle_id: String, battery: Number, voltage: Number, current: Number, temp: Number, lat: Number, lon: Number, time: { type: Date, default: Date.now },
  socEst: Number, cellMin: Number, cellMax: Number, insKohm: Number, gForce: Number, gyroDps: Number });
dataSchema.index({ vehicle_id: 1, time: -1 });
const Data = mongoose.model('Data', dataSchema);
// Derived estimates over time (capacity Ah, SOH %, resistance mΩ). Kept apart from raw telemetry so trends stay cheap to query.
const estSchema = new Schema({ vehicle_id: String, kind: String, value: Number, unit: String, method: String, quality: String, meta: Schema.Types.Mixed, time: { type: Date, default: Date.now } });
estSchema.index({ vehicle_id: 1, kind: 1, time: -1 });
const Estimate = mongoose.model('Estimate', estSchema);
const noteSchema = new Schema({ type: String, severity: String, title: String, message: String, key: String, kind: String, vehicle_id: String, vehicle_name: String, data: Schema.Types.Mixed,
  audience: { type: String, default: 'all' }, readBy: [Schema.Types.ObjectId], emailStatus: { type: String, default: 'pending' }, emailError: String, emailAttempts: { type: Number, default: 0 }, time: { type: Date, default: Date.now } });
noteSchema.index({ time: -1 }); noteSchema.index({ vehicle_id: 1, time: -1 }); noteSchema.index({ time: 1 }, { expireAfterSeconds: 180 * 864e2 });
const Notification = mongoose.model('Notification', noteSchema);
const Meta = mongoose.model('Meta', new Schema({ key: { type: String, unique: true }, value: Schema.Types.Mixed }));

// Serverless-safe connection: awaited per request, re-established if the platform dropped it while idle.
let connecting = null, seeded = false;
async function ensureDb() {
  const st = mongoose.connection.readyState;                 // 0 disconnected, 1 connected, 2 connecting, 3 disconnecting
  if (st === 1 && seeded) return;
  if (st === 0 || st === 3) connecting = null;
  if (!connecting) connecting = mongoose.connect(E.MONGO_URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5, bufferCommands: false })
    .then(async () => {
      console.log('MongoDB Connected');
      if (!seeded) {
        if (!(await User.findOne({ email: HOST_EMAIL }))) {
          const pw = E.HOST_PASSWORD || crypto.randomBytes(9).toString('base64url');
          await User.create({ name: 'Host', email: HOST_EMAIL, ...hashPw(pw), role: 'host', status: 'approved', emailAlerts: true }).catch(() => {});
          console.log(`Host account created: ${HOST_EMAIL}${E.HOST_PASSWORD ? '' : '  password: ' + pw + '   (shown once — change it in Profile)'}`);
        }
        seeded = true;
      }
    }).catch(e => { connecting = null; console.log('MongoDB connection error:', e.message); throw e; });
  await connecting;
}
if (!configError && !E.VERCEL) ensureDb().catch(() => {});

// ── Notifications: stored for the dashboard AND emailed ──
const noteOut = (n, host) => ({ id: n._id, type: n.type, severity: n.severity, title: n.title, message: n.message, vehicle_id: n.vehicle_id, vehicle_name: n.vehicle_name, kind: n.kind, time: n.time,
  ...(host ? { audience: n.audience, emailStatus: n.emailStatus, emailError: n.emailError } : {}) });
async function sendMail(docs) {
  if (!docs.length) return;
  let optIn = []; try { optIn = await User.find({ status: 'approved', emailAlerts: true, email: { $ne: HOST_EMAIL } }).select('email').limit(10).lean(); } catch {}
  const pub = d => ({ severity: d.severity, title: d.title, message: d.message, time: d.time }), url = appUrl();
  const hostRes = await mailer.send({ to: HOST_EMAIL, ...mailer.render(docs.map(pub), url) });          // the host receives everything that happens
  const shared = docs.filter(d => d.audience === 'all' && (d.severity !== 'info' || d.type === 'advice'));
  if (shared.length) await Promise.allSettled(optIn.map(u => mailer.send({ to: u.email, ...mailer.render(shared.map(pub), url) })));
  const status = hostRes.ok ? 'sent' : hostRes.skipped ? 'skipped' : 'failed';
  await Notification.updateMany({ _id: { $in: docs.map(d => d._id) } }, { $set: { emailStatus: status, emailError: hostRes.ok ? undefined : hostRes.error }, $inc: { emailAttempts: 1 } }).catch(() => {});
}
async function dispatch(items) {
  items = items.filter(Boolean); if (!items.length) return;
  let docs; try { docs = await Notification.insertMany(items.map(i => ({ audience: 'all', ...i, time: new Date() }))); } catch (e) { console.error('Could not store notifications:', e.message); return; }
  await sendMail(docs).catch(e => console.error('Email dispatch failed:', e.message));
}
const sys = (type, title, message, extra) => ({ type, severity: 'info', title, message, audience: 'host', ...extra });

// ── Charging advice (statistical baseline, see lib/advisor.js) ──
async function computeAdvice(v, socNow, charging) {
  const rows = await Data.aggregate([{ $match: { vehicle_id: v.vehicle_id, time: { $gt: new Date(Date.now() - 14 * 864e5) } } },
    { $group: { _id: { $dateTrunc: { date: '$time', unit: 'hour' } }, soc: { $avg: { $ifNull: ['$battery', '$socEst'] } }, cur: { $avg: '$current' }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
  const spec = B.resolveSpec(v.battery), soh = B.sohFrom((v.state && v.state.caps) || [], spec);
  return A.advise({ spec, buckets: rows.map(r => ({ t: r._id.getTime(), soc: r.soc, cur: r.cur, n: r.n })), socNow, charging, capacityAh: soh.status === 'ok' ? soh.capacityAh : spec.ratedAh, tz: TZ });
}

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: E.CORS_ORIGIN || true })); app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin' }); next(); });
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use(async (req, res, next) => {
  if (configError) return bad(res, 'Server is not configured: ' + configError, 500);
  try { await ensureDb(); next(); } catch (e) { bad(res, 'The database is temporarily unavailable. Please try again in a moment.', 503); }
});
const pub = u => ({ id: u._id, name: u.name, email: u.email, role: roleOf(u), status: u.status, emailAlerts: !!u.emailAlerts, createdAt: u.createdAt });
// level: 'any' = every approved user, 'edit' = host + manager, 'host' = host only
const auth = (level = 'any') => async (req, res, next) => {
  const p = verify((req.headers.authorization || '').replace(/^Bearer /, '')), u = p && await User.findById(p.id).catch(() => null);
  if (!u || u.status !== 'approved') return bad(res, 'Please sign in', 401);
  const r = roleOf(u);
  if (level === 'host' && r !== 'host') return bad(res, 'Host only', 403);
  if (level === 'edit' && r === 'viewer') return bad(res, 'Your account is view-only. Ask the host for manager access.', 403);
  req.user = u; req.role = r; next();
};

// ── Accounts ──
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {}, em = String(email || '').trim().toLowerCase();
  if (!name || String(name).trim().length < 2) return bad(res, 'Enter your full name');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return bad(res, 'Enter a valid email address');
  if (String(password || '').length < 8) return bad(res, 'Password must be at least 8 characters');
  if (em === HOST_EMAIL) return bad(res, 'This email is reserved for the host. Sign in instead.');
  if (await User.findOne({ email: em })) return bad(res, 'An account with this email already exists', 409);
  const nm = String(name).trim().slice(0, 80);
  await User.create({ name: nm, email: em, ...hashPw(String(password)) });
  await dispatch([sys('access', 'New access request', `${nm} (${em}) asked for access. Open Access requests in the dashboard to approve or reject.`)]);
  res.json({ ok: true, message: 'Request sent. The host must approve your account before you can sign in.' });
});
app.post('/api/auth/login', async (req, res) => {
  const em = String((req.body || {}).email || '').trim().toLowerCase(), pw = String((req.body || {}).password || ''), key = req.ip + em;
  if (limited(key)) return bad(res, 'Too many attempts. Try again in 15 minutes.', 429);
  const u = em && await User.findOne({ email: em });
  if (!u || !checkPw(pw, u)) {
    const a = tries.get(key); a.push(Date.now());
    if (a.length === 8) await dispatch([sys('security', 'Repeated failed sign-ins', `8 failed sign-in attempts for ${em || 'an unknown email'} from ${req.ip}. Further attempts are blocked for 15 minutes.`, { severity: 'warning' })]);
    return bad(res, 'Incorrect email or password', 401);
  }
  if (u.status === 'pending') return bad(res, 'Your account is waiting for host approval.', 403);
  if (u.status !== 'approved') return bad(res, 'Your access request was not approved or has been suspended. Contact the host.', 403);
  res.json({ token: sign({ id: u._id }), user: pub(u) });
});
app.get('/api/me', auth(), (req, res) => res.json(pub(req.user)));
app.patch('/api/me', auth(), async (req, res) => {
  const { name, currentPassword, newPassword, emailAlerts } = req.body || {}, u = req.user;
  if (name !== undefined) { if (String(name).trim().length < 2) return bad(res, 'Enter your full name'); u.name = String(name).trim().slice(0, 80); }
  if (typeof emailAlerts === 'boolean') u.emailAlerts = emailAlerts;
  if (newPassword) {
    if (!checkPw(String(currentPassword || ''), u)) return bad(res, 'Current password is incorrect');
    if (String(newPassword).length < 8) return bad(res, 'New password must be at least 8 characters');
    Object.assign(u, hashPw(String(newPassword)));
  }
  await u.save(); res.json(pub(u));
});
app.get('/api/config', auth(), (req, res) => {
  const key = E.GOOGLE_MAPS_API_KEY || '', provider = E.MAP_PROVIDER === 'osm' || !key ? 'osm' : 'google';
  res.json({ map: { provider, googleKey: provider === 'google' ? key : undefined }, timezone: TZ, ingestMinSeconds: INGEST_MIN_S, offlineSeconds: OFFLINE_MIN * 60 });
});

// ── Host: users, roles, system status ──
app.get('/api/admin/users', auth('host'), async (req, res) => {
  const users = await User.find({ role: { $ne: 'host' } }).sort({ createdAt: -1 }).lean();
  const counts = await Vehicle.aggregate([{ $group: { _id: '$owner', n: { $sum: 1 } } }]);
  res.json(users.map(u => ({ ...pub(u), vehicles: (counts.find(c => String(c._id) === String(u._id)) || {}).n || 0 })));
});
const ACTIONS = { approve: 'approved', reject: 'rejected', suspend: 'suspended', restore: 'approved' };
app.post('/api/admin/users/:id/role', auth('host'), async (req, res) => {
  const u = await User.findById(req.params.id).catch(() => null), role = String((req.body || {}).role);
  if (!u || u.role === 'host' || !['viewer', 'manager'].includes(role)) return bad(res, 'User not found or invalid role', 404);
  u.role = role; await u.save(); await dispatch([sys('access', 'User role changed', `${u.name} (${u.email}) is now ${role === 'manager' ? 'a manager (can add and edit vehicles)' : 'view-only'}.`)]); res.json(pub(u));
});
app.post('/api/admin/users/:id/:action', auth('host'), async (req, res) => {
  const u = await User.findById(req.params.id).catch(() => null), st = ACTIONS[req.params.action];
  if (!u || u.role === 'host' || !st) return bad(res, 'User not found', 404);
  u.status = st; const wanted = String((req.body || {}).role || ''); if (req.params.action === 'approve') u.role = wanted === 'manager' ? 'manager' : 'viewer';
  await u.save(); await dispatch([sys('access', `Access ${st}`, `${u.name} (${u.email}): ${req.params.action}${req.params.action === 'approve' ? ` as ${roleOf(u)}` : ''}.`)]);
  res.json(pub(u));
});
app.get('/api/admin/status', auth('host'), async (req, res) => {
  const [tick, daily] = await Promise.all([Meta.findOne({ key: 'lastTick' }).lean(), Meta.findOne({ key: 'lastDaily' }).lean()]);
  res.json({ email: { configured: mailer.configured(), to: HOST_EMAIL }, maps: E.GOOGLE_MAPS_API_KEY && E.MAP_PROVIDER !== 'osm' ? 'google' : 'osm', cron: { secretSet: !!E.CRON_SECRET, lastTick: tick && tick.value, lastDaily: daily && daily.value }, offlineMinutes: OFFLINE_MIN, timezone: TZ });
});
app.post('/api/admin/test-email', auth('host'), async (req, res) => {
  const r = await mailer.send({ to: HOST_EMAIL, subject: '[EV Fleet] Test email', text: 'Email notifications are working.', html: '<p>Email notifications are working.</p>' });
  res.status(r.ok ? 200 : 502).json(r.ok ? { ok: true } : { error: r.error });
});

// ── Vehicles (one shared fleet: every approved user sees all vehicles) ──
const SPEC_RULES = { ratedAh: [1, 3000], nominalV: [3, 1500], cellsSeries: [1, 400], eolPct: [50, 95], tempWarnC: [20, 100], tempCritC: [20, 120], vMin: [0, 1500], vMax: [0, 1500], maxDischargeA: [1, 5000], maxChargeA: [1, 5000],
  imbalanceWarnV: [0.005, 1], insulationMinKohm: [1, 1e6], lowSocWarn: [1, 60], lowSocCrit: [1, 50], reserveSoc: [0, 50], targetSoc: [50, 100], adviceTriggerSoc: [10, 80], rulWarnCycles: [1, 5000], resistanceRiseWarnPct: [5, 500], accelWarnG: [0.05, 16], accelCritG: [0.1, 16], gyroWarnDps: [10, 2000], gyroCritDps: [10, 2000] };
const CHEMISTRIES = ['NMC', 'NCA', 'LFP', 'LCO', 'LTO', 'LEAD_ACID', 'OTHER'];
function cleanSpec(b) {
  const s = {};
  for (const [k, [lo, hi]] of Object.entries(SPEC_RULES)) {
    if (b[k] === undefined || b[k] === null || b[k] === '') continue;
    const x = num(b[k], lo, hi); if (x === undefined) return { error: `${k} must be a number between ${lo} and ${hi}` }; s[k] = x;
  }
  if (b.chemistry) { const c = String(b.chemistry).toUpperCase(); if (!CHEMISTRIES.includes(c)) return { error: 'Unknown battery chemistry' }; s.chemistry = c; }
  if (s.tempWarnC != null && s.tempCritC != null && s.tempCritC <= s.tempWarnC) return { error: 'Critical temperature must be higher than the warning temperature' };
  if (s.vMin != null && s.vMax != null && s.vMax <= s.vMin) return { error: 'Maximum voltage must be higher than minimum voltage' };
  if (s.accelWarnG != null && s.accelCritG != null && s.accelCritG <= s.accelWarnG) return { error: 'Critical g-force must be higher than the warning g-force' };
  if (s.gyroWarnDps != null && s.gyroCritDps != null && s.gyroCritDps <= s.gyroWarnDps) return { error: 'Critical rotation rate must be higher than the warning rate' };
  if (s.lowSocCrit != null && s.lowSocWarn != null && s.lowSocCrit >= s.lowSocWarn) return { error: 'Critical SOC must be lower than the warning SOC' };
  return { spec: s };
}
const healthOf = (v, latest) => { const sp = B.resolveSpec(v.battery), sm = P.summarize(sp, v.state, latest); return { socEst: sm.soc.estimated, sohPct: sm.soh.status === 'ok' ? sm.soh.pct : null, sohStatus: sm.soh.status, rulStatus: sm.rul.status, alerts: sm.activeAlerts.length, specComplete: sm.specComplete }; };
const vehOut = async (v, owner) => {
  const latest = await Data.findOne({ vehicle_id: v.vehicle_id }).sort({ time: -1 }).select('-_id -__v').lean();
  return { vehicle_id: v.vehicle_id, name: v.name, plate: v.plate, fence: v.fence, owner: owner || undefined, createdAt: v.createdAt, battery: v.battery || {}, spec: B.resolveSpec(v.battery), health: healthOf(v, latest), latest };
};
const find = async (req, res) => { const v = await Vehicle.findOne({ vehicle_id: normId(req.params.id) }); if (!v) { bad(res, 'Vehicle not found', 404); return null; } return v; };
app.get('/api/vehicles', auth(), async (req, res) => {
  const list = await Vehicle.find({}).populate('owner', 'name').sort({ createdAt: 1 });
  res.json(await Promise.all(list.map(v => vehOut(v, v.owner ? v.owner.name : undefined))));
});
app.post('/api/vehicles', auth('edit'), async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 60), plate = String((req.body || {}).plate || '').trim().slice(0, 20), id = normId(plate);
  if (!name || id.length < 4) return bad(res, 'Enter a vehicle name and a plate / vehicle ID (at least 4 letters or digits)');
  if (await Vehicle.findOne({ vehicle_id: id })) return bad(res, 'A vehicle with this ID is already registered', 409);
  const key = crypto.randomBytes(18).toString('hex');
  const v = await Vehicle.create({ vehicle_id: id, name, plate, owner: req.user._id, keyHash: sha(key) });
  await dispatch([sys('system', 'Vehicle added', `${req.user.name} added ${name} (${id}).`, { vehicle_id: id, vehicle_name: name })]);
  res.json({ vehicle: await vehOut(v), deviceKey: key });
});
app.patch('/api/vehicles/:id', auth('edit'), async (req, res) => {
  const v = await find(req, res); if (!v) return; const b = req.body || {}, notes = [];
  if (b.name !== undefined) { if (!String(b.name).trim()) return bad(res, 'Enter a vehicle name'); v.name = String(b.name).trim().slice(0, 60); }
  if (b.fence) {
    const f = { enabled: !!b.fence.enabled, lat: num(b.fence.lat, -90, 90), lng: num(b.fence.lng, -180, 180), radiusKm: num(b.fence.radiusKm, 0.1, 500) };
    if (f.enabled && (f.lat === undefined || f.lng === undefined || f.radiusKm === undefined)) return bad(res, 'Set a centre point and a radius between 0.1 and 500 km');
    v.fence = f; notes.push(f.enabled ? `geofence set (${f.radiusKm} km radius)` : 'geofence turned off');
  }
  if (b.battery) { const c = cleanSpec(b.battery); if (c.error) return bad(res, c.error); v.battery = c.spec; v.markModified('battery'); notes.push('battery specification updated'); }
  await v.save();
  if (notes.length) await dispatch([sys('system', 'Vehicle settings changed', `${req.user.name} changed ${v.name}: ${notes.join(', ')}.`, { vehicle_id: v.vehicle_id, vehicle_name: v.name })]);
  res.json(await vehOut(v));
});
app.post('/api/vehicles/:id/key', auth('host'), async (req, res) => {
  const v = await find(req, res); if (!v) return; const key = crypto.randomBytes(18).toString('hex');
  v.keyHash = sha(key); await v.save(); await dispatch([sys('security', 'Device key replaced', `A new device key was created for ${v.name}. The old key no longer works.`, { vehicle_id: v.vehicle_id, vehicle_name: v.name })]);
  res.json({ deviceKey: key });
});
app.delete('/api/vehicles/:id', auth('host'), async (req, res) => {
  const v = await find(req, res); if (!v) return;
  await Promise.all([Data.deleteMany({ vehicle_id: v.vehicle_id }), Estimate.deleteMany({ vehicle_id: v.vehicle_id })]); await v.deleteOne();
  await dispatch([sys('system', 'Vehicle removed', `${req.user.name} removed ${v.name} (${v.vehicle_id}) and its stored readings.`)]); res.json({ ok: true });
});
// History: raw readings for short windows, time-bucketed averages for long ones (so a 7-day chart stays small and fast).
app.get('/api/vehicles/:id/history', auth(), async (req, res) => {
  const v = await find(req, res); if (!v) return; const min = Math.min(Math.max(Number(req.query.minutes) || 60, 5), 10080), match = { vehicle_id: v.vehicle_id, time: { $gt: new Date(Date.now() - min * MIN) } };
  if (min <= 180) return res.json(await Data.find(match).sort({ time: 1 }).limit(1500).select('-_id -__v -vehicle_id').lean());
  const bin = Math.max(1, Math.ceil(min / 400)), avg = f => ({ $avg: '$' + f });
  const rows = await Data.aggregate([{ $match: match }, { $group: { _id: { $dateTrunc: { date: '$time', unit: 'minute', binSize: bin } }, battery: avg('battery'), voltage: avg('voltage'), current: avg('current'), temp: avg('temp'), socEst: avg('socEst'), cellMin: { $min: '$cellMin' }, cellMax: { $max: '$cellMax' }, gForce: { $max: '$gForce' }, gyroDps: { $max: '$gyroDps' } } }, { $sort: { _id: 1 } }]);
  res.json(rows.map(({ _id, ...r }) => ({ time: _id, ...r })));
});
app.get('/api/vehicles/:id/estimates', auth(), async (req, res) => {
  const v = await find(req, res); if (!v) return; const kind = String(req.query.kind || 'capacity');
  if (!['capacity', 'soh', 'resistance'].includes(kind)) return bad(res, 'kind must be capacity, soh or resistance');
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 730);
  res.json(await Estimate.find({ vehicle_id: v.vehicle_id, kind, time: { $gt: new Date(Date.now() - days * 864e5) } }).sort({ time: 1 }).limit(600).select('-_id -__v -vehicle_id').lean());
});
app.get('/api/vehicles/:id/battery', auth(), async (req, res) => {
  const v = await find(req, res); if (!v) return;
  const spec = B.resolveSpec(v.battery), latest = await Data.findOne({ vehicle_id: v.vehicle_id }).sort({ time: -1 }).select('-_id -__v').lean(), sm = P.summarize(spec, v.state, latest);
  let advice = v.advice;
  const socNow = sm.soc.reported ?? sm.soc.estimated;
  if (socNow != null && (!advice || Date.now() - (advice.computedAt || 0) > 30 * MIN)) {
    advice = await computeAdvice(v, socNow, latest && latest.current < -1).catch(e => { console.error('advice failed:', e.message); return advice; });
    if (advice) await Vehicle.updateOne({ _id: v._id }, { $set: { advice } }).catch(() => {});
  }
  const notes = await Notification.find({ vehicle_id: v.vehicle_id, type: { $ne: 'advice' }, time: { $gt: new Date(Date.now() - 7 * 864e5) } }).sort({ time: -1 }).limit(15).lean();
  res.json({ vehicle_id: v.vehicle_id, spec, summary: sm, advice: advice || null, recentAlerts: notes.map(n => noteOut(n)) });
});

// ── Notification centre ──
const audience = req => req.role === 'host' ? {} : { audience: 'all' };
app.get('/api/notifications', auth(), async (req, res) => {
  const q = { ...audience(req) }, X = req.query, lim = Math.min(Math.max(Number(X.limit) || 40, 1), 100);
  if (X.vehicle) q.vehicle_id = normId(X.vehicle); if (['info', 'warning', 'critical'].includes(X.severity)) q.severity = X.severity; if (X.type) q.type = String(X.type).slice(0, 20);
  if (X.unread === '1') q.readBy = { $ne: req.user._id };
  const t = {}; if (X.after && !isNaN(Date.parse(X.after))) t.$gt = new Date(X.after); if (X.before && !isNaN(Date.parse(X.before))) t.$lt = new Date(X.before); if (Object.keys(t).length) q.time = t;
  const [items, unread] = await Promise.all([Notification.find(q).sort({ time: -1 }).limit(lim).lean(), Notification.countDocuments({ ...audience(req), readBy: { $ne: req.user._id }, time: { $gt: new Date(Date.now() - 30 * 864e5) } })]);
  res.json({ unread, items: items.map(n => ({ ...noteOut(n, req.role === 'host'), read: (n.readBy || []).some(id => String(id) === String(req.user._id)) })) });
});
app.post('/api/notifications/read', auth(), async (req, res) => {
  const b = req.body || {}, q = { ...audience(req) };
  if (b.all) q.readBy = { $ne: req.user._id }; else { const ids = (Array.isArray(b.ids) ? b.ids : []).filter(x => mongoose.isValidObjectId(x)).slice(0, 100); if (!ids.length) return bad(res, 'Nothing to mark'); q._id = { $in: ids }; }
  await Notification.updateMany(q, { $addToSet: { readBy: req.user._id } }); res.json({ ok: true });
});

// ── Device ingest (ESP32 etc.): POST /data with vehicle_id + key ──
app.post('/data', async (req, res) => {
  const b = req.body || {}, key = req.headers['x-device-key'] || b.key, v0 = await Vehicle.findOne({ vehicle_id: normId(b.vehicle_id) });
  if (!v0 || !key || !safeEq(sha(key), v0.keyHash)) return bad(res, 'Unknown vehicle or wrong device key', 401);
  const now = Date.now(); let t = now;
  if (b.ts != null) { let x = Number(b.ts); if (Number.isFinite(x)) { if (x < 1e12) x *= 1000; if (Math.abs(x - now) <= 10 * MIN) t = x; } }   // device clock is trusted only if it is close to the server clock
  const inv = [], take = (f, lo, hi) => { if (b[f] === undefined || b[f] === null || b[f] === '') return undefined; const x = num(b[f], lo, hi); if (x === undefined) inv.push(f); return x; };
  const d = { battery: take('battery', 0, 100), voltage: take('voltage', 0, 1500), current: take('current', -2000, 2000), temp: take('temp', -40, 125), lat: take('lat', -90, 90), lon: take('lon', -180, 180) };
  const cells = Array.isArray(b.cells) ? b.cells.map(Number).filter(x => Number.isFinite(x) && x > 0.5 && x < 6) : [];
  let cellMin = cells.length >= 2 ? Math.min(...cells) : num(b.cell_min, 0.5, 6), cellMax = cells.length >= 2 ? Math.max(...cells) : num(b.cell_max, 0.5, 6);
  if (cellMin === undefined || cellMax === undefined || cellMax < cellMin) cellMin = cellMax = undefined;
  const insKohm = num(b.insulation_kohm, 0, 1e7), mo = B.motion(b); if (mo.invalid) inv.push('motion');
  if (!inv.length && [...Object.values(d), cellMin, insKohm, mo.gForce, mo.gyroDps].every(x => x === undefined)) return bad(res, 'No valid readings in payload');
  const lastT = v0.state && v0.state.last && v0.state.last.t;
  const urgent = !mo.invalid && (mo.gForce >= B.resolveSpec(v0.battery).accelWarnG || mo.gyroDps >= B.resolveSpec(v0.battery).gyroWarnDps);   // a shock report is never dropped by the rate limit
  if (!urgent && lastT && t - lastT >= 0 && t - lastT < INGEST_MIN_S * 1000) return res.status(202).json({ success: true, throttled: true });   // avoids excessive writes

  let nv = v0, result = null;
  for (let attempt = 0; attempt < 3 && !result; attempt++) {
    const out = P.process({ spec: B.resolveSpec(nv.battery), state: nv.state, reading: { t, ...d, cellMin, cellMax, insKohm, gForce: mo.gForce, gyroDps: mo.gyroDps, invalid: inv }, fence: nv.fence, name: nv.name, now: t });
    if (out.skipped) return res.status(202).json({ success: true, ignored: out.skipped });
    const rev = nv.stateRev || 0, upd = await Vehicle.findOneAndUpdate({ _id: nv._id, $or: rev === 0 ? [{ stateRev: 0 }, { stateRev: { $exists: false } }] : [{ stateRev: rev }] },
      { $set: { state: out.state, stateRev: rev + 1 } }, { new: true });
    if (upd) { nv = upd; result = out; } else { nv = await Vehicle.findById(v0._id); if (!nv) return bad(res, 'Vehicle not found', 404); }   // another request updated the state first: reload and redo
  }
  if (!result) return bad(res, 'Busy, please retry', 503);

  const rec = { vehicle_id: nv.vehicle_id, ...d, cellMin, cellMax, insKohm, gForce: mo.gForce, gyroDps: mo.gyroDps, socEst: result.est.socEst, time: new Date(t) };
  for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
  await Data.create(rec);
  if (result.estimates.length) await Estimate.insertMany(result.estimates.map(e => ({ vehicle_id: nv.vehicle_id, ...e, time: new Date(e.time || t) }))).catch(e => console.error('estimate store failed:', e.message));

  const items = [];
  for (const e of result.events) {
    if (e.needsAdvice) {
      const adv = await computeAdvice(nv, e.soc, d.current != null && d.current < -1).catch(() => null);
      if (adv) { await Vehicle.updateOne({ _id: nv._id }, { $set: { advice: adv } }).catch(() => {}); if (adv.status === 'ok' && adv.needPct > 0) items.push({ type: 'advice', severity: 'info', title: `${nv.name}: charging advice`, message: adv.message, key: 'advice', kind: e.kind, vehicle_id: nv.vehicle_id, vehicle_name: nv.name, data: adv }); }
      continue;
    }
    items.push({ type: e.type, severity: e.severity, title: e.title, message: e.message, key: e.key, kind: e.kind, vehicle_id: nv.vehicle_id, vehicle_name: nv.name });
  }
  await dispatch(items);       // awaited: serverless functions are frozen as soon as the response is sent
  res.json({ success: true, events: items.length });
});

// ── Scheduled checks (Vercel Cron or any external pinger). Authorization: Bearer <CRON_SECRET> ──
async function tick() {
  const now = Date.now(), out = { offline: 0, emailRetried: 0, daily: false }, items = [], vehicles = await Vehicle.find({});
  for (const v of vehicles) {
    const last = v.state && v.state.last && v.state.last.t; if (!last) continue;
    const alerts = (v.state && v.state.alerts) || {}, mins = (now - last) / MIN;
    const a = { ...(alerts.offline || {}) }, boxed = { offline: a };
    const res = P.track(boxed, 'offline', { raised: mins >= OFFLINE_MIN, cleared: false, persist: 1, remindMs: 6 * 60 * MIN }, now);
    if (res) { out.offline++; items.push({ type: 'offline', severity: 'warning', title: `${v.name}: no data for ${Math.round(mins)} min`, message: `No telemetry since ${new Date(last).toLocaleString('en-IN', { timeZone: TZ })}. Check the vehicle's device power, SIM/Wi-Fi connection and device key.`, key: 'offline', kind: res, vehicle_id: v.vehicle_id, vehicle_name: v.name }); }
    if (JSON.stringify(boxed.offline) !== JSON.stringify(alerts.offline || {})) await Vehicle.updateOne({ _id: v._id }, { $set: { 'state.alerts.offline': boxed.offline } });
  }
  await dispatch(items);
  const retry = await Notification.find({ emailStatus: { $in: ['pending', 'failed'] }, emailAttempts: { $lt: 3 }, time: { $gt: new Date(now - 864e5) } }).limit(30);
  if (retry.length) { await sendMail(retry); out.emailRetried = retry.length; }
  const daily = await Meta.findOne({ key: 'lastDaily' });
  if (!daily || now - daily.value > 20 * 60 * MIN) {
    const lines = [];
    for (const v of vehicles) {
      const spec = B.resolveSpec(v.battery), latest = await Data.findOne({ vehicle_id: v.vehicle_id }).sort({ time: -1 }).lean(), sm = P.summarize(spec, v.state, latest), socNow = sm.soc.reported ?? sm.soc.estimated;
      let adv = null; if (socNow != null) { adv = await computeAdvice(v, socNow, latest && latest.current < -1).catch(() => null); if (adv) await Vehicle.updateOne({ _id: v._id }, { $set: { advice: adv } }); }
      lines.push(`${v.name} (${v.vehicle_id}): ${latest ? 'last seen ' + new Date(latest.time).toLocaleString('en-IN', { timeZone: TZ }) : 'no data yet'}; SOC ${socNow == null ? 'n/a' : Math.round(socNow) + '%'}; SOH ${sm.soh.status === 'ok' ? sm.soh.pct + '% (estimate)' : 'not enough data'}; RUL ${sm.rul.status === 'ok' ? sm.rul.cycles + ' cycles (baseline estimate)' : 'not enough data'}; ${sm.activeAlerts.length} active alert(s).${adv && adv.status === 'ok' ? ' Advice: ' + adv.message : ''}`);
    }
    const sev = await Notification.aggregate([{ $match: { time: { $gt: new Date(now - 864e5) }, type: { $nin: ['access', 'system', 'security'] } } }, { $group: { _id: '$severity', n: { $sum: 1 } } }]);
    const cnt = Object.fromEntries(sev.map(x => [x._id, x.n]));
    await dispatch([sys('summary', 'Daily fleet summary', `Last 24 hours: ${cnt.critical || 0} critical, ${cnt.warning || 0} warning alerts.\n\n${lines.join('\n\n') || 'No vehicles registered yet.'}`)]);
    await Meta.updateOne({ key: 'lastDaily' }, { $set: { value: now } }, { upsert: true }); out.daily = true;
  }
  await Meta.updateOne({ key: 'lastTick' }, { $set: { value: now } }, { upsert: true });
  return out;
}
app.get('/api/cron/tick', async (req, res) => {
  if (!E.CRON_SECRET) return bad(res, 'CRON_SECRET is not set', 503);
  if (!safeEq((req.headers.authorization || '').replace(/^Bearer /, ''), E.CRON_SECRET)) return bad(res, 'Unauthorized', 401);
  res.json(await tick());
});

// ── Nearby EV chargers (OpenStreetMap via Overpass), cached, with a mirror fallback ──
const cache = new Map(), OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
app.get('/api/chargers', auth(), async (req, res) => {
  const lat = num(req.query.lat, -90, 90), lon = num(req.query.lon, -180, 180); if (lat === undefined || lon === undefined) return bad(res, 'lat and lon required');
  const k = lat.toFixed(2) + ',' + lon.toFixed(2), hit = cache.get(k); if (hit && Date.now() - hit.t < 18e5) return res.json(hit.d);
  let r = null;
  for (const url of OVERPASS) {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'EVFleetMonitor/2.0' },
      body: 'data=' + encodeURIComponent(`[out:json][timeout:20];node["amenity"="charging_station"](around:15000,${lat},${lon});out 60;`), signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (r && r.ok) break;
  }
  if (!r || !r.ok) return bad(res, 'Charger lookup is unavailable right now', 502);
  const R = 6371, rad = x => x * Math.PI / 180;
  const d = (await r.json()).elements.map(e => ({ name: e.tags.name || e.tags.operator || 'EV charging station', operator: e.tags.operator || '', capacity: e.tags.capacity || '', lat: e.lat, lon: e.lon,
    distKm: 2 * R * Math.asin(Math.sqrt(Math.sin(rad(e.lat - lat) / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(e.lat)) * Math.sin(rad(e.lon - lon) / 2) ** 2)) })).sort((a, b) => a.distKm - b.distKm).slice(0, 10);
  cache.set(k, { t: Date.now(), d }); res.json(d);
});

app.use('/api', (req, res) => bad(res, 'Not found', 404));
app.use(express.static(path.join(__dirname, '../public')));
app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.use((e, req, res, next) => { console.error(e); const db = /Mongo|buffering|topology|ECONN|ETIMEDOUT/i.test(String(e && (e.name + e.message))); res.status(db ? 503 : 500).json({ error: db ? 'The database is temporarily unavailable. Please try again in a moment.' : 'Server error' }); });
if (require.main === module) app.listen(PORT, () => console.log(`Server running on port ${PORT} — http://localhost:${PORT}`));
module.exports = app;   // Vercel imports this
