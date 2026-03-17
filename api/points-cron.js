// ══════════════════════════════════════════════════════════════════════════
// api/points-cron.js  —  Fantasy PSL  —  Nightly Data Sync  (Budget-Safe v2)
// ══════════════════════════════════════════════════════════════════════════
//
// WHAT THIS DOES (runs at 9pm daily via Vercel cron):
//   Step 1 — Get/cache PSL season ID (1 call EVER after first run)
//   Step 2 — Sync upcoming fixtures to Supabase (1 call/day)
//   Step 3 — Sync recent results to Supabase (1 call/day)
//   Step 4 — Sync league standings to Supabase (1 call/day)
//   Step 5 — Score completed matches + update user GW points (1 call/match)
//   Step 6 — Sync top scorers weekly (1 call/week)
//
// CALL BUDGET: ~150-200 calls/month out of 2000 limit
//
// ENV VARS:
//   SPORTMONKS_TOKEN      — Sportmonks API token
//   SUPABASE_URL          — Supabase project URL
//   SUPABASE_SERVICE_KEY  — Supabase service role key
//   ADMIN_SECRET          — for manual trigger (fpsl-admin-2026)
// ══════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const { calculateFantasyPoints, normalisePosition } = require('./football_scoring');

const TOKEN    = process.env.SPORTMONKS_TOKEN    || '';
const SB_URL   = process.env.SUPABASE_URL        || '';
const SB_KEY   = process.env.SUPABASE_SERVICE_KEY || '';
const PSL_ID   = 806;
const BASE_URL = 'https://api.sportmonks.com/v3/football';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const adminKey = (req.query && req.query.admin_key) || '';
  const isAdmin  = adminKey && adminKey === (process.env.ADMIN_SECRET || 'fpsl-admin-2026');
  const isCron   = req.headers['x-vercel-cron'] === '1';

  if (!isCron && !isAdmin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!TOKEN)  return res.status(500).json({ error: 'SPORTMONKS_TOKEN not set' });
  if (!SB_URL) return res.status(500).json({ error: 'SUPABASE_URL not set' });
  if (!SB_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not set' });

  const db     = createClient(SB_URL, SB_KEY);
  const log    = [];
  const report = { started_at: new Date().toISOString(), steps: {} };

  try {
    // ── STEP 1: Get season ID (cached in Supabase) ─────────────────────
    log.push('Step 1: Getting season ID...');
    const seasonId = await getOrCacheSeasonId(db);
    report.steps.season_id = seasonId;
    log.push('  Season ID: ' + seasonId);

    // ── STEP 2: Sync upcoming fixtures ────────────────────────────────
    log.push('Step 2: Syncing fixtures...');
    const fixtureCount = await syncFixtures(db, seasonId);
    report.steps.fixtures = fixtureCount + ' synced';
    log.push('  Fixtures synced: ' + fixtureCount);

    // ── STEP 3: Sync results ──────────────────────────────────────────
    log.push('Step 3: Syncing results...');
    const resultsCount = await syncResults(db, seasonId);
    report.steps.results = resultsCount + ' synced';
    log.push('  Results synced: ' + resultsCount);

    // ── STEP 4: Sync standings ────────────────────────────────────────
    log.push('Step 4: Syncing standings...');
    const standingsCount = await syncStandings(db, seasonId);
    report.steps.standings = standingsCount + ' rows';
    log.push('  Standings rows: ' + standingsCount);

    // ── STEP 5: Score completed matches ───────────────────────────────
    log.push('Step 5: Scoring completed matches...');
    const scored = await scoreCompletedMatches(db, seasonId);
    report.steps.scored_matches = scored;
    log.push('  Matches scored: ' + scored);

    // ── STEP 6: Sync top scorers (weekly check) ───────────────────────
    log.push('Step 6: Checking top scorers...');
    const scorersSynced = await maybeSyncTopScorers(db, seasonId);
    report.steps.top_scorers = scorersSynced ? 'synced' : 'skipped (< 7 days)';
    log.push('  Top scorers: ' + (scorersSynced ? 'synced' : 'skipped'));

    report.completed_at = new Date().toISOString();
    report.log = log;
    report.ok  = true;
    return res.json(report);

  } catch (err) {
    console.error('[cron]', err.message);
    report.error = err.message;
    report.log   = log;
    return res.status(500).json(report);
  }
};

// ═══════════════════════════════════════════════════════════════════════
// STEP 1: Season ID — fetch once, cache permanently in Supabase
// ═══════════════════════════════════════════════════════════════════════
async function getOrCacheSeasonId(db) {
  // Check Supabase cache first
  const { data } = await db
    .from('api_cache')
    .select('value')
    .eq('key', 'psl_season_id')
    .single();

  if (data && data.value) {
    return parseInt(data.value, 10);
  }

  // Not cached — fetch from Sportmonks (1 call, done forever)
  const d = await smGet('/leagues/' + PSL_ID + '?include=currentSeason');
  const league = d.data || {};

  // Try currentSeason include
  let seasonId = null;
  const cs = league.currentSeason || league.current_season;
  if (cs && cs.id) {
    seasonId = cs.id;
  } else {
    // Fallback: search seasons by league
    const d2 = await smGet('/seasons?filters=seasonLeagues:' + PSL_ID + '&sort=id&order=desc&per_page=5');
    const list = (d2.data || []).filter(function(s) { return s.is_current || !s.finished; });
    if (list.length) {
      seasonId = list[0].id;
    } else if (d2.data && d2.data.length) {
      // Take most recent
      const sorted = d2.data.sort(function(a,b) { return b.id - a.id; });
      seasonId = sorted[0].id;
    }
  }

  if (!seasonId) throw new Error('Could not determine PSL season ID');

  // Cache in Supabase permanently
  await db.from('api_cache').upsert({
    key:        'psl_season_id',
    value:      String(seasonId),
    updated_at: new Date().toISOString()
  }, { onConflict: 'key' });

  return seasonId;
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 2: Sync upcoming fixtures to Supabase
// ═══════════════════════════════════════════════════════════════════════
async function syncFixtures(db, seasonId) {
  const d = await smGet(
    '/fixtures?filters=fixtureSeasons:' + seasonId + ';fixtureStates:1' +
    '&include=participants;round&per_page=30&sortBy=starting_at&order=asc'
  );

  const fixtures = (d.data || []).map(function(f) {
    const parts = f.participants || [];
    const home  = parts.find(function(p) { return p.meta && p.meta.location === 'home'; }) || parts[0] || {};
    const away  = parts.find(function(p) { return p.meta && p.meta.location === 'away'; }) || parts[1] || {};
    return {
      sportmonks_id: f.id,
      home_team:  home.name || '',
      away_team:  away.name || '',
      home_logo:  home.image_path || '',
      away_logo:  away.image_path || '',
      kickoff_at: f.starting_at,
      status:     'NS',
      round:      f.round ? (f.round.name || f.round.id) : null,
      season_id:  seasonId
    };
  });

  if (!fixtures.length) return 0;

  await db.from('fixtures').upsert(fixtures, { onConflict: 'sportmonks_id' });
  return fixtures.length;
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 3: Sync recent results to Supabase
// ═══════════════════════════════════════════════════════════════════════
async function syncResults(db, seasonId) {
  const d = await smGet(
    '/fixtures?filters=fixtureSeasons:' + seasonId + ';fixtureStates:5' +
    '&include=participants;scores;round&per_page=20&sortBy=starting_at&order=desc'
  );

  const results = (d.data || []).map(function(f) {
    const parts  = f.participants || [];
    const home   = parts.find(function(p) { return p.meta && p.meta.location === 'home'; }) || parts[0] || {};
    const away   = parts.find(function(p) { return p.meta && p.meta.location === 'away'; }) || parts[1] || {};
    const scores = f.scores || [];
    let hg = null, ag = null;
    scores.forEach(function(s) {
      if (!s.score) return;
      const desc = (s.description || '').toUpperCase();
      if (desc === 'FT' || desc === 'FULLTIME' || desc === 'CURRENT') {
        if (s.score.participant === 'home') hg = s.score.goals;
        if (s.score.participant === 'away') ag = s.score.goals;
      }
    });
    return {
      sportmonks_id: f.id,
      home_team:   home.name || '',
      away_team:   away.name || '',
      home_logo:   home.image_path || '',
      away_logo:   away.image_path || '',
      kickoff_at:  f.starting_at,
      status:      'FT',
      home_score:  hg,
      away_score:  ag,
      round:       f.round ? (f.round.name || f.round.id) : null,
      season_id:   seasonId
    };
  });

  if (!results.length) return 0;

  await db.from('fixtures').upsert(results, { onConflict: 'sportmonks_id' });
  return results.length;
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 4: Sync league standings to Supabase
// ═══════════════════════════════════════════════════════════════════════
async function syncStandings(db, seasonId) {
  const d = await smGet(
    '/standings/seasons/' + seasonId +
    '?include=participant;details'
  );

  // Sportmonks detail type_ids: 129=MP 130=W 131=D 132=L 133=GF 134=GA
  function detail(row, typeId) {
    const item = (row.details || []).find(function(x) { return x.type_id === typeId; });
    return item ? (item.value || 0) : 0;
  }

  const rows = (d.data || []).map(function(row) {
    const team = row.participant || {};
    const p  = detail(row, 129), w  = detail(row, 130), dr = detail(row, 131);
    const l  = detail(row, 132), gf = detail(row, 133), ga = detail(row, 134);
    return {
      season_id:     seasonId,
      position:      row.position || 0,
      team_name:     team.name    || '',
      team_logo:     team.image_path || '',
      played:        p, won: w, drawn: dr, lost: l,
      goals_for:     gf, goals_against: ga,
      goal_diff:     gf - ga,
      points:        row.points || 0,
      form:          row.form   || ''
    };
  }).sort(function(a, b) { return a.position - b.position; });

  if (!rows.length) return 0;

  // Clear and re-insert (standings change every match)
  await db.from('standings').delete().eq('season_id', seasonId);
  await db.from('standings').insert(rows);
  return rows.length;
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 5: Score completed matches + update user points
// ═══════════════════════════════════════════════════════════════════════
async function scoreCompletedMatches(db, seasonId) {
  // Get unprocessed FT fixtures
  const { data: processed } = await db.from('processed_fixtures').select('fixture_id');
  const processedIds = new Set((processed || []).map(function(r) { return r.fixture_id; }));

  const { data: ftFixtures } = await db
    .from('fixtures')
    .select('sportmonks_id, home_team, away_team, kickoff_at')
    .eq('status', 'FT')
    .eq('season_id', seasonId);

  const toProcess = (ftFixtures || []).filter(function(f) {
    return !processedIds.has(f.sportmonks_id);
  });

  if (!toProcess.length) return 0;

  let scored = 0;
  for (const fixture of toProcess.slice(0, 5)) { // max 5 per run to save API calls
    try {
      await scoreOneFixture(db, fixture.sportmonks_id);
      scored++;
    } catch(e) {
      console.error('[cron] scoreOneFixture', fixture.sportmonks_id, e.message);
    }
  }
  return scored;
}

async function scoreOneFixture(db, fixtureId) {
  // 1 API call per fixture
  const d = await smGet(
    '/fixtures/' + fixtureId +
    '?include=participants;scores;events.type;lineups.player;lineups.position;statistics.type'
  );
  const fix = d.data || {};

  const participants = fix.participants || [];
  const events       = fix.events      || [];
  const lineups      = fix.lineups     || [];
  const statistics   = fix.statistics  || [];
  const scores       = fix.scores      || [];

  // Final scores per participant_id
  const finalScore = {};
  scores.forEach(function(s) {
    if (!s.score) return;
    const desc = (s.description || '').toUpperCase();
    if (desc === 'FT' || desc === 'FULLTIME' || desc === 'CURRENT') {
      finalScore[s.participant_id] = s.score.goals || 0;
    }
  });

  // Events per player
  const ev = {};
  function getEv(pid) {
    if (!ev[pid]) ev[pid] = { goals: 0, assists: 0, yellowCards: 0, redCards: 0, penSaved: 0, penMissed: 0 };
    return ev[pid];
  }
  events.forEach(function(e) {
    const pid  = e.player_id; if (!pid) return;
    const type = e.type ? (e.type.developer_name || e.type.name || '').toUpperCase() : String(e.type_id || '');
    if (type.includes('GOAL') && !type.includes('OWN') && !type.includes('ASSIST') && !type.includes('MISS')) getEv(pid).goals++;
    if (type.includes('ASSIST'))              getEv(pid).assists++;
    if (type.includes('YELLOWCARD'))          getEv(pid).yellowCards++;
    if (type.includes('REDCARD'))             getEv(pid).redCards++;
    if (type.includes('MISSED_PENALTY'))      getEv(pid).penMissed++;
    if (type.includes('SAVED_PENALTY'))       getEv(pid).penSaved++;
  });

  // Saves from statistics
  const saves = {};
  statistics.forEach(function(s) {
    const typeName = s.type && (s.type.developer_name || s.type.name) || '';
    if (typeName.toUpperCase().includes('SAVE') && s.player_id) {
      saves[s.player_id] = parseInt(s.data && s.data.value, 10) || 0;
    }
  });

  // Build player stats rows
  const playerRows = lineups.map(function(entry) {
    const player  = entry.player   || {};
    const posObj  = entry.position || {};
    const pid     = player.id;
    const teamId  = entry.team_id || entry.participant_id;
    const team    = participants.find(function(p) { return String(p.id) === String(teamId); });
    const myConceded = Object.keys(finalScore).reduce(function(acc, tid) {
      return String(tid) !== String(teamId) ? (finalScore[tid] || 0) : acc;
    }, 0);
    const pos     = normalisePosition(posObj.name || posObj.developer_name || '');
    const pev     = ev[pid] || {};
    const pts     = calculateFantasyPoints({
      pos, minutes: entry.minutes_played || 0,
      goals: pev.goals || 0, assists: pev.assists || 0,
      saves: saves[pid] || 0, goalsConceded: myConceded,
      yellowCards: pev.yellowCards || 0, redCards: pev.redCards || 0,
      penSaved: pev.penSaved || 0, penMissed: pev.penMissed || 0
    });
    return {
      fixture_id:       fixtureId,
      player_name:      player.display_name || player.name || 'Unknown',
      team:             team ? (team.name || '') : '',
      position:         pos,
      minutes:          entry.minutes_played || 0,
      goals:            pev.goals || 0,
      assists:          pev.assists || 0,
      yellow_cards:     pev.yellowCards || 0,
      red_cards:        pev.redCards || 0,
      saves:            saves[pid] || 0,
      goals_conceded:   myConceded,
      penalties_saved:  pev.penSaved || 0,
      penalties_missed: pev.penMissed || 0,
      fantasy_points:   pts.total,
      points_breakdown: JSON.stringify(pts.breakdown)
    };
  });

  if (playerRows.length) {
    await db.from('player_match_stats').upsert(playerRows, { onConflict: 'fixture_id,player_name' });
  }

  // Now update user GW scores
  await updateUserPoints(db, fixtureId, playerRows);

  // Mark as processed
  await db.from('processed_fixtures').insert({ fixture_id: fixtureId });
}

async function updateUserPoints(db, fixtureId, playerRows) {
  const statsByName = {};
  playerRows.forEach(function(p) { statsByName[normaliseName(p.player_name)] = p; });

  const { data: gw } = await db.from('gameweeks').select('number').eq('is_current', true).single();
  const gwNum = gw ? gw.number : null;

  const { data: users } = await db
    .from('profiles')
    .select('id,squad_data,total_points,gw_points,active_chip')
    .not('squad_data', 'is', null);

  if (!users || !users.length) return;

  const updates = [];
  for (const user of users) {
    let squad;
    try { squad = user.squad_data ? JSON.parse(user.squad_data) : []; } catch(e) { continue; }
    if (!squad.length) continue;

    const { gwPts, playerBreakdown } = scoreUserForFixture(squad, statsByName, user.active_chip || null);
    if (gwPts === 0) continue;

    const newGW    = (user.gw_points    || 0) + gwPts;
    const newTotal = (user.total_points || 0) + gwPts;

    updates.push({
      id: user.id,
      gw_points:    newGW,
      total_points: newTotal,
      updated_at:   new Date().toISOString()
    });

    if (gwNum) {
      await db.from('gw_scores').upsert({
        user_id:  user.id,
        gameweek: gwNum,
        points:   newGW,
        breakdown: JSON.stringify(playerBreakdown),
        calculated_at: new Date().toISOString()
      }, { onConflict: 'user_id,gameweek' });
    }
  }

  if (updates.length) {
    for (const u of updates) {
      await db.from('profiles').update({ gw_points: u.gw_points, total_points: u.total_points, updated_at: u.updated_at }).eq('id', u.id);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 6: Weekly top scorers sync
// ═══════════════════════════════════════════════════════════════════════
async function maybeSyncTopScorers(db, seasonId) {
  const { data: cache } = await db.from('api_cache').select('value,updated_at').eq('key', 'topscorers_last_sync').single();
  if (cache && cache.updated_at) {
    const age = Date.now() - new Date(cache.updated_at).getTime();
    if (age < 7 * 24 * 60 * 60 * 1000) return false; // Skip if < 7 days old
  }

  const d = await smGet(
    '/topscorers/seasons/' + seasonId +
    '?include=participant;player&per_page=30'
  );

  const rows = (d.data || []).map(function(row, i) {
    const player = row.player      || {};
    const team   = row.participant || {};
    return {
      name:         player.display_name || player.name || 'Unknown',
      club:         team.name           || '',
      position:     normalisePosition(player.position_id ? String(player.position_id) : ''),
      goals:        row.total       || 0,
      apps:         row.appearances || 0,
      season_id:    seasonId
    };
  });

  if (rows.length) {
    // Update players table with goal counts
    for (const r of rows) {
      await db.from('players').update({ goals: r.goals, apps: r.apps })
        .ilike('name', '%' + r.name.split(' ').pop() + '%')
        .eq('club', r.club);
    }

    await db.from('api_cache').upsert({
      key: 'topscorers_last_sync', value: 'done', updated_at: new Date().toISOString()
    }, { onConflict: 'key' });
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════
function scoreUserForFixture(squad, statsByName, activeChip) {
  const isBB = activeChip === 'bb';
  const isTC = activeChip === 'tc';
  let gwPts = 0;
  const playerBreakdown = [];
  const captain = squad.find(function(p) { return p.isCaptain; });
  const capKey  = captain ? normaliseName(captain.name || captain.display_name || '') : '';
  const capStats = capKey ? (statsByName[capKey] || null) : null;
  const capPlayed = capStats && capStats.minutes > 0;

  squad.forEach(function(sp) {
    if (sp.onBench && !isBB) return;
    const key   = normaliseName(sp.name || sp.display_name || '');
    const stats = statsByName[key]; if (!stats) return;
    let pts = stats.fantasy_points || 0;
    if (sp.isCaptain)             pts = isTC ? pts * 3 : pts * 2;
    else if (sp.isVC && !capPlayed) pts = isTC ? pts * 3 : pts * 2;
    gwPts += pts;
    playerBreakdown.push({
      name:       sp.name || sp.display_name,
      position:   sp.position,
      minutes:    stats.minutes,
      base_pts:   stats.fantasy_points,
      final_pts:  pts,
      is_captain: sp.isCaptain || false,
      is_vc:      sp.isVC      || false
    });
  });
  return { gwPts, playerBreakdown };
}

function normaliseName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

async function smGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = BASE_URL + path + sep + 'api_token=' + TOKEN;
  console.log('[SM] GET', BASE_URL + path.split('?')[0]);
  const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const body = await response.text().catch(function() { return ''; });
    throw new Error('Sportmonks HTTP ' + response.status + ': ' + body.substring(0, 300));
  }
  const json = await response.json();
  if (json.errors) throw new Error('Sportmonks error: ' + JSON.stringify(json.errors).substring(0, 300));
  return json;
}
