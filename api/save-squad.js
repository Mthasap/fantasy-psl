// api/save-squad.js — Fantasy PSL — Secure Squad Save
// ─────────────────────────────────────────────────────────────────────────
// Validates JWT, checks deadline server-side, then upserts to profiles.
// ─────────────────────────────────────────────────────────────────────────

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  // 1. Verify JWT
  const token = (req.headers.authorization || '').split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const db = createClient(SB_URL, SB_KEY);
  const { data: { user }, error: authErr } = await db.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  try {
    // 2. Check GW deadline (skip if no current GW configured — never block save)
    try {
      const { data: gw } = await db
        .from('gameweeks')
        .select('deadline_at')
        .eq('is_current', true)
        .limit(1)
        .single();
      if (gw && gw.deadline_at && new Date() >= new Date(gw.deadline_at)) {
        return res.status(403).json({ error: 'Gameweek deadline has passed. Squad is locked.' });
      }
    } catch (gwErr) {
      // No current gameweek found — allow save to proceed
      console.warn('[save-squad] GW lookup skipped:', gwErr.message);
    }

    const payload = req.body || {};

    // 3. Parse squad_data — handle string, array, or object with players key
    const squadRaw = payload.squad_data;
    let squadArr = [];
    if (typeof squadRaw === 'string') {
      try { squadArr = JSON.parse(squadRaw); } catch(e) { squadArr = []; }
    } else if (Array.isArray(squadRaw)) {
      squadArr = squadRaw;
    } else if (squadRaw && Array.isArray(squadRaw.players)) {
      squadArr = squadRaw.players;
    }

    // 4. Count valid players with the most permissive possible check.
    //    A player is valid if it is a non-null object with ANY identifying field.
    //    This prevents NaN ids or missing psl_roster_id from dropping the count.
    const validPlayers = (squadArr || []).filter(p => {
      if (!p || typeof p !== 'object') return false;
      // Accept any of: numeric id > 0, string id (UUID), psl_roster_id, or name+position
      const hasNumId    = typeof p.id === 'number' && p.id > 0 && !isNaN(p.id);
      const hasStrId    = typeof p.id === 'string' && p.id.length > 0;
      const hasRosterId = !!(p.psl_roster_id);
      const hasNamePos  = !!(p.name && p.position);
      return hasNumId || hasStrId || hasRosterId || hasNamePos;
    });

    const count        = validPlayers.length;
    const isRegistered = count >= 15;

    // 5. Compute squad_data string to store — always store raw, never reject it
    const squadJson = typeof squadRaw === 'string'
      ? squadRaw
      : JSON.stringify(squadArr);

    // 6. Build update payload — user.id is always authoritative (cannot be spoofed)
    const updateData = {
      id:                user.id,
      squad_data:        squadJson,
      squad_count:       count,
      squad_registered:  isRegistered,
      free_transfers:    payload.free_transfers    ?? 1,
      transfers_this_gw: payload.transfers_this_gw ?? 0,
      active_chip:       payload.active_chip       ?? null,
      updated_at:        new Date().toISOString(),
    };

    // 7. Check existing profile — protect points from being overwritten
    let existingProfile = null;
    try {
      const { data } = await db
        .from('profiles')
        .select('total_points, gw_points, entry_gw, squad_registered_at, squad_registered')
        .eq('id', user.id)
        .single();
      existingProfile = data;
    } catch(e) { /* new user — no existing profile */ }

    // Lock in entry GW on first full-squad registration only
    if (isRegistered && payload.entry_gw && !(existingProfile && existingProfile.entry_gw)) {
      updateData.entry_gw           = payload.entry_gw;
      updateData.squad_registered_at = new Date().toISOString();
      updateData.total_points        = 0;
      updateData.gw_points           = 0;
    }

    // Never overwrite earned points
    if (existingProfile && (existingProfile.total_points > 0)) {
      delete updateData.total_points;
      delete updateData.gw_points;
    }
    if (existingProfile && existingProfile.entry_gw) {
      delete updateData.entry_gw;
      delete updateData.squad_registered_at;
    }

    // 8. Upsert — service key bypasses RLS
    const { error: upsertErr } = await db
      .from('profiles')
      .upsert(updateData, { onConflict: 'id' });

    if (upsertErr) {
      console.error('[save-squad] upsert error:', upsertErr.message);
      return res.status(500).json({ error: upsertErr.message });
    }

    console.log(`[save-squad] Saved user=${user.id} count=${count} registered=${isRegistered}`);

    return res.json({
      success:     true,
      squad_count: count,
      registered:  isRegistered,
    });

  } catch (err) {
    console.error('[save-squad] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
