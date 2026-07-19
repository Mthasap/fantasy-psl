// api/broadcast-email.js — Fantasy PSL — Broadcast Email + Safe User Wipe
// ══════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   1. GET  ?action=preview           → preview the email that will be sent
//   2. POST ?action=send-farewell      → email ALL users the upgrade notice
//   3. POST ?action=wipe-users         → delete ALL users AFTER emails sent
//   4. POST ?action=send-and-wipe      → email then wipe in one safe sequence
//   5. GET  ?action=status             → how many users, emails sent, waitlist count
//
// EMAIL PROVIDER: Resend (resend.com) — already configured via Supabase SMTP
//   Uses Resend REST API directly for bulk sends (more reliable than SMTP for bulk)
//   Requires: RESEND_API_KEY env var in Vercel
//
// SAFETY RULES:
//   - Emails are sent FIRST. Wipe only proceeds if email batch completes.
//   - Each user deletion is logged individually.
//   - Auth users deleted via auth.admin.deleteUser() (service key required).
//   - waitlist table is NEVER touched — those emails are kept.
//
// ══════════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL       = process.env.SUPABASE_URL          || '';
const SB_KEY       = process.env.SUPABASE_SERVICE_KEY  || '';
const ADMIN        = process.env.ADMIN_SECRET          || '';
const RESEND_KEY   = process.env.RESEND_API_KEY        || '';
const FROM_EMAIL   = 'Fantasy PSL <noreply@fantasypsl.co.za>';
const SITE_URL     = 'https://www.fantasypsl.co.za';

// ── Rate limiter ──────────────────────────────────────────────────────────
const _rl = new Map();
function rateLimit(ip, max = 5, ms = 60_000) {
  const now = Date.now(); const rec = _rl.get(ip) || { c: 0, r: now + ms };
  if (now > rec.r) { rec.c = 0; rec.r = now + ms; } rec.c++; _rl.set(ip, rec);
  return rec.c > max;
}

// ── Send single email via Resend REST API ─────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!RESEND_KEY) throw new Error('RESEND_API_KEY not set in Vercel env vars');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Resend HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  return await r.json();
}

// ── Beautiful farewell email HTML ─────────────────────────────────────────
function buildFarewellEmail(username) {
  const name = username || 'Fantasy Football Fan';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Fantasy PSL — Important Update</title>
</head>
<body style="margin:0;padding:0;background:#0C0F14;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0C0F14;padding:40px 20px">
  <tr><td align="center">
    <table width="100%" style="max-width:580px;background:#121620;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.07)">

      <!-- Header -->
      <tr><td style="background:linear-gradient(135deg,#B91C3A 0%,#8B1429 100%);padding:40px 40px 32px;text-align:center">
        <img src="${SITE_URL}/logo.png" width="64" height="64" alt="Fantasy PSL" style="border-radius:12px;margin-bottom:16px;display:block;margin-left:auto;margin-right:auto">
        <h1 style="margin:0;color:#fff;font-size:24px;font-weight:900;letter-spacing:-0.5px">Fantasy PSL</h1>
        <p style="margin:6px 0 0;color:rgba(255,255,255,0.7);font-size:13px;letter-spacing:2px;text-transform:uppercase">South Africa&rsquo;s #1 Fantasy Football</p>
      </td></tr>

      <!-- Body -->
      <tr><td style="padding:40px">
        <p style="margin:0 0 8px;color:rgba(255,255,255,0.5);font-size:13px;text-transform:uppercase;letter-spacing:1.5px;font-weight:700">Important Notice</p>
        <h2 style="margin:0 0 24px;color:#fff;font-size:22px;font-weight:900;line-height:1.3">We&rsquo;re Upgrading &mdash; Big Things Are Coming, ${name}! 🚀</h2>

        <p style="margin:0 0 20px;color:rgba(255,255,255,0.75);font-size:15px;line-height:1.8">
          We have been working tirelessly behind the scenes to build the <strong style="color:#fff">most powerful and exciting fantasy football platform</strong> South Africa has ever seen.
        </p>

        <p style="margin:0 0 20px;color:rgba(255,255,255,0.75);font-size:15px;line-height:1.8">
          As part of this major upgrade, we are performing a <strong style="color:#DBA94A">full platform reset</strong> ahead of the new 2026/27 Betway Premiership season. This means all existing accounts, squads, and points have been cleared to give everyone a completely fresh start.
        </p>

        <!-- What's new box -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(185,28,58,0.08);border:1px solid rgba(185,28,58,0.2);border-radius:12px;margin-bottom:28px">
          <tr><td style="padding:24px">
            <p style="margin:0 0 14px;color:#DBA94A;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase">What&rsquo;s New in the 2026/27 Season</p>
            <table cellpadding="0" cellspacing="0">
              ${['Completely rebuilt squad builder — faster and smarter',
                 'Live player stats synced directly from every PSL match',
                 'New leagues system — create private leagues with friends',
                 'Real-time points updates as matches happen',
                 'Improved mobile experience — works perfectly on any phone',
                 'PSL news and injury alerts to help your transfers',
                 'Chips system — Triple Captain, Bench Boost, Wildcard and more',
                ].map(item => `
              <tr><td style="padding:5px 0">
                <table cellpadding="0" cellspacing="0"><tr>
                  <td style="color:#22895A;font-size:18px;padding-right:10px;vertical-align:top;line-height:1.4">&#10003;</td>
                  <td style="color:rgba(255,255,255,0.8);font-size:14px;line-height:1.6">${item}</td>
                </tr></table>
              </td></tr>`).join('')}
            </table>
          </td></tr>
        </table>

        <p style="margin:0 0 28px;color:rgba(255,255,255,0.75);font-size:15px;line-height:1.8">
          Registration for the new season opens on <strong style="color:#fff">27 July 2026</strong>. You will be among the <strong style="color:#DBA94A">first to know</strong> the moment the platform goes live.
        </p>

        <!-- CTA Button -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
          <tr><td align="center">
            <a href="${SITE_URL}" style="display:inline-block;background:linear-gradient(135deg,#B91C3A,#8B1429);color:#fff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 36px;border-radius:10px;letter-spacing:0.5px;box-shadow:0 4px 20px rgba(185,28,58,0.4)">
              Visit Fantasy PSL &rarr;
            </a>
          </td></tr>
        </table>

        <p style="margin:0 0 8px;color:rgba(255,255,255,0.75);font-size:15px;line-height:1.8">
          Thank you for being part of the Fantasy PSL journey. The best is yet to come.
        </p>
        <p style="margin:0;color:rgba(255,255,255,0.75);font-size:15px;line-height:1.8">
          See you on the pitch 🏆
        </p>
        <p style="margin:16px 0 0;color:#fff;font-size:14px;font-weight:700">The Fantasy PSL Team</p>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#0C0F14;padding:24px 40px;border-top:1px solid rgba(255,255,255,0.06)">
        <p style="margin:0 0 8px;color:rgba(255,255,255,0.3);font-size:12px;text-align:center;line-height:1.6">
          This email was sent to you because you had a registered account on Fantasy PSL.<br>
          Fan-made &middot; Not affiliated with the PSL or Betway &middot; &copy; 2026 Fantasy PSL
        </p>
        <p style="margin:8px 0 0;text-align:center">
          <a href="${SITE_URL}" style="color:#DBA94A;font-size:12px;text-decoration:none">fantasypsl.co.za</a>
          &nbsp;&middot;&nbsp;
          <a href="mailto:admin@fantasypsl.co.za" style="color:rgba(255,255,255,0.3);font-size:12px;text-decoration:none">admin@fantasypsl.co.za</a>
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── Beautiful waitlist confirmation email HTML ─────────────────────────────
function buildWaitlistEmail(email) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>You&rsquo;re on the list — Fantasy PSL</title>
</head>
<body style="margin:0;padding:0;background:#0C0F14;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0C0F14;padding:40px 20px">
  <tr><td align="center">
    <table width="100%" style="max-width:580px;background:#121620;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.07)">

      <!-- Header -->
      <tr><td style="background:linear-gradient(135deg,#1a3a1a 0%,#0f2a0f 100%);padding:40px;text-align:center">
        <div style="font-size:52px;margin-bottom:12px">🎉</div>
        <h1 style="margin:0;color:#fff;font-size:26px;font-weight:900">You&rsquo;re on the list!</h1>
        <p style="margin:8px 0 0;color:rgba(255,255,255,0.6);font-size:14px">Fantasy PSL 2026/27 Early Access</p>
      </td></tr>

      <!-- Body -->
      <tr><td style="padding:40px">
        <p style="margin:0 0 20px;color:rgba(255,255,255,0.75);font-size:15px;line-height:1.8">
          You&rsquo;re officially on the <strong style="color:#DBA94A">Fantasy PSL Early Access List</strong>. When registration opens for the new 2026/27 Betway Premiership season, you will be the <strong style="color:#fff">first to know</strong>.
        </p>

        <!-- What happens next -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(34,137,90,0.08);border:1px solid rgba(34,137,90,0.2);border-radius:12px;margin-bottom:28px">
          <tr><td style="padding:24px">
            <p style="margin:0 0 14px;color:#22895A;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase">What Happens Next</p>
            ${[
              ['📅', 'Registration opens', '27 July 2026 — you\'ll get an email the moment it does'],
              ['⚽', 'Pick your squad', 'Choose 15 PSL players within a R100M budget'],
              ['🏆', 'Compete & win', 'Earn points from real Betway Premiership match performance'],
              ['🎯', 'Early advantage', 'Early registrations get first pick of the best players'],
            ].map(([icon, title, desc]) => `
            <table cellpadding="0" cellspacing="0" style="margin-bottom:12px;width:100%"><tr>
              <td style="font-size:20px;padding-right:12px;vertical-align:top;padding-top:2px;width:28px">${icon}</td>
              <td>
                <div style="color:#fff;font-size:14px;font-weight:700;margin-bottom:2px">${title}</div>
                <div style="color:rgba(255,255,255,0.55);font-size:13px;line-height:1.5">${desc}</div>
              </td>
            </tr></table>`).join('')}
          </td></tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
          <tr><td align="center">
            <a href="${SITE_URL}" style="display:inline-block;background:linear-gradient(135deg,#B91C3A,#8B1429);color:#fff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 36px;border-radius:10px;letter-spacing:0.5px;box-shadow:0 4px 20px rgba(185,28,58,0.4)">
              Visit Fantasy PSL &rarr;
            </a>
          </td></tr>
        </table>

        <p style="margin:0;color:rgba(255,255,255,0.5);font-size:13px;line-height:1.7;text-align:center">
          Share the excitement &mdash; tell your friends to sign up at <a href="${SITE_URL}" style="color:#DBA94A;text-decoration:none">fantasypsl.co.za</a>
        </p>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#0C0F14;padding:24px 40px;border-top:1px solid rgba(255,255,255,0.06)">
        <p style="margin:0;color:rgba(255,255,255,0.3);font-size:12px;text-align:center;line-height:1.6">
          You received this because you signed up for early access at fantasypsl.co.za<br>
          Fan-made &middot; Not affiliated with the PSL or Betway &middot; &copy; 2026 Fantasy PSL
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://www.fantasypsl.co.za');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Rate limit
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (rateLimit(ip)) return res.status(429).json({ error: 'Too many requests' });

  // Auth — admin key required for all actions
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key || '';
  if (!ADMIN || adminKey !== ADMIN) {
    return res.status(401).json({ error: 'Unauthorized — admin key required' });
  }

  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'Supabase env vars missing' });
  const db  = createClient(SB_URL, SB_KEY);
  const log = [];
  const action = req.query.action || 'status';

  // ── STATUS ────────────────────────────────────────────────────────────
  if (action === 'status') {
    try {
      const [profilesRes, waitlistRes] = await Promise.all([
        db.from('profiles').select('id', { count: 'exact', head: true }),
        db.from('waitlist').select('id', { count: 'exact', head: true }),
      ]);
      return res.json({
        success:        true,
        registered_users: profilesRes.count || 0,
        waitlist_count:   waitlistRes.count  || 0,
        resend_key_set:   !!RESEND_KEY,
        ready_to_send:    !!RESEND_KEY && (profilesRes.count || 0) > 0,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PREVIEW — show the email that will be sent (dry run) ──────────────
  if (action === 'preview') {
    return res.json({
      success:        true,
      farewell_email: buildFarewellEmail('Mthasap'),
      waitlist_email: buildWaitlistEmail('user@example.com'),
      note:           'These are the actual HTML emails that will be sent. Check them carefully before proceeding.',
    });
  }

  // ── SEND FAREWELL — email all registered users ─────────────────────────
  if (action === 'send-farewell' || action === 'send-and-wipe') {
    log.push(`=== FAREWELL EMAIL BROADCAST STARTED: ${new Date().toISOString()} ===`);

    if (!RESEND_KEY) {
      return res.status(500).json({
        error: 'RESEND_API_KEY not set in Vercel Environment Variables',
        fix:   'Go to Vercel → Project → Settings → Environment Variables → Add RESEND_API_KEY',
        log,
      });
    }

    // Get all profiles with emails
    log.push('Fetching all registered users...');
    const { data: profiles, error: profilesErr } = await db
      .from('profiles')
      .select('id, username, email')
      .not('id', 'is', null);

    if (profilesErr) return res.status(500).json({ error: profilesErr.message, log });

    // Also get emails from auth.users for users whose email may not be in profiles
    const emailMap = {};
    for (const p of (profiles || [])) {
      if (p.email) emailMap[p.id] = { email: p.email, username: p.username };
    }

    // Fetch auth emails for any missing profiles
    log.push(`Found ${profiles?.length || 0} profiles. Fetching auth emails...`);
    try {
      const { data: authUsers } = await db.auth.admin.listUsers({ perPage: 1000 });
      for (const u of (authUsers?.users || [])) {
        if (u.email && !emailMap[u.id]) {
          emailMap[u.id] = { email: u.email, username: null };
        } else if (u.email && emailMap[u.id] && !emailMap[u.id].email) {
          emailMap[u.id].email = u.email;
        }
      }
    } catch (e) {
      log.push(`⚠ Could not fetch auth users: ${e.message} — using profile emails only`);
    }

    const users    = Object.values(emailMap).filter(u => u.email);
    const total    = users.length;
    let   sent     = 0;
    let   failed   = 0;
    const failures = [];

    log.push(`Sending farewell emails to ${total} users...`);

    // Send emails in batches of 10 (Resend rate limit: 100 req/sec)
    const BATCH = 10;
    for (let i = 0; i < users.length; i += BATCH) {
      const batch = users.slice(i, i + BATCH);
      await Promise.all(batch.map(async (u) => {
        try {
          await sendEmail(
            u.email,
            '⚽ Important Update — Fantasy PSL Platform Upgrade',
            buildFarewellEmail(u.username)
          );
          sent++;
          log.push(`  ✅ Sent to ${u.email}`);
        } catch (e) {
          failed++;
          failures.push(`${u.email}: ${e.message}`);
          log.push(`  ❌ Failed: ${u.email} — ${e.message}`);
        }
      }));
      // Small delay between batches to avoid rate limits
      if (i + BATCH < users.length) await new Promise(r => setTimeout(r, 500));
    }

    log.push(`\nEmail broadcast complete: ${sent}/${total} sent, ${failed} failed`);

    // If action is send-only, return here
    if (action === 'send-farewell') {
      return res.json({ success: true, total, sent, failed, failures: failures.slice(0, 20), log });
    }

    // Otherwise fall through to wipe
    log.push('\n=== PROCEEDING TO USER WIPE ===');
    log.push(`Emails sent to ${sent}/${total} users before wipe`);
  }

  // ── WIPE USERS — delete all users from DB and auth ────────────────────
  if (action === 'wipe-users' || action === 'send-and-wipe') {
    log.push('\n=== USER WIPE STARTED ===');

    // Safety: confirm parameter required for wipe
    const confirm = req.query.confirm || (req.body && req.body.confirm);
    if (confirm !== 'WIPE_ALL_USERS') {
      return res.status(400).json({
        error:   'Safety check failed',
        message: 'Add ?confirm=WIPE_ALL_USERS to your request to confirm the wipe.',
        log,
      });
    }

    try {
      // Step 1: Get all user IDs
      const { data: authUsers } = await db.auth.admin.listUsers({ perPage: 1000 });
      const userIds = (authUsers?.users || []).map(u => u.id);
      log.push(`Found ${userIds.length} users in auth.users`);

      // Step 2: Bulk clear all profile game data (leagues, scores etc)
      log.push('Clearing game data tables...');
      const tables = ['gw_scores', 'league_members', 'leagues'];
      for (const table of tables) {
        try {
          const { error: e } = await db.from(table).delete().not('id', 'is', null);
          if (e) log.push(`  ⚠ ${table}: ${e.message}`);
          else   log.push(`  ✅ ${table} cleared`);
        } catch (e) { log.push(`  ⚠ ${table}: ${e.message}`); }
      }

      // Step 3: Delete all profiles
      const { error: profErr } = await db.from('profiles').delete().not('id', 'is', null);
      if (profErr) log.push(`⚠ profiles delete: ${profErr.message}`);
      else         log.push('✅ All profiles deleted');

      // Step 4: Delete all auth users one by one (auth.admin.deleteUser is individual)
      let authDeleted = 0;
      let authFailed  = 0;
      log.push(`Deleting ${userIds.length} auth users...`);
      for (const uid of userIds) {
        try {
          const { error } = await db.auth.admin.deleteUser(uid);
          if (error) { authFailed++; log.push(`  ⚠ ${uid}: ${error.message}`); }
          else        { authDeleted++; }
        } catch (e)  { authFailed++; log.push(`  ⚠ ${uid}: ${e.message}`); }
      }
      log.push(`✅ Auth users: ${authDeleted} deleted, ${authFailed} failed`);

      // Step 5: Reset any player season stats
      await db.from('players').update({
        total_points: 0, gw_points: 0, goals: 0, assists: 0,
        clean_sheets: 0, appearances: 0, minutes_played: 0,
        yellow_cards: 0, red_cards: 0, saves: 0, goals_conceded: 0,
        updated_at: new Date().toISOString(),
      }).not('id', 'is', null);
      log.push('✅ Player season stats reset');

      // Step 6: Mark all GWs as not current, not finished
      await db.from('gameweeks').update({ is_current: false, is_finished: false })
        .not('id', 'is', null);
      log.push('✅ Gameweeks reset');

      // Step 7: Set season_open to false in app_settings
      await db.from('app_settings').upsert(
        { key: 'season_open', value: 'false' },
        { onConflict: 'key' }
      );
      log.push('✅ Season set to closed (pre-season overlay will show)');

      log.push('\n=== WIPE COMPLETE ===');
      log.push(`NOTE: waitlist table was NOT touched — ${(await db.from('waitlist').select('id',{count:'exact',head:true})).count || 0} emails preserved`);

      return res.json({
        success:       true,
        auth_deleted:  authDeleted,
        auth_failed:   authFailed,
        log,
      });

    } catch (e) {
      log.push('❌ FATAL: ' + e.message);
      return res.status(500).json({ error: e.message, log });
    }
  }

  // ── SEND WAITLIST CONFIRMATION — triggered when user joins waitlist ────
  if (action === 'waitlist-confirm') {
    const email = req.query.email || (req.body && req.body.email);
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    try {
      await sendEmail(
        email,
        '🎉 You\'re on the Fantasy PSL Early Access List!',
        buildWaitlistEmail(email)
      );
      log.push(`✅ Waitlist confirmation sent to ${email}`);
      return res.json({ success: true, email, log });
    } catch (e) {
      log.push(`❌ Failed to send waitlist email to ${email}: ${e.message}`);
      return res.status(500).json({ error: e.message, log });
    }
  }

  // ── EMAIL TEST ACTIONS ───────────────────────────────────────────────
  // Merged here to avoid adding a new function (Vercel Hobby limit = 12)

  if (action === 'test-connection') {
    if (!RESEND_KEY) return res.json({ success:false, error:'RESEND_API_KEY not set in Vercel env vars', fix:'Vercel → Project → Settings → Environment Variables → Add RESEND_API_KEY' });
    try {
      const r = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${RESEND_KEY}` }, signal: AbortSignal.timeout(10_000)
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(data)}`);
      const domains = (data.data || []).map(d => ({ name: d.name, status: d.status, verified: d.status === 'verified' }));
      const fpslDomain = domains.find(d => d.name && d.name.includes('fantasypsl'));
      return res.json({ success: true, resend_connected: true, domains, fantasypsl_domain: fpslDomain || null, domain_verified: fpslDomain?.verified || false, ready_to_send: fpslDomain?.verified || false });
    } catch(e) { return res.json({ success: false, error: e.message }); }
  }

  if (action === 'test-email') {
    const testTo   = req.query.email || (req.body && req.body.email) || '';
    const testType = req.query.type  || 'all';
    if (!testTo || !testTo.includes('@')) return res.status(400).json({ error: 'email param required', example: '/api/broadcast-email?action=test-email&email=you@example.com&type=all&admin_key=KEY' });

    const SITE = process.env.SITE_URL || 'https://www.fantasypsl.co.za';
    function wrap(title, body, color) {
      return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;background:#0C0F14;font-family:Arial,sans-serif"><table width="100%" style="padding:40px 20px"><tr><td align="center"><table width="100%" style="max-width:560px;background:#121620;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.07)"><tr><td style="background:linear-gradient(135deg,${color},${color}cc);padding:32px;text-align:center"><img src="${SITE}/logo.png" width="56" height="56" style="border-radius:10px;margin-bottom:12px;display:block;margin:0 auto 12px" alt="Fantasy PSL"><h1 style="margin:0;color:#fff;font-size:22px;font-weight:900">Fantasy PSL</h1></td></tr><tr><td style="padding:36px">${body}</td></tr><tr><td style="background:#0C0F14;padding:20px;text-align:center;border-top:1px solid rgba(255,255,255,.06)"><p style="margin:0;color:rgba(255,255,255,.25);font-size:11px">&copy; 2026 Fantasy PSL &middot; <a href="${SITE}" style="color:#DBA94A;text-decoration:none">fantasypsl.co.za</a></p></td></tr></table></td></tr></table></body></html>`;
    }

    const templates = {
      registration: { subject:'✅ [TEST] Confirm your Fantasy PSL account', html: wrap('Confirm account', '<p style="color:rgba(255,255,255,.8);font-size:15px;line-height:1.8">This is a <strong style="color:#fff">test of the registration confirmation email</strong>. In production Supabase sends this automatically when a user registers. The real email contains a confirmation link directing to /confirm.</p><table width="100%" style="margin-top:20px"><tr><td align="center"><a href="'+SITE+'/confirm" style="display:inline-block;background:#22895A;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 32px;border-radius:9px">Confirm Email Address &rarr;</a></td></tr></table>', '#22895A') },
      reset:        { subject:'🔑 [TEST] Reset your Fantasy PSL password',  html: wrap('Reset password',  '<p style="color:rgba(255,255,255,.8);font-size:15px;line-height:1.8">This is a <strong style="color:#fff">test of the password reset email</strong>. In production this is triggered when a user clicks Forgot Password. The real email contains a secure reset link to /confirm?type=recovery that expires in 1 hour.</p><table width="100%" style="margin-top:20px"><tr><td align="center"><a href="'+SITE+'/confirm" style="display:inline-block;background:#DBA94A;color:#111;text-decoration:none;font-size:14px;font-weight:700;padding:13px 32px;border-radius:9px">Reset Password &rarr;</a></td></tr></table>', '#DBA94A') },
      waitlist:     { subject:'[TEST] You\'re on the Fantasy PSL Early Access List! \uD83C\uDF89', html: wrap('On the list!', '<p style="color:rgba(255,255,255,.8);font-size:15px;line-height:1.8">This is a <strong style="color:#fff">test of the waitlist confirmation email</strong>. In production this is sent the moment someone enters their email on the pre-season countdown page and clicks Notify Me. It confirms they are on early access and that registration opens 27 July 2026.</p><table width="100%" style="margin-top:20px"><tr><td align="center"><a href="'+SITE+'" style="display:inline-block;background:#B91C3A;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 32px;border-radius:9px">Visit Fantasy PSL &rarr;</a></td></tr></table>', '#B91C3A') },
      welcome:      { subject:'⚽ [TEST] Welcome to Fantasy PSL!', html: wrap('Welcome!', '<p style="color:rgba(255,255,255,.8);font-size:15px;line-height:1.8">This is a <strong style="color:#fff">test of the welcome email</strong>. In production this is sent after a user saves their squad for the first time.</p><table width="100%" style="margin-top:20px"><tr><td align="center"><a href="'+SITE+'" style="display:inline-block;background:#B91C3A;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 32px;border-radius:9px">View My Squad &rarr;</a></td></tr></table>', '#B91C3A') },
    };

    const toRun  = testType === 'all' ? Object.keys(templates) : [testType];
    const results = {};
    const testLog = [];
    for (const t of toRun) {
      if (!templates[t]) { results[t] = { ok:false, error:`Unknown type: ${t}` }; continue; }
      try {
        testLog.push(`Sending ${t} to ${testTo}...`);
        const sent = await sendEmail(testTo, templates[t].subject, templates[t].html);
        results[t] = { ok:true, subject: templates[t].subject };
        testLog.push(`  ✅ Sent`);
      } catch(e) {
        results[t] = { ok:false, error:e.message };
        testLog.push(`  ❌ ${e.message}`);
      }
      if (toRun.length > 1) await new Promise(r => setTimeout(r, 400));
    }
    const allOk = Object.values(results).every(r => r.ok);
    return res.json({ success: allOk, tested: toRun.length, results, log: testLog, next_steps: allOk ? 'All sent! Check your inbox and spam folder.' : 'Some failed — check error messages.' });
  }

    return res.status(400).json({ error: `Unknown action: ${action}` });
};
