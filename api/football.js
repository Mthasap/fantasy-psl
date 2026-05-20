// ══════════════════════════════════════════════════════════════════════════
// api/football.js — Fantasy PSL — API-Football Edition
// ══════════════════════════════════════════════════════════════════════════
//
// ENDPOINTS:
//   GET /api/football?type=live        → live PSL scores
//   GET /api/football?type=fixtures    → upcoming fixtures
//   GET /api/football?type=results     → completed results
//   GET /api/football?type=standings   → league table
//   GET /api/football?type=topscorers  → top scorers
//   GET /api/football?type=status      → health check
//
// ENV VARS:
//   APIFOOTBALL_KEY      — API-Football key (x-apisports-key header)
//   SUPABASE_URL         — Supabase project URL
//   SUPABASE_SERVICE_KEY — Supabase service role key
//
// API-Football PSL: league_id=288, season=2025
// ══════════════════════════════════════════════════════════════════════════

const { createClient }              = require('@supabase/supabase-js');
const { getSeasonYear, apiFetch, PSL_LEAGUE } = require('./season-helper');

const TOKEN  = process.env.APIFOOTBALL_KEY     || '';
const SB_URL = process.env.SUPABASE_URL        || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// In-memory cache
const CACHE = {};
const TTL = {
  live:      60  * 1000,        //  1 min
  fixtures:  5   * 60 * 1000,  //  5 min
  results:   2   * 60 * 1000,  //  2 min
  standings: 15  * 60 * 1000,  // 15 min
  topscorers:30  * 60 * 1000,  // 30 min
};

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (!TOKEN) {
    return res.status(500).json({ error: 'APIFOOTBALL_KEY not set in Vercel Environment Variables' });
  }

  var type = (req.query && req.query.type) || 'live';

  try {
    switch (type) {
      case 'live':           return res.json(await getLive());
      case 'fixtures':       return res.json(await getFixtures());
      case 'results':        return res.json(await getResults());
      case 'standings':      return res.json(await getStandings());
      case 'topscorers':     return res.json(await getTopScorers());
      case 'status':         return res.json(await getStatus());
      case 'fixture_detail': return res.json(await getFixtureDetail(req.query.fixture_id));
      case 'team_fixtures':  return res.json(await getTeamFixtures(req.query.team, req.query.team_id));
      // ── Migrated from sync.js ─────────────────────────────────────────
      case 'psl-data':       return res.json(await getPslData());
      case 'seasons':        return res.json(await getSeasons());
      case 'proxy': {
        const ep = req.query.endpoint;
        if (!ep) return res.status(400).json({ error: 'endpoint required' });
        return res.json(await apiFetch('/' + ep.replace(/^\//, ''), TOKEN));
      }
      // ── Pro Tier Endpoints ───────────────────────────────────────────
      case 'injuries':        return res.json(await getInjuries(req.query.fixture_id));
      case 'predictions':     return res.json(await getPredictions(req.query.fixture_id));
      case 'player_transfers':return res.json(await getPlayerTransfers(req.query.player_id, req.query.team_id));
      case 'sidelined':       return res.json(await getSidelined(req.query.player_id));
      case 'player_info':     return res.json(await getPlayerInfo(req.query.player_id));
      case 'coaches':         return res.json(await getCoaches(req.query.team_id));
      case 'trophies':        return res.json(await getTrophies(req.query.player_id));
      case 'odds':            return res.json(await getPreMatchOdds(req.query.fixture_id));
      case 'player_stats_season': return res.json(await getPlayerSeasonStats(req.query.player_id));
      default:               return res.status(400).json({ error: 'Unknown type: ' + type });
    }
  } catch(err) {
    console.error('[football.js]', type, err.message);
    return res.status(500).json({ error: err.message, type });
  }
};

// ── Cache helpers ─────────────────────────────────────────────────────────
function fromCache(key) {
  var c = CACHE[key];
  if (c && (Date.now() - c.ts) < (TTL[key] || 300000)) return c.data;
  return null;
}
function toCache(key, data) { CACHE[key] = { data, ts: Date.now() }; return data; }

// ── Supabase client ───────────────────────────────────────────────────────
function db() {
  if (!SB_URL || !SB_KEY) throw new Error('Supabase env vars not set');
  return createClient(SB_URL, SB_KEY);
}

// ── Season year ───────────────────────────────────────────────────────────
var _seasonYear = null;
async function seasonYear() {
  if (_seasonYear) return _seasonYear;
  _seasonYear = await getSeasonYear(TOKEN);
  return _seasonYear;
}

// ══════════════════════════════════════════════════════════════════════════
// LIVE SCORES
// ══════════════════════════════════════════════════════════════════════════
async function getLive() {
  var cached = fromCache('live');
  if (cached) return cached;

  var d = await apiFetch('/fixtures?league=' + PSL_LEAGUE + '&live=all', TOKEN);
  var matches = (d.response || []).map(formatFixture);

  return toCache('live', {
    type: 'live',
    isLive: matches.length > 0,
    matches,
    fetched_at: new Date().toISOString()
  });
}

// ══════════════════════════════════════════════════════════════════════════
// UPCOMING FIXTURES
// ══════════════════════════════════════════════════════════════════════════
async function getFixtures() {
  var cached = fromCache('fixtures');
  if (cached) return cached;

  // PRIMARY: Supabase (admin-entered/synced)
  if (SB_URL && SB_KEY) {
    try {
      var res = await db().from('fixtures').select('*')
        .eq('status', 'NS').order('kickoff_at', { ascending: true }).limit(200);
      if (!res.error && res.data && res.data.length) {
        // Dedup by home+away+date in case of duplicate rows in Supabase
        var seen = {};
        var deduped = res.data.filter(function(f) {
          var key = (f.home_team||'').toLowerCase().slice(0,8) + '_' +
                    (f.away_team||'').toLowerCase().slice(0,8) + '_' +
                    ((f.kickoff_at||f.date||'').slice(0,10));
          if (seen[key]) return false;
          seen[key] = true;
          return true;
        });
        return toCache('fixtures', {
          type: 'fixtures',
          fixtures: deduped.map(formatSupabaseFixture),
          source: 'supabase',
          fetched_at: new Date().toISOString()
        });
      }
    } catch(e) { console.warn('[fixtures] Supabase error:', e.message); }
  }

  // FALLBACK: API-Football upcoming fixtures
  var sy = await seasonYear();
  var d  = await apiFetch('/fixtures?league=' + PSL_LEAGUE + '&season=' + sy + '&status=NS&next=20', TOKEN);
  var fixtures = (d.response || []).map(formatFixture);

  return toCache('fixtures', {
    type: 'fixtures', fixtures, source: 'api-football',
    fetched_at: new Date().toISOString()
  });
}

// ══════════════════════════════════════════════════════════════════════════
// RESULTS
// ══════════════════════════════════════════════════════════════════════════
async function getResults() {
  var cached = fromCache('results');
  if (cached) return cached;

  // PRIMARY: Supabase
  if (SB_URL && SB_KEY) {
    try {
      var res = await db().from('fixtures').select('*')
        .eq('status', 'FT').order('kickoff_at', { ascending: false }).limit(60);
      if (!res.error && res.data && res.data.length) {
        return toCache('results', {
          type: 'results',
          results: res.data.map(formatSupabaseFixture),
          source: 'supabase',
          fetched_at: new Date().toISOString()
        });
      }
    } catch(e) { console.warn('[results] Supabase error:', e.message); }
  }

  // FALLBACK: API-Football last 30 finished
  var sy = await seasonYear();
  var d  = await apiFetch('/fixtures?league=' + PSL_LEAGUE + '&season=' + sy + '&status=FT&last=30', TOKEN);
  var results = (d.response || []).map(formatFixture).reverse();

  return toCache('results', {
    type: 'results', results, source: 'api-football',
    fetched_at: new Date().toISOString()
  });
}

// ══════════════════════════════════════════════════════════════════════════
// STANDINGS
// ══════════════════════════════════════════════════════════════════════════
async function getStandings() {
  var cached = fromCache('standings');
  if (cached) return cached;

  var sy = await seasonYear();
  var d  = await apiFetch('/standings?league=' + PSL_LEAGUE + '&season=' + sy, TOKEN);

  var groups = (d.response || [])[0];
  var rows   = groups ? (groups.league && groups.league.standings ? groups.league.standings[0] : []) : [];

  var standings = (rows || []).map(function(s) {
    return {
      pos:  s.rank,
      team: normTeam(s.team && s.team.name || ''),
      logo: s.team && s.team.logo || null,
      p:    s.all && s.all.played || 0,
      w:    s.all && s.all.win    || 0,
      d:    s.all && s.all.draw   || 0,
      l:    s.all && s.all.lose   || 0,
      gf:   s.all && s.all.goals && s.all.goals.for     || 0,
      ga:   s.all && s.all.goals && s.all.goals.against || 0,
      gd:   s.goalsDiff || 0,
      pts:  s.points    || 0,
      form: s.form ? s.form.split('').slice(-5) : []
    };
  });

  // Persist to Supabase for cron use
  if (SB_URL && SB_KEY && standings.length) {
    try {
      var dbRows = standings.map(function(s) {
        return {
          id:            s.pos,
          team_name:     s.team,
          team_logo:     s.logo,
          position:      s.pos,
          played:        s.p,
          won:           s.w,
          drawn:         s.d,
          lost:          s.l,
          goals_for:     s.gf,
          goals_against: s.ga,
          goal_diff:     s.gd,
          points:        s.pts,
          form:          s.form.join(','),
          updated_at:    new Date().toISOString()
        };
      });
      await db().from('standings').upsert(dbRows, { onConflict: 'id' });
    } catch(e) {}
  }

  return toCache('standings', {
    type: 'standings', standings,
    fetched_at: new Date().toISOString()
  });
}

// ══════════════════════════════════════════════════════════════════════════
// TOP SCORERS
// ══════════════════════════════════════════════════════════════════════════
async function getTopScorers() {
  var cached = fromCache('topscorers');
  if (cached) return cached;

  // PRIMARY: Supabase players table
  if (SB_URL && SB_KEY) {
    try {
      var res = await db().from('players').select('display_name,team,goals,apps,total_points,photo')
        .gt('goals', 0).order('goals', { ascending: false }).limit(20);
      if (!res.error && res.data && res.data.length >= 3) {
        return toCache('topscorers', {
          type: 'topscorers',
          topScorers: res.data.map(function(p, i) {
            return { rank: i+1, name: p.display_name, club: p.team, goals: p.goals, apps: p.apps, photo: p.photo };
          }),
          source: 'supabase', fetched_at: new Date().toISOString()
        });
      }
    } catch(e) {}
  }

  // FALLBACK: API-Football top scorers
  var sy = await seasonYear();
  var d  = await apiFetch('/players/topscorers?league=' + PSL_LEAGUE + '&season=' + sy, TOKEN);
  var topScorers = (d.response || []).slice(0, 20).map(function(r, i) {
    var p    = r.player || {};
    var stat = (r.statistics || [])[0] || {};
    return {
      rank:  i + 1,
      name:  p.name || 'Unknown',
      club:  stat.team && stat.team.name || '',
      goals: stat.goals && stat.goals.total || 0,
      apps:  stat.games && stat.games.appearences || 0,
      photo: p.photo || null
    };
  });

  return toCache('topscorers', {
    type: 'topscorers', topScorers, source: 'api-football',
    fetched_at: new Date().toISOString()
  });
}

// ══════════════════════════════════════════════════════════════════════════
// STATUS / HEALTH CHECK
// ══════════════════════════════════════════════════════════════════════════
async function getStatus() {
  var status = {
    ok: true, provider: 'API-Football v3',
    token_set: !!TOKEN,
    psl_league_id: PSL_LEAGUE,
    supabase_configured: !!(SB_URL && SB_KEY),
    checked_at: new Date().toISOString()
  };
  try {
    var sy = await seasonYear();
    status.season_year = sy;
    var d = await apiFetch('/leagues?id=' + PSL_LEAGUE, TOKEN);
    var league = (d.response || [])[0];
    status.league_name = league && league.league && league.league.name;
    status.requests_remaining = d.response ? 'check dashboard' : 'unknown';
    status.league_ok = true;
  } catch(e) {
    status.league_ok = false;
    status.league_error = e.message;
  }
  return status;
}

// ══════════════════════════════════════════════════════════════════════════
// FORMAT HELPERS
// ══════════════════════════════════════════════════════════════════════════

// Normalise team names to match PSL_ROSTER club names in index.html
var TEAM_MAP = {
  'Mamelodi Sundowns':           'Mamelodi Sundowns',
  'Orlando Pirates':             'Orlando Pirates',
  'Kaizer Chiefs':               'Kaizer Chiefs',
  'AmaZulu FC':                  'AmaZulu',
  'Amazulu':                     'AmaZulu',
  'Stellenbosch FC':             'Stellenbosch',
  'Sekhukhune United':           'Sekhukhune United',
  'Polokwane City':              'Polokwane City',
  'TS Galaxy':                   'TS Galaxy',
  'Golden Arrows':               'Golden Arrows',
  'Lamontville Golden Arrows':   'Golden Arrows',
  'Chippa United':               'Chippa United',
  'Richards Bay':                'Richards Bay',
  'SuperSport United':           'Siwelele',
  'Siwelele FC':                 'Siwelele',
  'Magesi FC':                   'Magesi',
  'Marumo Gallants':             'Marumo Gallants FC',
  'Cape Town City':              'Cape Town City',
  'Cape Town Spurs':             'Cape Town Spurs',
  'Durban City':                 'Durban City',
  'Orbit College':               'Orbit College',
};

function normTeam(name) { return TEAM_MAP[name] || name; }

// Format API-Football fixture response → standard shape
function formatFixture(f) {
  var fix    = f.fixture  || {};
  var teams  = f.teams    || {};
  var goals  = f.goals    || {};
  var league = f.league   || {};

  var status = fix.status && fix.status.short || 'NS';
  var isLive = ['1H','2H','HT','ET','P','LIVE'].indexOf(status) > -1;
  var isFT   = ['FT','AET','PEN'].indexOf(status) > -1;

  return {
    fixture_id:    fix.id,
    api_fixture_id: fix.id,
    status:        isFT ? 'FT' : isLive ? 'LIVE' : 'NS',
    date:          fix.date,
    home:          normTeam(teams.home && teams.home.name || ''),
    away:          normTeam(teams.away && teams.away.name || ''),
    home_logo:     teams.home && teams.home.logo || null,
    away_logo:     teams.away && teams.away.logo || null,
    hg:            (isFT || isLive) ? goals.home : null,
    ag:            (isFT || isLive) ? goals.away : null,
    is_live:       isLive,
    is_ft:         isFT,
    elapsed:       fix.status && fix.status.elapsed || null,
    round:         league.round || null
  };
}

// Format Supabase fixture row → standard shape
// Handles both naming conventions:
//   home_team (string) — written by sync.js
//   home_team_name / home_team_id — written by apifootball-sync.js
function formatSupabaseFixture(f) {
  var isLive = ['LIVE','1H','2H','HT','ET','P'].indexOf(f.status) > -1;
  var isFT   = ['FT','AET','PEN'].indexOf(f.status) > -1;

  // Resolve team names — try every known column variant
  var home = f.home_team      ||
             f.home_team_name  ||
             f.homeTeam        ||
             f.home            ||
             (f.home_team_id   ? 'Team ' + f.home_team_id : 'TBD');

  var away = f.away_team      ||
             f.away_team_name  ||
             f.awayTeam        ||
             f.away            ||
             (f.away_team_id   ? 'Team ' + f.away_team_id : 'TBD');

  // Resolve logos
  var homeLogo = f.home_logo || f.home_team_logo || f.homeLogo || null;
  var awayLogo = f.away_logo || f.away_team_logo || f.awayLogo || null;

  // Resolve scores
  var hg = f.home_score !== undefined ? f.home_score :
           f.homeScore  !== undefined ? f.homeScore  :
           f.goals_home !== undefined ? f.goals_home : null;
  var ag = f.away_score !== undefined ? f.away_score :
           f.awayScore  !== undefined ? f.awayScore  :
           f.goals_away !== undefined ? f.goals_away : null;

  // Resolve fixture id
  var fid = f.api_fixture_id || f.fixture_id || f.apifootball_id || f.id;

  return {
    fixture_id:    fid,
    api_fixture_id: fid,
    status:        f.status || 'NS',
    date:          f.kickoff_at || f.date || f.kickoff || null,
    home:          normTeam(home),
    away:          normTeam(away),
    home_logo:     homeLogo,
    away_logo:     awayLogo,
    hg:            (isFT || isLive) ? hg : null,
    ag:            (isFT || isLive) ? ag : null,
    is_live:       isLive,
    is_ft:         isFT,
    elapsed:       f.elapsed || null,
    round:         f.round   || null,
    gw_number:     f.gw_number || null
  };
}

// ══════════════════════════════════════════════════════════════════════════
// FIXTURE DETAIL — full match stats, lineups, events (goals/cards/subs)
// GET /api/football?type=fixture_detail&fixture_id=123456
// ══════════════════════════════════════════════════════════════════════════
async function getFixtureDetail(fixtureId) {
  if (!fixtureId) throw new Error('fixture_id required');

  var cacheKey = 'fixture_' + fixtureId;
  var cached   = fromCache(cacheKey);
  if (cached) return cached;

  // Fetch base fixture + events + lineups + statistics in parallel
  var [fixtureRes, eventsRes, lineupsRes, statsRes] = await Promise.all([
    apiFetch('/fixtures?id=' + fixtureId, TOKEN),
    apiFetch('/fixtures/events?fixture=' + fixtureId, TOKEN),
    apiFetch('/fixtures/lineups?fixture=' + fixtureId, TOKEN),
    apiFetch('/fixtures/statistics?fixture=' + fixtureId, TOKEN),
  ]);

  var f   = (fixtureRes.response || [])[0] || {};
  var fix = f.fixture || {}, teams = f.teams || {}, goals = f.goals || {}, score = f.score || {}, league = f.league || {};

  var status    = fix.status && fix.status.short || 'NS';
  var isLive    = ['1H','2H','HT','ET','P','LIVE'].indexOf(status) > -1;
  var isFT      = ['FT','AET','PEN'].indexOf(status) > -1;

  // ── Events (goals, cards, substitutions) ─────────────────────────
  var events = (eventsRes.response || []).map(function(e) {
    return {
      time:    e.time && e.time.elapsed || 0,
      extra:   e.time && e.time.extra || null,
      team:    normTeam(e.team && e.team.name || ''),
      team_id: e.team && e.team.id || null,
      player:  e.player && e.player.name || '',
      assist:  e.assist && e.assist.name || null,
      type:    e.type  || '',   // Goal, Card, subst, Var
      detail:  e.detail || '',  // Normal Goal, Yellow Card, Red Card, etc.
    };
  });

  // ── Lineups ───────────────────────────────────────────────────────
  var lineups = (lineupsRes.response || []).map(function(l) {
    return {
      team:       normTeam(l.team && l.team.name || ''),
      team_logo:  l.team && l.team.logo || null,
      formation:  l.formation || '',
      coach:      l.coach && l.coach.name || '',
      startXI:    (l.startXI || []).map(function(p) {
        var pl = p.player || {};
        return { id: pl.id, name: pl.name, number: pl.number, pos: pl.pos, grid: pl.grid };
      }),
      substitutes: (l.substitutes || []).map(function(p) {
        var pl = p.player || {};
        return { id: pl.id, name: pl.name, number: pl.number, pos: pl.pos };
      }),
    };
  });

  // ── Statistics (shots, possession, etc.) ─────────────────────────
  var statistics = (statsRes.response || []).map(function(t) {
    var statMap = {};
    (t.statistics || []).forEach(function(s) { statMap[s.type] = s.value; });
    return {
      team:             normTeam(t.team && t.team.name || ''),
      team_logo:        t.team && t.team.logo || null,
      shots_on_target:  statMap['Shots on Goal'] || 0,
      shots_total:      statMap['Total Shots'] || 0,
      possession:       statMap['Ball Possession'] || '0%',
      passes:           statMap['Total passes'] || 0,
      pass_accuracy:    statMap['Passes accurate'] || 0,
      fouls:            statMap['Fouls'] || 0,
      yellow_cards:     statMap['Yellow Cards'] || 0,
      red_cards:        statMap['Red Cards'] || 0,
      offsides:         statMap['Offsides'] || 0,
      corners:          statMap['Corner Kicks'] || 0,
      saves:            statMap['Goalkeeper Saves'] || 0,
    };
  });

  // TTL: live matches cache only 60s; finished/upcoming cache longer
  var ttl = isLive ? 60000 : isFT ? 10 * 60000 : 5 * 60000;
  TTL[cacheKey] = ttl;

  return toCache(cacheKey, {
    type:       'fixture_detail',
    fixture_id: fixtureId,
    status:     isFT ? 'FT' : isLive ? 'LIVE' : 'NS',
    elapsed:    fix.status && fix.status.elapsed || null,
    date:       fix.date,
    venue:      fix.venue && fix.venue.name || null,
    round:      league.round || null,
    home:       normTeam(teams.home && teams.home.name || ''),
    away:       normTeam(teams.away && teams.away.name || ''),
    home_logo:  teams.home && teams.home.logo || null,
    away_logo:  teams.away && teams.away.logo || null,
    hg:         (isFT || isLive) ? goals.home : null,
    ag:         (isFT || isLive) ? goals.away : null,
    ht_score:   score.halftime || null,
    ft_score:   score.fulltime || null,
    events,
    lineups,
    statistics,
    fetched_at: new Date().toISOString()
  });
}

// ══════════════════════════════════════════════════════════════════════════
// TEAM FIXTURES — next 3 upcoming + last 5 results for a team
// GET /api/football?type=team_fixtures&team=Orlando+Pirates
// GET /api/football?type=team_fixtures&team_id=12345
// ══════════════════════════════════════════════════════════════════════════
async function getTeamFixtures(teamName, teamId) {
  if (!teamName && !teamId) throw new Error('team or team_id required');

  var cacheKey = 'team_' + (teamId || teamName);
  var cached   = fromCache(cacheKey);
  if (cached) return cached;

  var sy = await seasonYear();

  // If we have a team name but no API team_id, try to find it from standings
  var resolvedTeamId = teamId;
  if (!resolvedTeamId && teamName) {
    try {
      var standData = await apiFetch('/standings?league=' + PSL_LEAGUE + '&season=' + sy, TOKEN);
      var groups    = (standData.response || [])[0];
      var rows      = groups && groups.league && groups.league.standings ? groups.league.standings[0] : [];
      var match     = rows.find(function(r) {
        return normTeam(r.team && r.team.name || '').toLowerCase() === (teamName || '').toLowerCase() ||
               (r.team && r.team.name || '').toLowerCase() === (teamName || '').toLowerCase();
      });
      if (match) resolvedTeamId = match.team && match.team.id;
    } catch(e) {}
  }

  if (!resolvedTeamId) {
    // Return empty if we can't resolve
    return { upcoming: [], results: [], team: teamName };
  }

  // Fetch upcoming + past in parallel
  var [upRes, pastRes] = await Promise.all([
    apiFetch('/fixtures?league=' + PSL_LEAGUE + '&season=' + sy + '&team=' + resolvedTeamId + '&status=NS&next=3', TOKEN),
    apiFetch('/fixtures?league=' + PSL_LEAGUE + '&season=' + sy + '&team=' + resolvedTeamId + '&status=FT&last=5', TOKEN),
  ]);

  var upcoming = (upRes.response  || []).map(formatFixture);
  var results  = (pastRes.response || []).map(formatFixture).reverse();

  TTL[cacheKey] = 10 * 60 * 1000; // 10 min cache

  return toCache(cacheKey, {
    type:     'team_fixtures',
    team:     teamName,
    team_id:  resolvedTeamId,
    upcoming: upcoming.slice(0, 3),
    results:  results.slice(0, 5),
    fetched_at: new Date().toISOString()
  });
}

// ══════════════════════════════════════════════════════════════════════════
// PRO TIER ADDITIONS — Injuries, Predictions, Transfers, Sidelined, etc.
// All endpoints below require the $19/mo Pro plan (7500 req/day)
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
// INJURIES — GET /api/football?type=injuries&fixture_id=XXX (or no fixture for PSL-wide)
// Returns all injured/suspended players for a fixture or the whole league
// ══════════════════════════════════════════════════════════════════════════
async function getInjuries(fixtureId) {
  var cacheKey = 'injuries_' + (fixtureId || 'league');
  var cached   = fromCache(cacheKey);
  if (cached) return cached;

  var sy = await seasonYear();
  var endpoint = fixtureId
    ? '/injuries?fixture=' + fixtureId
    : '/injuries?league=' + PSL_LEAGUE + '&season=' + sy;

  var d = await apiFetch(endpoint, TOKEN);

  var injuries = (d.response || []).map(function(inj) {
    var p    = inj.player  || {};
    var team = inj.team    || {};
    var fix  = inj.fixture || {};
    return {
      player_id:   p.id,
      player_name: p.name,
      player_photo:p.photo || null,
      team_id:     team.id,
      team_name:   normTeam(team.name || ''),
      team_logo:   team.logo || null,
      fixture_id:  fix.id   || fixtureId || null,
      fixture_date:fix.date || null,
      type:        inj.player && inj.player.type   || 'Unknown',  // Injured / Suspended
      reason:      inj.player && inj.player.reason || '',
    };
  });

  // Also write to Supabase players table so the UI can show injury icons
  if (SB_URL && SB_KEY && injuries.length) {
    try {
      var dbClient = db();
      // Mark injured players
      var injured = injuries.filter(function(i) { return i.type !== 'Suspended'; });
      for (var i = 0; i < injured.length; i++) {
        var inj = injured[i];
        if (inj.player_id) {
          await dbClient.from('players').update({
            is_injured:   true,
            is_available: false,
            injury_type:  inj.type,
            injury_reason: inj.reason,
            updated_at:   new Date().toISOString()
          }).eq('apifootball_id', inj.player_id);
        }
      }
    } catch(e) { console.warn('[injuries] Supabase write error:', e.message); }
  }

  TTL[cacheKey] = 30 * 60 * 1000; // 30 min
  return toCache(cacheKey, {
    type: 'injuries',
    count: injuries.length,
    injuries,
    fetched_at: new Date().toISOString()
  });
}

// ══════════════════════════════════════════════════════════════════════════
// PREDICTIONS — GET /api/football?type=predictions&fixture_id=XXX
// Returns AI/model prediction: winner, goals, advice, percentages
// ══════════════════════════════════════════════════════════════════════════
async function getPredictions(fixtureId) {
  if (!fixtureId) throw new Error('fixture_id required for predictions');

  var cacheKey = 'predictions_' + fixtureId;
  var cached   = fromCache(cacheKey);
  if (cached) return cached;

  var d = await apiFetch('/predictions?fixture=' + fixtureId, TOKEN);
  var pred = (d.response || [])[0] || {};

  var result = {
    type:         'predictions',
    fixture_id:   fixtureId,
    winner:       pred.predictions && pred.predictions.winner ? {
      id:     pred.predictions.winner.id,
      name:   normTeam(pred.predictions.winner.name || ''),
      comment: pred.predictions.winner.comment || ''
    } : null,
    win_or_draw:  pred.predictions && pred.predictions.win_or_draw,
    under_over:   pred.predictions && pred.predictions.under_over,
    goals_home:   pred.predictions && pred.predictions.goals && pred.predictions.goals.home,
    goals_away:   pred.predictions && pred.predictions.goals && pred.predictions.goals.away,
    advice:       pred.predictions && pred.predictions.advice || '',
    percent: {
      home: pred.predictions && pred.predictions.percent && pred.predictions.percent.home || '0%',
      draw: pred.predictions && pred.predictions.percent && pred.predictions.percent.draw || '0%',
      away: pred.predictions && pred.predictions.percent && pred.predictions.percent.away || '0%',
    },
    comparison: pred.comparison || null,
    h2h_last5: (pred.h2h || []).slice(0, 5).map(function(f) {
      var fix  = f.fixture || {};
      var gs   = f.goals   || {};
      var tms  = f.teams   || {};
      return {
        date:  fix.date,
        home:  normTeam(tms.home && tms.home.name || ''),
        away:  normTeam(tms.away && tms.away.name || ''),
        hg:    gs.home,
        ag:    gs.away,
        status: fix.status && fix.status.short || ''
      };
    }),
    fetched_at: new Date().toISOString()
  };

  TTL[cacheKey] = 60 * 60 * 1000; // 1hr — predictions don't change much
  return toCache(cacheKey, result);
}

// ══════════════════════════════════════════════════════════════════════════
// PLAYER TRANSFERS — GET /api/football?type=player_transfers&player_id=XXX
//                  — GET /api/football?type=player_transfers&team_id=XXX
// ══════════════════════════════════════════════════════════════════════════
async function getPlayerTransfers(playerId, teamId) {
  if (!playerId && !teamId) throw new Error('player_id or team_id required');

  var cacheKey = 'transfers_' + (playerId || 'team_' + teamId);
  var cached   = fromCache(cacheKey);
  if (cached) return cached;

  var endpoint = playerId
    ? '/transfers?player=' + playerId
    : '/transfers?team=' + teamId;

  var d = await apiFetch(endpoint, TOKEN);

  var transfers = (d.response || []).map(function(t) {
    var p = t.player || {};
    return {
      player_id:   p.id,
      player_name: p.name,
      transfers: (t.transfers || []).map(function(tr) {
        return {
          date:     tr.date,
          type:     tr.type,
          from_team: normTeam(tr.teams && tr.teams.out && tr.teams.out.name || ''),
          from_logo: tr.teams && tr.teams.out && tr.teams.out.logo || null,
          to_team:   normTeam(tr.teams && tr.teams.in  && tr.teams.in.name  || ''),
          to_logo:   tr.teams && tr.teams.in  && tr.teams.in.logo  || null,
        };
      }).sort(function(a, b) { return new Date(b.date) - new Date(a.date); })
    };
  });

  TTL[cacheKey] = 24 * 60 * 60 * 1000; // 24hr
  return toCache(cacheKey, {
    type: 'player_transfers',
    count: transfers.length,
    transfers,
    fetched_at: new Date().toISOString()
  });
}

// ══════════════════════════════════════════════════════════════════════════
// SIDELINED — GET /api/football?type=sidelined&player_id=XXX
// Returns a player's full injury history
// ══════════════════════════════════════════════════════════════════════════
async function getSidelined(playerId) {
  if (!playerId) throw new Error('player_id required');

  var cacheKey = 'sidelined_' + playerId;
  var cached   = fromCache(cacheKey);
  if (cached) return cached;

  var d = await apiFetch('/sidelined?player=' + playerId, TOKEN);

  var sidelined = (d.response || []).map(function(s) {
    return {
      type:       s.player && s.player.type   || 'Injury',
      reason:     s.player && s.player.reason || '',
      start_date: s.player && s.player.start  || null,
      end_date:   s.player && s.player.end    || null,
    };
  });

  TTL[cacheKey] = 12 * 60 * 60 * 1000; // 12hr
  return toCache(cacheKey, {
    type: 'sidelined',
    player_id: playerId,
    history: sidelined,
    fetched_at: new Date().toISOString()
  });
}

// ══════════════════════════════════════════════════════════════════════════
// PLAYER INFO + SEASON STATS — GET /api/football?type=player_info&player_id=XXX
// Returns player profile + current season statistics
// ══════════════════════════════════════════════════════════════════════════
async function getPlayerInfo(playerId) {
  if (!playerId) throw new Error('player_id required');

  var cacheKey = 'player_info_' + playerId;
  var cached   = fromCache(cacheKey);
  if (cached) return cached;

  var sy = await seasonYear();
  var d  = await apiFetch('/players?id=' + playerId + '&season=' + sy, TOKEN);
  var entry = (d.response || [])[0] || {};
  var p    = entry.player     || {};
  var stat = (entry.statistics || [])[0] || {};

  var result = {
    type:        'player_info',
    player_id:   playerId,
    name:        p.name         || '',
    first_name:  p.firstname    || '',
    last_name:   p.lastname     || '',
    age:         p.age          || null,
    nationality: p.nationality  || '',
    height:      p.height       || '',
    weight:      p.weight       || '',
    photo:       p.photo        || null,
    injured:     p.injured      || false,
    birth_date:  p.birth && p.birth.date    || null,
    birth_place: p.birth && p.birth.place   || null,
    birth_country: p.birth && p.birth.country || null,
    team:        normTeam(stat.team && stat.team.name || ''),
    team_logo:   stat.team && stat.team.logo || null,
    league:      stat.league && stat.league.name || '',
    position:    stat.games && stat.games.position || '',
    season_stats: {
      appearances:  stat.games && stat.games.appearences || 0,
      lineups:      stat.games && stat.games.lineups     || 0,
      minutes:      stat.games && stat.games.minutes     || 0,
      rating:       parseFloat(stat.games && stat.games.rating || 0) || null,
      captain:      stat.games && stat.games.captain     || false,
      goals:        stat.goals && stat.goals.total       || 0,
      assists:      stat.goals && stat.goals.assists     || 0,
      conceded:     stat.goals && stat.goals.conceded    || 0,
      saves:        stat.goals && stat.goals.saves       || 0,
      shots_total:  stat.shots && stat.shots.total       || 0,
      shots_on:     stat.shots && stat.shots.on          || 0,
      passes_total: stat.passes && stat.passes.total     || 0,
      key_passes:   stat.passes && stat.passes.key       || 0,
      pass_accuracy:parseFloat(stat.passes && stat.passes.accuracy || 0) || null,
      tackles:      stat.tackles && stat.tackles.total   || 0,
      blocks:       stat.tackles && stat.tackles.blocks  || 0,
      interceptions:stat.tackles && stat.tackles.interceptions || 0,
      duels_total:  stat.duels && stat.duels.total       || 0,
      duels_won:    stat.duels && stat.duels.won         || 0,
      dribbles_att: stat.dribbles && stat.dribbles.attempts || 0,
      dribbles_suc: stat.dribbles && stat.dribbles.success  || 0,
      fouls_drawn:  stat.fouls && stat.fouls.drawn       || 0,
      fouls_committed: stat.fouls && stat.fouls.committed || 0,
      yellow_cards: stat.cards && stat.cards.yellow      || 0,
      yellow_red:   stat.cards && stat.cards.yellowred   || 0,
      red_cards:    stat.cards && stat.cards.red         || 0,
      pen_won:      stat.penalty && stat.penalty.won     || 0,
      pen_committed:stat.penalty && stat.penalty.commited || 0,
      pen_scored:   stat.penalty && stat.penalty.scored  || 0,
      pen_missed:   stat.penalty && stat.penalty.missed  || 0,
      pen_saved:    stat.penalty && stat.penalty.saved   || 0,
    },
    fetched_at: new Date().toISOString()
  };

  // Persist rich stats to Supabase players table
  if (SB_URL && SB_KEY && playerId) {
    try {
      await db().from('players').update({
        photo:          result.photo,
        nationality:    result.nationality,
        age:            result.age,
        height:         result.height,
        weight:         result.weight,
        is_injured:     result.injured,
        is_available:   !result.injured,
        avg_rating:     result.season_stats.rating,
        appearances:    result.season_stats.appearances,
        goals:          result.season_stats.goals,
        assists:        result.season_stats.assists,
        saves:          result.season_stats.saves,
        yellow_cards:   result.season_stats.yellow_cards,
        red_cards:      result.season_stats.red_cards,
        updated_at:     new Date().toISOString()
      }).eq('apifootball_id', parseInt(playerId));
    } catch(e) {}
  }

  TTL[cacheKey] = 6 * 60 * 60 * 1000; // 6hr
  return toCache(cacheKey, result);
}

// ══════════════════════════════════════════════════════════════════════════
// PLAYER SEASON STATS — shortcut for just stats without full profile
// ══════════════════════════════════════════════════════════════════════════
async function getPlayerSeasonStats(playerId) {
  var full = await getPlayerInfo(playerId);
  return {
    type: 'player_stats_season',
    player_id: playerId,
    name: full.name,
    team: full.team,
    position: full.position,
    stats: full.season_stats,
    fetched_at: full.fetched_at
  };
}

// ══════════════════════════════════════════════════════════════════════════
// COACHES — GET /api/football?type=coaches&team_id=XXX
// ══════════════════════════════════════════════════════════════════════════
async function getCoaches(teamId) {
  if (!teamId) throw new Error('team_id required');

  var cacheKey = 'coaches_' + teamId;
  var cached   = fromCache(cacheKey);
  if (cached) return cached;

  var d = await apiFetch('/coachs?team=' + teamId, TOKEN);

  var coaches = (d.response || []).map(function(c) {
    return {
      id:          c.id,
      name:        c.name,
      first_name:  c.firstname || '',
      last_name:   c.lastname  || '',
      age:         c.age       || null,
      nationality: c.nationality || '',
      photo:       c.photo     || null,
      team:        normTeam(c.team && c.team.name || ''),
      team_logo:   c.team && c.team.logo || null,
      career: (c.career || []).map(function(cr) {
        return {
          team:  normTeam(cr.team && cr.team.name || ''),
          logo:  cr.team && cr.team.logo || null,
          start: cr.start || null,
          end:   cr.end   || null
        };
      })
    };
  });

  TTL[cacheKey] = 24 * 60 * 60 * 1000; // 24hr
  return toCache(cacheKey, {
    type: 'coaches',
    team_id: teamId,
    coaches,
    fetched_at: new Date().toISOString()
  });
}

// ══════════════════════════════════════════════════════════════════════════
// TROPHIES — GET /api/football?type=trophies&player_id=XXX
// Returns all trophies/honours won by a player
// ══════════════════════════════════════════════════════════════════════════
async function getTrophies(playerId) {
  if (!playerId) throw new Error('player_id required');

  var cacheKey = 'trophies_' + playerId;
  var cached   = fromCache(cacheKey);
  if (cached) return cached;

  var d = await apiFetch('/trophies?player=' + playerId, TOKEN);

  var trophies = (d.response || []).map(function(t) {
    return {
      league:  t.league  || '',
      country: t.country || '',
      season:  t.season  || '',
      place:   t.place   || ''
    };
  });

  TTL[cacheKey] = 24 * 60 * 60 * 1000;
  return toCache(cacheKey, {
    type: 'trophies',
    player_id: playerId,
    trophies,
    fetched_at: new Date().toISOString()
  });
}

// ══════════════════════════════════════════════════════════════════════════
// PRE-MATCH ODDS — GET /api/football?type=odds&fixture_id=XXX
// Returns betting odds from multiple bookmakers
// ══════════════════════════════════════════════════════════════════════════
async function getPreMatchOdds(fixtureId) {
  if (!fixtureId) throw new Error('fixture_id required');

  var cacheKey = 'odds_' + fixtureId;
  var cached   = fromCache(cacheKey);
  if (cached) return cached;

  var d = await apiFetch('/odds?fixture=' + fixtureId, TOKEN);

  var bookmakers = (d.response || []).slice(0, 5).map(function(entry) {
    var bk = entry.bookmakers && entry.bookmakers[0];
    if (!bk) return null;
    var matchWinner = (bk.bets || []).find(function(b) { return b.name === 'Match Winner'; });
    return {
      bookmaker: bk.name,
      match_winner: matchWinner ? matchWinner.values : []
    };
  }).filter(Boolean);

  TTL[cacheKey] = 30 * 60 * 1000; // 30 min
  return toCache(cacheKey, {
    type: 'odds',
    fixture_id: fixtureId,
    bookmakers,
    fetched_at: new Date().toISOString()
  });
}

// ══════════════════════════════════════════════════════════════════════════
// MIGRATED FROM sync.js
// ══════════════════════════════════════════════════════════════════════════

// PSL Data Bundle — gameweek + fixtures + standings in one call
async function getPslData() {
  if (!SB_URL) throw new Error('SUPABASE_URL not set');
  async function sbGet(path) {
    var r = await fetch(SB_URL + '/rest/v1' + path, {
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Accept': 'application/json' }
    });
    if (!r.ok) throw new Error('Supabase HTTP ' + r.status);
    return r.json();
  }
  var [gwRes, fixturesRes, standingsRes] = await Promise.all([
    sbGet('/gameweeks?is_current=eq.true&limit=1'),
    sbGet('/fixtures?order=kickoff_time.asc&limit=100'),
    sbGet('/profiles?select=username,team_name,total_points&order=total_points.desc&limit=100')
  ]);
  var currentGW = (gwRes[0] || {}).gw_number || (gwRes[0] || {}).number || null;
  return {
    currentGW,
    FT:        fixturesRes.filter(function(f) { return f.status === 'FT'; }),
    NS:        fixturesRes.filter(function(f) { return f.status === 'NS'; }),
    live:      fixturesRes.filter(function(f) { return ['LIVE','1H','2H','HT'].includes(f.status); }),
    standings: standingsRes,
    ts:        Date.now()
  };
}

// PSL Seasons list
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
