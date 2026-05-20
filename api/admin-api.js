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
      await db.auth.admin.updateUserById(userId, { ban_duration: '876000h' }); // ~100 years = permanent ban

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

    // ── SQUAD IMPORT (migrated from squad-import.js) ──────────────────────
    if (action === 'squad-import') {
      return await handleSquadImport(db, q, res);
    }

    // ── LINK PLAYER IDS (migrated from link-player-ids.js) ────────────────
    if (action === 'link-player-ids') {
      return await handleLinkPlayerIds(db, q, res);
    }

    // ── PLAYER CRAWLER (migrated from player-crawler.js) ──────────────────
    if (action === 'player-crawler') {
      return await handlePlayerCrawler(db, q, res);
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

// ══════════════════════════════════════════════════════════════════════════
// SQUAD IMPORT HANDLER (migrated from squad-import.js)
// GET /api/admin-api?action=squad-import&admin_key=XXX[&club=NAME]
// ══════════════════════════════════════════════════════════════════════════

const SQUAD_IMPORT_TEAM_MAP = {
  'Orlando Pirates':'Orlando Pirates','Mamelodi Sundowns':'Mamelodi Sundowns',
  'Golden Arrows':'Golden Arrows','Sekhukhune United':'Sekhukhune United',
  'AmaZulu':'AmaZulu FC','AmaZulu FC':'AmaZulu FC','Kaizer Chiefs':'Kaizer Chiefs',
  'Stellenbosch':'Stellenbosch FC','Stellenbosch FC':'Stellenbosch FC',
  'TS Galaxy':'TS Galaxy','Richards Bay':'Richards Bay','Polokwane City':'Polokwane City',
  'Chippa United':'Chippa United','Marumo Gallants':'Marumo Gallants FC',
  'Marumo Gallants FC':'Marumo Gallants FC','Magesi':'Magesi FC','Magesi FC':'Magesi FC',
  'Siwelele':'Siwelele FC','Siwelele FC':'Siwelele FC','Cape Town City':'Cape Town City',
  'Durban City':'Durban City','Orbit College':'Orbit College FC','Orbit College FC':'Orbit College FC',
};

async function handleSquadImport(db, q, res) {
  const TOKEN      = process.env.APIFOOTBALL_KEY || '';
  const PSL_LEAGUE = 288;
  const PSL_SEASON = parseInt(process.env.APIFOOTBALL_SEASON || '2025', 10);
  const filterClub = q.club || null;
  const log        = [];

  if (!TOKEN) return res.status(500).json({ error: 'APIFOOTBALL_KEY not set' });

  function normPos(raw) {
    if (!raw) return 'MID';
    const r = raw.toUpperCase();
    if (r.includes('GOAL')||r==='G'||r==='GK') return 'GK';
    if (r.includes('DEFEND')||r==='D'||r==='DEF') return 'DEF';
    if (r.includes('FORWARD')||r.includes('ATTACK')||r==='F'||r==='FWD') return 'FWD';
    return 'MID';
  }
  function normName(s) {
    return (s||'').toLowerCase().replace(/[àáâãäå]/g,'a').replace(/[èéêë]/g,'e')
      .replace(/[ìíîï]/g,'i').replace(/[òóôõö]/g,'o').replace(/[ùúûü]/g,'u')
      .replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim();
  }

  async function apiFetchLocal(endpoint) {
    const url = `https://v3.football.api-sports.io${endpoint}`;
    const r = await fetch(url, { headers: { 'x-rapidapi-key': TOKEN, 'x-rapidapi-host': 'v3.football.api-sports.io' } });
    if (!r.ok) throw new Error(`API-Football ${r.status}`);
    const d = await r.json();
    if (d.errors && Object.keys(d.errors).length && !JSON.stringify(d.errors).includes('{}'))
      throw new Error('API error: ' + JSON.stringify(d.errors));
    return d;
  }

  try {
    const { data: existingPlayers } = await db.from('players')
      .select('id, display_name, team, position, psl_roster_id');
    const existingByNorm = {};
    const existingIds = [];
    for (const p of (existingPlayers||[])) {
      existingByNorm[normName(p.display_name)] = p;
      if (p.psl_roster_id) existingIds.push(p.psl_roster_id);
    }

    const teamsRes = await apiFetchLocal(`/teams?league=${PSL_LEAGUE}&season=${PSL_SEASON}`);
    const teams    = teamsRes.response || [];
    log.push(`Teams: ${teams.length}`);

    const allFetched = [];
    for (const te of teams) {
      const team = te.team || {};
      const teamName = SQUAD_IMPORT_TEAM_MAP[team.name] || team.name || 'Unknown';
      if (filterClub && !teamName.toLowerCase().includes(filterClub.toLowerCase())) continue;
      try {
        const sr = await apiFetchLocal(`/players/squads?team=${team.id}`);
        const squad = (sr.response||[])[0];
        const players = squad ? (squad.players||[]) : [];
        for (const p of players) {
          allFetched.push({
            api_player_id: String(p.id), display_name: p.name||'Unknown',
            team: teamName, position: normPos(p.position||''),
            photo: p.photo||null, name_normalised: normName(p.name||'')
          });
        }
        await new Promise(r=>setTimeout(r,150));
      } catch(e) { log.push(`Error ${teamName}: ${e.message}`); }
    }

    const seen = new Set(); const known = []; const newPlayers = [];
    let sid = Math.max(20000,...existingIds)+1;
    for (const p of allFetched) {
      if (seen.has(p.api_player_id)) continue;
      seen.add(p.api_player_id);
      const ex = existingByNorm[p.name_normalised];
      if (ex) known.push({...p,status:'known',db_id:ex.id,psl_roster_id:ex.psl_roster_id});
      else newPlayers.push({...p,status:'new',suggested_psl_id:sid++});
    }

    log.push(`Known: ${known.length} | New: ${newPlayers.length}`);
    return res.json({ success:true, known_count:known.length, new_count:newPlayers.length,
      known, new_players:newPlayers, log });
  } catch(err) {
    return res.status(500).json({ error: err.message, log });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// LINK PLAYER IDS HANDLER (migrated from link-player-ids.js)
// GET /api/admin-api?action=link-player-ids&admin_key=XXX[&apply=1]
// ══════════════════════════════════════════════════════════════════════════

async function handleLinkPlayerIds(db, q, res) {
  const apply = q.apply === '1';
  const log   = [];

  function normLPI(s) {
    return (s||'').toLowerCase().replace(/[àáâãäå]/g,'a').replace(/[èéêë]/g,'e')
      .replace(/[ìíîï]/g,'i').replace(/[òóôõö]/g,'o').replace(/[ùúûü]/g,'u')
      .replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim();
  }
  function surnameOf(n) { const p=n.split(' '); return p[p.length-1]; }
  function initKeyOf(n) { const p=n.split(' '); return p.length<2?null:p[0][0]+'_'+p[p.length-1]; }

  try {
    const { data: statsPlayers } = await db.from('match_player_stats')
      .select('apifootball_player_id,player_name').not('apifootball_player_id','is',null).not('player_name','is',null);

    const apiPlayerMap = {};
    for (const row of (statsPlayers||[])) {
      if (!apiPlayerMap[row.apifootball_player_id]) {
        const n = normLPI(row.player_name);
        apiPlayerMap[row.apifootball_player_id] = { api_id:row.apifootball_player_id, name:row.player_name, norm:n, surname:surnameOf(n), initKey:initKeyOf(n) };
      }
    }
    const apiPlayers = Object.values(apiPlayerMap);
    const byNorm={}, bySurname={}, byInit={};
    for (const ap of apiPlayers) {
      byNorm[ap.norm]=ap;
      if (ap.surname&&ap.surname.length>=4) { if (!bySurname[ap.surname]) bySurname[ap.surname]=ap; else bySurname[ap.surname]=null; }
      if (ap.initKey) { if (!byInit[ap.initKey]) byInit[ap.initKey]=ap; else byInit[ap.initKey]=null; }
    }

    const { data: ourPlayers } = await db.from('players').select('id,display_name,team,position,apifootball_id,psl_roster_id');
    const matched=[],unmatched=[],already=[];

    for (const p of (ourPlayers||[])) {
      if (p.apifootball_id && p.apifootball_id>1000) { already.push({id:p.id,name:p.display_name,apifootball_id:p.apifootball_id}); continue; }
      const pn=normLPI(p.display_name),ps=surnameOf(pn),pk=initKeyOf(pn);
      let hit=null,tier=0;
      if (!hit&&byNorm[pn]) { hit=byNorm[pn]; tier=1; }
      if (!hit&&ps.length>=4&&bySurname[ps]) { hit=bySurname[ps]; tier=2; }
      if (!hit&&pk&&byInit[pk]) { hit=byInit[pk]; tier=3; }
      if (!hit) {
        const fn=pn.split(' ')[0];
        if (fn&&fn.length>=5) {
          const cands=apiPlayers.filter(ap=>ap.norm.split(' ')[0]===fn);
          if (cands.length===1) { hit=cands[0]; tier=4; }
        }
      }
      if (hit) matched.push({db_id:p.id,our_name:p.display_name,api_name:hit.name,apifootball_id:hit.api_id,tier});
      else unmatched.push({db_id:p.id,name:p.display_name,team:p.team});
    }

    let updated=0;
    if (apply) {
      for (const m of matched) {
        const { error } = await db.from('players').update({apifootball_id:m.apifootball_id}).eq('id',m.db_id);
        if (!error) updated++;
      }
    }

    return res.json({ success:true, dry_run:!apply, matched:matched.length, already_had:already.length,
      unmatched:unmatched.length, updated, log, matches:matched, unmatched_players:unmatched });
  } catch(err) {
    return res.status(500).json({ error: err.message, log });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PLAYER CRAWLER HANDLER (migrated from player-crawler.js)
// GET /api/admin-api?action=player-crawler&admin_key=XXX[&apply=1][&team_id=N]
// ══════════════════════════════════════════════════════════════════════════

async function handlePlayerCrawler(db, q, res) {
  const TOKEN      = process.env.APIFOOTBALL_KEY || '';
  const PSL_LEAGUE = 288;
  const PSL_SEASON = parseInt(process.env.APIFOOTBALL_SEASON || '2025', 10);
  const apply      = q.apply === '1';
  const teamIdFilter = q.team_id ? parseInt(q.team_id, 10) : null;
  const log        = [];

  if (!TOKEN) return res.status(500).json({ error: 'APIFOOTBALL_KEY not set' });

  function normPos(raw) {
    if (!raw) return 'MID';
    const r = raw.toUpperCase();
    if (r.includes('GOAL')||r==='G'||r==='GK') return 'GK';
    if (r.includes('DEFEND')||r==='D'||r==='DEF') return 'DEF';
    if (r.includes('FORWARD')||r.includes('ATTACK')||r==='F'||r==='FWD') return 'FWD';
    return 'MID';
  }
  function normName(s) {
    return (s||'').toLowerCase().replace(/[àáâãäå]/g,'a').replace(/[èéêë]/g,'e')
      .replace(/[ìíîï]/g,'i').replace(/[òóôõö]/g,'o').replace(/[ùúûü]/g,'u')
      .replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim();
  }
  function makeSlug(name) { return (name||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
  function defaultPrice(pos) { return pos==='GK'?5.0:pos==='DEF'?5.5:pos==='MID'?6.5:7.0; }

  const CRAWL_TEAM_MAP = {
    'Orlando Pirates':'Orlando Pirates','Mamelodi Sundowns':'Mamelodi Sundowns',
    'Golden Arrows':'Golden Arrows','Sekhukhune United':'Sekhukhune United',
    'AmaZulu':'AmaZulu FC','AmaZulu FC':'AmaZulu FC','Kaizer Chiefs':'Kaizer Chiefs',
    'Stellenbosch':'Stellenbosch FC','Stellenbosch FC':'Stellenbosch FC',
    'TS Galaxy':'TS Galaxy','Richards Bay':'Richards Bay','Polokwane City':'Polokwane City',
    'Chippa United':'Chippa United','Marumo Gallants':'Marumo Gallants FC',
    'Marumo Gallants FC':'Marumo Gallants FC','Magesi':'Magesi FC','Magesi FC':'Magesi FC',
    'Siwelele':'Siwelele FC','Siwelele FC':'Siwelele FC','Cape Town City':'Cape Town City',
    'Durban City':'Durban City','Orbit College':'Orbit College FC','Orbit College FC':'Orbit College FC',
  };

  async function apiFetchLocal(endpoint) {
    const url = `https://v3.football.api-sports.io${endpoint}`;
    const r = await fetch(url, { headers: { 'x-rapidapi-key': TOKEN, 'x-rapidapi-host': 'v3.football.api-sports.io' } });
    if (!r.ok) throw new Error(`API-Football ${r.status}`);
    const d = await r.json();
    if (d.errors && Object.keys(d.errors).length && !JSON.stringify(d.errors).includes('{}'))
      throw new Error('API error: ' + JSON.stringify(d.errors));
    return d;
  }

  try {
    const { data: existingPlayers } = await db.from('players')
      .select('id,display_name,team,position,apifootball_id,psl_roster_id,photo,is_active');
    const byApiId={}, byNormName={};
    const allRosterIds = new Set();
    for (const p of (existingPlayers||[])) {
      if (p.apifootball_id) byApiId[p.apifootball_id]=p;
      byNormName[normName(p.display_name)]=p;
      if (p.psl_roster_id) allRosterIds.add(p.psl_roster_id);
    }
    let nextRosterId = Math.max(20000,...Array.from(allRosterIds))+1;

    const teamsData = await apiFetchLocal(`/teams?league=${PSL_LEAGUE}&season=${PSL_SEASON}`);
    const teams = teamsData.response||[];
    log.push(`Teams: ${teams.length}`);

    const allApiPlayers=[], fetchErrors=[];
    for (const entry of teams) {
      const team=entry.team||{};
      const teamName=CRAWL_TEAM_MAP[team.name]||team.name||'Unknown';
      if (teamIdFilter && team.id!==teamIdFilter) continue;
      try {
        const sd = await apiFetchLocal(`/players/squads?team=${team.id}`);
        const squad=(sd.response||[])[0];
        const players=squad?(squad.players||[]):[];
        log.push(`${teamName}: ${players.length}`);
        for (const p of players) {
          allApiPlayers.push({ apifootball_id:p.id, display_name:p.name||'Unknown',
            team:teamName, position:normPos(p.position||''), age:p.age||null,
            photo:p.photo||null, norm_name:normName(p.name||'') });
        }
        await new Promise(r=>setTimeout(r,150));
      } catch(e) { fetchErrors.push(`${teamName}: ${e.message}`); }
    }

    const seenIds=new Set(), dedupPlayers=[];
    for (const p of allApiPlayers) { if (!seenIds.has(p.apifootball_id)){seenIds.add(p.apifootball_id);dedupPlayers.push(p);} }

    const toInsert=[],toUpdate=[];
    for (const ap of dedupPlayers) {
      const ex=byApiId[ap.apifootball_id]||byNormName[ap.norm_name];
      if (ex) toUpdate.push({id:ex.id,display_name:ap.display_name,team:ap.team,position:ap.position,
        photo:ap.photo||ex.photo||null,age:ap.age||null,apifootball_id:ap.apifootball_id,
        is_active:true,updated_at:new Date().toISOString()});
      else toInsert.push({display_name:ap.display_name,team:ap.team,position:ap.position,
        apifootball_id:ap.apifootball_id,photo:ap.photo||null,age:ap.age||null,
        price:defaultPrice(ap.position),psl_roster_id:nextRosterId++,
        slug:makeSlug(ap.display_name)+'-'+ap.apifootball_id,
        is_available:true,is_active:true,goals:0,assists:0,clean_sheets:0,
        yellow_cards:0,red_cards:0,saves:0,apps:0,total_points:0,
        created_at:new Date().toISOString(),updated_at:new Date().toISOString()});
    }
    const activeApiIds=new Set(dedupPlayers.map(p=>p.apifootball_id));
    const toDeactivate=(existingPlayers||[]).filter(p=>p.apifootball_id&&!activeApiIds.has(p.apifootball_id)&&p.is_active!==false);

    let inserted=0,updated=0,deactivated=0,errors=0;
    if (apply) {
      for (let i=0;i<toInsert.length;i+=25) {
        const batch=toInsert.slice(i,i+25);
        const {error}=await db.from('players').insert(batch);
        if (!error) inserted+=batch.length;
        else { errors++; log.push('Insert error: '+error.message); }
      }
      for (const row of toUpdate) {
        const {id,...fields}=row;
        const {error}=await db.from('players').update(fields).eq('id',id);
        if (!error) updated++; else errors++;
      }
      if (toDeactivate.length>0) {
        const ids=toDeactivate.map(p=>p.id);
        await db.from('players').update({is_active:false,is_available:false,updated_at:new Date().toISOString()}).in('id',ids);
        deactivated=ids.length;
      }
    }

    return res.json({ success:true, dry_run:!apply, season:PSL_SEASON,
      api_total:dedupPlayers.length, new_count:toInsert.length, update_count:toUpdate.length,
      deactivate_count:toDeactivate.length, inserted, updated, deactivated, errors,
      fetch_errors:fetchErrors, log,
      new_players_preview:toInsert.slice(0,20).map(p=>({name:p.display_name,team:p.team,pos:p.position})),
    });
  } catch(err) {
    return res.status(500).json({ error: err.message, log });
  }
}
