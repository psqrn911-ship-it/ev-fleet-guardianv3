# EV Fleet Monitor v3

One shared dashboard for the whole team, battery intelligence, a notification centre with email, and a working map.

## What changed from the previous version

| Area | Before | Now |
|---|---|---|
| Access | Approved users landed in an empty private dashboard | **One shared fleet.** Everyone signs in with their own login and sees the same vehicles. Roles: **Host** (everything), **Manager** (add/edit vehicles, geofence, battery spec), **Viewer** (read-only). The host picks the role when approving and can change it later. |
| Notifications | Toast in the open tab only | **Notification centre** (bell, unread badge, full page with filters) plus **email to psqrn.911@gmail.com** for every event. Other members can opt in to emails for warnings, critical alerts and charging advice. |
| Events | Geofence toast | Geofence in/out, temperature, abnormal heating rate, low charge, pack voltage, current, cell imbalance, insulation, resistance rise, capacity loss, end-of-life, short RUL, sensor faults, vehicle offline, charging advice, new access requests, role changes, vehicle added/removed/settings, key replaced, repeated failed sign-ins, daily summary. |
| Map | Leaflet only (failed silently) | **Google Maps** when `GOOGLE_MAPS_API_KEY` is set, otherwise **OpenStreetMap**. If Google rejects the key or a tile provider is blocked it falls back automatically and shows a message instead of a blank box. |
| Battery | Raw voltage / current / temperature | SOC, SOH, RUL, internal resistance, capacity, equivalent cycles, thermal, imbalance, insulation, charging advisor. Every value is labelled **Measured / Estimated / Prediction / Unavailable**. |

## Files

```
api/index.js               Vercel entry (re-exports the server)
Backend/server.js          Express API, auth, roles, ingest, notifications, cron
Backend/lib/battery.js     SOC, capacity, SOH, RUL, resistance maths (pure functions)
Backend/lib/pipeline.js    Per-reading processing, alert rules with persistence/hysteresis, dashboard summary
Backend/lib/advisor.js     Charging advisor (statistical baseline)
Backend/lib/mailer.js      Email (SMTP via nodemailer)
Backend/test/              30 unit tests (npm test)
firmware/                  Example ESP32 + MPU6050 sketch (untested)
public/                    index.html, script.js, styles.css (same look as before)
vercel.json                routes + daily cron
```

## Run locally

1. `npm install` (or `cd Backend && npm install`)
2. Copy `Backend/.env.example` to `Backend/.env` and fill it in.
3. `npm start`, open http://localhost:3000
4. `npm test` runs the unit tests.

## Environment variables

| Name | Needed | Purpose |
|---|---|---|
| `MONGO_URI` | yes | MongoDB Atlas connection string |
| `JWT_SECRET` | yes on Vercel | Long random string for login tokens |
| `HOST_PASSWORD` | recommended | Password for the host account (first start only) |
| `SMTP_USER`, `SMTP_PASS` | for email | Gmail address + a Google **App password** (Google account → Security → 2-step verification → App passwords) |
| `APP_URL` | recommended | Public site address, used for the button in emails |
| `CRON_SECRET` | for scheduled checks | Protects `/api/cron/tick` |
| `GOOGLE_MAPS_API_KEY` | optional | Browser key. Restrict it to your site address in Google Cloud. Without it OpenStreetMap is used. |
| `APP_TIMEZONE`, `INGEST_MIN_INTERVAL_S`, `OFFLINE_ALERT_MIN`, `MAIL_MAX_PER_HOUR`, `CORS_ORIGIN`, `HOST_EMAIL`, `MAP_PROVIDER=osm` | optional | See `.env.example` |

No secret is ever sent to the browser. The Google Maps browser key is public by design, so restrict it by website address.

## Deploy on Vercel

1. Replace the repo contents with this folder (keep `.gitignore`), commit, push.
2. Vercel → Project → Settings → Environment Variables: add the variables above.
3. MongoDB Atlas → Network Access must allow Vercel (`0.0.0.0/0`) with a strong database password. Atlas must be MongoDB 5.0+ (the free tier is).
4. Redeploy. Sign in as the host and open **Team & settings**: press **Send test email** to confirm email works, and check the status panel.
5. Scheduled checks: `vercel.json` runs `/api/cron/tick` once a day (offline check, email retries, daily summary). Vercel's free plan only allows daily runs. For faster offline detection, add a free external pinger (for example cron-job.org) that calls `https://YOUR-SITE/api/cron/tick` every 5 minutes with the header `Authorization: Bearer YOUR_CRON_SECRET`.

## What you must know before deploying

- **Existing vehicles become visible to all approved users.** Previously each user only saw their own. Existing user records keep working: the old role `user` is treated as **Manager**. New approvals default to **Viewer**.
- Only the host can delete a vehicle or replace its device key.
- No existing records are modified or deleted. New optional fields are added on first use. Notifications are removed automatically after 180 days; raw readings are kept (consider a retention policy if you approach the Atlas free-tier 512 MB).
- Readings arriving faster than every 2 s are acknowledged but not stored (`INGEST_MIN_INTERVAL_S`). Send every 5–10 s.

## Device payload (ESP32)

`POST https://YOUR-SITE/data`, JSON, header `x-device-key` or `"key"` in the body:

```json
{ "vehicle_id": "KA01EV2341", "key": "…", "battery": 78, "voltage": 352.4, "current": 12.5,
  "temp": 31.2, "lat": 12.97, "lon": 77.59 }
```

- `current` positive = discharging, negative = charging.
- Motion (MPU6050): `ax`,`ay`,`az` in **g** (or add `"accel_unit":"ms2"` to send m/s²), `gx`,`gy`,`gz` in **°/s**, and `g_peak` / `gyro_peak` = strongest value since the previous post. See `firmware/mpu6050_example.ino` (untested example).
- Optional: `"cells": [3.71, 3.70, …]` (or `cell_min`/`cell_max`) and `"insulation_kohm"`. Without them, cell imbalance and insulation show as unavailable. They are never invented.
- Optional `"ts"` (epoch seconds) is used only if within 10 minutes of the server clock.
- A DS18B20 that is disconnected reads −127 °C and reports 85 °C after a reset; both are detected as sensor faults, not as heat.

## Motion alerts and thresholds (MPU6050)

- **g-force** = |acceleration vector| − 1 g, so it works in any mounting orientation and ignores gravity. It tells you *how hard* the vehicle accelerated, braked or was hit, not the direction.
- **Rotation** = magnitude of the gyro vector in °/s (sharp turns, spins, possible rollover).
- A 5–10 s post interval would hide a 100 ms impact, so the device should send `g_peak` (the maximum since the last post) and post immediately on a shock. The server does **not** rate-limit a post that reports a shock.
- Provisional thresholds until you set your own in **Battery specification**: acceleration 0.4 g warning / 1.0 g critical, rotation 120 / 250 °/s. Every metric has its own warning and critical threshold (temperature, voltage, current, low charge, cell imbalance, insulation, g-force, rotation, resistance rise, EOL, RUL). Tune them per vehicle.
- A shock raises one notification (dashboard + email), then waits 30 s before another, to avoid floods on rough roads. Critical escalates immediately.
- **Voltage standard limits:** if you enter the battery chemistry (NMC, NCA, LCO, LFP, LTO) and the number of series cells, pack limits are derived from the typical per-cell window (NMC/NCA/LCO 3.0–4.2 V, LFP 2.5–3.65 V, LTO 1.5–2.8 V, with 1 % tolerance). They are labelled **provisional** in alerts. Enter the manufacturer's values to replace them. With no chemistry, nothing is guessed and voltage alerts stay off.

## How the estimates work

- **SOC** (estimated): coulomb counting, trapezoidal integration, clamped to 0–100 %, state persisted in the database (a restart never resets it). Never integrates across gaps over 120 s. Optional correction from resting voltage only for NMC/NCA with a series cell count (generic OCV curve, provisional). Shown **next to** the device-reported SOC, never in place of it.
- **Capacity & SOH** (estimated): each continuous charge or discharge run with at least a 30 % swing in device-reported SOC gives one capacity observation = Ah moved ÷ SOC swing. SOH = median of the latest 5 ÷ rated capacity, needs 3 observations, shows data quality. Not computed from voltage/current/temperature alone.
- **Equivalent full cycles**: discharged Ah ÷ rated Ah (continuous data only, so it can under-count after outages).
- **RUL** (prediction): linear regression of capacity vs equivalent cycles to the configurable end-of-life threshold. Needs 8+ observations over 14+ days and 3+ cycles with R² ≥ 0.5. Otherwise it says "Insufficient data for reliable RUL prediction". It is a statistical baseline and is labelled as not machine learning.
- **Internal resistance** (estimated): −ΔV/ΔI between consecutive samples within 15 s with a current step of at least 10 A, temperature stable within 2 °C; median of 5 valid pairs, at most one stored per 10 minutes. Trend compares only readings at similar temperature. Not a lab measurement.
- **Thermal**: configurable warning and critical limits (provisional 45 / 55 °C until you enter the manufacturer values, labelled as provisional), must persist for 2–3 readings, clears 3 °C below, plus a heating-rate alert. These are software alerts only and do not replace hardware protection.
- **Charging advisor** (statistical baseline): after about 3 days of real history it uses the vehicle's own medians (daily use, discharge and charge rates, usual departure hour) to say what to charge to, how much energy, and when to start. Before that it says it is still learning. It is not a trained ML model and does not claim to be; `lib/advisor.js` has a small interface so a validated model can replace it later.

## Not available with the current hardware

- Cell imbalance and insulation resistance need a BMS that reports per-cell voltages / insulation. The dashboard shows "unavailable" until the device sends them.
- Accurate SOH needs the device to report SOC (or the pack to rest and have a known OCV curve), a rated capacity from the datasheet, and a few full-ish cycles.
- A real ML model for SOH/RUL needs a labelled dataset from your own packs (many cycles, known chemistry, capacity check-ups). Until then the baselines above are used.
- Mappls is not included because I could not test it without a key; the map layer is a small adapter in `public/script.js` (`MapX`) if you want to add it.
