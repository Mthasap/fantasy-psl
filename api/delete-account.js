// api/delete-account.js — Fantasy PSL — Account & data deletion
// ─────────────────────────────────────────────────────────────────────────
// Google Play requires apps with account creation to let users delete their
// account and associated data. This endpoint:
//   1. Verifies the caller's JWT (they can only delete THEIR OWN account).
//   2. Clears the two foreign keys that don't auto-cascade (leagues they
//      created, POTM rows they set).
//   3. Deletes the auth user — every other table (profiles, squads,
//      diski_posts, diski_reactions, diski_reports, gw_scores, potm_votes,
//      league_members) is removed automatically by ON DELETE CASCADE.
// ─────────────────────────────────────────────────────────────────────────

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY; // service key = can delete auth users

module.exports = async (req, res) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.fantasypsl.co.za';
  const origin = req.headers.origin || '';
  const isAllowed = origin === ALLOWED_ORIGIN || origin === 'https://fantasypsl.co.za'
    || (process.env.NODE_ENV !== 'production');
  res.setHeader('Access-Control-Allow-Origin', isAllowed ? origin : ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  if (!SB_URL || !SB_KEY) {
    console.error('[delete-account] FATAL: Supabase env vars missing');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  // ── 1. Verify JWT — the user may only delete their own account ──────────
  const token = (req.headers.authorization || '').split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const db = createClient(SB_URL, SB_KEY);

  let user;
  try {
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) {
      return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
    }
    user = data.user;
  } catch (e) {
    console.error('[delete-account] Auth check threw:', e.message);
    return res.status(401).json({ error: 'Auth check failed' });
  }

  const uid = user.id;

  try {
    // ── 2. Clear non-cascading references so the auth delete can't be blocked ──
    // Leagues this user created (deleting the league cascades its members).
    const { error: lErr } = await db.from('leagues').delete().eq('created_by', uid);
    if (lErr) console.warn('[delete-account] league cleanup:', lErr.message);

    // POTM rows this user set (admin-only in practice; null it out defensively).
    try { await db.from('official_potm').update({ set_by: null }).eq('set_by', uid); } catch (_) {}

    // ── 3. Delete the auth user — CASCADE removes everything else ───────────
    const { error: dErr } = await db.auth.admin.deleteUser(uid);
    if (dErr) {
      console.error('[delete-account] deleteUser failed for', uid, ':', dErr.message);
      return res.status(500).json({ error: 'Could not delete account: ' + dErr.message });
    }

    console.log('[delete-account] ✅ Deleted account + data for', uid);
    return res.json({
      success: true,
      message: 'Your account and all associated data have been permanently deleted.',
    });
  } catch (err) {
    console.error('[delete-account] FATAL for', uid, ':', err.message);
    return res.status(500).json({ error: err.message });
  }
};
