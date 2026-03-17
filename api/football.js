// ══════════════════════════════════════════════════════════════════════════
// api/football.js  —  Fantasy PSL  —  Sportmonks Proxy  (Budget-Safe v2)
// ══════════════════════════════════════════════════════════════════════════
//
// ARCHITECTURE: This file is a THIN PROXY only.
// All data is read from Supabase (populated by points-cron.js nightly).
// Direct Sportmonks calls are ONLY made here for:
//   - Live scores (during match windows, every 5min)
//   - Status/health check
//   - Season ID discovery (once ever, then cached in Supabase)
//
// ENDPOINTS:
//   GET /api/football?type=live            → live scores (5min cache)
//   GET /api/football?type=fixtures        → from Supabase fixtures table
//   GET /api/football?type=results         → from Supabase fixtures table
//   GET /api/football?type=standings       → from Supabase standings table
//   GET /api/football?type=topscorers      → from Supabase player_season_stats
//   GET /api/football?type=player_stats&fixture_id=XXX → from Supabase
//   GET /api/football?type=status          → health check + call budget
//
// ENV VARS:
//   SPORTMONKS_TOKEN     — Sportmonks API token
//   SUPABASE_URL         — Supabase project URL
//   SUPABASE_SERVICE_KEY — Supabase service role key
//
// PSL League ID: 806  |  Season auto-discovered and cached in Supabase
// ══════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

const TOKEN    = process.env.SPORTMONKS_TOKEN    || '';
const SB_URL   = process.env.SUPABASE_URL        || '';
const SB_KEY   = process.env.SUPABASE_SERVICE_KEY || '';
const PSL_ID   = 806;
const BASE_URL = 'https://api.sportmonks.com/v3/football';

// Short in-memory cache for live scores only (55s)
let LIVE_CACHE = { data: null, ts: 0 };
const LIVE_TTL = 55 * 1000;

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const type      = (req.query && req.query.type) || 'live';
  const fixtureId = req.query && req.query.fixture_id;

  // Token check only needed for live/status
  if ((type === 'live' || type === 'status') && !TOKEN) {
    return res.status(500).json({
      error: 'SPORTMONKS_TOKEN not set in Vercel Environment Variables'
    });
  }

  try {
    switch (type) {
      case 'live':        return res.json(await getLive());
      case 'fixtures':    return res.json(await getFromSupabase('fixtures'));
      case 'results':     return res.json(await getFromSupabase('results'));
      case 'standings':   return res.json(await getFromSupabase('standings'));
      case 'topscorers':  return res.json(await getFromSupabase('topscorers'));
      case 'player_stats':
        if (!fixtureId) return res.status(400).json({ error: 'fixture_id required' });
        return res.json(await getPlayerStats(fixtureId));
      case 'status':      return res.json(await getStatus());
      default:
        return res.status(400).json({ error: 'Unknown type: ' + type });
    }
  } catch (err) {
    console.error('[football.js]', type, err.message);
    return res.status(500).json({ error: err.message, type });
  }
};

// ── Supabase client ───────────────────────────────────────────────────────
function db() {
  if (!SB_URL || !SB_KEY) throw new Error('Supabase env vars not set');
  return createClient(SB_URL, SB_KEY);
}

// ── Read data from Supabase cache tables ──────────────────────────────────
async function getFromSupabase(dataType) {
  const client = db();

  if (dataType === 'fixtures') {
    const { data, error } = await client
      .from('fixtures')
      .select('*')
      .eq('status', 'NS')
      .order('kickoff_at', { ascending: true })
      .limit(20);
    if (error) throw new Error('fixtures: ' + error.message);
    return { type: 'fixtures', fixtures: (data || []).map(formatFixtureRow), fetched_at: new Date().toISOString() };
  }

  if (dataType === 'results') {
    const { data, error } = await client
      .from('fixtures')
      .select('*')
      .eq('status', 'FT')
      .order('kickoff_at', { ascending: false })
      .limit(20);
    if (error) throw new Error('results: ' + error.message);
    return { type: 'results', results: (data || []).map(formatFixtureRow), fetched_at: new Date().toISOString() };
  }

  if (dataType === 'standings') {
    const { data, error } = await client
      .from('standings')
      .select('*')
      .order('position', { ascending: true });
    if (error) {
      // standings table may not exist yet — return empty
      console.warn('standings table missing:', error.message);
      return { type: 'standings', standings: [], fetched_at: new Date().toISOString() };
    }
    return { type: 'standings', standings: (data || []).map(formatStandingRow), fetched_at: new Date().toISOString() };
  }

  if (dataType === 'topscorers') {
    const { data, error } = await client
      .from('players')
      .select('id,name,club,position,goals,assists,yellow_cards,red_cards,clean_sheets,apps,total_points')
      .order('goals', { ascending: false })
      .limit(20);
    if (error) throw new Error('topscorers: ' + error.message);
    return {
      type: 'topscorers',
      topScorers: (data || []).map(function(p, i) {
        return { rank: i + 1, name: p.name, club: p.club, goals: p.goals || 0, apps: p.apps || 0 };
      }),
      fetched_at: new Date().toISOString()
    };
  }
}

// ── Format helpers ────────────────────────────────────────────────────────
function formatFixtureRow(f) {
  return {
    fixture_id: f.sportmonks_id || f.id,
    status:     f.status || 'NS',
    date:       f.kickoff_at,
    home:       f.home_team,
    away:       f.away_team,
    home_logo:  f.home_logo || '',
    away_logo:  f.away_logo || '',
    hg:         f.home_score !== null && f.home_score !== undefined ? f.home_score : null,
    ag:         f.away_score !== null && f.away_score !== undefined ? f.away_score : null,
    is_live:    f.status === 'LIVE' || f.status === '1H' || f.status === '2H',
    elapsed:    f.elapsed || null,
    round:      f.round || null
  };
}

function formatStandingRow(s) {
  return {
    pos:  s.position || s.pos,
    team: s.team_name || s.team,
    p:    s.played   || 0,
    w:    s.won      || 0,
    d:    s.drawn    || 0,
    l:    s.lost     || 0,
    gf:   s.goals_for     || 0,
    ga:   s.goals_against || 0,
    gd:   s.goal_diff     || (s.goals_for || 0) - (s.goals_against || 0),
    pts:  s.points   || 0,
    form: s.form ? s.form.split(',').slice(-5) : []
  };
}

// ── Live scores ───────────────────────────────────────────────────────────
async function getLive() {
  // Check in-memory cache first
  if (LIVE_CACHE.data && (Date.now() - LIVE_CACHE.ts) < LIVE_TTL) {
    return LIVE_CACHE.data;
  }

  const d = await smGet(
    '/livescores/inplay?include=participants;scores;state' +
    '&filters=fixtureLeagues:' + PSL_ID
  );

  const matches = (d.data || []).map(formatSMFixture);
  const result  = {
    type:    'live',
    isLive:  matches.length > 0,
    matches,
    fetched_at: new Date().toISOString()
  };

  LIVE_CACHE = { data: result, ts: Date.now() };
  return result;
}

// ── Player stats from Supabase ────────────────────────────────────────────
async function getPlayerStats(fixtureId) {
  const client = db();
  const { data, error } = await client
    .from('player_match_stats')
    .select('*')
    .eq('fixture_id', fixtureId);
  if (error) throw new Error('player_stats: ' + error.message);
  return {
    type:       'player_stats',
    fixture_id: parseInt(fixtureId, 10),
    players:    data || [],
    fetched_at: new Date().toISOString()
  };
}

// ── Status / health check ─────────────────────────────────────────────────
async function getStatus() {
  const status = {
    ok: true,
    provider: 'Sportmonks v3',
    token_set: !!TOKEN,
    psl_league_id: PSL_ID,
    supabase_configured: !!(SB_URL && SB_KEY),
    checked_at: new Date().toISOString()
  };

  // Quick token ping
  try {
    const d = await smGet('/leagues/' + PSL_ID + '?include=currentSeason');
    status.league_name = d.data && d.data.name;
    status.league_ok = true;
    const cs = d.data && (d.data.currentSeason || d.data.current_season);
    if (cs && cs.id) status.current_season_id = cs.id;
  } catch (e) {
    status.league_ok = false;
    status.league_error = e.message;
  }

  return status;
}

// ── Sportmonks GET helper ─────────────────────────────────────────────────
async function smGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = BASE_URL + path + sep + 'api_token=' + TOKEN;
  console.log('[SM] GET', BASE_URL + path.split('?')[0]);

  const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error('Sportmonks HTTP ' + response.status + ': ' + body.substring(0, 300));
  }
  const json = await response.json();
  if (json.errors) throw new Error('Sportmonks error: ' + JSON.stringify(json.errors).substring(0, 300));
  return json;
}

// ── Format Sportmonks live fixture ────────────────────────────────────────
function formatSMFixture(f) {
  const parts  = f.participants || [];
  const home   = parts.find(function(p) { return p.meta && p.meta.location === 'home'; }) || parts[0] || {};
  const away   = parts.find(function(p) { return p.meta && p.meta.location === 'away'; }) || parts[1] || {};
  const scores = f.scores || [];
  let hg = null, ag = null;
  scores.forEach(function(s) {
    if (!s.score) return;
    const desc = (s.description || '').toUpperCase();
    if (desc === 'CURRENT' || desc === '2ND_HALF' || desc === 'FULLTIME' || desc === 'FT') {
      if (s.score.participant === 'home') hg = s.score.goals;
      if (s.score.participant === 'away') ag = s.score.goals;
    }
  });
  const state  = f.state || {};
  const status = (state.short_name || state.state || 'NS').toUpperCase();
  return {
    fixture_id: f.id, status, date: f.starting_at,
    home: home.name || '', away: away.name || '',
    home_logo: home.image_path || '', away_logo: away.image_path || '',
    hg, ag, is_live: true, elapsed: f.minute || null
  };
}

// Export for points-cron.js
const { calculateFantasyPoints, normalisePosition } = require('./football_scoring');
module.exports.calculateFantasyPoints = calculateFantasyPoints;
module.exports.normalisePosition      = normalisePosition;
