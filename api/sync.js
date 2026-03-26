// ══════════════════════════════════════════════════════════════════════════
// api/sync.js  —  Fantasy PSL  —  Consolidated Sync & Data Proxy
// ══════════════════════════════════════════════════════════════════════════
//
// Replaces: force-sync, import-players, sportmonks-setup, sportmonks,
//           live-matches, psl-data, sync-fixtures, sync-player-stats
//
// ENDPOINTS  (all via ?action=xxx):
//   GET  /api/sync?action=live                → live match scores
//   GET  /api/sync?action=psl-data            → full Supabase data bundle
//   GET  /api/sync?action=force-sync&admin_key=xxx  → fixture + standings sync
//   GET  /api/sync?action=import-players&admin_key=xxx → import players from Sportmonks
//   GET  /api/sync?action=setup&admin_key=xxx → Sportmonks diagnostic
//   GET  /api/sync?action=setup&action_sub=xxx&admin_key=xxx → sub-action
//   GET  /api/sync?action=proxy&endpoint=xxx  → Sportmonks proxy (admin debug)
//   GET  /api/sync?action=seasons             → list PSL seasons
//
//  Backward compat redirects maintained via vercel.json rewrites.
//
// ENV VARS:
//   SPORTMONKS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_SECRET
// ══════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const { getSeasonId }  = require('./season-helper');

const TOKEN  = process.env.SPORTMONKS_TOKEN    || '';
const SB_URL = process.env.SUPABASE_URL        || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ADMIN  = process.env.ADMIN_SECRET        || 'mzansi4sho';
const BASE   = 'https://api.sportmonks.com/v3/football';
const PSL_ID = 806;

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var q      = req.query || {};
  var action = q.action || 'psl-data';
  var adminKey = q.admin_key || (req.headers && req.headers['x-admin-key']) || '';

  try {
    // ── Public endpoints (no auth needed) ─────────────────────────────
    if (action === 'live')     return res.json(await getLive());
    if (action === 'psl-data') return res.json(await getPslData());
    if (action === 'seasons')  return res.json(await getSeasons());

    // ── Admin-only endpoints ───────────────────────────────────────────
    if (adminKey !== ADMIN) return res.status(401).json({ error: 'Unauthorized' });

    if (action === 'force-sync' || action === 'sync-fixtures') {
      return res.json(await runForceSync());
    }
    if (action === 'import-players' || action === 'sync-player-stats') {
      return res.json(await runImportPlayers());
    }
    if (action === 'setup' || action === 'diagnose') {
      var sub = q.action_sub || q.sub || 'diagnose';
      return res.json(await runSetup(sub, q));
    }
    if (action === 'proxy') {
      var endpoint = q.endpoint || '';
      return res.json(await runProxy(endpoint));
    }

    return res.status(400).json({ error: 'Unknown action: ' + action + '. Valid: live, psl-data, seasons, force-sync, import-players, setup, proxy' });

  } catch (err) {
    console.error('[sync.js]', action, err.message);
    return res.status(500).json({ error: err.message, action });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// LIVE SCORES
// ══════════════════════════════════════════════════════════════════════════
async function getLive() {
  if (!TOKEN) throw new Error('SPORTMONKS_TOKEN not set');
  var r    = await fetch(BASE + '/livescores/inplay?include=participants;scores;state&filters=fixtureLeagues:' + PSL_ID + '&api_token=' + TOKEN, { headers: { Accept: 'application/json' } });
  var json = await r.json();
  var data = json.data || [];
  var matches = data.map(function(f) {
    var parts = f.participants || [];
    var home  = parts.find(function(p){ return p.meta && p.meta.location === 'home'; }) || parts[0] || {};
    var away  = parts.find(function(p){ return p.meta && p.meta.location === 'away'; }) || parts[1] || {};
    var hg = null, ag = null;
    (f.scores || []).forEach(function(s) {
      var d = (s.description || '').toUpperCase();
      if (['CURRENT','FT','2ND_HALF','FULLTIME'].indexOf(d) > -1) {
        if (s.score && s.score.participant === 'home') hg = s.score.goals;
        if (s.score && s.score.participant === 'away') ag = s.score.goals;
      }
    });
    return { fixture_id: f.id, home: home.name || '', away: away.name || '',
             home_logo: home.image_path || '', away_logo: away.image_path || '',
             hg: hg, ag: ag, is_live: true, status: 'LIVE',
             elapsed: f.minute || null, date: f.starting_at };
  });
  return { isLive: matches.length > 0, matches: matches, count: matches.length };
}

// ══════════════════════════════════════════════════════════════════════════
// PSL DATA BUNDLE (Supabase → frontend)
// ══════════════════════════════════════════════════════════════════════════
async function getPslData() {
  if (!SB_URL) throw new Error('SUPABASE_URL not set');

  var [gwRes, fixturesRes, standingsRes] = await Promise.all([
    sbGet('/gameweeks?is_current=eq.true&limit=1'),
    sbGet('/fixtures?order=kickoff_at.asc&limit=100'),
    sbGet('/profiles?select=username,team_name,total_points&order=total_points.desc&limit=100')
  ]);

  var currentGW = (gwRes[0] || {}).number || null;
  var FT   = fixturesRes.filter(function(f) { return f.status === 'FT'; });
  var NS   = fixturesRes.filter(function(f) { return f.status === 'NS'; });
  var live = fixturesRes.filter(function(f) { return f.status === 'LIVE'; });

  return { currentGW: currentGW, FT: FT, NS: NS, live: live, standings: standingsRes, ts: Date.now() };
}

// ══════════════════════════════════════════════════════════════════════════
// FORCE SYNC — fixtures + standings → Supabase
// ══════════════════════════════════════════════════════════════════════════
async function runForceSync() {
  if (!TOKEN)          throw new Error('SPORTMONKS_TOKEN missing');
  if (!SB_URL||!SB_KEY) throw new Error('Supabase env vars missing');

  var db  = createClient(SB_URL, SB_KEY);
  var log = [];

  var seasonId = process.env.SPORTMONKS_SEASON_ID
    ? parseInt(process.env.SPORTMONKS_SEASON_ID, 10)
    : await getSeasonId(db, TOKEN);
  log.push('Season ID: ' + seasonId);

  // Write test
  var testRow = { sportmonks_id: -1, home_team:'TEST', away_team:'TEST', status:'NS', kickoff_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  var testRes = await db.from('fixtures').upsert(testRow, { onConflict:'sportmonks_id' });
  if (testRes.error) { log.push('⚠️ Write test failed: ' + testRes.error.message); }
  else { log.push('✅ Write test passed'); await db.from('fixtures').delete().eq('sportmonks_id', -1); }

  // Upcoming fixtures
  var upCount = 0;
  try {
    for (var page = 1; page <= 5; page++) {
      var upData = await smGet('/fixtures?filters=fixtureSeasons:' + seasonId + ';fixtureStates:1&include=participants;round&per_page=50&page=' + page);
      var upcoming = upData.data || [];
      if (!upcoming.length) break;
      for (var i = 0; i < upcoming.length; i++) {
        try { await upsertFixture(db, upcoming[i], 'NS', null, null); upCount++; } catch(ue) { log.push('Upcoming row error: ' + ue.message); }
      }
      var umeta = upData.meta && upData.meta.pagination;
      if (!umeta || !umeta.has_next_page) break;
    }
    log.push('Upcoming synced: ' + upCount);
  } catch(e) { log.push('Upcoming error: ' + e.message); }

  // Past results
  var pastCount = 0;
  try {
    for (var ppage = 1; ppage <= 10; ppage++) {
      var pastData = await smGet('/fixtures?filters=fixtureSeasons:' + seasonId + ';fixtureStates:5&include=participants;scores&per_page=50&page=' + ppage);
      var past = pastData.data || [];
      if (!past.length) break;
      for (var pi = 0; pi < past.length; pi++) {
        var scores = extractScores(past[pi].scores || []);
        try { await upsertFixture(db, past[pi], 'FT', scores.home, scores.away); pastCount++; } catch(pe) { log.push('Past row error: ' + pe.message); }
      }
      var pmeta = pastData.meta && pastData.meta.pagination;
      if (!pmeta || !pmeta.has_next_page) break;
    }
    log.push('Past results synced: ' + pastCount);
  } catch(e) { log.push('Past results error: ' + e.message); }

  // Standings
  var standCount = 0;
  try {
    var standData = await smGet('/standings/seasons/' + seasonId);
    var rows = flattenStandings(standData.data || []);
    if (rows.length) { await db.from('standings').upsert(rows, { onConflict:'id' }); standCount = rows.length; }
    log.push('Standings synced: ' + standCount + ' teams');
  } catch(e) { log.push('Standings error: ' + e.message); }

  return { success: true, season_id: seasonId, upcoming_synced: upCount, past_synced: pastCount, standings_synced: standCount, log, message: 'Sync complete' };
}

// ══════════════════════════════════════════════════════════════════════════
// IMPORT PLAYERS from Sportmonks → Supabase
// ══════════════════════════════════════════════════════════════════════════
async function runImportPlayers() {
  if (!TOKEN || !SB_URL || !SB_KEY) throw new Error('Missing env vars');

  var db = createClient(SB_URL, SB_KEY);
  var seasonId = await getSeasonId(db, TOKEN);
  var teamsRes = await smGet('/teams/seasons/' + seasonId + '?per_page=25');
  var teams    = teamsRes.data || [];
  if (!teams.length) throw new Error('No teams found for season ' + seasonId);

  var allPlayers = [], errors = [];

  for (var i = 0; i < teams.length; i++) {
    var team = teams[i];
    try {
      var squadRes = await smGet('/squads/teams/' + team.id + '?include=player.position');
      var squad    = squadRes.data || [];
      for (var j = 0; j < squad.length; j++) {
        var entry = squad[j];
        var p     = entry.player || {};
        if (!p.id) continue;
        var rawPos = (entry.position && (entry.position.name || entry.position.developer_name)) || '';
        var pos    = normPos(rawPos);
        allPlayers.push({
          api_player_id: String(p.id),
          display_name:  p.display_name || p.name || 'Unknown',
          team:          team.name, position: pos,
          photo:         p.image_path || null,
          price:         pos === 'GK' ? 4.5 : pos === 'DEF' ? 5.0 : pos === 'MID' ? 6.0 : 6.5,
          is_available:  true, goals: 0, assists: 0,
          yellow_cards: 0, red_cards: 0, clean_sheets: 0, apps: 0, total_points: 0,
          updated_at: new Date().toISOString()
        });
      }
    } catch(e) { errors.push('Team ' + team.name + ': ' + e.message); }
  }

  if (!allPlayers.length) throw new Error('No players found. ' + errors.join('; '));

  var imported = 0;
  for (var ci = 0; ci < allPlayers.length; ci += 50) {
    var chunk = allPlayers.slice(ci, ci + 50);
    var uRes  = await db.from('players').upsert(chunk, { onConflict: 'api_player_id' });
    if (uRes.error) errors.push('Chunk ' + ci + ': ' + uRes.error.message);
    else imported += chunk.length;
  }

  return { success: true, players_imported: imported, teams_processed: teams.length, season_id: seasonId, errors };
}

// ══════════════════════════════════════════════════════════════════════════
// SETUP / DIAGNOSTIC
// ══════════════════════════════════════════════════════════════════════════
async function runSetup(sub, q) {
  if (!TOKEN) throw new Error('SPORTMONKS_TOKEN not set');
  var report = { action: 'setup', sub, token_preview: TOKEN.substring(0,8)+'…', results: {}, errors: [] };

  if (sub === 'diagnose' || sub === 'default') {
    try { var ld = await smGet('/leagues/' + PSL_ID); report.results.league = { ok: true, name: ld.data && ld.data.name }; } catch(e) { report.results.league = { ok: false, error: e.message }; }
    var seasonId = null;
    try { seasonId = await autoGetSeasonId(); report.results.current_season = { ok: true, id: seasonId }; } catch(e) { report.results.current_season = { ok: false, error: e.message }; }
    if (seasonId) {
      try { var fd = await smGet('/fixtures?filters=fixtureSeasons:' + seasonId + ';fixtureStates:1&include=participants;round&per_page=5'); report.results.upcoming_fixtures = { ok: true, count: (fd.data||[]).length }; } catch(e) { report.results.upcoming_fixtures = { ok: false, error: e.message }; }
      try { var pd = await smGet('/fixtures?filters=fixtureSeasons:' + seasonId + ';fixtureStates:5&include=participants;scores&per_page=5'); report.results.past_fixtures = { ok: true, count: (pd.data||[]).length }; } catch(e) { report.results.past_fixtures = { ok: false, error: e.message }; }
    }
    report.summary = report.errors.length === 0 ? '✅ All endpoints working!' : '⚠️ ' + report.errors.length + ' issues found.';

  } else if (sub === 'fixtures') {
    var sid = q.season_id || await autoGetSeasonId();
    var [up, ps] = await Promise.all([
      smGet('/fixtures?filters=fixtureSeasons:' + sid + ';fixtureStates:1&include=participants;round&per_page=20'),
      smGet('/fixtures?filters=fixtureSeasons:' + sid + ';fixtureStates:5&include=participants;scores&per_page=20')
    ]);
    report.results = { season_id: sid, upcoming: (up.data||[]).length, past: (ps.data||[]).length };

  } else if (sub === 'teams') {
    var sid = q.season_id || await autoGetSeasonId();
    var td = await smGet('/teams/seasons/' + sid + '?per_page=25');
    report.results = { season_id: sid, teams: (td.data||[]).map(function(t){ return { id:t.id, name:t.name }; }) };

  } else if (sub === 'standings_raw') {
    if (!SB_URL||!SB_KEY) throw new Error('Supabase env vars not set');
    var db = createClient(SB_URL, SB_KEY);
    var { data, error } = await db.from('standings').select('id,team_name,position,points,played').order('position');
    if (error) throw new Error(error.message);
    report.results = { count: (data||[]).length, standings: data };
  }

  return report;
}

// ══════════════════════════════════════════════════════════════════════════
// SPORTMONKS PROXY (admin debug)
// ══════════════════════════════════════════════════════════════════════════
async function runProxy(endpoint) {
  if (!TOKEN) throw new Error('SPORTMONKS_TOKEN not set');
  if (!endpoint) throw new Error('endpoint param required');
  if (endpoint.includes('..') || !endpoint.match(/^[a-zA-Z0-9\/_\-?&=:,]+$/)) throw new Error('Invalid endpoint');
  var sep = endpoint.includes('?') ? '&' : '?';
  var url = BASE + '/' + endpoint + sep + 'api_token=' + TOKEN;
  var r   = await fetch(url, { headers: { Accept: 'application/json' } });
  return r.json();
}

// ══════════════════════════════════════════════════════════════════════════
// SEASONS LIST
// ══════════════════════════════════════════════════════════════════════════
async function getSeasons() {
  var pslSeasons = [];
  for (var page = 1; page <= 5; page++) {
    var d = await smGet('/seasons?per_page=100&page=' + page);
    var rows = d.data || [];
    if (!rows.length) break;
    rows.forEach(function(s) { if (s.league_id === PSL_ID) pslSeasons.push({ id:s.id, name:s.name, is_current:s.is_current }); });
    if (!(d.meta && d.meta.pagination && d.meta.pagination.has_next_page)) break;
  }
  pslSeasons.sort(function(a,b){ return b.id - a.id; });
  return { type:'seasons', psl_seasons: pslSeasons, env_season_id: process.env.SPORTMONKS_SEASON_ID||null };
}

// ══════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════
async function upsertFixture(db, f, status, homeScore, awayScore) {
  var parts = f.participants || [];
  var row = {
    sportmonks_id: f.id,
    home_team: getParticipant(parts,'home','name') || 'TBD',
    away_team: getParticipant(parts,'away','name') || 'TBD',
    home_logo: getParticipant(parts,'home','image_path') || null,
    away_logo: getParticipant(parts,'away','image_path') || null,
    home_score: homeScore, away_score: awayScore,
    status: status, kickoff_at: f.starting_at,
    round: (f.round && f.round.name) || null,
    updated_at: new Date().toISOString()
  };
  var res = await db.from('fixtures').upsert(row, { onConflict:'sportmonks_id' });
  if (res.error) {
    var res2 = await db.from('fixtures').insert(row);
    if (res2.error && !res2.error.message.includes('duplicate')) throw new Error('fixture upsert: ' + res2.error.message);
  }
}

function getParticipant(parts, loc, field) {
  var p = parts.find(function(x){ return x.meta && x.meta.location === loc; });
  return p ? p[field] : null;
}

function extractScores(scores) {
  var home = null, away = null;
  scores.forEach(function(s) {
    var desc = (s.description || '').toUpperCase();
    if (['CURRENT','FT','FULLTIME','2ND_HALF'].indexOf(desc) > -1) {
      if (s.score && s.score.participant === 'home') home = s.score.goals;
      if (s.score && s.score.participant === 'away') away = s.score.goals;
    }
  });
  return { home, away };
}

function flattenStandings(data) {
  var rows = [];
  data.forEach(function(g) {
    var items = (g.standings && Array.isArray(g.standings)) ? g.standings : (g.position ? [g] : []);
    items.forEach(function(s) {
      var det  = s.details || [];
      var part = s.participant || {};
      function dv(tid) { var d=det.find(function(x){return x.type_id===tid;}); return d?(d.value||0):0; }
      rows.push({
        id: s.participant_id || part.id || (rows.length + 1),
        team_name: part.name || s.team_name || 'Unknown',
        team_logo: part.image_path || null,
        position: s.position || rows.length + 1,
        played: dv(129)||s.games_played||0, won: dv(130)||s.won||0,
        drawn: dv(131)||s.draw||0, lost: dv(132)||s.lost||0,
        goals_for: dv(133)||0, goals_against: dv(134)||0,
        goal_diff: dv(135)||0, points: s.points||0,
        form: Array.isArray(s.form) ? s.form.slice(-5).join(',') : (s.form||''),
        updated_at: new Date().toISOString()
      });
    });
  });
  return rows;
}

function normPos(raw) {
  if (!raw) return 'MID';
  var r = raw.toUpperCase().trim();
  if (r.includes('GOAL') || r === 'GK' || r === 'G') return 'GK';
  if (r.includes('DEFEND') || r === 'DEF' || r === 'D') return 'DEF';
  if (r.includes('FORWARD') || r.includes('ATTACK') || r === 'FWD' || r === 'F' || r === 'ST') return 'FWD';
  return 'MID';
}

async function autoGetSeasonId() {
  try { var d = await smGet('/leagues/' + PSL_ID); var sid = (d.data||{}).current_season_id; if (sid) return sid; } catch(_) {}
  var found = null;
  try {
    for (var page = 1; page <= 5; page++) {
      var d = await smGet('/seasons?per_page=100&page=' + page);
      var seasons = d.data || [];
      if (!seasons.length) break;
      for (var i = 0; i < seasons.length; i++) {
        var s = seasons[i];
        if (s.league_id === PSL_ID) {
          if (s.is_current) { found = s.id; break; }
          if (!found || s.id > found) found = s.id;
        }
      }
      if (found) break;
      if (!(d.meta && d.meta.pagination && d.meta.pagination.has_next_page)) break;
    }
  } catch(_) {}
  return found || 26173;
}

async function smGet(path) {
  var sep = path.indexOf('?') > -1 ? '&' : '?';
  var url = BASE + path + sep + 'api_token=' + TOKEN;
  var r   = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) { var b = await r.text().catch(function(){return'';}); throw new Error('Sportmonks ' + r.status + ': ' + b.substring(0,300)); }
  var json = await r.json();
  if (json.errors) throw new Error('Sportmonks errors: ' + JSON.stringify(json.errors).substring(0,300));
  return json;
}

async function sbGet(path) {
  var url = SB_URL + '/rest/v1' + path;
  var r = await fetch(url, { headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('Supabase HTTP ' + r.status + ' for ' + path);
  return r.json();
}
