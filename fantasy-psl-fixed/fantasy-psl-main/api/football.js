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
  standings: 3   * 60 * 1000,  //  3 min (early season results move fast)
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
      case 'standings':      return res.json(await getStandings(req.query && (req.query.refresh === '1' || req.query.refresh === 'true')));
      case 'topscorers':     return res.json(await getTopScorers());
      case 'status':         return res.json(await getStatus());
      case 'fixture_detail': return res.json(await getFixtureDetail(req.query.fixture_id));
      case 'team_fixtures':  return res.json(await getTeamFixtures(req.query.team, req.query.team_id));
      case 'injuries':       return res.json(await getInjuries(req.query.team));
      case 'player_stats':   return res.json(await getPlayerStats(req.query.player_id, req.query.season));
      case 'predictions':    return res.json(await getPredictions(req.query.fixture_id));
      case 'h2h':            return res.json(await getH2H(req.query.h2h));
      case 'player_search':  return res.json(await searchPlayer(req.query.name));
      case 'proxy':          return res.json(await proxyPassthrough(req.query.endpoint));
      default:               return res.status(400).json({ error: 'Unknown type: ' + type });
    }
  } catch(err) {
    console.error('[football.js]', type, err.message);
    return res.status(500).json({ error: err.message, type });
  }
};

// ── Admin proxy passthrough ───────────────────────────────────────────────
// Lets the admin panel look up players/teams directly from API-Football.
// Whitelisted to safe read-only endpoints. ALWAYS returns JSON (never a
// plain-text crash), so the admin UI's res.json() can't choke.
async function proxyPassthrough(endpoint) {
  if (!endpoint) return { response: [], error: 'No endpoint provided' };
  var decoded = decodeURIComponent(endpoint);
  var allowed = ['players', 'teams', 'players/squads'];
  var base = decoded.split('?')[0].replace(/^\/+/, '');
  if (allowed.indexOf(base) === -1) {
    return { response: [], error: 'Endpoint not allowed: ' + base };
  }
  try {
    var json = await apiFetch('/' + decoded.replace(/^\/+/, ''), TOKEN);
    return json;
  } catch (err) {
    return { response: [], error: String(err.message || err).substring(0, 300) };
  }
}

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
async function getStandings(forceRefresh) {
  // ?refresh=1 bypasses the server cache and recomputes on the spot.
  var cached = forceRefresh ? null : fromCache('standings');
  if (cached) return cached;

  var sy = await seasonYear();

  // ── OPTION A: compute the table from OUR OWN finished fixtures ──────────
  // The API-Football /standings feed lags and can be internally inconsistent
  // (e.g. a team showing form ["W"] but played 0). We already store every
  // result in our fixtures table, so we build the table ourselves — it always
  // matches the results users can see, updates the instant a fixture goes FT,
  // and correctly sums across overlapping gameweeks.
  var standings = null;
  try {
    standings = await computeStandingsFromFixtures(sy);
  } catch (e) {
    standings = null; // fall through to API-Football fallback below
  }

  // ── FALLBACK: only if our fixtures read failed entirely ────────────────
  if (!standings || !standings.length) {
    try {
      var d      = await apiFetch('/standings?league=' + PSL_LEAGUE + '&season=' + sy, TOKEN);
      var groups = (d.response || [])[0];
      var rows   = groups ? (groups.league && groups.league.standings ? groups.league.standings[0] : []) : [];
      standings = (rows || []).map(function(s) {
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
      standings.sort(sortStandings);
      standings.forEach(function(s,i){ s.pos = i+1; });
    } catch (e2) {
      standings = [];
    }
  }

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
          form:          (s.form || []).join(','),
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

// Shared sort: points desc → goal difference desc → goals-for desc → name asc
function sortStandings(a, b) {
  if ((b.pts||0) !== (a.pts||0)) return (b.pts||0) - (a.pts||0);
  if ((b.gd||0)  !== (a.gd||0))  return (b.gd||0)  - (a.gd||0);
  if ((b.gf||0)  !== (a.gf||0))  return (b.gf||0)  - (a.gf||0);
  return (a.team||'') < (b.team||'') ? -1 : 1;
}

// Build the league table from our own fixtures for the given season.
// Every team that appears in any fixture is included (so all 16 clubs show,
// even before they've played). Stats come only from finished (FT/AET/PEN)
// fixtures, so unplayed teams correctly sit on zero.
async function computeStandingsFromFixtures(sy) {
  var FT_STATUSES = ['FT', 'AET', 'PEN'];

  var res = await db()
    .from('fixtures')
    .select('home_team_name,away_team_name,home_team_logo,away_team_logo,home_score,away_score,status,kickoff_at')
    .eq('season', sy)
    .order('kickoff_at', { ascending: true });

  if (res.error) throw new Error(res.error.message);
  var fixtures = res.data || [];
  if (!fixtures.length) return [];

  var teams = {}; // key: normalised team name → row
  function keyOf(name) { return (name || '').trim().toLowerCase().replace(/\s*fc$/, ''); }
  function ensure(name, logo) {
    var k = keyOf(name);
    if (!k) return null;
    if (!teams[k]) {
      teams[k] = { team: normTeam((name || '').trim()), logo: logo || null,
                   p:0, w:0, d:0, l:0, gf:0, ga:0, gd:0, pts:0, _form: [] };
    }
    if (!teams[k].logo && logo) teams[k].logo = logo;
    return teams[k];
  }

  fixtures.forEach(function(f) {
    var home = ensure(f.home_team_name, f.home_team_logo);
    var away = ensure(f.away_team_name, f.away_team_logo);
    if (!home || !away) return;

    var isFT = FT_STATUSES.indexOf(f.status) > -1;
    if (!isFT || f.home_score == null || f.away_score == null) return;

    var hs = Number(f.home_score), as = Number(f.away_score);
    if (isNaN(hs) || isNaN(as)) return;

    home.p++; away.p++;
    home.gf += hs; home.ga += as;
    away.gf += as; away.ga += hs;

    if (hs > as)      { home.w++; home.pts += 3; away.l++; home._form.push('W'); away._form.push('L'); }
    else if (hs < as) { away.w++; away.pts += 3; home.l++; home._form.push('L'); away._form.push('W'); }
    else              { home.d++; away.d++; home.pts += 1; away.pts += 1; home._form.push('D'); away._form.push('D'); }
  });

  var standings = Object.keys(teams).map(function(k) {
    var t = teams[k];
    t.gd = t.gf - t.ga;
    t.form = t._form.slice(-5); // last 5 results, chronological
    delete t._form;
    return t;
  });

  standings.sort(sortStandings);
  standings.forEach(function(s, i) { s.pos = i + 1; });
  return standings;
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

// ══════════════════════════════════════════════════════════════════════
// INJURIES — Pro tier: current injuries for PSL (or specific team)
// GET /api/football?type=injuries[&team=teamId]
// ══════════════════════════════════════════════════════════════════════
async function getInjuries(teamId) {
  var cacheKey = 'injuries_' + (teamId || 'all');
  var cached = fromCache(cacheKey);
  if (cached) return cached;
  var sy  = await seasonYear();
  var ep  = teamId
    ? '/injuries?league=' + PSL_LEAGUE + '&season=' + sy + '&team=' + teamId
    : '/injuries?league=' + PSL_LEAGUE + '&season=' + sy;
  var data = await apiFetch(ep, TOKEN);
  var result = {
    type: 'injuries', season: sy,
    injuries: (data.response || []).map(function(r) {
      return {
        player_id:    r.player && r.player.id,
        player_name:  r.player && r.player.name,
        player_photo: r.player && r.player.photo,
        team_name:    r.team && r.team.name,
        team_logo:    r.team && r.team.logo,
        fixture_date: r.fixture && r.fixture.date,
        type:         r.player && r.player.type,
        reason:       r.player && r.player.reason,
      };
    }),
    fetched_at: new Date().toISOString(),
  };
  TTL[cacheKey] = 30 * 60 * 1000;
  return toCache(cacheKey, result);
}

// ══════════════════════════════════════════════════════════════════════
// PLAYER STATS — Pro tier: season stats for one player
// GET /api/football?type=player_stats&player_id=123&season=2025
// ══════════════════════════════════════════════════════════════════════
async function getPlayerStats(playerId, season) {
  if (!playerId) throw new Error('player_id required');
  var sy = season || await seasonYear();
  var cacheKey = 'pstats_' + playerId + '_' + sy;
  var cached = fromCache(cacheKey);
  if (cached) return cached;
  var data = await apiFetch('/players?id=' + playerId + '&league=' + PSL_LEAGUE + '&season=' + sy, TOKEN);
  var resp   = (data.response || [])[0] || {};
  var player = resp.player || {};
  var stats  = (resp.statistics || [])[0] || {};
  var result = {
    type: 'player_stats', player_id: playerId, season: sy,
    name: player.name, age: player.age, photo: player.photo,
    nationality: player.nationality,
    position:    stats.games && stats.games.position,
    team:        stats.team && stats.team.name,
    stats: {
      appearances:   stats.games && stats.games.appearences,
      minutes:       stats.games && stats.games.minutes,
      rating:        stats.games && stats.games.rating,
      goals:         stats.goals && stats.goals.total,
      assists:       stats.goals && stats.goals.assists,
      shots_total:   stats.shots && stats.shots.total,
      shots_on:      stats.shots && stats.shots.on,
      key_passes:    stats.passes && stats.passes.key,
      pass_accuracy: stats.passes && stats.passes.accuracy,
      tackles:       stats.tackles && stats.tackles.total,
      interceptions: stats.tackles && stats.tackles.interceptions,
      yellow_cards:  stats.cards && stats.cards.yellow,
      red_cards:     stats.cards && stats.cards.red,
      saves:         stats.goals && stats.goals.saves,
      penalty_saved: stats.penalty && stats.penalty.saved,
    },
    fetched_at: new Date().toISOString(),
  };
  TTL[cacheKey] = 60 * 60 * 1000;
  return toCache(cacheKey, result);
}

// ══════════════════════════════════════════════════════════════════════
// PREDICTIONS — Pro tier: match prediction + H2H
// GET /api/football?type=predictions&fixture_id=123456
// ══════════════════════════════════════════════════════════════════════
async function getPredictions(fixtureId) {
  if (!fixtureId) throw new Error('fixture_id required');
  var cacheKey = 'pred_' + fixtureId;
  var cached = fromCache(cacheKey);
  if (cached) return cached;
  var data = await apiFetch('/predictions?fixture=' + fixtureId, TOKEN);
  var resp = (data.response || [])[0] || {};
  var result = {
    type: 'predictions', fixture_id: fixtureId,
    winner:     resp.predictions && resp.predictions.winner,
    advice:     resp.predictions && resp.predictions.advice,
    percent:    resp.predictions && resp.predictions.percent,
    home_form:  resp.teams && resp.teams.home && resp.teams.home.league && resp.teams.home.league.form,
    away_form:  resp.teams && resp.teams.away && resp.teams.away.league && resp.teams.away.league.form,
    h2h: (resp.h2h || []).slice(0, 5).map(function(m) {
      return {
        date:       m.fixture && m.fixture.date,
        home:       m.teams && m.teams.home && m.teams.home.name,
        away:       m.teams && m.teams.away && m.teams.away.name,
        home_score: m.goals && m.goals.home,
        away_score: m.goals && m.goals.away,
      };
    }),
    fetched_at: new Date().toISOString(),
  };
  TTL[cacheKey] = 60 * 60 * 1000;
  return toCache(cacheKey, result);
}

// ══════════════════════════════════════════════════════════════════════
// HEAD TO HEAD — Pro tier: last 10 meetings between two teams
// GET /api/football?type=h2h&h2h=33-34
// ══════════════════════════════════════════════════════════════════════
async function getH2H(h2hParam) {
  if (!h2hParam) throw new Error('h2h param required e.g. h2h=33-34');
  var cacheKey = 'h2h_' + h2hParam;
  var cached = fromCache(cacheKey);
  if (cached) return cached;
  var data = await apiFetch('/fixtures/headtohead?h2h=' + h2hParam + '&last=10', TOKEN);
  var result = {
    type: 'h2h', h2h: h2hParam,
    matches: (data.response || []).map(function(m) {
      var fix = m.fixture || {}, teams = m.teams || {}, goals = m.goals || {};
      return {
        fixture_id:   fix.id,
        date:         fix.date,
        status:       fix.status && fix.status.short,
        home:         teams.home && teams.home.name,
        away:         teams.away && teams.away.name,
        home_logo:    teams.home && teams.home.logo,
        away_logo:    teams.away && teams.away.logo,
        home_score:   goals.home,
        away_score:   goals.away,
        home_winner:  teams.home && teams.home.winner,
        away_winner:  teams.away && teams.away.winner,
      };
    }),
    fetched_at: new Date().toISOString(),
  };
  TTL[cacheKey] = 24 * 60 * 60 * 1000;
  return toCache(cacheKey, result);
}

// ══════════════════════════════════════════════════════════════════════
// PLAYER SEARCH — Pro tier: find player by name in PSL
// GET /api/football?type=player_search&name=Rayners
// ══════════════════════════════════════════════════════════════════════
async function searchPlayer(name) {
  if (!name) throw new Error('name required');
  var sy = await seasonYear();
  var cacheKey = 'psearch_' + name.toLowerCase().replace(/\s/g,'_');
  var cached = fromCache(cacheKey);
  if (cached) return cached;
  var data = await apiFetch('/players?search=' + encodeURIComponent(name) + '&league=' + PSL_LEAGUE + '&season=' + sy, TOKEN);
  var result = {
    type: 'player_search', query: name, season: sy,
    results: (data.response || []).slice(0, 10).map(function(r) {
      var p = r.player || {}, s = (r.statistics || [])[0] || {};
      return {
        id:       p.id,
        name:     p.name,
        age:      p.age,
        photo:    p.photo,
        team:     s.team && s.team.name,
        position: s.games && s.games.position,
        goals:    s.goals && s.goals.total,
        assists:  s.goals && s.goals.assists,
        rating:   s.games && s.games.rating,
      };
    }),
    fetched_at: new Date().toISOString(),
  };
  TTL[cacheKey] = 60 * 60 * 1000;
  return toCache(cacheKey, result);
}
