// ══════════════════════════════════════════════════════════════════════════
// api/football.js  —  Fantasy PSL  —  Sportmonks Proxy
// ══════════════════════════════════════════════════════════════════════════
// Serves live scores, fixtures and results to the frontend.
// All data comes from Sportmonks API v3.
// Cached in memory so thousands of users share one API call.
//
// ENDPOINTS:
//   GET /api/football?type=live       → live scores right now
//   GET /api/football?type=fixtures   → upcoming PSL fixtures
//   GET /api/football?type=results    → recent PSL results
//   GET /api/football?type=status     → API health check
//
// ENV VARS:
//   SPORTMONKS_TOKEN — your Sportmonks API token
// ══════════════════════════════════════════════════════════════════════════

const TOKEN    = process.env.SPORTMONKS_TOKEN || '';
const PSL_ID   = 806;   // Sportmonks league ID for Betway Premiership
const SM_BASE  = 'https://api.sportmonks.com/v3/football';

// In-memory cache shared across requests
const CACHE = {
  live:     { data: null, ts: 0, ttl: 60  * 1000 },        // 1 min
  fixtures: { data: null, ts: 0, ttl: 10  * 60 * 1000 },   // 10 min
  results:  { data: null, ts: 0, ttl: 10  * 60 * 1000 },   // 10 min
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const type = (req.query && req.query.type) || 'live';

  if (!TOKEN) return res.status(500).json({ error: 'SPORTMONKS_TOKEN not configured' });

  try {
    switch (type) {
      case 'live':     return res.json(await getLive());
      case 'fixtures': return res.json(await getFixtures());
      case 'results':  return res.json(await getResults());
      case 'status':   return res.json({ ok: true, token_set: !!TOKEN });
      default:         return res.status(400).json({ error: 'Unknown type: ' + type });
    }
  } catch (err) {
    console.error('[football.js]', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Sportmonks fetch helper ───────────────────────────────────────────────
async function smGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = SM_BASE + path + sep + 'api_token=' + TOKEN;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Sportmonks HTTP ' + r.status);
  const json = await r.json();
  if (json.message) throw new Error('Sportmonks: ' + json.message);
  return json;
}

// ── Cache helper ─────────────────────────────────────────────────────────
function fromCache(key) {
  const c = CACHE[key];
  return (c && c.data && (Date.now() - c.ts) < c.ttl) ? c.data : null;
}
function toCache(key, data) {
  CACHE[key] = { ...CACHE[key], data, ts: Date.now() };
  return data;
}

// ── Participant helpers ───────────────────────────────────────────────────
function getHome(participants) {
  return (participants || []).find(function(p) { return p.meta && p.meta.location === 'home'; }) || {};
}
function getAway(participants) {
  return (participants || []).find(function(p) { return p.meta && p.meta.location === 'away'; }) || {};
}
function getCurrentScore(scores, side) {
  const s = (scores || []).find(function(s) {
    return s.description === 'CURRENT' && s.score && s.score.participant === side;
  });
  return s ? s.score.goals : null;
}
function isFinished(state) {
  if (!state) return false;
  const n = (state.developer_name || state.name || '').toUpperCase();
  return n === 'FT' || n === 'FINISHED' || n === 'AET' || n === 'PEN';
}
function isLive(state) {
  if (!state) return false;
  const n = (state.developer_name || state.name || '').toUpperCase();
  return n === 'INPLAY' || n === 'HT' || n === 'LIVE' || n === '1ST' || n === '2ND';
}

// ── LIVE SCORES ───────────────────────────────────────────────────────────
async function getLive() {
  const cached = fromCache('live');
  if (cached) return cached;

  // Filter livescores by PSL league
  const json = await smGet('/livescores/inplay?include=participants;scores;state;periods&filters=fixtureLeagues:' + PSL_ID);
  const live = (json.data || []).map(function(f) {
    const home = getHome(f.participants);
    const away = getAway(f.participants);
    const min  = f.periods ? (f.periods[f.periods.length - 1] || {}).minutes || '' : '';
    return {
      id:        f.id,
      home:      home.name || '',
      away:      away.name || '',
      hg:        getCurrentScore(f.scores, 'home'),
      ag:        getCurrentScore(f.scores, 'away'),
      status:    'LIVE',
      minute:    min,
      state:     (f.state && f.state.name) || 'LIVE'
    };
  });

  return toCache('live', { live: live, ts: Date.now() });
}

// ── UPCOMING FIXTURES ─────────────────────────────────────────────────────
async function getFixtures() {
  const cached = fromCache('fixtures');
  if (cached) return cached;

  const json = await smGet('/fixtures/upcoming/leagues/' + PSL_ID + '?include=participants;round&per_page=50');
  const fixtures = (json.data || []).map(function(f) {
    const home = getHome(f.participants);
    const away = getAway(f.participants);
    // Extract GW number from round name
    let gw = null;
    if (f.round && f.round.name) {
      const m = (f.round.name + '').match(/(\d+)/);
      if (m) gw = parseInt(m[1]);
    }
    return {
      id:         f.id,
      home:       home.name || '',
      away:       away.name || '',
      kickoff_at: f.starting_at,
      status:     'NS',
      gw:         gw
    };
  });

  return toCache('fixtures', { NS: fixtures, ts: Date.now() });
}

// ── RECENT RESULTS ────────────────────────────────────────────────────────
async function getResults() {
  const cached = fromCache('results');
  if (cached) return cached;

  const json = await smGet('/fixtures/last/30/leagues/' + PSL_ID + '?include=participants;scores;state;round');
  const results = (json.data || [])
    .filter(function(f) { return isFinished(f.state); })
    .map(function(f) {
      const home = getHome(f.participants);
      const away = getAway(f.participants);
      let gw = null;
      if (f.round && f.round.name) {
        const m = (f.round.name + '').match(/(\d+)/);
        if (m) gw = parseInt(m[1]);
      }
      return {
        id:         f.id,
        home:       home.name || '',
        away:       away.name || '',
        hg:         getCurrentScore(f.scores, 'home'),
        ag:         getCurrentScore(f.scores, 'away'),
        kickoff_at: f.starting_at,
        status:     'FT',
        gw:         gw
      };
    });

  return toCache('results', { FT: results, ts: Date.now() });
}
