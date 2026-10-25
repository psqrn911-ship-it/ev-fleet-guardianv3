'use strict';
// Email delivery. Uses SMTP (Gmail app password works) through nodemailer. Nothing here logs credentials.
// On serverless platforms the function freezes once the response is sent, so callers must `await` send().
let nodemailer = null; try { nodemailer = require('nodemailer'); } catch { /* optional dependency: reported as "not configured" */ }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const env = () => process.env;
const configured = () => !!(nodemailer && env().SMTP_USER && env().SMTP_PASS);
let transport = null, sentThisHour = { h: 0, n: 0 };

function getTransport() {
  if (transport) return transport;
  const e = env(), port = Number(e.SMTP_PORT) || 465;
  transport = nodemailer.createTransport({ host: e.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465, auth: { user: e.SMTP_USER, pass: e.SMTP_PASS },
    connectionTimeout: 6000, greetingTimeout: 6000, socketTimeout: 9000 });
  return transport;
}

// Global safety valve so a fault storm cannot flood an inbox (or get the Gmail account blocked).
function allowed() { const h = Math.floor(Date.now() / 36e5); if (sentThisHour.h !== h) sentThisHour = { h, n: 0 }; return sentThisHour.n++ < (Number(env().MAIL_MAX_PER_HOUR) || 40); }

async function send({ to, subject, text, html }) {
  if (!configured()) return { ok: false, skipped: true, error: 'Email is not configured (set SMTP_USER and SMTP_PASS).' };
  if (!allowed()) return { ok: false, skipped: true, error: 'Hourly email limit reached; the notification is still in the dashboard.' };
  try { await getTransport().sendMail({ from: env().MAIL_FROM || `EV Fleet Monitor <${env().SMTP_USER}>`, to, subject, text, html }); return { ok: true }; }
  catch (e) { transport = null; return { ok: false, error: String(e && e.code || e && e.message || 'send failed').slice(0, 120) }; }
}

const COLOR = { critical: '#e84646', warning: '#ff7b54', info: '#0084ff' };
function render(items, appUrl) {
  const worst = items.some(i => i.severity === 'critical') ? 'critical' : items.some(i => i.severity === 'warning') ? 'warning' : 'info';
  const subject = items.length === 1 ? `[EV Fleet${worst === 'info' ? '' : ' · ' + worst.toUpperCase()}] ${items[0].title}` : `[EV Fleet${worst === 'info' ? '' : ' · ' + worst.toUpperCase()}] ${items.length} new notifications`;
  const text = items.map(i => `${i.severity.toUpperCase()} · ${i.title}\n${i.message}\n${new Date(i.time).toISOString()}`).join('\n\n') + (appUrl ? `\n\nOpen the dashboard: ${appUrl}` : '');
  const rows = items.map(i => `<tr><td style="padding:14px 0;border-top:1px solid #e5e9f0"><span style="display:inline-block;font:600 11px Arial;letter-spacing:.6px;color:#fff;background:${COLOR[i.severity] || COLOR.info};border-radius:10px;padding:2px 9px">${esc(i.severity.toUpperCase())}</span>
    <div style="font:600 15px Arial;margin:8px 0 4px;color:#1a1e2e">${esc(i.title)}</div><div style="font:14px/1.5 Arial;color:#4a5068;white-space:pre-line">${esc(i.message)}</div>
    <div style="font:12px Arial;color:#8a92a8;margin-top:6px">${esc(new Date(i.time).toLocaleString('en-IN', { timeZone: env().APP_TIMEZONE || 'Asia/Kolkata' }))}</div></td></tr>`).join('');
  const html = `<div style="max-width:560px;margin:0 auto;padding:24px;font-family:Arial,sans-serif"><div style="font:600 18px Arial;color:#1a1e2e">EV<span style="color:#00c48c">Fleet</span> Monitor</div><table width="100%" cellspacing="0" style="margin-top:12px">${rows}</table>${appUrl ? `<p style="margin-top:20px"><a href="${esc(appUrl)}" style="background:#00c48c;color:#fff;text-decoration:none;font:600 14px Arial;padding:10px 18px;border-radius:8px">Open dashboard</a></p>` : ''}
    <p style="font:12px Arial;color:#8a92a8;margin-top:22px">Dashboard alerts are software monitoring only and do not replace hardware battery protection.</p></div>`;
  return { subject, text, html };
}

module.exports = { send, render, configured, esc };
