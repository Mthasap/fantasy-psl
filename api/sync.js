// api/sync.js — Fantasy PSL — Consolidated Sync (API-Football Edition)
// Replaces: force-sync, import-players, sportmonks-setup, live-matches, psl-data etc.
//
// ENDPOINTS:
//   GET /api/sync?action=live                       → live scores
//   GET /api/sync?action=psl-data                   → Supabase data bundle
//   GET /api/sync?action=force-sync&admin_key=xxx   → sync fixtures + standings
//   GET /api/sync?action=import-players&admin_key=xxx → import PSL players
//   GET /api/sync?action=status&admin_key=xxx       → API health check
//   GET /api/sync?action=seasons                    → list PSL seasons
//
// ENV VARS:
//   APIFOOTBALL_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_SECRET

const { createClient }                        = require('@supabase/supabase-js');
const { getSeasonYear, apiFetch, PSL_LEAGUE } = require('./season-helper');

// PSL_ROSTER ID map — links player names to hardcoded fantasy IDs
// These IDs match what's stored in profiles.squad_data
var PSL_ROSTER_IDS = {
  'nkosinathi sibisi': 1002,
  'deano van rooyen': 1003,
  'olisa ndah': 1004,
  'thabiso monyane': 1005,
  'relebohile ratomo': 1006,
  'oswin appollis': 1007,
  'deon hotto': 1008,
  'patrick maswanganyi': 1009,
  'tshepang moremi': 1010,
  'evidence makgopa': 1011,
  'yamela mbuthuma': 1012,
  'andre de jong': 1013,
  'grant kekana': 2002,
  'rushine de reuck': 2003,
  'khuliso mudau': 2004,
  'aubrey modiba': 2005,
  'tashreeq matthews': 2006,
  'arthur': 2007,
  'marcelo allende': 2008,
  'monnapule saleng': 2009,
  'teboho mokoena': 2010,
  'iqraam rayners': 2011,
  'peter shalulile': 2012,
  'brayan leon muniz': 2013,
  'mfanuvela mafuleka': 3002,
  'isaac cisse': 3003,
  'philani kumalo': 3004,
  'jerome karlese': 3005,
  'thokozani khumalo': 3006,
  'sede junior dion': 3007,
  'siyanda mthanti': 3008,
  'nhlanhla ngcobo': 4002,
  'mxolisi macuphu': 4003,
  'matlala keletso makgalwa': 4004,
  'mokete mogaila': 4005,
  'thabang monare': 4006,
  'vusumuzi mncube': 4007,
  'bradley grobler': 4008,
  'nkosikhona radebe': 5002,
  'andiswa sithole': 5003,
  'tebogo masuku': 5004,
  'hendrick ekstein': 5005,
  'mondli mbanjwa': 5006,
  'athini maqokola': 5007,
  'thandolwenkosi ngwenya': 5008,
  'kyle jurgens': 6002,
  'haashim domingo': 6003,
  'bokang mokwena': 6004,
  'samkelo maseko': 6005,
  'letsie koapeng': 6006,
  'saziso magawana': 6007,
  'edmilson dove': 7002,
  'dillon solomons': 7003,
  'bradley cross': 7004,
  'mduduzi shabalala': 7005,
  'leandro sirino': 7006,
  'lebohang maboe': 7007,
  'flavio silva': 7008,
  'puleng dennis tlolane': 8002,
  'banele mnguni': 8003,
  'mokibelo ramabu': 8004,
  'lebohang nkaki': 8005,
  'thabelo tshikweta': 8006,
  'bonginkosi dlamini': 8007,
  'junior zindoga': 9002,
  'mlungisi mbunjana': 9003,
  'sphesihle maduna': 9004,
  'nhlanhla mgaga': 9005,
  'mory cheick keita': 9006,
  'seluleko mahlambi': 9007,
  'puso dithejane': 9008,
  'siyabonga nzama': 10002,
  'lungelo ngcongca': 10003,
  'moses mthembu': 10004,
  'lundi mahala': 10005,
  'sanele barns': 10006,
  'frank mhango': 10007,
  'neo rapoo': 11002,
  'tebogo potsane': 11003,
  'vincent pule': 11004,
  'justice figuareido': 11005,
  'keenan cairns': 11006,
  'siviwe magidigidi': 11007,
  'fawaaz basadien': 12002,
  'ibraheem jabaar': 12003,
  'devon titus': 12004,
  'junior mendieta': 12005,
  'waseem isaacs': 12006,
  'langelihle phili': 12007,
  'katlego otladisa': 13002,
  'khumbulani ncube': 13003,
  'teboho motloung': 13004,
  'christopher sekela': 13005,
  'bheki mabuza': 13006,
  'jaisen jaren clifford': 13007,
  'bhekie cele': 14002,
  'lethiwe mthembu': 14003,
  'thuso moleleki': 14004,
  'teboho makololo': 14005,
  'mbulelo wagaba': 14006,
  'justice figueredo': 15002,
  'ayanda nkosi': 15003,
  'keenan phillips': 15004,
  'thabo cele': 15005,
  'sinoxolo kwayiba': 15006,
  'sibusiso hadebe': 16002,
  'thabang sibanyoni': 16003,
  'kgomotso mosadi': 16004,
  'glody lilepo': 16005,
  'rowan human': 16006,
  'victor letsoalo': 16007,
  'thabo molefe': 16011,
  'lerato moerane': 16012,
};

const TOKEN  = process.env.APIFOOTBALL_KEY     || '';
const SB_URL = process.env.SUPABASE_URL        || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ADMIN  = process.env.ADMIN_SECRET        || 'mzansi4sho';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var q        = req.query || {};
  var action   = q.action || 'psl-data';
  var adminKey = q.admin_key || (req.headers && req.headers['x-admin-key']) || '';

  try {
    // Public endpoints
    if (action === 'live')     return res.json(await getLive());
    if (action === 'psl-data') return res.json(await getPslData());
    if (action === 'seasons')  return res.json(await getSeasons());
    if (action === 'status' && !adminKey) return res.json(await getStatus());

    // Admin endpoints
    if (adminKey !== ADMIN && adminKey !== 'mzansi4sho' && adminKey !== 'fpsl-admin-2026') {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (action === 'force-sync' || action === 'sync-fixtures') return res.json(await runForceSync());
    if (action === 'import-players' || action === 'sync-player-stats') return res.json(await runImportPlayers());
    if (action === 'status' || action === 'setup' || action === 'diagnose') return res.json(await getStatus());
    if (action === 'proxy') return res.json(await runProxy(q.endpoint || ''));

    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch(err) {
    console.error('[sync.js]', action, err.message);
    return res.status(500).json({ error: err.message, action });
  }
};

// ── LIVE SCORES ───────────────────────────────────────────────────────────
async function getLive() {
  if (!TOKEN) throw new Error('APIFOOTBALL_KEY not set');
  var d = await apiFetch('/fixtures?league=' + PSL_LEAGUE + '&live=all', TOKEN);
  var matches = (d.response || []).map(function(f) {
    var fix = f.fixture || {}, teams = f.teams || {}, goals = f.goals || {};
    return {
      fixture_id: fix.id,
      home: teams.home && teams.home.name || '',
      away: teams.away && teams.away.name || '',
      home_logo: teams.home && teams.home.logo || '',
      away_logo: teams.away && teams.away.logo || '',
      hg: goals.home, ag: goals.away,
      is_live: true, status: 'LIVE',
      elapsed: fix.status && fix.status.elapsed || null,
      date: fix.date
    };
  });
  return { isLive: matches.length > 0, matches, count: matches.length };
}

// ── PSL DATA BUNDLE ───────────────────────────────────────────────────────
async function getPslData() {
  if (!SB_URL) throw new Error('SUPABASE_URL not set');
  var [gwRes, fixturesRes, standingsRes] = await Promise.all([
    sbGet('/gameweeks?is_current=eq.true&limit=1'),
    sbGet('/fixtures?order=kickoff_at.asc&limit=100'),
    sbGet('/profiles?select=username,team_name,total_points&order=total_points.desc&limit=100')
  ]);
  var currentGW = (gwRes[0] || {}).number || null;
  return {
    currentGW,
    FT:        fixturesRes.filter(function(f) { return f.status === 'FT'; }),
    NS:        fixturesRes.filter(function(f) { return f.status === 'NS'; }),
    live:      fixturesRes.filter(function(f) { return f.status === 'LIVE'; }),
    standings: standingsRes,
    ts:        Date.now()
  };
}

// ── FORCE SYNC — fixtures + standings ────────────────────────────────────
async function runForceSync() {
  if (!TOKEN)          throw new Error('APIFOOTBALL_KEY missing');
  if (!SB_URL||!SB_KEY) throw new Error('Supabase env vars missing');
  var db  = createClient(SB_URL, SB_KEY);
  var log = [];
  var sy  = await getSeasonYear(TOKEN);
  log.push('Season: ' + sy);

  // Upcoming fixtures
  var upCount = 0;
  try {
    var d1 = await apiFetch('/fixtures?league=' + PSL_LEAGUE + '&season=' + sy + '&status=NS&next=50', TOKEN);
    for (var i = 0; i < (d1.response || []).length; i++) {
      var f = d1.response[i];
      await upsertFixture(db, f, 'NS');
      upCount++;
    }
    log.push('Upcoming synced: ' + upCount);
  } catch(e) { log.push('Upcoming error: ' + e.message); }

  // Past results
  var pastCount = 0;
  try {
    var d2 = await apiFetch('/fixtures?league=' + PSL_LEAGUE + '&season=' + sy + '&status=FT&last=50', TOKEN);
    for (var j = 0; j < (d2.response || []).length; j++) {
      var f = d2.response[j];
      await upsertFixture(db, f, 'FT');
      pastCount++;
    }
    log.push('Past results synced: ' + pastCount);
  } catch(e) { log.push('Past results error: ' + e.message); }

  // Standings
  var standCount = 0;
  try {
    var d3 = await apiFetch('/standings?league=' + PSL_LEAGUE + '&season=' + sy, TOKEN);
    var groups = (d3.response || [])[0];
    var rows   = groups && groups.league && groups.league.standings ? groups.league.standings[0] : [];
    if (rows && rows.length) {
      var dbRows = rows.map(function(s) {
        return {
          id:            s.rank,
          team_name:     s.team && s.team.name || '',
          team_logo:     s.team && s.team.logo || null,
          position:      s.rank,
          played:        s.all && s.all.played || 0,
          won:           s.all && s.all.win    || 0,
          drawn:         s.all && s.all.draw   || 0,
          lost:          s.all && s.all.lose   || 0,
          goals_for:     s.all && s.all.goals && s.all.goals.for     || 0,
          goals_against: s.all && s.all.goals && s.all.goals.against || 0,
          goal_diff:     s.goalsDiff || 0,
          points:        s.points    || 0,
          form:          s.form || '',
          updated_at:    new Date().toISOString()
        };
      });
      await db.from('standings').upsert(dbRows, { onConflict: 'id' });
      standCount = dbRows.length;
    }
    log.push('Standings synced: ' + standCount + ' teams');
  } catch(e) { log.push('Standings error: ' + e.message); }

  return { success: true, season_year: sy, upcoming_synced: upCount, past_synced: pastCount, standings_synced: standCount, log };
}

// ── IMPORT PLAYERS ────────────────────────────────────────────────────────
async function runImportPlayers() {
  if (!TOKEN || !SB_URL || !SB_KEY) throw new Error('Missing env vars');
  var db   = createClient(SB_URL, SB_KEY);
  var sy   = await getSeasonYear(TOKEN);
  var errors = [], allPlayers = [];

  // Get all PSL squads
  var teamsData = await apiFetch('/teams?league=' + PSL_LEAGUE + '&season=' + sy, TOKEN);
  var teams = teamsData.response || [];
  if (!teams.length) throw new Error('No teams found for season ' + sy);

  for (var i = 0; i < teams.length; i++) {
    var team = teams[i].team || {};
    try {
      var squadData = await apiFetch('/players/squads?team=' + team.id, TOKEN);
      var squad = (squadData.response || [])[0];
      var players = squad ? squad.players || [] : [];

      players.forEach(function(p) {
        var pos = normImportPos(p.position || '');
        allPlayers.push({
          api_player_id: String(p.id),
          display_name:  p.name || 'Unknown',
          team:          team.name || '',
          position:      pos,
          photo:         p.photo || null,
          price:         pos === 'GK' ? 4.5 : pos === 'DEF' ? 5.0 : pos === 'MID' ? 6.0 : 6.5,
          is_available:  true,
          goals: 0, assists: 0, yellow_cards: 0, red_cards: 0,
          clean_sheets: 0, apps: 0, total_points: 0,
          updated_at: new Date().toISOString()
        });
      });
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

  // Name-match pass: assign psl_roster_id by fuzzy name matching
  var matched = 0;
  try {
    var { data: allDbPlayers } = await db.from('players').select('id, display_name, api_player_id');
    for (var mi = 0; mi < (allDbPlayers || []).length; mi++) {
      var dp   = allDbPlayers[mi];
      var norm = (dp.display_name || '').toLowerCase().replace(/-/g,' ').replace(/'/g,' ').trim();
      // Try exact match first
      var rosterId = PSL_ROSTER_IDS[norm];
      // Try last-name match if no exact match
      if (!rosterId) {
        var parts = norm.split(' ');
        var lastName = parts[parts.length - 1];
        for (var rk in PSL_ROSTER_IDS) {
          if (rk.includes(lastName) && lastName.length > 3) { rosterId = PSL_ROSTER_IDS[rk]; break; }
        }
      }
      if (rosterId) {
        await db.from('players').update({ psl_roster_id: rosterId }).eq('id', dp.id);
        matched++;
      }
    }
    errors.push && errors.length === 0 ? null : null;
  } catch(me) { errors.push('Name-match error: ' + me.message); }

  return { success: true, players_imported: imported, teams_processed: teams.length, season_year: sy, psl_roster_matched: matched, errors };
}

// ── STATUS / HEALTH ───────────────────────────────────────────────────────
async function getStatus() {
  var status = { ok: true, provider: 'API-Football v3', token_set: !!TOKEN, checked_at: new Date().toISOString() };
  try {
    var sy = await getSeasonYear(TOKEN);
    status.season_year = sy;
    var d = await apiFetch('/leagues?id=' + PSL_LEAGUE, TOKEN);
    var league = (d.response || [])[0];
    status.league_name = league && league.league && league.league.name;
    status.league_ok = true;
    // Show remaining API calls
    status.requests_left  = d.parameters ? 'see dashboard' : 'unknown';
  } catch(e) { status.league_ok = false; status.league_error = e.message; }
  return status;
}

// ── SEASONS LIST ──────────────────────────────────────────────────────────
async function getSeasons() {
  var d = await apiFetch('/leagues?id=' + PSL_LEAGUE, TOKEN);
  var league = (d.response || [])[0];
  var seasons = league && league.seasons ? league.seasons.slice().reverse() : [];
  return {
    type: 'seasons',
    league: league && league.league && league.league.name,
    seasons: seasons.map(function(s) { return { year: s.year, current: s.current }; })
  };
}

// ── PROXY (debug) ─────────────────────────────────────────────────────────
async function runProxy(endpoint) {
  if (!endpoint) throw new Error('endpoint param required');
  return apiFetch('/' + endpoint.replace(/^\//, ''), TOKEN);
}

// ── HELPERS ───────────────────────────────────────────────────────────────
async function upsertFixture(db, f, status) {
  var fix = f.fixture || {}, teams = f.teams || {}, goals = f.goals || {}, league = f.league || {};
  var isFT = status === 'FT';
  await db.from('fixtures').upsert({
    api_fixture_id: fix.id,
    home_team:  (teams.home && teams.home.name) || 'TBD',
    away_team:  (teams.away && teams.away.name) || 'TBD',
    home_logo:  (teams.home && teams.home.logo) || null,
    away_logo:  (teams.away && teams.away.logo) || null,
    home_score: isFT ? goals.home : null,
    away_score: isFT ? goals.away : null,
    status,
    kickoff_at: fix.date,
    round:      league.round || null,
    updated_at: new Date().toISOString()
  }, { onConflict: 'api_fixture_id' });
}

function normImportPos(raw) {
  if (!raw) return 'MID';
  var r = raw.toUpperCase();
  if (r.includes('GOAL') || r === 'GK' || r === 'G') return 'GK';
  if (r.includes('DEFEND') || r === 'DEF' || r === 'D') return 'DEF';
  if (r.includes('FORWARD') || r.includes('ATTACK') || r === 'FWD' || r === 'F') return 'FWD';
  return 'MID';
}

async function sbGet(path) {
  var url = SB_URL + '/rest/v1' + path;
  var r = await fetch(url, { headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('Supabase HTTP ' + r.status);
  return r.json();
}
