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
      case 'live':       return res.json(await getLive());
      case 'fixtures':   return res.json(await getFixtures());
      case 'results':    return res.json(await getResults());
      case 'standings':  return res.json(await getStandings());
      case 'topscorers': return res.json(await getTopScorers());
      case 'status':     return res.json(await getStatus());
      default:           return res.status(400).json({ error: 'Unknown type: ' + type });
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
        .eq('status', 'NS').order('kickoff_at', { ascending: true }).limit(50);
      if (!res.error && res.data && res.data.length) {
        return toCache('fixtures', {
          type: 'fixtures',
          fixtures: res.data.map(formatSupabaseFixture),
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
