// api/save-squad.js — Fantasy PSL — Secure Squad Save
// ─────────────────────────────────────────────────────────────────────────
// Validates JWT, checks deadline server-side, enforces 15-player rule,
// then upserts to profiles table using service key (bypasses RLS safely).
// ─────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  // 1. Verify JWT token from Authorization header
  const token = (req.headers.authorization || '').split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const db = createClient(SB_URL, SB_KEY);
  const { data: { user }, error: authErr } = await db.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  try {
    // 2. Check GW deadline server-side (cannot be bypassed from client)
    const { data: gw } = await db
      .from('gameweeks')
      .select('deadline_at, is_current, gw_number')
      .eq('is_current', true)
      .eq('season', 2025)
      .limit(1)
      .single();

    if (gw && gw.deadline_at) {
      if (new Date() >= new Date(gw.deadline_at)) {
        return res.status(403).json({ error: 'Gameweek deadline has passed. Squad is locked.' });
      }
    }

    const payload = req.body || {};

    // 3. Validate squad structure
    const squadData = payload.squad_data;
    let squadArr = [];
    if (typeof squadData === 'string') {
      try { squadArr = JSON.parse(squadData); } catch(e) { squadArr = []; }
    } else if (Array.isArray(squadData)) {
      squadArr = squadData;
    } else if (squadData && squadData.players) {
      squadArr = squadData.players;
    }

    const validPlayers = squadArr.filter(p => p && (p.id || p.psl_roster_id));

    // Only enforce 15-player rule when registering a full squad
    if (payload.squad_registered === true && validPlayers.length !== 15) {
      return res.status(400).json({
        error: `Incomplete squad. You need 15 players but have ${validPlayers.length}.`
      });
    }

    // 4. Enforce user can only save their own profile (always force own ID)
    const updateData = {
      id:                user.id,
      squad_data:        typeof squadData === 'string' ? squadData : JSON.stringify(squadArr),
      squad_count:       validPlayers.length,
      squad_registered:  validPlayers.length === 15,
      free_transfers:    payload.free_transfers    ?? 1,
      transfers_this_gw: payload.transfers_this_gw ?? 0,
      active_chip:       payload.active_chip       ?? null,
      updated_at:        new Date().toISOString(),
    };

    // First registration: lock in entry GW and timestamps
    if (payload.entry_gw) {
      updateData.entry_gw            = payload.entry_gw;
      updateData.squad_registered_at = payload.squad_registered_at || new Date().toISOString();
      // Only zero out points on first-ever registration
      if (!payload._skipPointsReset) {
        updateData.total_points = 0;
        updateData.gw_points    = 0;
      }
    }

    // 5. Check if profile already exists (to avoid wiping existing points data)
    const { data: existingProfile } = await db
      .from('profiles')
      .select('total_points, gw_points, entry_gw, squad_registered_at')
      .eq('id', user.id)
      .single();

    // SAFETY: Never overwrite existing points if they're already recorded
    if (existingProfile && existingProfile.total_points > 0 && !payload.entry_gw) {
      delete updateData.total_points;
      delete updateData.gw_points;
    }

    // If already registered once, don't overwrite entry_gw or squad_registered_at
    if (existingProfile && existingProfile.entry_gw) {
      delete updateData.entry_gw;
      delete updateData.squad_registered_at;
    }

    // 6. Upsert to profiles (service key bypasses RLS)
    const { error: upsertErr } = await db
      .from('profiles')
      .upsert(updateData, { onConflict: 'id' });

    if (upsertErr) {
      console.error('[save-squad] upsert error:', upsertErr.message);
      return res.status(500).json({ error: upsertErr.message });
    }

    return res.json({
      success:     true,
      squad_count: validPlayers.length,
      registered:  validPlayers.length === 15,
    });

  } catch (err) {
    console.error('[save-squad] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
