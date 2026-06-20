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
const { getSeasonYear, apiFetch, PSL_LEAGUE } = require('./_season-helper');

const TOKEN  = process.env.APIFOOTBALL_KEY     || '';
const SB_URL = process.env.SUPABASE_URL        || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ADMIN  = process.env.ADMIN_SECRET;

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
    if (!ADMIN || adminKey !== ADMIN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (action === 'force-sync' || action === 'sync-fixtures') return res.json(await runForceSync());
    if (action === 'import-players' || action === 'sync-player-stats') return res.json(await runImportPlayers());
    if (action === 'status' || action === 'setup' || action === 'diagnose') return res.json(await getStatus());
    if (action === 'test-stats') return res.json(await testPlayerStats(q.player_id || '414149'));
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
  var currentGW = (gwRes[0] || {}).gw_number || (gwRes[0] || {}).number || null;
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

  return { success: true, players_imported: imported, teams_processed: teams.length, season_year: sy, errors };
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

// ── TEST PLAYER STATS ─────────────────────────────────────────────────────
async function testPlayerStats(playerId) {
  var sy = await getSeasonYear(TOKEN);
  // Test single player stats
  var d1 = await apiFetch('/players?id=' + playerId + '&season=' + sy, TOKEN);
  var player = (d1.response || [])[0];

  // Test league-wide player stats page 1
  var d2 = await apiFetch('/players?league=' + PSL_LEAGUE + '&season=' + sy + '&page=1', TOKEN);
  var samplePlayers = (d2.response || []).slice(0, 3).map(function(r) {
    var p    = r.player     || {};
    var stat = (r.statistics || [])[0] || {};
    return {
      id:      p.id,
      name:    p.name,
      team:    stat.team && stat.team.name,
      goals:   stat.goals && stat.goals.total,
      assists: stat.goals && stat.goals.assists,
      minutes: stat.games && stat.games.minutes,
      apps:    stat.games && stat.games.appearences
    };
  });

  return {
    tested_player_id: playerId,
    season: sy,
    player_found: !!player,
    player_name:  player && player.player && player.player.name,
    player_stats: player && player.statistics && player.statistics[0] && {
      team:    player.statistics[0].team && player.statistics[0].team.name,
      goals:   player.statistics[0].goals && player.statistics[0].goals.total,
      assists: player.statistics[0].goals && player.statistics[0].goals.assists,
      minutes: player.statistics[0].games && player.statistics[0].games.minutes,
      apps:    player.statistics[0].games && player.statistics[0].games.appearences,
      yellow:  player.statistics[0].cards && player.statistics[0].cards.yellow,
      red:     player.statistics[0].cards && player.statistics[0].cards.red
    },
    league_stats_available: d2.response && d2.response.length > 0,
    league_total_pages: d2.paging && d2.paging.total,
    sample_players: samplePlayers
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

  // Extract gw_number from round string e.g. "Regular Season - 26" → 26
  // API-Football round format: "Regular Season - N"
  var round = league.round || null;
  var gwNumber = null;
  if (round) {
    var m = round.match(/(\d+)\s*$/);
    if (m) gwNumber = parseInt(m[1], 10);
  }

  var homeName  = (teams.home && teams.home.name) || 'TBD';
  var awayName  = (teams.away && teams.away.name) || 'TBD';
  var homeLogo  = (teams.home && teams.home.logo) || null;
  var awayLogo  = (teams.away && teams.away.logo) || null;

  // Write BOTH home_team (string name) and home_team_name to cover both schemas
  var payload = {
    api_fixture_id: fix.id,
    home_team:      homeName,
    away_team:      awayName,
    home_team_name: homeName,
    away_team_name: awayName,
    home_logo:      homeLogo,
    away_logo:      awayLogo,
    home_score:     isFT ? goals.home : null,
    away_score:     isFT ? goals.away : null,
    status,
    kickoff_at:     fix.date,
    round:          round,
    gw_number:      gwNumber,
    updated_at:     new Date().toISOString()
  };

  var { error: upsErr } = await db.from('fixtures')
    .upsert(payload, { onConflict: 'api_fixture_id' });

  // If a column doesn't exist, retry with only the safe minimal set
  if (upsErr && upsErr.message && upsErr.message.includes('does not exist')) {
    var minimal = {
      api_fixture_id: fix.id,
      home_score:     isFT ? goals.home : null,
      away_score:     isFT ? goals.away : null,
      status,
      kickoff_at:     fix.date,
      gw_number:      gwNumber,
      updated_at:     new Date().toISOString()
    };
    var { error: minErr } = await db.from('fixtures').upsert(minimal, { onConflict: 'api_fixture_id' });
    if (minErr) throw new Error('upsertFixture minimal: ' + minErr.message);
  } else if (upsErr) {
    throw new Error('upsertFixture: ' + upsErr.message);
  }
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
