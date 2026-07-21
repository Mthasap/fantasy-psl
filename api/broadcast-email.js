// api/broadcast-email.js — Fantasy Pro Soccer League — Email System v4
// ══════════════════════════════════════════════════════════════════════════
//
// ALL EMAIL ACTIONS:
//
//   STATUS & TESTING
//   ?action=status           → count of users, waitlist, resend config
//   ?action=test-connection  → verify Resend API key + domain
//   ?action=test-email&email=X&type=all|registration|reset|waitlist|welcome|newsletter
//                            → send test versions of any email type
//
//   AUTOMATED (called by master-agent or triggered manually)
//   ?action=waitlist-confirm&email=X  → send waitlist confirmation email
//   ?action=news-digest               → send weekly PSL news to opted-in users
//
//   USER MANAGEMENT (admin only)
//   ?action=send-farewell    → email all users an upgrade/reset notice
//   ?action=wipe-users&confirm=WIPE_ALL_USERS → delete all users from DB+auth
//   ?action=send-and-wipe&confirm=WIPE_ALL_USERS → farewell then wipe
//
// ══════════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL     = process.env.SUPABASE_URL          || '';
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY  || '';
const ADMIN      = process.env.ADMIN_SECRET          || '';
const RESEND_KEY = process.env.RESEND_API_KEY        || '';
const FROM       = 'Fantasy Pro Soccer League <noreply@fantasypsl.co.za>';
const SITE       = process.env.SITE_URL || 'https://www.fantasypsl.co.za';

// ── Rate limiter ──────────────────────────────────────────────────────────
const _rl = new Map();
function rateLimit(ip, max = 10, ms = 60_000) {
  const now = Date.now();
  const rec = _rl.get(ip) || { c:0, r:now+ms };
  if (now > rec.r) { rec.c=0; rec.r=now+ms; }
  rec.c++; _rl.set(ip, rec);
  return rec.c > max;
}

// ── Core send function ────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!RESEND_KEY) throw new Error('RESEND_API_KEY not set in Vercel env vars');
  const r = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ from: FROM, to: Array.isArray(to) ? to : [to], subject, html }),
    signal:  AbortSignal.timeout(12_000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Resend HTTP ${r.status}: ${body.slice(0,200)}`);
  }
  return r.json();
}

// ── Email wrapper ─────────────────────────────────────────────────────────
function wrap(title, body, headerColor = '#B91C3A', headerIcon = '⚽') {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;padding:0;background:#0C0F14;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0C0F14;padding:32px 16px">
<tr><td align="center">
<table width="100%" style="max-width:560px;background:#121620;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.07)">
  <tr><td style="background:linear-gradient(135deg,${headerColor} 0%,${headerColor}99 100%);padding:32px;text-align:center">
    <div style="margin-bottom:10px;display:flex;justify-content:center">${headerIcon}</div>
    <img src="${SITE}/logo.png" width="52" height="52" style="border-radius:10px;margin-bottom:10px;display:block;margin:0 auto 10px" alt="Fantasy PSL">
    <h1 style="margin:0;color:#fff;font-size:20px;font-weight:900;letter-spacing:-.3px">Fantasy Pro Soccer League</h1>
    <p style="margin:5px 0 0;color:rgba(255,255,255,.6);font-size:11px;letter-spacing:2px;text-transform:uppercase">South Africa's Fantasy Football</p>
  </td></tr>
  <tr><td style="padding:32px">${body}</td></tr>
  <tr><td style="background:#080B10;padding:20px 32px;border-top:1px solid rgba(255,255,255,.05);text-align:center">
    <p style="margin:0;color:rgba(255,255,255,.2);font-size:11px;line-height:1.6">
      &copy; 2026 Fantasy Pro Soccer League &nbsp;&middot;&nbsp;
      <a href="${SITE}" style="color:#DBA94A;text-decoration:none">fantasypsl.co.za</a><br>
      Fan-made &middot; Not affiliated with PSL or Betway &middot;
      <a href="${SITE}/?settings=email" style="color:rgba(255,255,255,.2);text-decoration:none">Manage email preferences</a>
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function btn(text, url, color = '#B91C3A') {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0">
  <tr><td align="center">
    <a href="${url}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 32px;border-radius:9px;letter-spacing:.4px;box-shadow:0 3px 16px rgba(185,28,58,.4)">${text}</a>
  </td></tr></table>`;
}

// ── Email templates ───────────────────────────────────────────────────────
const TEMPLATES = {

  // 1. Registration confirmation (test — real one sent by Supabase SMTP)
  registration: () => ({
    subject: '✅ [TEST] Confirm your Fantasy Pro Soccer League account',
    html: wrap(
      'Confirm your account',
      `<p style="color:rgba(255,255,255,.8);font-size:15px;line-height:1.8;margin:0 0 16px">
        This is a <strong style="color:#fff">TEST</strong> of the registration confirmation email.
        In production Supabase sends this automatically when a user registers.
      </p>
      <div style="background:rgba(34,137,90,.08);border:1px solid rgba(34,137,90,.2);border-radius:10px;padding:16px;margin-bottom:20px">
        <p style="color:rgba(255,255,255,.7);font-size:13px;margin:0;line-height:1.7">
          The real email contains a secure confirmation link that takes the user to
          <strong style="color:#DBA94A">${SITE}/confirm</strong> to verify their email address.
          Until confirmed, they cannot fully access the app.
        </p>
      </div>
      ${btn('Confirm Email Address →', SITE + '/confirm', '#22895A')}
      <p style="color:rgba(255,255,255,.35);font-size:12px;text-align:center;margin:0">
        If you did not create an account, ignore this email.
      </p>`,
      '#22895A', '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
    ),
  }),

  // 2. Password reset (test — real one sent by Supabase SMTP)
  reset: () => ({
    subject: '🔑 [TEST] Reset your Fantasy Pro Soccer League password',
    html: wrap(
      'Reset your password',
      `<p style="color:rgba(255,255,255,.8);font-size:15px;line-height:1.8;margin:0 0 16px">
        This is a <strong style="color:#fff">TEST</strong> of the password reset email.
        In production Supabase sends this when a user clicks "Forgot Password".
      </p>
      <div style="background:rgba(219,169,74,.07);border:1px solid rgba(219,169,74,.2);border-radius:10px;padding:16px;margin-bottom:20px">
        <p style="color:rgba(255,255,255,.7);font-size:13px;margin:0;line-height:1.7">
          The real email contains a secure reset link → <strong style="color:#DBA94A">${SITE}/confirm?type=recovery</strong><br>
          The link expires after <strong style="color:#fff">1 hour</strong>.
          After clicking, the user is taken to a password reset form.
        </p>
      </div>
      ${btn('Reset My Password →', SITE + '/confirm?type=recovery', '#DBA94A')}
      <p style="color:rgba(255,255,255,.35);font-size:12px;text-align:center;margin:0">
        If you did not request this, ignore this email — your password will not change.
      </p>`,
      '#DBA94A', '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>'
    ),
  }),

  // 3. Waitlist confirmation
  waitlist: (email) => ({
    subject: '🎉 You\'re on the Fantasy Pro Soccer League Early Access List!',
    html: wrap(
      'You\'re on the list!',
      `<p style="color:rgba(255,255,255,.8);font-size:15px;line-height:1.8;margin:0 0 16px">
        You are officially on the <strong style="color:#DBA94A">Fantasy PSL Early Access List</strong>.
        When squad selection opens on <strong style="color:#fff">27 July 2026</strong> you will be the first to know.
      </p>
      <div style="background:rgba(34,137,90,.07);border:1px solid rgba(34,137,90,.18);border-radius:12px;padding:20px;margin-bottom:24px">
        <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:14px"><tr>
              <td style="width:32px;vertical-align:top;padding-top:2px;padding-right:12px">
                <div style="width:30px;height:30px;border-radius:7px;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;padding:6px;box-sizing:border-box"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#DBA94A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></div>
              </td>
              <td>
                <div style="color:#fff;font-size:14px;font-weight:700;margin-bottom:2px">Registration opens</div>
                <div style="color:rgba(255,255,255,.5);font-size:12px;line-height:1.5">27 July 2026 — 2 weeks before the first PSL game</div>
              </td>
            </tr></table><table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:14px"><tr>
              <td style="width:32px;vertical-align:top;padding-top:2px;padding-right:12px">
                <div style="width:30px;height:30px;border-radius:7px;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;padding:6px;box-sizing:border-box"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#DBA94A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/><line x1="2" y1="12" x2="22" y2="12"/></svg></div>
              </td>
              <td>
                <div style="color:#fff;font-size:14px;font-weight:700;margin-bottom:2px">Pick your squad</div>
                <div style="color:rgba(255,255,255,.5);font-size:12px;line-height:1.5">15 Betway Premiership players within a R100M budget</div>
              </td>
            </tr></table><table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:14px"><tr>
              <td style="width:32px;vertical-align:top;padding-top:2px;padding-right:12px">
                <div style="width:30px;height:30px;border-radius:7px;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;padding:6px;box-sizing:border-box"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#DBA94A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="M6 9H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2"/><path d="M18 9h2a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2"/><path d="M4 3h16v7a8 8 0 0 1-8 8 8 8 0 0 1-8-8z"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg></div>
              </td>
              <td>
                <div style="color:#fff;font-size:14px;font-weight:700;margin-bottom:2px">Earn points</div>
                <div style="color:rgba(255,255,255,.5);font-size:12px;line-height:1.5">From every PSL match in the 2026/27 season</div>
              </td>
            </tr></table>
      </div>
      ${btn('Visit Fantasy PSL →', SITE)}
      <p style="color:rgba(255,255,255,.35);font-size:12px;text-align:center;margin:0">
        Share with friends: <a href="${SITE}" style="color:#DBA94A">${SITE.replace('https://', '')}</a>
      </p>`,
      '#22895A', '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>'
    ),
  }),

  // 4. Welcome (after first squad save)
  welcome: (username) => ({
    subject: '⚽ Welcome to Fantasy Pro Soccer League!',
    html: wrap(
      'Welcome!',
      `<p style="color:rgba(255,255,255,.8);font-size:15px;line-height:1.8;margin:0 0 16px">
        Welcome to Fantasy PSL, <strong style="color:#fff">${username || 'Manager'}</strong>!
        Your squad is saved and you are ready for the 2026/27 Betway Premiership season.
      </p>
      <div style="background:rgba(185,28,58,.08);border:1px solid rgba(185,28,58,.2);border-radius:12px;padding:20px;margin-bottom:24px">
        <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:14px"><tr>
              <td style="width:32px;vertical-align:top;padding-top:2px;padding-right:12px">
                <div style="width:30px;height:30px;border-radius:7px;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;padding:6px;box-sizing:border-box"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#DBA94A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/><path d="M12 12l2 2-2 2-2-2z"/></svg></div>
              </td>
              <td>
                <div style="color:#fff;font-size:14px;font-weight:700;margin-bottom:2px">Set your captain</div>
                <div style="color:rgba(255,255,255,.5);font-size:12px;line-height:1.5">Your captain earns double points every gameweek</div>
              </td>
            </tr></table><table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:14px"><tr>
              <td style="width:32px;vertical-align:top;padding-top:2px;padding-right:12px">
                <div style="width:30px;height:30px;border-radius:7px;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;padding:6px;box-sizing:border-box"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#DBA94A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></div>
              </td>
              <td>
                <div style="color:#fff;font-size:14px;font-weight:700;margin-bottom:2px">Use your free transfer</div>
                <div style="color:rgba(255,255,255,.5);font-size:12px;line-height:1.5">You get 1 free transfer per gameweek to improve your squad</div>
              </td>
            </tr></table><table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:14px"><tr>
              <td style="width:32px;vertical-align:top;padding-top:2px;padding-right:12px">
                <div style="width:30px;height:30px;border-radius:7px;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;padding:6px;box-sizing:border-box"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#DBA94A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>
              </td>
              <td>
                <div style="color:#fff;font-size:14px;font-weight:700;margin-bottom:2px">Create or join a league</div>
                <div style="color:rgba(255,255,255,.5);font-size:12px;line-height:1.5">Compete with friends using a private invite code</div>
              </td>
            </tr></table><table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:14px"><tr>
              <td style="width:32px;vertical-align:top;padding-top:2px;padding-right:12px">
                <div style="width:30px;height:30px;border-radius:7px;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;padding:6px;box-sizing:border-box"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#DBA94A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
              </td>
              <td>
                <div style="color:#fff;font-size:14px;font-weight:700;margin-bottom:2px">Check Diski Chat</div>
                <div style="color:rgba(255,255,255,.5);font-size:12px;line-height:1.5">Discuss tactics with other PSL managers</div>
              </td>
            </tr></table>
      </div>
      ${btn('Go to My Squad →', SITE)}`,
      '#B91C3A', '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/><line x1="2" y1="12" x2="22" y2="12"/></svg>'
    ),
  }),

  // 5. Weekly news digest (sent to opted-in users)
  newsletter: (username, articles) => ({
    subject: '⚽ Your Fantasy PSL Weekly Digest — PSL News & Tips',
    html: wrap(
      'Weekly PSL Digest',
      `<p style="color:rgba(255,255,255,.8);font-size:15px;line-height:1.8;margin:0 0 20px">
        Hi <strong style="color:#fff">${username || 'Manager'}</strong>, here is your weekly roundup of
        PSL news and fantasy football tips.
      </p>
      ${(articles || []).slice(0, 5).map(a => `
      <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:14px 16px;margin-bottom:10px">
        <div style="font-family:sans-serif;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#B91C3A;margin-bottom:4px">${a.category || 'PSL News'}</div>
        <div style="color:#fff;font-size:14px;font-weight:700;line-height:1.4;margin-bottom:6px">${a.title}</div>
        <div style="color:rgba(255,255,255,.5);font-size:12px;line-height:1.6;margin-bottom:8px">${(a.summary || a.excerpt || '').slice(0,150)}${(a.summary || '').length > 150 ? '…' : ''}</div>
        <a href="${a.source_url || SITE}" style="color:#DBA94A;font-size:12px;font-weight:700;text-decoration:none">Read more →</a>
      </div>`).join('')}
      ${btn('Read All PSL News →', SITE + '/#news')}
      <p style="color:rgba(255,255,255,.3);font-size:11px;text-align:center;margin:0;line-height:1.6">
        You are receiving this because you opted in to news emails.<br>
        <a href="${SITE}/?settings=email" style="color:rgba(255,255,255,.3)">Unsubscribe</a>
      </p>`,
      '#B91C3A', '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2z"/><path d="M4 22a2 2 0 0 1-2-2V6"/><path d="M8 6h8"/><path d="M8 10h8"/><path d="M8 14h4"/></svg>'
    ),
  }),
};

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', SITE);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-key');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  if (rateLimit(ip)) return res.status(429).json({ error: 'Too many requests' });

  const adminKey = req.headers['x-admin-key'] || req.query.admin_key || '';
  const isCron   = req.headers['x-vercel-cron'] === '1';
  const isAdmin  = ADMIN && adminKey === ADMIN;

  if (!isCron && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  if (!SB_URL || !SB_KEY)  return res.status(500).json({ error: 'Supabase env vars missing' });

  const db     = createClient(SB_URL, SB_KEY);
  const action = req.query.action || 'status';
  const log    = [];

  // ── STATUS ──────────────────────────────────────────────────────────────
  if (action === 'status') {
    try {
      const [profilesRes, waitlistRes, newsletterRes] = await Promise.all([
        db.from('profiles').select('id', { count:'exact', head:true }),
        db.from('waitlist').select('id', { count:'exact', head:true }),
        db.from('profiles').select('id', { count:'exact', head:true }).eq('email_newsletter', true),
      ]);
      return res.json({
        success:           true,
        registered_users:  profilesRes.count || 0,
        waitlist_count:    waitlistRes.count  || 0,
        newsletter_opted_in: newsletterRes.count || 0,
        resend_key_set:    !!RESEND_KEY,
        from_address:      FROM,
        ready_to_send:     !!RESEND_KEY,
      });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── TEST CONNECTION ──────────────────────────────────────────────────────
  if (action === 'test-connection') {
    if (!RESEND_KEY) return res.json({ success:false, error:'RESEND_API_KEY not set' });
    try {
      const r = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${RESEND_KEY}` },
        signal: AbortSignal.timeout(10_000),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(data)}`);
      const domains = (data.data || []).map(d => ({ name:d.name, status:d.status, verified:d.status==='verified' }));
      const fpsl = domains.find(d => d.name?.includes('fantasypsl'));
      return res.json({
        success:          true,
        resend_connected: true,
        domains,
        fantasypsl_domain: fpsl || null,
        domain_verified:  fpsl?.verified || false,
        ready_to_send:    fpsl?.verified || false,
      });
    } catch(e) { return res.json({ success:false, error:e.message }); }
  }

  // ── TEST EMAILS ──────────────────────────────────────────────────────────
  if (action === 'test-email') {
    const email    = req.query.email || (req.body && req.body.email) || '';
    const type     = req.query.type  || 'all';
    if (!email || !email.includes('@')) {
      return res.status(400).json({
        error:   'email param required',
        example: `/api/broadcast-email?action=test-email&email=you@example.com&type=all&admin_key=KEY`,
        types:   Object.keys(TEMPLATES),
      });
    }

    const toRun   = type === 'all' ? Object.keys(TEMPLATES) : [type];
    const results = {};

    for (const t of toRun) {
      if (!TEMPLATES[t]) { results[t] = { ok:false, error:'Unknown type' }; continue; }
      try {
        const tpl = TEMPLATES[t](email, [
          { title:'Sundowns edge Chiefs in Soweto Derby', category:'Results', summary:'Mamelodi Sundowns claimed a narrow 1-0 victory over Kaizer Chiefs.', source_url: SITE },
          { title:'Top 5 Fantasy Picks for GW1', category:'Fantasy Tips', summary:'Our analysts reveal the must-have players for your opening gameweek squad.', source_url: SITE },
          { title:'Bafana Bafana squad named for AFCON qualifier', category:'Bafana', summary:'Hugo Broos has named a 23-man squad for the upcoming qualifier.', source_url: SITE },
        ]);
        log.push(`Sending ${t} to ${email}...`);
        await sendEmail(email, tpl.subject, tpl.html);
        results[t] = { ok:true, subject:tpl.subject };
        log.push(`  ✅ Sent`);
      } catch(e) {
        results[t] = { ok:false, error:e.message };
        log.push(`  ❌ ${e.message}`);
      }
      if (toRun.length > 1) await new Promise(r => setTimeout(r, 400));
    }

    const allOk = Object.values(results).every(r => r.ok);
    return res.json({
      success:    allOk,
      tested:     toRun.length,
      results,
      log,
      next_steps: allOk
        ? '✅ All emails sent! Check your inbox and spam folder. If all 5 arrive correctly your email system is fully operational.'
        : '⚠ Some emails failed — check the error messages above.',
    });
  }

  // ── WAITLIST CONFIRM ─────────────────────────────────────────────────────
  if (action === 'waitlist-confirm') {
    const email = req.query.email || (req.body && req.body.email) || '';
    if (!email || !email.includes('@')) return res.status(400).json({ error:'email required' });
    try {
      const tpl = TEMPLATES.waitlist(email);
      await sendEmail(email, tpl.subject, tpl.html);
      log.push(`✅ Waitlist confirmation sent to ${email}`);
      return res.json({ success:true, email, log });
    } catch(e) { return res.status(500).json({ error:e.message, log }); }
  }

  // ── NEWS DIGEST — send weekly news to all opted-in users ─────────────────
  if (action === 'news-digest') {
    log.push('=== NEWS DIGEST STARTED: ' + new Date().toISOString() + ' ===');

    // Get latest articles
    const { data: articles } = await db.from('news_posts')
      .select('title, summary, excerpt, category, source_url')
      .eq('published', true)
      .order('published_at', { ascending:false })
      .limit(5);

    if (!articles || articles.length === 0) {
      return res.json({ success:false, error:'No articles to send', log });
    }

    // Get opted-in users with emails
    const { data: users } = await db.from('profiles')
      .select('id, username, email')
      .eq('email_newsletter', true)
      .not('email', 'is', null);

    // Also get emails from auth for users without email in profiles
    const emailMap = {};
    for (const u of (users || [])) {
      if (u.email) emailMap[u.id] = { email:u.email, username:u.username };
    }

    try {
      const { data: authUsers } = await db.auth.admin.listUsers({ perPage:1000 });
      for (const u of (authUsers?.users || [])) {
        if (emailMap[u.id] && !emailMap[u.id].email) emailMap[u.id].email = u.email;
      }
    } catch(_) {}

    const recipients = Object.values(emailMap).filter(u => u.email);
    log.push(`Sending digest to ${recipients.length} opted-in users...`);

    let sent = 0; let failed = 0;
    for (const u of recipients) {
      try {
        const tpl = TEMPLATES.newsletter(u.username, articles);
        await sendEmail(u.email, tpl.subject, tpl.html);
        sent++;
      } catch(e) {
        failed++;
        log.push(`❌ ${u.email}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    log.push(`✅ Digest complete: ${sent} sent, ${failed} failed`);
    return res.json({ success:true, total:recipients.length, sent, failed, articles:articles.length, log });
  }

  // ── FAREWELL & WIPE ──────────────────────────────────────────────────────
  if (action === 'send-farewell' || action === 'send-and-wipe') {
    log.push('=== FAREWELL BROADCAST: ' + new Date().toISOString());
    if (!RESEND_KEY) return res.status(500).json({ error:'RESEND_API_KEY not set', log });

    const { data: profiles } = await db.from('profiles').select('id, username, email');
    const emailMap = {};
    for (const p of (profiles || [])) {
      if (p.email) emailMap[p.id] = { email:p.email, username:p.username };
    }
    try {
      const { data: authUsers } = await db.auth.admin.listUsers({ perPage:1000 });
      for (const u of (authUsers?.users || [])) {
        if (u.email && !emailMap[u.id]) emailMap[u.id] = { email:u.email, username:null };
        else if (u.email && emailMap[u.id] && !emailMap[u.id].email) emailMap[u.id].email = u.email;
      }
    } catch(e) { log.push('⚠ Auth users: ' + e.message); }

    const users = Object.values(emailMap).filter(u => u.email);
    let sent=0, failed=0;
    for (const u of users) {
      try {
        await sendEmail(u.email, '⚽ Important Update — Fantasy Pro Soccer League Platform Upgrade', buildFarewellHtml(u.username));
        sent++; log.push(`✅ ${u.email}`);
      } catch(e) { failed++; log.push(`❌ ${u.email}: ${e.message}`); }
      if (users.length > 1) await new Promise(r => setTimeout(r, 300));
    }
    log.push(`Emails: ${sent}/${users.length}`);
    if (action === 'send-farewell') return res.json({ success:true, sent, failed, log });
    log.push('Proceeding to wipe...');
  }

  if (action === 'wipe-users' || action === 'send-and-wipe') {
    const confirm = req.query.confirm || (req.body && req.body.confirm);
    if (confirm !== 'WIPE_ALL_USERS') {
      return res.status(400).json({ error:'Add ?confirm=WIPE_ALL_USERS to confirm wipe', log });
    }
    try {
      const { data: authUsers } = await db.auth.admin.listUsers({ perPage:1000 });
      const ids = (authUsers?.users || []).map(u => u.id);
      for (const table of ['gw_scores','league_members','leagues']) {
        await db.from(table).delete().not('id','is',null).catch(()=>{});
      }
      await db.from('profiles').delete().not('id','is',null);
      let deleted=0, failed=0;
      for (const id of ids) {
        const { error } = await db.auth.admin.deleteUser(id);
        if (error) failed++; else deleted++;
      }
      await db.from('app_settings').upsert({ key:'season_open', value:'false' }, { onConflict:'key' });
      log.push(`Deleted: ${deleted} users, ${failed} failed`);
      return res.json({ success:true, auth_deleted:deleted, auth_failed:failed, log });
    } catch(e) { return res.status(500).json({ error:e.message, log }); }
  }

  return res.status(400).json({ error:`Unknown action: ${action}`, log });
};

// ── Farewell HTML ─────────────────────────────────────────────────────────
function buildFarewellHtml(username) {
  const name = username || 'Fantasy Football Fan';
  const SITE = process.env.SITE_URL || 'https://www.fantasypsl.co.za';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;background:#0C0F14;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" style="padding:32px 16px"><tr><td align="center">
<table width="100%" style="max-width:560px;background:#121620;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.07)">
<tr><td style="background:linear-gradient(135deg,#B91C3A,#8B1020);padding:32px;text-align:center">
  <h1 style="margin:0;color:#fff;font-size:20px;font-weight:900">Fantasy Pro Soccer League</h1>
  <p style="margin:6px 0 0;color:rgba(255,255,255,.6);font-size:11px;letter-spacing:2px;text-transform:uppercase">Important Update</p>
</td></tr>
<tr><td style="padding:32px">
  <h2 style="margin:0 0 16px;color:#fff;font-size:20px;font-weight:900">We're Upgrading — Big Things Are Coming, ${name}! 🚀</h2>
  <p style="color:rgba(255,255,255,.75);font-size:15px;line-height:1.8;margin:0 0 16px">As part of a major platform upgrade ahead of the 2026/27 Betway Premiership season, we are performing a full reset. All accounts will need to be re-created when registration opens on <strong style="color:#DBA94A">27 July 2026</strong>.</p>
  <p style="color:rgba(255,255,255,.75);font-size:15px;line-height:1.8;margin:0 0 24px">The new season brings real-time player stats, live points, private leagues, and much more.</p>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <a href="${SITE}" style="display:inline-block;background:#B91C3A;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 32px;border-radius:9px">Visit Fantasy PSL →</a>
  </td></tr></table>
</td></tr>
<tr><td style="background:#080B10;padding:20px;text-align:center;border-top:1px solid rgba(255,255,255,.05)">
  <p style="margin:0;color:rgba(255,255,255,.2);font-size:11px">&copy; 2026 Fantasy Pro Soccer League · <a href="${SITE}" style="color:#DBA94A;text-decoration:none">fantasypsl.co.za</a></p>
</td></tr>
</table></td></tr></table></body></html>`;
}
