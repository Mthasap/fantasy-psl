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
function formatSupabaseFixture(f) {
  var isLive = ['LIVE','1H','2H','HT'].indexOf(f.status) > -1;
  var isFT   = f.status === 'FT';
  return {
    fixture_id:    f.api_fixture_id || f.id,
    api_fixture_id: f.api_fixture_id || f.id,
    status:        f.status || 'NS',
    date:          f.kickoff_at,
    home:          normTeam(f.home_team || ''),
    away:          normTeam(f.away_team || ''),
    home_logo:     f.home_logo || null,
    away_logo:     f.away_logo || null,
    hg:            (isFT || isLive) ? f.home_score : null,
    ag:            (isFT || isLive) ? f.away_score : null,
    is_live:       isLive,
    is_ft:         isFT,
    elapsed:       f.elapsed || null,
    round:         f.round   || null
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
