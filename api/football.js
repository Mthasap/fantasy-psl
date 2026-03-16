// ══════════════════════════════════════════════════════════════════════════
// api/football.js  —  Fantasy PSL  —  Sportmonks Proxy
// ══════════════════════════════════════════════════════════════════════════
//
// All API-Football references removed. This file now exclusively calls
// Sportmonks (api.sportmonks.com/v3/football).
//
// ENDPOINTS exposed to the frontend:
//   GET /api/football?type=live            → live scores (cached 55s)
//   GET /api/football?type=fixtures        → upcoming fixtures (cached 10min)
//   GET /api/football?type=results         → recent results (cached 10min)
//   GET /api/football?type=standings       → league table (cached 30min)
//   GET /api/football?type=topscorers      → top scorers (cached 1hr)
//   GET /api/football?type=player_stats&fixture_id=XXX  (cached 30min)
//   GET /api/football?type=status          → health check
//
// ENVIRONMENT VARIABLES (set in Vercel dashboard):
//   SPORTMONKS_TOKEN  — your Sportmonks API token
//
// PSL League ID on Sportmonks: 806
// ══════════════════════════════════════════════════════════════════════════

const TOKEN    = process.env.SPORTMONKS_TOKEN || '';
const PSL_ID   = 806;
const BASE_URL = 'https://api.sportmonks.com/v3/football';

// Season ID is fetched once per process lifetime
let PSL_SEASON_ID = null;

// In-memory response cache (all Vercel instances within a region share this)
const CACHE = {
  live:         { data: null, ts: 0, ttl: 55  * 1000 },
  fixtures:     { data: null, ts: 0, ttl: 10  * 60 * 1000 },
  results:      { data: null, ts: 0, ttl: 10  * 60 * 1000 },
  standings:    { data: null, ts: 0, ttl: 30  * 60 * 1000 },
  topscorers:   { data: null, ts: 0, ttl: 60  * 60 * 1000 },
  player_stats: {}
};

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (!TOKEN) {
    return res.status(500).json({
      error: 'SPORTMONKS_TOKEN is not set in Vercel environment variables.',
      fix:   'Vercel Dashboard → Your Project → Settings → Environment Variables → Add SPORTMONKS_TOKEN'
    });
  }

  const type      = (req.query && req.query.type) || 'live';
  const fixtureId = req.query && req.query.fixture_id;

  try {
    switch (type) {
      case 'live':        return res.json(await getLive());
      case 'fixtures':    return res.json(await getFixtures());
      case 'results':     return res.json(await getResults());
      case 'standings':   return res.json(await getStandings());
      case 'topscorers':  return res.json(await getTopScorers());
      case 'player_stats':
        if (!fixtureId) return res.status(400).json({ error: 'fixture_id required for player_stats' });
        return res.json(await getPlayerStats(fixtureId));
      case 'status':
        return res.json({ ok: true, provider: 'Sportmonks', token_set: !!TOKEN, psl_league_id: PSL_ID });
      default:
        return res.status(400).json({ error: 'Unknown type: ' + type });
    }
  } catch (err) {
    console.error('[football.js]', type, err.message);
    const stale = CACHE[type] && CACHE[type].data;
    if (stale) return res.json(Object.assign({}, stale, { stale: true, error: err.message }));
    return res.status(500).json({ error: err.message, type });
  }
};

// ── Season discovery ──────────────────────────────────────────────────────
async function getSeasonId() {
  if (PSL_SEASON_ID) return PSL_SEASON_ID;

  // Try to get current season from league endpoint
  try {
    const d = await smGet('/leagues/' + PSL_ID + '?include=currentSeason');
    const s = (d.data && d.data.currentSeason) || (d.data && d.data.current_season);
    if (s && s.id) { PSL_SEASON_ID = s.id; return PSL_SEASON_ID; }
  } catch (_) {}

  // Fallback: list all seasons for PSL, take most recent
  const d = await smGet('/seasons?filters=leagueId:' + PSL_ID);
  const list = (d.data || []).sort(function(a, b) { return b.id - a.id; });
  if (list.length) { PSL_SEASON_ID = list[0].id; return PSL_SEASON_ID; }

  throw new Error('Could not determine PSL season ID. Check SPORTMONKS_TOKEN and league ID 806.');
}

// ── Live scores ───────────────────────────────────────────────────────────
async function getLive() {
  if (isFresh(CACHE.live)) return CACHE.live.data;

  // Live scores filtered by league ID (livescores endpoint supports leagueId filter)
  const d = await smGet(
    '/livescores/inplay?include=participants;scores;state' +
    '&filters=fixtureLeagues:' + PSL_ID
  );

  const matches = (d.data || []).map(formatFixture);
  const result  = { type: 'live', isLive: matches.length > 0, matches, fetched_at: new Date().toISOString() };
  CACHE.live = { data: result, ts: Date.now(), ttl: 55 * 1000 };
  return result;
}

// ── Upcoming fixtures ─────────────────────────────────────────────────────
async function getFixtures() {
  if (isFresh(CACHE.fixtures)) return CACHE.fixtures.data;

  const sid = await getSeasonId();
  // Upcoming fixtures scoped to PSL season — no leagueId filter needed
  const d   = await smGet(
    '/fixtures/upcoming/season/' + sid +
    '?include=participants;round&per_page=30'
  );

  const fixtures = (d.data || []).map(formatFixture);
  const result   = { type: 'fixtures', fixtures, fetched_at: new Date().toISOString() };
  CACHE.fixtures = { data: result, ts: Date.now(), ttl: 10 * 60 * 1000 };
  return result;
}

// ── Recent results ────────────────────────────────────────────────────────
async function getResults() {
  if (isFresh(CACHE.results)) return CACHE.results.data;

  const sid = await getSeasonId();
  // Past fixtures scoped to PSL season — no leagueId filter needed
  const d   = await smGet(
    '/fixtures/past/season/' + sid +
    '?include=participants;scores;round&per_page=20'
  );

  const results = (d.data || []).map(formatFixture);
  const result  = { type: 'results', results, fetched_at: new Date().toISOString() };
  CACHE.results = { data: result, ts: Date.now(), ttl: 10 * 60 * 1000 };
  return result;
}

// ── League table ──────────────────────────────────────────────────────────
async function getStandings() {
  if (isFresh(CACHE.standings)) return CACHE.standings.data;

  const sid = await getSeasonId();
  // Standings endpoint: /standings/seasons/{season_id}
  // No leagueId filter needed — season_id already scopes to PSL
  const d   = await smGet(
    '/standings/seasons/' + sid +
    '?include=participant;details'
  );

  // Sportmonks detail type_ids for standings:
  // 129=MP 130=W 131=D 132=L 133=GF 134=GA
  function detail(row, typeId) {
    const item = (row.details || []).find(function(x) { return x.type_id === typeId; });
    return item ? (item.value || 0) : 0;
  }

  const standings = (d.data || []).map(function(row) {
    const team = row.participant || {};
    const p = detail(row,129), w = detail(row,130), dr = detail(row,131);
    const l = detail(row,132), gf= detail(row,133), ga= detail(row,134);
    return {
      pos:  row.position || 0,
      team: team.name    || '',
      p, w, d: dr, l, gf, ga,
      gd:  gf - ga,
      pts: row.points || 0,
      form: row.form ? row.form.split(',').slice(-5).map(function(r){ return r.trim().toUpperCase(); }) : []
    };
  }).sort(function(a,b){ return a.pos - b.pos; });

  const result = { type: 'standings', standings, fetched_at: new Date().toISOString() };
  CACHE.standings = { data: result, ts: Date.now(), ttl: 30 * 60 * 1000 };
  return result;
}

// ── Top scorers ───────────────────────────────────────────────────────────
async function getTopScorers() {
  if (isFresh(CACHE.topscorers)) return CACHE.topscorers.data;

  const sid = await getSeasonId();
  // Top scorers scoped to PSL season — no leagueId filter needed
  const d   = await smGet(
    '/topscorers/season/' + sid +
    '?include=participant;player&per_page=20'
  );

  const topScorers = (d.data || []).map(function(row, i) {
    const player = row.player       || {};
    const team   = row.participant  || {};
    return {
      rank:  i + 1,
      name:  player.display_name || player.name || 'Unknown',
      club:  team.name           || '',
      goals: row.total           || 0,
      apps:  row.appearances     || 0
    };
  });

  const result = { type: 'topscorers', topScorers, fetched_at: new Date().toISOString() };
  CACHE.topscorers = { data: result, ts: Date.now(), ttl: 60 * 60 * 1000 };
  return result;
}

// ── Player stats for a specific fixture (powers points engine) ────────────
async function getPlayerStats(fixtureId) {
  const cacheKey = String(fixtureId);
  if (CACHE.player_stats[cacheKey] && isFresh(CACHE.player_stats[cacheKey])) {
    return CACHE.player_stats[cacheKey].data;
  }

  const d   = await smGet(
    '/fixtures/' + fixtureId +
    '?include=participants;scores;events.type;lineups.player;lineups.position;statistics.type'
  );
  const fix = d.data || {};

  const participants = fix.participants  || [];
  const events       = fix.events       || [];
  const lineups      = fix.lineups      || [];
  const statistics   = fix.statistics   || [];
  const scores       = fix.scores       || [];

  // Final scores per participant_id
  const finalScore = {};
  scores.forEach(function(s) {
    if (!s.score) return;
    var desc = (s.description||'').toUpperCase();
    if (desc === 'FT' || desc === 'CURRENT' || desc === 'FULLTIME') {
      finalScore[s.participant_id] = s.score.goals || 0;
    }
  });

  // Events per player
  const ev = {};
  function getEv(pid) {
    if (!ev[pid]) ev[pid] = {goals:0,assists:0,yellowCards:0,redCards:0,penSaved:0,penMissed:0};
    return ev[pid];
  }
  events.forEach(function(e) {
    var pid  = e.player_id;
    if (!pid) return;
    var type = '';
    if (e.type) type = (e.type.developer_name || e.type.name || '').toUpperCase();
    else        type = String(e.type_id || '');

    if (type.includes('GOAL') && !type.includes('ASSIST') && !type.includes('OWN') && !type.includes('MISS') && !type.includes('SAVE')) getEv(pid).goals++;
    if (type.includes('OWN_GOAL') || type === '17') { getEv(pid).goals = Math.max(0, getEv(pid).goals - 1); }
    if (type.includes('ASSIST') || type === '19')   getEv(pid).assists++;
    if (type.includes('YELLOWCARD') || type === '83') getEv(pid).yellowCards++;
    if (type.includes('REDCARD')    || type === '84') getEv(pid).redCards++;
    if (type.includes('MISSED_PENALTY') || type === '50') getEv(pid).penMissed++;
    if (type.includes('SAVED_PENALTY')  || type === '51') getEv(pid).penSaved++;
  });

  // Saves per player from statistics
  const saves = {};
  statistics.forEach(function(s) {
    var typeName = s.type && (s.type.developer_name || s.type.name) || '';
    if (typeName.toUpperCase().includes('SAVE') && s.player_id) {
      saves[s.player_id] = parseInt(s.data && s.data.value, 10) || 0;
    }
  });

  // Build players from lineups
  const allPlayers = lineups.map(function(entry) {
    var player  = entry.player   || {};
    var posObj  = entry.position || {};
    var pid     = player.id;
    var teamId  = entry.team_id || entry.participant_id;

    // Goals the player's team conceded = the other team's score
    var myConceded = 0;
    Object.keys(finalScore).forEach(function(tid) {
      if (String(tid) !== String(teamId)) myConceded = finalScore[tid] || 0;
    });

    var pos     = normalisePosition(posObj.name || posObj.developer_name || '');
    var minutes = entry.minutes_played || 0;
    var pev     = ev[pid] || {};

    var pts = calculateFantasyPoints({
      pos,
      minutes,
      goals:        pev.goals        || 0,
      assists:      pev.assists      || 0,
      saves:        saves[pid]       || 0,
      goalsConceded:myConceded,
      yellowCards:  pev.yellowCards  || 0,
      redCards:     pev.redCards     || 0,
      penSaved:     pev.penSaved     || 0,
      penMissed:    pev.penMissed    || 0
    });

    var team = participants.find(function(p){ return String(p.id)===String(teamId); });

    return {
      player_name:      player.display_name || player.name || 'Unknown',
      team:             team ? (team.name||'') : '',
      position:         pos,
      minutes,
      goals:            pev.goals        || 0,
      assists:          pev.assists      || 0,
      yellow_cards:     pev.yellowCards  || 0,
      red_cards:        pev.redCards     || 0,
      saves:            saves[pid]       || 0,
      goals_conceded:   myConceded,
      penalties_saved:  pev.penSaved     || 0,
      penalties_missed: pev.penMissed    || 0,
      fantasy_points:   pts.total,
      points_breakdown: pts.breakdown
    };
  });

  var result = {
    type:       'player_stats',
    fixture_id: parseInt(fixtureId, 10),
    players:    allPlayers,
    fetched_at: new Date().toISOString()
  };

  CACHE.player_stats[cacheKey] = { data: result, ts: Date.now(), ttl: 30 * 60 * 1000 };
  return result;
}

// ══════════════════════════════════════════════════════════════════════════
// FANTASY POINTS ENGINE (single source of truth — also used by points-cron.js)
// ══════════════════════════════════════════════════════════════════════════
function calculateFantasyPoints(s) {
  var breakdown = {}, total = 0;
  function add(key, val) { if (val !== 0) { breakdown[key] = val; total += val; } }

  if (s.minutes === 0) return { total: 0, breakdown: { appearance: 0 } };

  add('appearance', s.minutes >= 60 ? 2 : 1);

  if (s.goals > 0) {
    add('goals', (s.pos==='GK'||s.pos==='DEF') ? s.goals*6 : s.pos==='MID' ? s.goals*5 : s.goals*4);
  }
  if (s.assists      > 0) add('assists',        s.assists      *  3);
  if (s.minutes >= 60 && s.goalsConceded === 0) {
    if (s.pos==='GK'||s.pos==='DEF') add('clean_sheet', 4);
    else if (s.pos==='MID')          add('clean_sheet', 1);
  }
  if ((s.pos==='GK'||s.pos==='DEF') && s.goalsConceded >= 2)
    add('goals_conceded', -Math.floor(s.goalsConceded / 2));
  if (s.pos==='GK' && s.saves >= 3)
    add('saves_bonus', Math.floor(s.saves / 3));
  if (s.penSaved  > 0) add('penalty_saved',  s.penSaved  *  5);
  if (s.penMissed > 0) add('penalty_missed', s.penMissed * -2);
  if (s.yellowCards > 0) add('yellow_card', s.yellowCards * -1);
  if (s.redCards    > 0) add('red_card',    s.redCards    * -3);

  return { total, breakdown };
}

function normalisePosition(raw) {
  if (!raw) return 'MID';
  var r = raw.toUpperCase().trim();
  if (r.includes('GOAL') || r==='GK' || r==='G' || r==='24' || r==='GOALKEEPER') return 'GK';
  if (r.includes('DEF')  || r==='D'  || r==='25' || r==='DEFENDER')  return 'DEF';
  if (r.includes('MID')  || r==='M'  || r==='26' || r==='MIDFIELDER') return 'MID';
  if (r.includes('ATT')  || r.includes('FOR') || r==='FWD' || r==='F' || r==='27' || r==='ATTACKER') return 'FWD';
  return 'MID';
}

function formatFixture(f) {
  var parts  = f.participants || [];
  var home   = parts.find(function(p){return p.meta&&p.meta.location==='home';})||parts[0]||{};
  var away   = parts.find(function(p){return p.meta&&p.meta.location==='away';})||parts[1]||{};
  var scores = f.scores || [];
  var hg=null, ag=null;

  scores.forEach(function(s) {
    if (!s.score) return;
    var desc=(s.description||'').toUpperCase();
    if (desc==='FT'||desc==='CURRENT'||desc==='FULLTIME') {
      if (s.score.participant==='home') hg=s.score.goals;
      if (s.score.participant==='away') ag=s.score.goals;
    }
  });

  var state  = f.state || {};
  var status = (state.short_name || state.state || 'NS').toUpperCase();
  var liveS  = ['1H','HT','2H','ET','BT','P','INT','LIVE','INPLAY'];
  var isLive = liveS.some(function(s){return status.includes(s);});

  return {
    fixture_id:  f.id,
    status:      status==='FT'?'FT':status==='NS'?'NS':isLive?status:'NS',
    status_long: state.name || status,
    elapsed:     f.minute || null,
    is_live:     isLive,
    date:        f.starting_at || null,
    home:        home.name       || '',
    away:        away.name       || '',
    home_logo:   home.image_path || '',
    away_logo:   away.image_path || '',
    hg,
    ag
  };
}

async function smGet(path) {
  var sep = path.includes('?') ? '&' : '?';
  var url = BASE_URL + path + sep + 'api_token=' + TOKEN;
  console.log('[Sportmonks] GET', BASE_URL + path.split('?')[0]);

  var response = await fetch(url, { method:'GET', headers:{ Accept:'application/json' } });
  if (!response.ok) {
    var body = await response.text().catch(function(){return '';});
    throw new Error('Sportmonks HTTP ' + response.status + ': ' + body.substring(0,200));
  }
  var json = await response.json();
  if (json.errors) throw new Error('Sportmonks error: ' + JSON.stringify(json.errors).substring(0,300));
  return json;
}

function isFresh(entry) {
  if (!entry||!entry.data||!entry.ts||!entry.ttl) return false;
  return (Date.now() - entry.ts) < entry.ttl;
}

// Export for points-cron.js
module.exports.calculateFantasyPoints = calculateFantasyPoints;
module.exports.normalisePosition      = normalisePosition;
