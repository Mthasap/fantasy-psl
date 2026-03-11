// ══════════════════════════════════════════════════════════════════════════
// api/football.js  —  Fantasy PSL  —  API-Football Proxy
// ══════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Acts as a server-side cache between your users and API-Football.
//   - Every user calls /api/football  (your Vercel server)
//   - This function calls api-football.com  (at most once per 55 seconds)
//   - All users share the same cached response
//   - Result: 1,000,000 users = same API quota usage as 1 user
//
// ENDPOINTS:
//   GET /api/football?type=live            → live scores (cached 55s)
//   GET /api/football?type=fixtures        → upcoming fixtures (cached 10min)
//   GET /api/football?type=results         → recent results (cached 10min)
//   GET /api/football?type=player_stats&fixture_id=XXX → post-match stats (cached 30min)
//   GET /api/football?type=status          → quota remaining today
//
// ENVIRONMENT VARIABLES (set in Vercel dashboard):
//   API_FOOTBALL_KEY  — your API-Football key
//
// ══════════════════════════════════════════════════════════════════════════

const API_KEY    = process.env.API_FOOTBALL_KEY || '';
const PSL_LEAGUE = 288;    // Betway Premiership
const SEASON     = 2024;   // API-Football uses season start year (2024 = 2024/25)
const BASE_URL   = 'https://v3.football.api-sports.io';

// ── In-memory cache (shared across requests to same Vercel instance) ──────
const CACHE = {
  live:         { data: null, ts: 0, ttl: 55  * 1000 },   // 55 seconds
  fixtures:     { data: null, ts: 0, ttl: 10  * 60 * 1000 }, // 10 minutes
  results:      { data: null, ts: 0, ttl: 10  * 60 * 1000 }, // 10 minutes
  player_stats: {}  // keyed by fixture_id, each entry has its own TTL
};

// ── Quota guard — tracks usage from API response headers ─────────────────
let quotaRemaining = 100; // updated from every API response header

// ══════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const type      = (req.query && req.query.type) || 'live';
  const fixtureId = req.query && req.query.fixture_id;

  try {
    switch (type) {
      case 'live':
        return res.json(await getLive());

      case 'fixtures':
        return res.json(await getFixtures());

      case 'results':
        return res.json(await getResults());

      case 'player_stats':
        if (!fixtureId) return res.status(400).json({ error: 'fixture_id is required for player_stats' });
        return res.json(await getPlayerStats(fixtureId));

      case 'status':
        return res.json({
          quota_remaining: quotaRemaining,
          quota_limit: 100,
          quota_used: 100 - quotaRemaining,
          note: 'Free plan: 100 requests per day, resets at midnight UTC'
        });

      default:
        return res.status(400).json({ error: 'Unknown type. Use: live, fixtures, results, player_stats, status' });
    }
  } catch (err) {
    console.error('[football.js]', type, err.message);
    // Return stale cache on error rather than a broken response
    const stale = CACHE[type] && CACHE[type].data;
    if (stale) return res.json(Object.assign({}, stale, { stale: true, error: err.message }));
    return res.status(500).json({ error: err.message, type });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// LIVE SCORES
// Polls API-Football for any currently live PSL matches.
// Cached for 55 seconds — all concurrent users share one cached answer.
// ══════════════════════════════════════════════════════════════════════════
async function getLive() {
  if (isFresh(CACHE.live)) return CACHE.live.data;

  const raw = await apiGet('/fixtures', { league: PSL_LEAGUE, season: SEASON, live: 'all' });
  const matches = (raw.response || []).map(formatFixture);

  const result = {
    type:    'live',
    isLive:  matches.length > 0,
    matches,
    quota_remaining: raw._quota_remaining,
    fetched_at: new Date().toISOString()
  };

  CACHE.live = { data: result, ts: Date.now(), ttl: 55 * 1000 };
  return result;
}

// ══════════════════════════════════════════════════════════════════════════
// UPCOMING FIXTURES
// ══════════════════════════════════════════════════════════════════════════
async function getFixtures() {
  if (isFresh(CACHE.fixtures)) return CACHE.fixtures.data;

  // status=NS means Not Started; TBD means date not confirmed yet
  const raw = await apiGet('/fixtures', {
    league: PSL_LEAGUE,
    season: SEASON,
    status: 'NS-TBD',
    next:   30
  });

  const fixtures = (raw.response || []).map(formatFixture);
  const result   = { type: 'fixtures', fixtures, fetched_at: new Date().toISOString() };

  CACHE.fixtures = { data: result, ts: Date.now(), ttl: 10 * 60 * 1000 };
  return result;
}

// ══════════════════════════════════════════════════════════════════════════
// RECENT RESULTS
// ══════════════════════════════════════════════════════════════════════════
async function getResults() {
  if (isFresh(CACHE.results)) return CACHE.results.data;

  // FT = Full Time, AET = After Extra Time, PEN = After Penalties
  const raw = await apiGet('/fixtures', {
    league: PSL_LEAGUE,
    season: SEASON,
    status: 'FT-AET-PEN',
    last:   20
  });

  const results = (raw.response || []).map(formatFixture);
  const result  = { type: 'results', results, fetched_at: new Date().toISOString() };

  CACHE.results = { data: result, ts: Date.now(), ttl: 10 * 60 * 1000 };
  return result;
}

// ══════════════════════════════════════════════════════════════════════════
// PLAYER STATS FOR ONE SPECIFIC MATCH
//
// This is what powers the points engine. Called with a fixture_id after
// a match finishes. Returns every player's stats + their calculated
// fantasy points for that match.
//
// The cron job (points-cron.js) calls this internally — users' browsers
// never need to call it directly.
// ══════════════════════════════════════════════════════════════════════════
async function getPlayerStats(fixtureId) {
  const cacheKey = String(fixtureId);

  if (CACHE.player_stats[cacheKey] && isFresh(CACHE.player_stats[cacheKey])) {
    return CACHE.player_stats[cacheKey].data;
  }

  const raw   = await apiGet('/fixtures/players', { fixture: fixtureId });
  const teams = raw.response || [];

  if (!teams.length) {
    throw new Error('No player data returned for fixture ' + fixtureId + '. Match may not be finished yet.');
  }

  // API returns two objects (one per team). We flatten into one player array.
  const allPlayers = [];

  teams.forEach(function(teamData) {
    const teamName = teamData.team && teamData.team.name ? teamData.team.name : 'Unknown';

    // Count how many goals this team's players conceded (for clean sheet calc)
    // We get this from the other team's goals, but API gives us goals_conceded per player
    (teamData.players || []).forEach(function(entry) {
      const player = entry.player || {};
      const stats  = (entry.statistics && entry.statistics[0]) || {};

      const parsed = parsePlayerStats(stats, player, teamName);
      allPlayers.push(parsed);
    });
  });

  const result = {
    type:       'player_stats',
    fixture_id: parseInt(fixtureId, 10),
    players:    allPlayers,
    fetched_at: new Date().toISOString()
  };

  // Cache completed match stats for 30 minutes (stats won't change after FT)
  CACHE.player_stats[cacheKey] = { data: result, ts: Date.now(), ttl: 30 * 60 * 1000 };
  return result;
}

// ══════════════════════════════════════════════════════════════════════════
// PARSE ONE PLAYER'S STATS FROM API-FOOTBALL FORMAT
// and calculate their fantasy points for this match
// ══════════════════════════════════════════════════════════════════════════
function parsePlayerStats(stats, player, teamName) {
  // API-Football position codes: 'Goalkeeper', 'Defender', 'Midfielder', 'Attacker'
  // We normalise these to: GK, DEF, MID, FWD
  const posRaw = (stats.games && stats.games.position) || '';
  const pos    = normalisePosition(posRaw);

  const minutes        = (stats.games  && stats.games.minutes)           || 0;
  const goals          = (stats.goals  && stats.goals.total)             || 0;
  const assists        = (stats.goals  && stats.goals.assists)           || 0;
  const saves          = (stats.goals  && stats.goals.saves)             || 0;
  const goalsConceded  = (stats.goals  && stats.goals.conceded)          || 0;
  const yellowCards    = (stats.cards  && stats.cards.yellow)            || 0;
  const redCards       = (stats.cards  && stats.cards.red)               || 0;
  const penSaved       = (stats.penalty && stats.penalty.saved)          || 0;
  const penMissed      = (stats.penalty && stats.penalty.missed)         || 0;

  const pts = calculateFantasyPoints({
    pos, minutes, goals, assists, saves, goalsConceded,
    yellowCards, redCards, penSaved, penMissed
  });

  return {
    api_player_id:    player.id   || null,
    player_name:      player.name || 'Unknown',
    team:             teamName,
    position:         pos,
    // Raw stats (stored in player_gw_stats table)
    minutes,
    goals,
    assists,
    yellow_cards:     yellowCards,
    red_cards:        redCards,
    saves,
    goals_conceded:   goalsConceded,
    penalties_saved:  penSaved,
    penalties_missed: penMissed,
    // Calculated fantasy points
    fantasy_points:   pts.total,
    points_breakdown: pts.breakdown
  };
}

// ══════════════════════════════════════════════════════════════════════════
// FANTASY POINTS CALCULATION ENGINE
//
// This is the single source of truth for how points are calculated.
// Both the API proxy (for display) and the cron job (for Supabase writes)
// use this exact same function — ensuring they always agree.
//
// POINTS SYSTEM (EPL FPL-style, adapted for PSL):
//   Appearance (1–59 min):      +1 pt
//   Appearance (60+ min):       +2 pts
//   Goal scored by GK or DEF:   +6 pts
//   Goal scored by MID:         +5 pts
//   Goal scored by FWD:         +4 pts
//   Assist:                     +3 pts
//   Clean sheet, GK or DEF:     +4 pts  (must play 60+ min, team concede 0)
//   Clean sheet, MID:           +1 pt   (must play 60+ min, team concede 0)
//   Every 3 saves by GK:        +1 pt
//   Penalty saved by GK:        +5 pts
//   Penalty missed:             -2 pts
//   Yellow card:                -1 pt
//   Red card:                   -3 pts
//   Every 2 goals conceded
//     by GK or DEF:             -1 pt
//   Captain: points × 2
//   Vice-captain (if cap DNP):  points × 2
// ══════════════════════════════════════════════════════════════════════════
function calculateFantasyPoints(s) {
  const breakdown = {};
  let   total     = 0;

  function add(key, val) {
    if (val !== 0) { breakdown[key] = val; total += val; }
  }

  // ── Appearance ──────────────────────────────────────────────────────────
  if (s.minutes >= 60) {
    add('appearance', 2);
  } else if (s.minutes > 0) {
    add('appearance', 1);
  }
  // Did not play at all → 0 points total, return early
  if (s.minutes === 0) return { total: 0, breakdown: { appearance: 0 } };

  // ── Goals scored ─────────────────────────────────────────────────────────
  if (s.goals > 0) {
    const gPts = s.pos === 'GK'  ? s.goals * 6
               : s.pos === 'DEF' ? s.goals * 6
               : s.pos === 'MID' ? s.goals * 5
               :                   s.goals * 4; // FWD
    add('goals', gPts);
  }

  // ── Assists ───────────────────────────────────────────────────────────────
  if (s.assists > 0) add('assists', s.assists * 3);

  // ── Clean sheet (only for players who played 60+ minutes) ────────────────
  // goalsConceded is the number of goals the player's team conceded while they played
  // API-Football gives this as stats.goals.conceded for the individual player
  if (s.minutes >= 60 && s.goalsConceded === 0) {
    if (s.pos === 'GK' || s.pos === 'DEF') add('clean_sheet', 4);
    else if (s.pos === 'MID')              add('clean_sheet', 1);
    // FWD gets nothing for clean sheet
  }

  // ── Goals conceded penalty (GK and DEF only) ─────────────────────────────
  // -1 point for every 2 goals conceded (rounded down)
  if ((s.pos === 'GK' || s.pos === 'DEF') && s.goalsConceded >= 2) {
    add('goals_conceded', -Math.floor(s.goalsConceded / 2));
  }

  // ── Saves (GK) ───────────────────────────────────────────────────────────
  // +1 point for every 3 saves
  if (s.pos === 'GK' && s.saves >= 3) {
    add('saves_bonus', Math.floor(s.saves / 3));
  }

  // ── Penalties ────────────────────────────────────────────────────────────
  if (s.penSaved  > 0) add('penalty_saved',  s.penSaved  *  5);
  if (s.penMissed > 0) add('penalty_missed', s.penMissed * -2);

  // ── Cards ────────────────────────────────────────────────────────────────
  if (s.yellowCards > 0) add('yellow_card', s.yellowCards * -1);
  if (s.redCards    > 0) add('red_card',    s.redCards    * -3);

  return { total, breakdown };
}

// ══════════════════════════════════════════════════════════════════════════
// POSITION NORMALISER
// API-Football returns full English words. We normalise to our 4 codes.
// ══════════════════════════════════════════════════════════════════════════
function normalisePosition(raw) {
  if (!raw) return 'MID';
  const r = raw.toUpperCase().trim();
  if (r === 'GOALKEEPER'  || r === 'GK' || r === 'G') return 'GK';
  if (r === 'DEFENDER'    || r === 'DEF'|| r === 'D') return 'DEF';
  if (r === 'MIDFIELDER'  || r === 'MID'|| r === 'M') return 'MID';
  if (r === 'ATTACKER'    || r === 'FORWARD' || r === 'FWD' || r === 'F') return 'FWD';
  return 'MID'; // safe fallback
}

// ══════════════════════════════════════════════════════════════════════════
// FORMAT A FIXTURE FROM API-FOOTBALL RESPONSE
// ══════════════════════════════════════════════════════════════════════════
function formatFixture(f) {
  const fixture = f.fixture || {};
  const teams   = f.teams   || {};
  const goals   = f.goals   || {};
  const score   = f.score   || {};
  const status  = fixture.status || {};

  // Determine if match is currently live
  const liveStatuses = ['1H','HT','2H','ET','BT','P','INT','LIVE'];
  const isLive = liveStatuses.includes(status.short || '');

  return {
    fixture_id:  fixture.id,
    status:      status.short || 'NS',
    status_long: status.long  || 'Not Started',
    elapsed:     status.elapsed || null,
    is_live:     isLive,
    date:        fixture.date || null,   // ISO string with timezone
    venue:       (fixture.venue && fixture.venue.name) || '',
    home:        (teams.home && teams.home.name) || '',
    away:        (teams.away && teams.away.name) || '',
    home_logo:   (teams.home && teams.home.logo) || '',
    away_logo:   (teams.away && teams.away.logo) || '',
    hg:          goals.home !== undefined ? goals.home : null,
    ag:          goals.away !== undefined ? goals.away : null,
    ht_hg:       (score.halftime && score.halftime.home) || null,
    ht_ag:       (score.halftime && score.halftime.away) || null
  };
}

// ══════════════════════════════════════════════════════════════════════════
// API-FOOTBALL HTTP CLIENT
// Single function all API calls go through. Handles auth, error detection,
// quota tracking from response headers, and logging.
// ══════════════════════════════════════════════════════════════════════════
async function apiGet(endpoint, params) {
  if (!API_KEY) {
    throw new Error(
      'API_FOOTBALL_KEY is not set. ' +
      'Go to Vercel Dashboard → Your Project → Settings → Environment Variables ' +
      'and add API_FOOTBALL_KEY with your key: efd40a28aa4d2ed1758174bd319553d1'
    );
  }

  // Build URL with query string
  const qs  = new URLSearchParams(params).toString();
  const url = BASE_URL + endpoint + '?' + qs;

  console.log('[API-Football] GET', endpoint, params, '| quota remaining:', quotaRemaining);

  const response = await fetch(url, {
    method:  'GET',
    headers: {
      'x-apisports-key': API_KEY,
      // Some requests still need the RapidAPI host header
      'x-rapidapi-host': 'v3.football.api-sports.io'
    }
  });

  if (!response.ok) {
    throw new Error(
      'API-Football returned HTTP ' + response.status +
      ' for ' + endpoint +
      '. If 401: check your API key. If 429: daily quota exceeded.'
    );
  }

  const json = await response.json();

  // Update quota tracking from response headers
  const remaining = response.headers.get('x-ratelimit-requests-remaining');
  if (remaining !== null) {
    quotaRemaining = parseInt(remaining, 10);
    json._quota_remaining = quotaRemaining;
  }

  // API-Football returns errors inside the JSON body even on HTTP 200
  if (json.errors && typeof json.errors === 'object' && Object.keys(json.errors).length > 0) {
    const errMsg = JSON.stringify(json.errors);
    throw new Error('API-Football error response: ' + errMsg);
  }

  return json;
}

// ══════════════════════════════════════════════════════════════════════════
// CACHE HELPERS
// ══════════════════════════════════════════════════════════════════════════
function isFresh(entry) {
  if (!entry || !entry.data || !entry.ts || !entry.ttl) return false;
  return (Date.now() - entry.ts) < entry.ttl;
}

// Export the points calculator and normaliser so points-cron.js can import them
// without duplicating the logic
module.exports.calculateFantasyPoints = calculateFantasyPoints;
module.exports.normalisePosition      = normalisePosition;
