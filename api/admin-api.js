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
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data: profiles, error: profileErr } = await db
        .from('profiles')
        .select('id, username, team_name, squad_count, created_at')
        .eq('squad_registered', false)
        .lt('created_at', oneHourAgo)
        .limit(200);

      if (profileErr) return res.status(500).json({ error: profileErr.message });

      let nudged = 0, skipped = 0, errors = 0;
      const log = [];

      for (const profile of (profiles || [])) {
        if (!profile.squad_count || profile.squad_count === 0) { skipped++; continue; }

        const have = profile.squad_count || 0;
        const need = 15 - have;
        const subject = `⚽ Your Fantasy PSL squad is ${have}/15 — ${need} players missing`;
        const html = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0C0F14;color:#fff;border-radius:12px;overflow:hidden">
          <div style="background:linear-gradient(135deg,#E8192C,#8B1228);padding:1.5rem;text-align:center">
            <div style="font-size:1.3rem;font-weight:900">Fantasy PSL</div>
            <div style="font-size:.72rem;opacity:.6;letter-spacing:2px;text-transform:uppercase">Betway Premiership 2025/26</div>
          </div>
          <div style="padding:1.5rem">
            <p style="font-size:1.05rem;font-weight:700;margin-top:0">Hi ${profile.username || 'Coach'},</p>
            <p style="color:rgba(255,255,255,.7);line-height:1.6">
              You've picked <strong style="color:#FFB830">${have}/15 players</strong>. 
              Add ${need} more before the deadline to earn points this gameweek!
            </p>
            <div style="text-align:center;margin:1.5rem 0">
              <a href="${APP_URL}?page=squad" style="background:#E8192C;color:#fff;text-decoration:none;padding:.85rem 2rem;border-radius:10px;font-weight:700;display:inline-block">
                Complete My Squad →
              </a>
            </div>
            <p style="font-size:.72rem;color:rgba(255,255,255,.3)">Fantasy PSL · fan-made · not affiliated with the PSL or Betway</p>
          </div>
        </div>`;

        try {
          if (RESEND_KEY) {
            const r = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: 'Fantasy PSL <noreply@fantasypsl.co.za>', to: [profile.id], subject, html })
            });
            if (r.ok) nudged++; else { errors++; log.push(`Resend error for ${profile.id}`); }
          } else {
            skipped++;
            log.push('RESEND_API_KEY not set — configure it to enable email nudges');
          }
        } catch (e) { errors++; log.push(`Error ${profile.id}: ${e.message}`); }
      }

      return res.json({ success: true, nudged, skipped, errors, log });
    }

    // ── STANDARD DB ACTIONS ─────────────────────────────────────────────
    const { table, data, match, notMatch, select = '*' } = body;
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
