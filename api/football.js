// ══════════════════════════════════════════════════════════════════════════
// api/football.js  —  Fantasy PSL  —  Sportmonks Proxy  (v4 — Live First)
// ══════════════════════════════════════════════════════════════════════════
//
// ARCHITECTURE: Fetches directly from Sportmonks for fixtures/results/standings.
// No longer depends on Supabase fixtures table being synced — results are always
// live from Sportmonks, so stale data from Feb 2026 can never appear again.
//
// Supabase is ONLY used for: player_match_stats, player_season_stats lookups.
//
// ENDPOINTS:
//   GET /api/football?type=live            → live scores (60s in-memory cache)
//   GET /api/football?type=fixtures        → upcoming NS fixtures from Sportmonks
//   GET /api/football?type=results         → completed FT results from Sportmonks
//   GET /api/football?type=standings       → league table from Sportmonks
//   GET /api/football?type=topscorers      → top scorers from Supabase players table
//   GET /api/football?type=player_stats&fixture_id=XXX → from Supabase
//   GET /api/football?type=status          → health check
//
// ENV VARS:
//   SPORTMONKS_TOKEN     — Sportmonks API token
//   SUPABASE_URL         — Supabase project URL
//   SUPABASE_SERVICE_KEY — Supabase service role key
//   SPORTMONKS_SEASON_ID — (optional) hard-override season ID e.g. 26173
//
// PSL League ID: 806
// ══════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const { getSeasonId }  = require('./season-helper');

const TOKEN  = process.env.SPORTMONKS_TOKEN    || '';
const SB_URL = process.env.SUPABASE_URL        || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const PSL_ID = 806;
const BASE   = 'https://api.sportmonks.com/v3/football';

// In-memory caches — keyed by type, value: { data, ts }
const CACHE = {};
const TTL = {
  live:      60  * 1000,   //  1 min  — live scores
  fixtures:  5   * 60 * 1000,  //  5 min  — upcoming fixtures
  results:   10  * 60 * 1000,  // 10 min  — results (rarely change once FT)
  standings: 15  * 60 * 1000,  // 15 min  — table
};

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const type      = (req.query && req.query.type) || 'live';
  const fixtureId = req.query && req.query.fixture_id;

  if (!TOKEN) {
    return res.status(500).json({ error: 'SPORTMONKS_TOKEN not set in Vercel Environment Variables' });
  }

  try {
    switch (type) {
      case 'live':         return res.json(await getLive());
      case 'fixtures':     return res.json(await getFixtures());
      case 'results':      return res.json(await getResults());
      case 'standings_raw':
        // Debug: returns raw Sportmonks standings response so you can inspect the shape
        const sid2 = await seasonId();
        const raw  = await smGet('/standings/seasons/' + sid2 + '?include=participant');
        return res.json({ season_id: sid2, raw_data: (raw.data || []).slice(0, 2), fetched_at: new Date().toISOString() });
      case 'standings':    return res.json(await getStandings());
      case 'topscorers':   return res.json(await getTopScorers());
      case 'player_stats':
        if (!fixtureId) return res.status(400).json({ error: 'fixture_id required' });
        return res.json(await getPlayerStats(fixtureId));
      case 'seasons':      return res.json(await getSeasons());
      case 'status':       return res.json(await getStatus());
      default:
        return res.status(400).json({ error: 'Unknown type: ' + type });
    }
  } catch (err) {
    console.error('[football.js]', type, err.message);
    return res.status(500).json({ error: err.message, type });
  }
};

// ── Cache helper ──────────────────────────────────────────────────────────
function fromCache(key) {
  const c = CACHE[key];
  if (c && (Date.now() - c.ts) < (TTL[key] || 300000)) return c.data;
  return null;
}
function toCache(key, data) {
  CACHE[key] = { data, ts: Date.now() };
  return data;
}

// ── Supabase client ───────────────────────────────────────────────────────
function db() {
  if (!SB_URL || !SB_KEY) throw new Error('Supabase env vars not set');
  return createClient(SB_URL, SB_KEY);
}

// ── Season ID helper ──────────────────────────────────────────────────────
async function seasonId() {
  const cached = fromCache('season_id');
  if (cached) return cached;
  const id = await getSeasonId(db(), TOKEN);
  toCache('season_id', id);
  return id;
}

// ══════════════════════════════════════════════════════════════════════════
// LIVE SCORES — straight from Sportmonks inplay endpoint
// ══════════════════════════════════════════════════════════════════════════
async function getLive() {
  const cached = fromCache('live');
  if (cached) return cached;

  const d = await smGet(
    '/livescores/inplay?include=participants;scores;state' +
    '&filters=fixtureLeagues:' + PSL_ID
  );
  const matches = (d.data || []).map(formatSMFixture);
  return toCache('live', {
    type: 'live', isLive: matches.length > 0,
    matches, fetched_at: new Date().toISOString()
  });
}

// ══════════════════════════════════════════════════════════════════════════
// UPCOMING FIXTURES — fetched directly from Sportmonks (state 1 = NS)
// ══════════════════════════════════════════════════════════════════════════
async function getFixtures() {
  const cached = fromCache('fixtures');
  if (cached) return cached;

  // PRIMARY: Supabase fixtures table (admin enters/syncs these)
  // This is always accurate because you control it
  if (SB_URL && SB_KEY) {
    try {
      const { data, error } = await db()
        .from('fixtures')
        .select('*')
        .eq('status', 'NS')
        .order('kickoff_at', { ascending: true })
        .limit(50);
      if (!error && data && data.length) {
        const fixtures = data.map(formatSupabaseFixture);
        return toCache('fixtures', { type: 'fixtures', fixtures, source: 'supabase', fetched_at: new Date().toISOString() });
      }
    } catch(e) { console.warn('[fixtures] Supabase error:', e.message); }
  }

  // FALLBACK: Sportmonks upcoming fixtures (state 1 = NS)
  try {
    const sid = await seasonId();
    const d = await smGet(
      '/fixtures?filters=fixtureSeasons:' + sid + ';fixtureStates:1' +
      '&include=participants;round' +
      '&sortBy=starting_at&order=asc' +
      '&per_page=50&page=1'
    );
    const fixtures = (d.data || []).map(function(f) { return formatSMFixture(f, 'NS'); });
    return toCache('fixtures', { type: 'fixtures', fixtures, source: 'sportmonks', fetched_at: new Date().toISOString() });
  } catch(e) {
    console.warn('[fixtures] Sportmonks error:', e.message);
    return toCache('fixtures', { type: 'fixtures', fixtures: [], fetched_at: new Date().toISOString() });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// RESULTS — Supabase PRIMARY (admin-entered), Sportmonks fallback
// Sportmonks only has 50 PSL fixtures indexed (Aug–Feb 2026).
// All matches from Feb onwards must be entered manually via admin panel.
// ══════════════════════════════════════════════════════════════════════════
async function getResults() {
  const cached = fromCache('results');
  if (cached) return cached;

  let results = [];

  // PRIMARY: Supabase fixtures table — admin enters results here
  // These are always current and accurate
  if (SB_URL && SB_KEY) {
    try {
      const { data, error } = await db()
        .from('fixtures')
        .select('*')
        .eq('status', 'FT')
        .order('kickoff_at', { ascending: false })
        .limit(60);
      if (!error && data && data.length) {
        results = data.map(formatSupabaseFixture);
        return toCache('results', { type: 'results', results, source: 'supabase', fetched_at: new Date().toISOString() });
      }
    } catch(e) { console.warn('[results] Supabase error:', e.message); }
  }

  // FALLBACK: Sportmonks (only has Aug–Feb data, better than nothing)
  try {
    const sid = await seasonId();
    const allResults = [];
    for (let page = 1; page <= 2; page++) {
      const d = await smGet(
        '/fixtures?filters=fixtureSeasons:' + sid + ';fixtureStates:5' +
        '&include=participants;scores' +
        '&sortBy=starting_at&order=desc' +
        '&per_page=50&page=' + page
      );
      const rows = d.data || [];
      if (!rows.length) break;
      allResults.push(...rows);
      if (!(d.meta && d.meta.pagination && d.meta.pagination.has_next_page)) break;
    }
    results = allResults.map(function(f) {
      const scores = extractScores(f.scores || []);
      return formatSMFixture(f, 'FT', scores.home, scores.away);
    });
    results.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });
  } catch(e) { console.warn('[results] Sportmonks fallback error:', e.message); }

  return toCache('results', { type: 'results', results, source: 'sportmonks_fallback', fetched_at: new Date().toISOString() });
}

// ══════════════════════════════════════════════════════════════════════════
// STANDINGS — fetched from Sportmonks, also written to Supabase for cron use
// ══════════════════════════════════════════════════════════════════════════
async function getStandings() {
  const cached = fromCache('standings');
  if (cached) return cached;

  const sid = await seasonId();

  // Include participant so we get team name + logo
  const d    = await smGet('/standings/seasons/' + sid + '?include=participant');
  const rows = flattenStandings(d.data || []);

  if (!rows.length) {
    // Sportmonks returned empty — return null so frontend uses REAL_TABLE fallback
    return toCache('standings', { type: 'standings', standings: [], fetched_at: new Date().toISOString() });
  }

  // Persist to Supabase for cron use
  if (SB_URL && SB_KEY) {
    try { await db().from('standings').upsert(rows, { onConflict: 'id' }); } catch(e) {}
  }

  const standings = rows.map(formatStandingRow);
  return toCache('standings', { type: 'standings', standings, fetched_at: new Date().toISOString() });
}

// ══════════════════════════════════════════════════════════════════════════
// TOP SCORERS — from Supabase players table (populated by import-players + PSL_ROSTER)
// Only falls back to Sportmonks if DB has nothing at all
// ══════════════════════════════════════════════════════════════════════════
async function getTopScorers() {
  const cached = fromCache('topscorers');
  if (cached) return cached;

  // Read from Supabase players table — this has the PSL_ROSTER stats
  // (goals, apps etc set during import or manually updated)
  if (SB_URL && SB_KEY) {
    try {
      const { data } = await db()
        .from('players')
        .select('display_name, team, goals, apps, total_points, photo')
        .gt('goals', 0)
        .order('goals', { ascending: false })
        .limit(30);

      if (data && data.length >= 5) {
        const topScorers = data.map(function(p, i) {
          return {
            rank:  i + 1,
            name:  p.display_name || 'Unknown',
            club:  p.team || '',
            goals: p.goals || 0,
            apps:  p.apps  || 0,
            photo: p.photo || null
          };
        });
        return toCache('topscorers', { type: 'topscorers', topScorers, source: 'supabase', fetched_at: new Date().toISOString() });
      }
    } catch(e) {
      console.warn('[topscorers] Supabase error:', e.message);
    }
  }

  // Fallback: Sportmonks topscorers endpoint (may be incomplete)
  try {
    const sid = await seasonId();
    const d   = await smGet('/topscorers/seasons/' + sid + '?include=player;participant&limit=20');
    const topScorers = (d.data || []).map(function(s, i) {
      const p = s.player || {};
      return {
        rank:  i + 1,
        name:  p.display_name || p.name || 'Unknown',
        club:  (s.participant && s.participant.name) || '',
        goals: s.total || 0,
        apps:  s.appearances || 0
      };
    });
    if (topScorers.length) {
      return toCache('topscorers', { type: 'topscorers', topScorers, source: 'sportmonks', fetched_at: new Date().toISOString() });
    }
  } catch(e) {
    console.warn('[topscorers] Sportmonks error:', e.message);
  }

  // Last resort: empty
  return toCache('topscorers', { type: 'topscorers', topScorers: [], fetched_at: new Date().toISOString() });
}

// ══════════════════════════════════════════════════════════════════════════
// PLAYER STATS — from Supabase player_match_stats table
// ══════════════════════════════════════════════════════════════════════════
async function getPlayerStats(fixtureId) {
  const { data, error } = await db()
    .from('player_match_stats')
    .select('*')
    .eq('fixture_id', fixtureId);
  if (error) throw new Error('player_stats: ' + error.message);
  return {
    type: 'player_stats',
    fixture_id: parseInt(fixtureId, 10),
    players: data || [],
    fetched_at: new Date().toISOString()
  };
}

// ══════════════════════════════════════════════════════════════════════════
// SEASONS DEBUG — lists all PSL seasons so you can find the correct ID
// Visit: /api/football?type=seasons
// ══════════════════════════════════════════════════════════════════════════
async function getSeasons() {
  // Check what /leagues/806 says the current season is
  let leagueCurrentId = null;
  try {
    const ld = await smGet('/leagues/' + PSL_ID);
    leagueCurrentId = (ld.data || {}).current_season_id || null;
  } catch(e) {}

  // List all seasons for PSL league
  const pslSeasons = [];
  for (let page = 1; page <= 5; page++) {
    const d = await smGet('/seasons?per_page=100&page=' + page);
    const rows = d.data || [];
    if (!rows.length) break;
    rows.forEach(function(s) {
      if (s.league_id === PSL_ID) {
        pslSeasons.push({ id: s.id, name: s.name, is_current: s.is_current, league_id: s.league_id });
      }
    });
    if (!(d.meta && d.meta.pagination && d.meta.pagination.has_next_page)) break;
  }

  // Sort newest first
  pslSeasons.sort(function(a, b) { return b.id - a.id; });

  const envSeasonId = process.env.SPORTMONKS_SEASON_ID || null;

  return {
    type: 'seasons',
    action_required: !envSeasonId,
    instruction: envSeasonId
      ? 'SPORTMONKS_SEASON_ID env var is set to ' + envSeasonId + '. Change it in Vercel if wrong.'
      : 'Set SPORTMONKS_SEASON_ID in Vercel env vars to the correct season ID from the list below, then redeploy.',
    league_current_season_id: leagueCurrentId,
    env_season_id: envSeasonId,
    psl_seasons: pslSeasons,
    fetched_at: new Date().toISOString()
  };
}

// ══════════════════════════════════════════════════════════════════════════
// STATUS / HEALTH CHECK
// ══════════════════════════════════════════════════════════════════════════
async function getStatus() {
  const status = {
    ok: true, provider: 'Sportmonks v3',
    token_set: !!TOKEN,
    psl_league_id: PSL_ID,
    supabase_configured: !!(SB_URL && SB_KEY),
    checked_at: new Date().toISOString()
  };
  try {
    const d = await smGet('/leagues/' + PSL_ID);
    status.league_name = d.data && d.data.name;
    status.current_season_id = d.data && d.data.current_season_id;
    status.league_ok = true;
  } catch(e) {
    status.league_ok    = false;
    status.league_error = e.message;
  }
  return status;
}

// ══════════════════════════════════════════════════════════════════════════
// FORMAT HELPERS
// ══════════════════════════════════════════════════════════════════════════

// Maps any team name variant to the Sportmonks canonical name used in the app
const TEAM_NAME_MAP = {
  'Mamelodi Sundowns FC': 'Mamelodi Sundowns',
  'Orlando Pirates FC':   'Orlando Pirates',
  'Kaizer Chiefs FC':     'Kaizer Chiefs',
  'AmaZulu FC':           'AmaZulu',
  'Sekhukhune United FC': 'Sekhukhune United',
  'Stellenbosch FC':      'Stellenbosch',
  'Polokwane City FC':    'Polokwane City',
  'Durban City FC':       'Durban City',
  'TS Galaxy FC':         'TS Galaxy',
  'Lamontville Golden Arrows FC': 'Golden Arrows',
  'Golden Arrows FC':     'Golden Arrows',
  'Chippa United FC':     'Chippa United',
  'Richards Bay FC':      'Richards Bay',
  'Siwelele FC':          'Siwelele',
  'Magesi FC':            'Magesi',
  'Orbit College FC':     'Orbit College',
  'Marumo Gallants':      'Marumo Gallants FC',
  'Cape Town Spurs FC':   'Cape Town Spurs',
  'Cape Town City FC':    'Cape Town City',
};

function normTeam(name) {
  return TEAM_NAME_MAP[name] || name;
}

// ── Format Supabase fixtures row → standard fixture shape ─────────────────
// Used when Supabase is the primary data source (admin-entered results)
function formatSupabaseFixture(f) {
  const isLive = f.status === 'LIVE' || f.status === '1H' || f.status === '2H' || f.status === 'HT';
  const isFT   = f.status === 'FT';
  return {
    fixture_id:    f.sportmonks_id || f.id,
    sportmonks_id: f.sportmonks_id || f.id,
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

function formatSMFixture(f, statusOverride, hgOverride, agOverride) {
  const parts  = f.participants || [];
  const home   = parts.find(function(p) { return p.meta && p.meta.location === 'home'; }) || parts[0] || {};
  const away   = parts.find(function(p) { return p.meta && p.meta.location === 'away'; }) || parts[1] || {};

  let hg = hgOverride !== undefined ? hgOverride : null;
  let ag = agOverride !== undefined ? agOverride : null;

  // Parse scores if not provided as override
  if (hg === null && ag === null) {
    (f.scores || []).forEach(function(s) {
      if (!s.score) return;
      const desc = (s.description || '').toUpperCase();
      if (['CURRENT','2ND_HALF','FULLTIME','FT'].indexOf(desc) > -1) {
        if (s.score.participant === 'home') hg = s.score.goals;
        if (s.score.participant === 'away') ag = s.score.goals;
      }
    });
  }

  const state  = f.state || {};
  const rawStatus = statusOverride || (state.short_name || state.state || 'NS').toUpperCase();
  const status = rawStatus === '5' ? 'FT' : rawStatus === '1' ? 'NS' : rawStatus;

  const isLive = status === 'LIVE' || status === '1H' || status === '2H' || status === 'HT';
  const isFT   = status === 'FT';

  return {
    fixture_id:   f.id,
    sportmonks_id: f.id,
    status,
    date:         f.starting_at,
    home:         normTeam(home.name || ''),
    away:         normTeam(away.name || ''),
    home_logo:    home.image_path || '',
    away_logo:    away.image_path || '',
    hg:           hg,
    ag:           ag,
    is_live:      isLive,
    is_ft:        isFT,
    elapsed:      f.minute || null,
    round:        (f.round && f.round.name) || null
  };
}

function extractScores(scores) {
  let home = null, away = null;
  scores.forEach(function(s) {
    const desc = (s.description || '').toUpperCase();
    if (['CURRENT','FT','FULLTIME','2ND_HALF'].indexOf(desc) > -1) {
      if (s.score && s.score.participant === 'home') home = s.score.goals;
      if (s.score && s.score.participant === 'away') away = s.score.goals;
    }
  });
  return { home, away };
}

function formatStandingRow(s) {
  return {
    pos:  s.position,
    team: normTeam(s.team_name || ''),
    logo: s.team_logo || null,
    p:    s.played   || 0,
    w:    s.won      || 0,
    d:    s.drawn    || 0,
    l:    s.lost     || 0,
    gf:   s.goals_for     || 0,
    ga:   s.goals_against || 0,
    gd:   s.goal_diff     || 0,
    pts:  s.points   || 0,
    form: s.form ? s.form.split(',').slice(-5) : []
  };
}

function flattenStandings(data) {
  const rows = [];

  // Sportmonks v3 /standings/seasons/{id}?include=participant
  // Top-level data[] is an array of standing rule groups.
  // Each group has a .standings[] array of team position rows.
  // Each row: { id, participant_id, position, points, participant:{name,image_path,...}, details:[] }
  // Note: played/won/drawn/lost come from details[] with type_ids, OR from a
  // separate ?include=participant.details call. With basic include=participant
  // we only reliably get: position, points, participant.name, participant.image_path

  data.forEach(function(group) {
    const items = Array.isArray(group.standings) ? group.standings
                : group.position                  ? [group]
                : [];

    items.forEach(function(s) {
      const part = s.participant || {};
      const det  = s.details || [];

      // Safely read a detail value by type_id
      function dv(tid) {
        const d = det.find(function(x) { return x.type_id === tid; });
        return d ? (parseFloat(d.value) || 0) : 0;
      }

      const teamName = part.name || s.team_name || '';
      if (!teamName) return; // skip empty rows

      // Stats from details (populated if Sportmonks includes them)
      // Fall back to 0 — frontend will merge with REAL_TABLE form/played data
      const played = dv(129) || s.games_played || 0;
      const won    = dv(130) || s.won    || 0;
      const drawn  = dv(131) || s.draw   || s.drawn || 0;
      const lost   = dv(132) || s.lost   || 0;
      const gf     = dv(133) || s.goals_for     || s.goals_scored   || 0;
      const ga     = dv(134) || s.goals_against || s.goals_conceded || 0;
      const gd     = dv(135) || s.goal_difference || (gf - ga) || 0;

      rows.push({
        id:            s.participant_id || part.id || s.id,
        team_name:     normTeam(teamName),
        team_logo:     part.image_path || null,
        position:      s.position || rows.length + 1,
        played, won, drawn, lost,
        goals_for:     gf,
        goals_against: ga,
        goal_diff:     gd,
        points:        s.points || 0,
        form:          Array.isArray(s.form) ? s.form.slice(-5).join(',') : (s.form || ''),
        updated_at:    new Date().toISOString()
      });
    });
  });

  rows.sort(function(a, b) { return a.position - b.position; });
  return rows;
}

// ── Sportmonks GET helper ─────────────────────────────────────────────────
async function smGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = BASE + path + sep + 'api_token=' + TOKEN;
  console.log('[SM] GET', BASE + path.split('?')[0]);
  const r = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (!r.ok) {
    const body = await r.text().catch(function() { return ''; });
    throw new Error('Sportmonks HTTP ' + r.status + ': ' + body.substring(0, 300));
  }
  const json = await r.json();
  if (json.errors) throw new Error('Sportmonks error: ' + JSON.stringify(json.errors).substring(0, 300));
  return json;
}

// Export scoring helpers for points-cron.js
const { calculateFantasyPoints, normalisePosition } = require('./football_scoring');
module.exports.calculateFantasyPoints = calculateFantasyPoints;
module.exports.normalisePosition      = normalisePosition;
