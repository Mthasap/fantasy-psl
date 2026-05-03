// api/admin-api.js — Fantasy PSL — Unified Admin API
// ─────────────────────────────────────────────────────────────────────────
// Handles ALL admin operations in one function to stay within Vercel
// Hobby plan's 12 Serverless Function limit.
//
// ACTIONS (standard DB):
//   insert | upsert | update | update_not | delete | select
//
// ACTIONS (special):
//   add_player          → insert a missing player with validation + dupe check
//   bulk_add_players    → insert multiple players at once
//   nudge_squads        → email users with incomplete squads (< 15 players)
//
// SECURITY:
//   Key read ONLY from ADMIN_SECRET env var — never hardcoded.
//   Must be sent in x-admin-key HEADER (not URL param — URL params appear in logs).
// ─────────────────────────────────────────────────────────────────────────

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL     = process.env.SUPABASE_URL;
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY;
const ADMIN      = process.env.ADMIN_SECRET;
const RESEND_KEY = process.env.RESEND_API_KEY || null;
const APP_URL    = 'https://www.fantasypsl.co.za';

// ── Position normaliser ───────────────────────────────────────────────────
function normalisePosition(raw) {
  if (!raw) return 'MID';
  const r = raw.toUpperCase().trim();
  if (r === 'GK'  || r.includes('GOAL'))                          return 'GK';
  if (r === 'DEF' || r.includes('DEF') || r.includes('BACK'))    return 'DEF';
  if (r === 'FWD' || r.includes('ATT') || r.includes('FOR') || r.includes('STRIKE')) return 'FWD';
  return 'MID';
}

function defaultPrice(pos) {
  return pos === 'GK' ? 5.0 : pos === 'DEF' ? 5.5 : pos === 'MID' ? 6.5 : 7.0;
}

function buildPlayerRow(p) {
  const pos = normalisePosition(p.position);
  return {
    display_name:   (p.display_name || p.name || '').trim(),
    team:           (p.team || p.club || '').trim(),
    position:       pos,
    apifootball_id: p.apifootball_id ? parseInt(p.apifootball_id, 10) : null,
    price:          parseFloat(p.price) || defaultPrice(pos),
    is_available:   p.is_available !== false,
    goals:          0, assists: 0, yellow_cards: 0, red_cards: 0,
    clean_sheets:   0, apps: 0, total_points: 0,
    updated_at:     new Date().toISOString(),
  };
}

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  // Auth — header only, never URL param
  const adminKey = req.headers && req.headers['x-admin-key'];
  if (!ADMIN) {
    console.error('[Admin API] ADMIN_SECRET env var not set');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }
  if (!adminKey || adminKey !== ADMIN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db   = createClient(SB_URL, SB_KEY);
  const body = req.body || {};
  const { action } = body;

  if (!action) return res.status(400).json({ error: 'action is required' });

  try {

    // ── ADD SINGLE PLAYER ───────────────────────────────────────────────
    if (action === 'add_player') {
      const p = body.data || body;
      if (!p.display_name && !p.name) {
        return res.status(400).json({
          error: 'display_name is required',
          example: { display_name: 'Bongani Zungu', team: 'Mamelodi Sundowns', position: 'MID', apifootball_id: 89123, price: 7.5 }
        });
      }
      if (!p.team && !p.club) return res.status(400).json({ error: 'team is required' });

      const row = buildPlayerRow(p);

      // Dupe check by apifootball_id
      if (row.apifootball_id) {
        const { data: existing } = await db.from('players')
          .select('id, display_name, team')
          .eq('apifootball_id', row.apifootball_id)
          .limit(1);
        if (existing && existing.length > 0) {
          return res.status(409).json({ error: 'Player with this apifootball_id already exists', existing: existing[0] });
        }
      }

      const { data, error } = await db.from('players').insert(row).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, message: `${data.display_name} added successfully`, player: data });
    }

    // ── BULK ADD PLAYERS ────────────────────────────────────────────────
    if (action === 'bulk_add_players') {
      const players = body.players;
      if (!Array.isArray(players) || !players.length) {
        return res.status(400).json({ error: 'players array is required' });
      }
      const rows = players.map(buildPlayerRow);
      const invalid = rows.filter(r => !r.display_name || !r.team);
      if (invalid.length) {
        return res.status(400).json({ error: 'Each player needs display_name and team', invalid });
      }
      const { data, error } = await db.from('players').insert(rows)
        .select('id, display_name, team, position, apifootball_id');
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, inserted: data.length, players: data });
    }

    // ── NUDGE INCOMPLETE SQUADS ─────────────────────────────────────────
    if (action === 'nudge_squads') {
      // How long after registration to wait before first nudge (default 2 hours)
      const waitHours  = parseInt(body.wait_hours || 2, 10);
      const waitCutoff = new Date(Date.now() - waitHours * 60 * 60 * 1000).toISOString();

      // Fetch incomplete profiles — squad_registered = false and created > waitHours ago
      const { data: profiles, error: profileErr } = await db
        .from('profiles')
        .select('id, username, team_name, squad_count, created_at')
        .eq('squad_registered', false)
        .lt('created_at', waitCutoff)
        .limit(500);

      if (profileErr) return res.status(500).json({ error: profileErr.message });

      // Also fetch their real email addresses from auth.users (service key required)
      // We need emails separately since profiles table stores user_id not email
      const userIds = (profiles || []).map(p => p.id);
      if (!userIds.length) {
        return res.json({ success: true, nudged: 0, skipped: 0, errors: 0, log: ['No incomplete squads found'] });
      }

      // Fetch emails in batches via Supabase auth admin
      const emailMap = {};
      try {
        // Supabase admin API — list users and map id → email
        const authRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
          headers: {
            'apikey':        process.env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
          }
        });
        if (authRes.ok) {
          const authData = await authRes.json();
          for (const u of (authData.users || [])) {
            if (u.email) emailMap[u.id] = u.email;
          }
        }
      } catch (e) {
        return res.status(500).json({ error: 'Could not fetch user emails: ' + e.message });
      }

      if (!Object.keys(emailMap).length) {
        return res.status(500).json({ error: 'No user emails found — check SUPABASE_SERVICE_KEY has auth.admin access' });
      }

      let nudged = 0, skipped = 0, errors = 0;
      const log = [];

      for (const profile of (profiles || [])) {
        const email = emailMap[profile.id];
        if (!email) { skipped++; log.push(`No email for user ${profile.id}`); continue; }

        const have    = profile.squad_count || 0;
        const need    = 15 - have;
        const name    = profile.username || 'Coach';
        const team    = profile.team_name ? ` "${profile.team_name}"` : '';
        const subject = have === 0
          ? `⚽ ${name}, your Fantasy PSL squad is empty — start picking now!`
          : `⚽ ${name}, you need ${need} more players to complete your Fantasy PSL squad`;

        const progressBar = Array.from({ length: 15 }, (_, i) =>
          `<span style="display:inline-block;width:16px;height:16px;border-radius:50%;margin:2px;background:${i < have ? '#25C06A' : 'rgba(255,255,255,.15)'}">&nbsp;</span>`
        ).join('');

        const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#080B10;font-family:Arial,sans-serif">
  <div style="max-width:540px;margin:0 auto;background:#080B10">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#E8192C 0%,#7B0D14 100%);padding:28px 24px;text-align:center">
      <div style="font-size:28px;font-weight:900;color:#fff;letter-spacing:-0.5px;margin-bottom:4px">Fantasy PSL</div>
      <div style="font-size:11px;color:rgba(255,255,255,.6);letter-spacing:3px;text-transform:uppercase">Betway Premiership 2025/26</div>
    </div>

    <!-- Body -->
    <div style="padding:28px 24px;background:#0E1420">

      <p style="font-size:18px;font-weight:700;color:#fff;margin:0 0 12px">Hi ${name}! 👋</p>

      ${have === 0 ? `
      <p style="color:rgba(255,255,255,.75);line-height:1.7;font-size:15px;margin:0 0 20px">
        You registered for <strong style="color:#fff">Fantasy PSL${team}</strong> but you haven't picked any players yet!
        You need <strong style="color:#FFB830">15 players</strong> to start earning points this gameweek.
      </p>
      ` : `
      <p style="color:rgba(255,255,255,.75);line-height:1.7;font-size:15px;margin:0 0 20px">
        Your team${team} has <strong style="color:#FFB830">${have} out of 15 players</strong> — 
        you're just <strong style="color:#fff">${need} player${need !== 1 ? 's' : ''} away</strong> from 
        earning fantasy points this gameweek!
      </p>
      `}

      <!-- Progress indicator -->
      <div style="background:#141B28;border-radius:12px;padding:16px 20px;margin-bottom:24px;text-align:center">
        <div style="font-size:12px;color:rgba(255,255,255,.4);letter-spacing:2px;text-transform:uppercase;margin-bottom:10px">Squad Progress</div>
        <div style="margin-bottom:10px">${progressBar}</div>
        <div style="font-size:22px;font-weight:900;color:${have === 15 ? '#25C06A' : '#FFB830'}">${have} / 15</div>
        <div style="font-size:12px;color:rgba(255,255,255,.4);margin-top:4px">players selected</div>
      </div>

      <!-- What they're missing -->
      <div style="background:#141B28;border-radius:12px;padding:16px 20px;margin-bottom:24px">
        <div style="font-size:12px;color:rgba(255,255,255,.4);letter-spacing:2px;text-transform:uppercase;margin-bottom:12px">What you're missing out on</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <div style="flex:1;min-width:120px;text-align:center;background:rgba(255,255,255,.04);border-radius:8px;padding:12px 8px">
            <div style="font-size:20px;margin-bottom:4px">⚽</div>
            <div style="font-size:13px;font-weight:700;color:#fff">Goals = 4–6 pts</div>
            <div style="font-size:11px;color:rgba(255,255,255,.4)">per goal scored</div>
          </div>
          <div style="flex:1;min-width:120px;text-align:center;background:rgba(255,255,255,.04);border-radius:8px;padding:12px 8px">
            <div style="font-size:20px;margin-bottom:4px">🎯</div>
            <div style="font-size:13px;font-weight:700;color:#fff">Assists = 3 pts</div>
            <div style="font-size:11px;color:rgba(255,255,255,.4)">per assist</div>
          </div>
          <div style="flex:1;min-width:120px;text-align:center;background:rgba(255,255,255,.04);border-radius:8px;padding:12px 8px">
            <div style="font-size:20px;margin-bottom:4px">🧤</div>
            <div style="font-size:13px;font-weight:700;color:#fff">Clean Sheet = 4 pts</div>
            <div style="font-size:11px;color:rgba(255,255,255,.4)">GK &amp; DEF</div>
          </div>
        </div>
      </div>

      <!-- CTA -->
      <div style="text-align:center;margin:28px 0">
        <a href="${APP_URL}?page=squad"
           style="display:inline-block;background:linear-gradient(135deg,#E8192C,#B91228);color:#fff;text-decoration:none;padding:16px 36px;border-radius:12px;font-size:16px;font-weight:700;letter-spacing:.5px;box-shadow:0 4px 20px rgba(232,25,44,.4)">
          Complete My Squad →
        </a>
        <div style="margin-top:12px;font-size:12px;color:rgba(255,255,255,.3)">
          Tap the button or go to <a href="${APP_URL}" style="color:rgba(255,255,255,.4)">${APP_URL}</a>
        </div>
      </div>

      <!-- Deadline reminder -->
      <div style="background:rgba(232,25,44,.08);border:1px solid rgba(232,25,44,.25);border-radius:10px;padding:14px 18px;text-align:center;margin-bottom:20px">
        <div style="font-size:13px;color:rgba(255,255,255,.7);line-height:1.6">
          ⏰ <strong style="color:#fff">Pick before the gameweek deadline</strong> — squads lock when the first match kicks off
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div style="padding:16px 24px;border-top:1px solid rgba(255,255,255,.06);text-align:center">
      <div style="font-size:11px;color:rgba(255,255,255,.25);line-height:1.8">
        Fantasy PSL · fan-made · not affiliated with the PSL or Betway<br>
        <a href="${APP_URL}" style="color:rgba(255,255,255,.3)">${APP_URL}</a>
      </div>
    </div>
  </div>
</body>
</html>`;

        try {
          if (!RESEND_KEY) {
            skipped++;
            if (!log.includes('RESEND_API_KEY not set')) log.push('RESEND_API_KEY not set — configure it in Vercel env vars');
            continue;
          }

          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from:    'Fantasy PSL <noreply@fantasypsl.co.za>',
              to:      [email],
              subject: subject,
              html:    html
            })
          });

          if (r.ok) {
            nudged++;
            log.push(`✓ Sent to ${email} (${have}/15 players)`);
          } else {
            const errBody = await r.text().catch(() => '');
            errors++;
            log.push(`✗ Failed ${email}: ${errBody.substring(0, 100)}`);
          }
        } catch (e) {
          errors++;
          log.push(`✗ Error ${email}: ${e.message}`);
        }
      }

      return res.json({
        success:      true,
        total_found:  (profiles || []).length,
        nudged,
        skipped,
        errors,
        resend_configured: !!RESEND_KEY,
        log
      });
    }

    // ── STANDARD DB ACTIONS ─────────────────────────────────────────────
    const { table, data, match, notMatch, select = '*' } = body;
    // ── DELETE USER (self-initiated or admin) ───────────────────────────────
    if (action === 'delete_user' || action === 'delete_user_self') {
      const userId = body.user_id;
      if (!userId) return res.status(400).json({ error: 'user_id required' });
      const logs = [];
      try {
        await db.from('profiles').update({
          deleted_at:  new Date().toISOString(),
          squad_data:  null,
          username:    'deleted_' + userId.substring(0,8),
          team_name:   'Deleted Account',
        }).eq('id', userId);
        logs.push('Profile anonymised');
      } catch(e) { logs.push('Profile error: ' + e.message); }
      try {
        await db.from('league_members').delete().eq('user_id', userId);
        logs.push('League memberships removed');
      } catch(e) { logs.push('League remove error: ' + e.message); }
      try {
        const { createClient: cc } = require('@supabase/supabase-js');
        const adminDb = cc(SB_URL, SB_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
        const { error: delErr } = await adminDb.auth.admin.deleteUser(userId);
        if (delErr) throw new Error(delErr.message);
        logs.push('Auth user hard-deleted');
      } catch(e) {
        logs.push('Auth delete error: ' + e.message + ' (profile soft-deleted only)');
        return res.json({ success: true, soft_only: true, logs });
      }
      return res.json({ success: true, hard_deleted: true, logs });
    }

    // ── LIST USERS (admin panel) ─────────────────────────────────────────
    if (action === 'list_users') {
      const limit = parseInt(body.limit || 200);
      const { data: profiles, error: pErr, count } = await db
        .from('profiles')
        .select('id,username,team_name,squad_registered,squad_count,total_points,gw_points,entry_gw,created_at,deleted_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .limit(limit);
      if (pErr) return res.status(500).json({ error: pErr.message });

      // Fetch email + verification status for each user via auth admin
      const emailMap = {};
      try {
        const { createClient: cc } = require('@supabase/supabase-js');
        const adminDb = cc(SB_URL, SB_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
        for (const p of (profiles || [])) {
          try {
            const { data: au } = await adminDb.auth.admin.getUserById(p.id);
            if (au && au.user) emailMap[p.id] = {
              email:          au.user.email,
              email_confirmed: !!au.user.email_confirmed_at,
              last_sign_in:   au.user.last_sign_in_at
            };
          } catch(e) {}
        }
      } catch(e) {}

      const users = (profiles || []).map(p => ({
        ...p, ...(emailMap[p.id] || {}), is_deleted: !!p.deleted_at
      }));
      return res.json({ success: true, users, total: count });
    }

    // ── PURGE SOFT-DELETED USERS 30+ days old ───────────────────────────
    if (action === 'purge_deleted') {
      const cutoff = new Date(Date.now() - 30*24*60*60*1000).toISOString();
      const { data: toDelete } = await db.from('profiles')
        .select('id').not('deleted_at','is',null).lt('deleted_at', cutoff);
      const purged = [], errors = [];
      try {
        const { createClient: cc } = require('@supabase/supabase-js');
        const adminDb = cc(SB_URL, SB_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
        for (const u of (toDelete || [])) {
          try {
            await adminDb.auth.admin.deleteUser(u.id);
            await db.from('profiles').delete().eq('id', u.id);
            purged.push(u.id);
          } catch(e) { errors.push(u.id + ': ' + e.message); }
        }
      } catch(e) { errors.push('Admin client error: ' + e.message); }
      return res.json({ success: true, purged: purged.length, errors });
    }

    if (!table) return res.status(400).json({ error: 'table is required for DB actions' });

    let q;
    switch (action) {
      case 'insert':
        q = db.from(table).insert(data).select();
        break;
      case 'upsert':
        q = db.from(table).upsert(data, { onConflict: body.onConflict || 'id' }).select();
        break;
      case 'update':
        if (!match || !Object.keys(match).length)
          return res.status(400).json({ error: 'update requires match' });
        q = db.from(table).update(data);
        Object.entries(match).forEach(([k, v]) => { q = q.eq(k, v); });
        q = q.select();
        break;
      case 'update_not':
        if (!notMatch || !Object.keys(notMatch).length)
          return res.status(400).json({ error: 'update_not requires notMatch' });
        q = db.from(table).update(data);
        Object.entries(notMatch).forEach(([k, v]) => { q = q.neq(k, v); });
        q = q.select();
        break;
      case 'delete':
        if (!match || !Object.keys(match).length)
          return res.status(400).json({ error: 'delete requires match' });
        q = db.from(table).delete();
        Object.entries(match).forEach(([k, v]) => { q = q.eq(k, v); });
        break;
      case 'select':
        q = db.from(table).select(select);
        if (match) Object.entries(match).forEach(([k, v]) => { q = q.eq(k, v); });
        break;
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    const result = await q;
    if (result.error) {
      console.error('[Admin API Error]', result.error);
      return res.status(500).json({ error: result.error.message, details: result.error.details });
    }
    return res.json({ success: true, data: result.data });

  } catch (err) {
    console.error('[Admin API Fatal]', err);
    return res.status(500).json({ error: err.message });
  }
};
