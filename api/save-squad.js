// api/save-squad.js — Fantasy PSL — Secure Squad Save v2
// ─────────────────────────────────────────────────────────────────────────
// Validates JWT, checks deadline server-side, then upserts to profiles.
// v2: full Vercel-visible error logging on every failure path so we can
//     diagnose squad-revert issues from the log panel.
// ─────────────────────────────────────────────────────────────────────────

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Simple in-memory rate limiter ─────────────────────────────────────────
const _rl = new Map();
function rateLimit(ip, max, windowMs) {
  const now = Date.now();
  const rec = _rl.get(ip) || { count: 0, reset: now + windowMs };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + windowMs; }
  rec.count++;
  _rl.set(ip, rec);
  return rec.count > max;
}

module.exports = async (req, res) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.fantasypsl.co.za';
  const origin = req.headers.origin || '';
  const isAllowed = origin === ALLOWED_ORIGIN || origin === 'https://fantasypsl.co.za'
    || (process.env.NODE_ENV !== 'production');
  res.setHeader('Access-Control-Allow-Origin', isAllowed ? origin : ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  // ── Rate limit: 20 saves/min per IP ──────────────────────────────────────
  const clientIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (rateLimit(clientIp, 20, 60_000)) {
    return res.status(429).json({ error: 'Too many requests — please wait a moment' });
  }

  // ── Guard: env vars must be set ──────────────────────────────────────────
  if (!SB_URL || !SB_KEY) {
    console.error('[save-squad] FATAL: SUPABASE_URL or SUPABASE_SERVICE_KEY not set');
    return res.status(500).json({ error: 'Server misconfiguration — env vars missing' });
  }

  // ── 1. Verify JWT ────────────────────────────────────────────────────────
  const token = (req.headers.authorization || '').split('Bearer ')[1];
  if (!token) {
    console.warn('[save-squad] 401: Missing auth token');
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const db = createClient(SB_URL, SB_KEY);

  let user;
  try {
    const { data: authData, error: authErr } = await db.auth.getUser(token);
    if (authErr || !authData.user) {
      console.warn('[save-squad] 401: Invalid token —', authErr ? authErr.message : 'no user returned');
      return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
    }
    user = authData.user;
  } catch (e) {
    console.error('[save-squad] Auth check threw:', e.message);
    return res.status(401).json({ error: 'Auth check failed: ' + e.message });
  }

  try {
    // ── 2. Check GW deadline (skip if no current GW — never block save) ────
    try {
      const { data: gw } = await db
        .from('gameweeks')
        .select('deadline, deadline_at, gw_number')
        .eq('is_current', true)
        .limit(1)
        .single();
      if (gw) {
        // Normalise: actual column is 'deadline', handle both variants
        const deadlineVal = gw.deadline_at || gw.deadline || null;
        if (deadlineVal && new Date() >= new Date(deadlineVal)) {
          console.warn('[save-squad] 403: Deadline passed for GW', gw.gw_number, 'user:', user.id);
          return res.status(403).json({ error: 'Gameweek deadline has passed. Squad is locked.' });
        }
      }
    } catch (gwErr) {
      // No current gameweek found — allow save to proceed
      console.warn('[save-squad] GW lookup skipped:', gwErr.message);
    }

    const payload = req.body || {};

    // ── 3. Parse squad_data ──────────────────────────────────────────────
    const squadRaw = payload.squad_data;
    let squadArr = [];
    if (typeof squadRaw === 'string') {
      try { squadArr = JSON.parse(squadRaw); } catch(e) {
        console.error('[save-squad] squad_data JSON parse failed for user', user.id, ':', e.message);
        squadArr = [];
      }
    } else if (Array.isArray(squadRaw)) {
      squadArr = squadRaw;
    } else if (squadRaw && Array.isArray(squadRaw.players)) {
      squadArr = squadRaw.players;
    }

    // ── 4. Count valid players ──────────────────────────────────────────
    const validPlayers = (squadArr || []).filter(p => {
      if (!p || typeof p !== 'object') return false;
      const hasNumId    = typeof p.id === 'number' && p.id > 0 && !isNaN(p.id);
      const hasStrId    = typeof p.id === 'string' && p.id.length > 0;
      const hasRosterId = !!(p.psl_roster_id);
      const hasNamePos  = !!(p.name && p.position);
      return hasNumId || hasStrId || hasRosterId || hasNamePos;
    });

    const count        = validPlayers.length;
    const isRegistered = count >= 15;

    console.log(`[save-squad] user=${user.id} rawLen=${(squadArr||[]).length} validCount=${count} isRegistered=${isRegistered}`);

    // ── 5. Normalise squad_data for storage ─────────────────────────────
    const squadJson = typeof squadRaw === 'string'
      ? squadRaw
      : JSON.stringify(squadArr);

    // ── 5b. INTEGRITY GUARD ──────────────────────────────────────────────
    // Root cause of the "registered but empty squad" ghost rows: earlier code
    // could set squad_registered=true / squad_count=15 while squad_data ended
    // up null or "[]". That left users flagged as having a team with no picks
    // stored — so scoring found nothing to score. Never again: if the payload
    // does not actually contain a full valid squad, refuse to mark registered.
    const squadJsonIsEmpty =
      !squadJson || squadJson === 'null' || squadJson === '[]' || squadJson.trim() === '';

    if (isRegistered && squadJsonIsEmpty) {
      console.error('[save-squad] REFUSED registration for user', user.id,
        '— squad_data empty despite count', count, '| rawType:', typeof squadRaw);
      return res.status(400).json({
        error: 'Squad data did not arrive on the server. Your picks were NOT saved. ' +
               'Please rebuild your squad and save again.',
        code:  'EMPTY_SQUAD_DATA',
      });
    }

    // ── 6. Resolve entry_gw (never leave it null on first registration) ──
    let resolvedEntryGW = payload.entry_gw ? parseInt(payload.entry_gw, 10) : null;
    if (isNaN(resolvedEntryGW)) resolvedEntryGW = null;

    // ── 7. Load existing profile ─────────────────────────────────────────
    let existingProfile = null;
    try {
      const { data } = await db
        .from('profiles')
        .select('total_points, gw_points, entry_gw, squad_registered_at, squad_registered')
        .eq('id', user.id)
        .single();
      existingProfile = data;
    } catch(e) {
      console.log('[save-squad] No existing profile for user', user.id, '(new user)');
    }

    // ── 8. Auto-resolve entry_gw from DB when client didn't send it ──────
    if (isRegistered && !resolvedEntryGW && !(existingProfile && existingProfile.entry_gw)) {
      try {
        const { data: gwRow } = await db
          .from('gameweeks')
          .select('gw_number, number')
          .eq('is_current', true)
          .limit(1)
          .maybeSingle();
        if (gwRow) resolvedEntryGW = gwRow.gw_number || gwRow.number || null;
      } catch (e) { /* continue */ }

      // Last-resort fallback
      if (!resolvedEntryGW) {
        try {
          const { data: latestGW } = await db
            .from('gameweeks')
            .select('gw_number, number')
            .order('gw_number', { ascending: false })
            .limit(1)
            .maybeSingle();
          resolvedEntryGW = latestGW ? (latestGW.gw_number || latestGW.number || 1) : 1;
        } catch (e) { resolvedEntryGW = 1; }
      }
      console.log(`[save-squad] Resolved entry_gw=${resolvedEntryGW} from DB for user=${user.id}`);
    }

    // ── 9. Build update payload ──────────────────────────────────────────
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

    // Stamp entry_gw once on first full-squad registration
    if (isRegistered && resolvedEntryGW && !(existingProfile && existingProfile.entry_gw)) {
      updateData.entry_gw            = resolvedEntryGW;
      updateData.squad_registered_at = new Date().toISOString();
      updateData.total_points        = 0;
      updateData.gw_points           = 0;
      console.log(`[save-squad] First registration: user=${user.id} entry_gw=${resolvedEntryGW}`);
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

    // ── 10. Upsert (service key bypasses RLS) ───────────────────────────
    const { error: upsertErr } = await db
      .from('profiles')
      .upsert(updateData, { onConflict: 'id' });

    if (upsertErr) {
      // Log the FULL error object so it's visible in Vercel logs
      console.error('[save-squad] UPSERT ERROR for user', user.id, ':',
        upsertErr.message, '| code:', upsertErr.code, '| hint:', upsertErr.hint,
        '| details:', upsertErr.details);
      return res.status(500).json({
        error: upsertErr.message,
        code:  upsertErr.code,
        hint:  upsertErr.hint
      });
    }

    console.log(`[save-squad] ✅ Saved user=${user.id} count=${count} registered=${isRegistered} entry_gw=${updateData.entry_gw || existingProfile?.entry_gw || 'existing'}`);

    return res.json({
      success:     true,
      squad_count: count,
      registered:  isRegistered,
      entry_gw:    updateData.entry_gw || (existingProfile && existingProfile.entry_gw) || null,
    });

  } catch (err) {
    console.error('[save-squad] FATAL for user', user ? user.id : 'unknown', ':', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
};
