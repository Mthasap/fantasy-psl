// api/admin-api.js — Fantasy PSL — Admin Operations API
// ══════════════════════════════════════════════════════════════════════════
//
// HOW USER DELETION WORKS:
//   Supabase auth.users is a privileged table — the frontend JS SDK can
//   NEVER delete from it, even if the user is authenticated. Only the
//   service-role key (server-side) can call auth.admin.deleteUser().
//
//   This endpoint is the bridge: the frontend calls here, we verify the
//   admin key (or the user's own JWT), then delete from both auth.users
//   and the profiles table using the service key.
//
//   For SELF-DELETION: user passes their JWT, we verify it, then delete
//   their own account. No admin key needed — any logged-in user can delete
//   their own account via DELETE /api/admin-api?action=delete-self.
//
//   For ADMIN DELETION: admin passes admin_key, can delete any user by ID.
//
// ENDPOINTS:
//   DELETE /api/admin-api?action=delete-self          + Authorization: Bearer <jwt>
//   DELETE /api/admin-api?action=delete-user&user_id=XXX + admin_key=XXX
//   GET    /api/admin-api?action=list-users&admin_key=XXX
//   GET    /api/admin-api?action=user-detail&user_id=XXX&admin_key=XXX
//
// ══════════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL          || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY   || '';
const ADMIN  = process.env.ADMIN_SECRET;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: 'Server misconfiguration: Supabase env vars missing' });
  }

  const db     = createClient(SB_URL, SB_KEY);
  const q      = req.query || {};
  const action = q.action || '';

  // ── SELF DELETION — user deletes their own account ──────────────────────
  // Requires valid JWT in Authorization header (no admin key needed)
  if (action === 'delete-self') {
    const token = (req.headers.authorization || '').split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Missing auth token' });

    let user;
    try {
      const { data, error } = await db.auth.getUser(token);
      if (error || !data.user) return res.status(401).json({ error: 'Invalid or expired session' });
      user = data.user;
    } catch(e) {
      return res.status(401).json({ error: 'Auth check failed: ' + e.message });
    }

    return await deleteUserById(db, user.id, res, 'Self-deletion');
  }

  // ── ADMIN OPERATIONS — require admin_key ─────────────────────────────────
  const adminKey = q.admin_key || (req.headers && req.headers['x-admin-key']) || '';
  if (!ADMIN || adminKey !== ADMIN) {
    return res.status(401).json({ error: 'Unauthorized: invalid admin key' });
  }

  // ── DELETE USER (admin) ──────────────────────────────────────────────────
  if (action === 'delete-user') {
    const userId = q.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id required' });
    return await deleteUserById(db, userId, res, 'Admin deletion');
  }

  // ── LIST USERS (admin) ───────────────────────────────────────────────────
  if (action === 'list-users') {
    try {
      const page  = parseInt(q.page || '1', 10);
      const limit = Math.min(parseInt(q.limit || '50', 10), 100);

      // Get profiles with points and squad info
      const { data: profiles, error: profErr } = await db
        .from('profiles')
        .select('id, username, team_name, email, total_points, gw_points, squad_registered, squad_count, entry_gw, created_at')
        .order('total_points', { ascending: false })
        .range((page - 1) * limit, page * limit - 1);

      if (profErr) throw new Error(profErr.message);

      // For each profile, get auth user info (email confirmation status)
      // We batch this via the admin API
      const enriched = await Promise.all((profiles || []).map(async function(p) {
        try {
          const { data: authUser } = await db.auth.admin.getUserById(p.id);
          return {
            ...p,
            email:             authUser && authUser.user ? authUser.user.email : (p.email || ''),
            email_confirmed:   authUser && authUser.user ? !!authUser.user.email_confirmed_at : null,
            last_sign_in:      authUser && authUser.user ? authUser.user.last_sign_in_at : null,
            auth_created_at:   authUser && authUser.user ? authUser.user.created_at : null,
          };
        } catch(_) { return p; }
      }));

      return res.json({ success: true, users: enriched, page, limit });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── USER DETAIL (admin) ──────────────────────────────────────────────────
  if (action === 'user-detail') {
    const userId = q.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id required' });

    try {
      const [profileRes, authRes] = await Promise.all([
        db.from('profiles').select('*').eq('id', userId).single(),
        db.auth.admin.getUserById(userId),
      ]);

      return res.json({
        success:  true,
        profile:  profileRes.data || null,
        auth:     authRes.data && authRes.data.user || null,
        profile_error: profileRes.error ? profileRes.error.message : null,
        auth_error:    authRes.error    ? authRes.error.message    : null,
      });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── BAN USER (admin) — keeps auth account but clears their squad + points ─
  if (action === 'ban-user') {
    const userId = q.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id required' });

    try {
      // Update auth user to disable them
      await db.auth.admin.updateUserById(userId, { ban_duration: 'none' });

      // Clear their squad and points
      await db.from('profiles').update({
        is_banned:       true,
        squad_data:      null,
        squad_count:     0,
        squad_registered: false,
        total_points:    0,
        gw_points:       0,
        updated_at:      new Date().toISOString()
      }).eq('id', userId);

      return res.json({ success: true, message: 'User banned and data cleared' });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }


  // ── CRUD OPERATIONS ─────────────────────────────────────────────────────
  // Actions: insert | update | update_not | delete | upsert | select
  // Used by admin panel for articles, gameweeks, fixtures, players, etc.
  const body      = req.body || {};
  const table     = body.table || q.table || '';
  const data      = body.data  || null;
  const match     = body.match || null;
  const notMatch  = body.notMatch   || null;
  const onConflict= body.onConflict || null;

  const ALLOWED_TABLES = new Set([
    'news_posts','gameweeks','fixtures','players','profiles',
    'announcements','api_cache','standings','match_player_stats',
    'leagues','league_members','gw_scores'
  ]);

  if (!table) return res.status(400).json({ error: 'table required' });
  if (!ALLOWED_TABLES.has(table)) return res.status(403).json({ error: 'Table not permitted: ' + table });

  function applyEq(query, obj) {
    if (!obj || typeof obj !== 'object') return query;
    Object.entries(obj).forEach(function([c,v]){ query = query.eq(c,v); });
    return query;
  }
  function applyNeq(query, obj) {
    if (!obj || typeof obj !== 'object') return query;
    Object.entries(obj).forEach(function([c,v]){ query = query.neq(c,v); });
    return query;
  }

  try {
    if (action === 'select') {
      let q2 = db.from(table).select(body.select || '*');
      q2 = applyEq(q2, match);
      if (body.limit) q2 = q2.limit(parseInt(body.limit));
      const { data: rows, error: e } = await q2;
      if (e) throw new Error(e.message);
      return res.json({ success: true, data: rows });
    }

    if (action === 'insert') {
      if (!data) return res.status(400).json({ error: 'data required' });
      const { data: ins, error: e } = await db.from(table).insert(data).select();
      if (e) throw new Error(e.message);
      return res.json({ success: true, data: ins });
    }

    if (action === 'update') {
      if (!data) return res.status(400).json({ error: 'data required' });
      const hasFilter = (match && Object.keys(match).length) || (notMatch && Object.keys(notMatch).length);
      if (!hasFilter) return res.status(400).json({ error: 'update requires match or notMatch' });
      let q2 = db.from(table).update(data);
      q2 = applyEq(q2, match);
      q2 = applyNeq(q2, notMatch);
      const { error: e } = await q2;
      if (e) throw new Error(e.message);
      return res.json({ success: true });
    }

    if (action === 'update_not') {
      if (!data) return res.status(400).json({ error: 'data required' });
      let q2 = db.from(table).update(data);
      q2 = applyNeq(q2, notMatch);
      q2 = applyEq(q2, match);
      const { error: e } = await q2;
      if (e) throw new Error(e.message);
      return res.json({ success: true });
    }

    if (action === 'delete') {
      if (!match || !Object.keys(match).length) return res.status(400).json({ error: 'delete requires match' });
      let q2 = db.from(table).delete();
      q2 = applyEq(q2, match);
      const { error: e } = await q2;
      if (e) throw new Error(e.message);
      return res.json({ success: true });
    }

    if (action === 'upsert') {
      if (!data) return res.status(400).json({ error: 'data required' });
      const opts = onConflict ? { onConflict } : {};
      const { data: ups, error: e } = await db.from(table).upsert(data, opts).select();
      if (e) throw new Error(e.message);
      return res.json({ success: true, data: ups });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('[admin-api] CRUD error:', action, table, err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Shared deletion logic ─────────────────────────────────────────────────
async function deleteUserById(db, userId, res, source) {
  const log = [source + ': deleting user ' + userId];

  try {
    // 1. Delete from league_members
    try {
      await db.from('league_members').delete().eq('user_id', userId);
      log.push('✅ Removed from league_members');
    } catch(e) { log.push('⚠ league_members: ' + e.message); }

    // 2. Delete from gw_scores
    try {
      await db.from('gw_scores').delete().eq('user_id', userId);
      log.push('✅ Removed from gw_scores');
    } catch(e) { log.push('⚠ gw_scores: ' + e.message); }

    // 3. Delete profile (cascades to related data)
    try {
      await db.from('profiles').delete().eq('id', userId);
      log.push('✅ Profile deleted');
    } catch(e) { log.push('⚠ profiles: ' + e.message); }

    // 4. Delete from Supabase auth.users — THIS is the key step that was missing
    //    Only the service-role key can do this via auth.admin.deleteUser()
    const { error: authErr } = await db.auth.admin.deleteUser(userId);
    if (authErr) {
      log.push('❌ auth.admin.deleteUser failed: ' + authErr.message);
      return res.status(500).json({
        success: false,
        error:   'Failed to delete from auth.users: ' + authErr.message,
        note:    'Profile and related data were deleted. Go to Supabase Dashboard → Authentication → Users to manually delete auth record if needed.',
        log
      });
    }

    log.push('✅ Deleted from auth.users');
    return res.json({ success: true, user_id: userId, log });

  } catch(err) {
    log.push('FATAL: ' + err.message);
    return res.status(500).json({ success: false, error: err.message, log });
  }
}
