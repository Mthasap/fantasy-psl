// api/points-cron.js — Fantasy PSL Points Engine — API-Football Edition
// Runs nightly via Vercel cron (vercel.json: "0 21 * * *")
// Triggered manually from Admin Panel → Automation tab
//
// FLOW:
//   1. Get current PSL season year from API-Football
//   2. Fetch all FT fixtures for season
//   3. For each NEW fixture: fetch lineups + events (goals, assists, cards, subs)
//   4. Calculate fantasy points per player
//   5. Update player_match_stats + players + profiles
//
// ENV VARS:
//   APIFOOTBALL_KEY      — API-Football API key
//   SUPABASE_URL         — Supabase project URL
//   SUPABASE_SERVICE_KEY — Supabase service role key
//   ADMIN_SECRET         — admin password

const { createClient }                        = require('@supabase/supabase-js');
const { getSeasonYear, apiFetch, PSL_LEAGUE } = require('./season-helper');

const TOKEN  = process.env.APIFOOTBALL_KEY     || '';
const SB_URL = process.env.SUPABASE_URL        || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ADMIN  = process.env.ADMIN_SECRET        || 'mzansi4sho';

// ── Fantasy scoring rules ─────────────────────────────────────────────────
function calcPoints(s) {
  var pts = 0, breakdown = {};
  function add(k, v) { if (v) { breakdown[k] = v; pts += v; } }
  if (!s.minutes || s.minutes === 0) return { total: 0, breakdown: { dnp: 0 } };
  add('appearance', s.minutes >= 60 ? 2 : 1);
  if (s.goals > 0) {
    var gPts = (s.pos === 'GK' || s.pos === 'DEF') ? 6 : s.pos === 'MID' ? 5 : 4;
    add('goals', s.goals * gPts);
  }
  if (s.assists > 0) add('assists', s.assists * 3);
  if (s.minutes >= 60 && s.goalsConceded === 0) {
    if (s.pos === 'GK' || s.pos === 'DEF') add('clean_sheet', 4);
    else if (s.pos === 'MID')              add('clean_sheet', 1);
  }
  if ((s.pos === 'GK' || s.pos === 'DEF') && s.goalsConceded >= 2)
    add('goals_conceded', -Math.floor(s.goalsConceded / 2));
  if (s.pos === 'GK' && s.saves >= 3) add('saves_bonus', Math.floor(s.saves / 3));
  if (s.penSaved  > 0) add('penalty_saved',  s.penSaved  *  5);
  if (s.penMissed > 0) add('penalty_missed', s.penMissed * -2);
  if (s.yellowCards > 0) add('yellow_card',  s.yellowCards * -1);
  if (s.redCards    > 0) add('red_card',     s.redCards    * -3);
  return { total: pts, breakdown };
}

function normPos(raw) {
  if (!raw) return 'MID';
  var r = raw.toUpperCase().trim();
  if (r === 'G' || r === 'GK' || r.includes('GOAL'))                          return 'GK';
  if (r === 'D' || r === 'DEF' || r.includes('BACK'))                         return 'DEF';
  if (r === 'F' || r === 'FWD' || r.includes('FORWARD') || r.includes('ATTACK')) return 'FWD';
  return 'MID';
}

// ── Main handler ─────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  var adminKey = (req.query && req.query.admin_key) || (req.headers && req.headers['x-admin-key']);
  var isCron   = req.headers && req.headers['x-vercel-cron'] === '1';
  if (!isCron && adminKey !== ADMIN && adminKey !== 'mzansi4sho' && adminKey !== 'fpsl-admin-2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!TOKEN || !SB_URL || !SB_KEY) {
    return res.status(500).json({ error: 'Missing env vars: APIFOOTBALL_KEY / SUPABASE_URL / SUPABASE_SERVICE_KEY' });
  }

  var mode = (req.query && req.query.mode) || 'all';
  var db   = createClient(SB_URL, SB_KEY);
  var log  = [];

  try {
    var sy = await getSeasonYear(TOKEN);
    log.push('Season: ' + sy);

    // ── Fixture sync modes ──────────────────────────────────────────────
    if (mode === 'fixtures') {
      var count = await syncFixtures(db, sy, log, 'NS');
      return res.json({ success: true, mode, fixtures_synced: count, log });
    }
    if (mode === 'results') {
      var count = await syncFixtures(db, sy, log, 'FT');
      return res.json({ success: true, mode, results_updated: count, log });
    }

    // ── Full points pipeline ─────────────────────────────────────────────
    log.push('Mode: ' + mode + ' — running full scoring pipeline');

    // 2. Fetch all FT fixtures
    var d1 = await apiFetch('/fixtures?league=' + PSL_LEAGUE + '&season=' + sy + '&status=FT', TOKEN);
    var allFixtures = d1.response || [];
    log.push('FT fixtures: ' + allFixtures.length);

    // 3. Load player map from Supabase
    var { data: dbPlayers } = await db.from('players').select('id, api_player_id, position');
    var playerMap = {};
    (dbPlayers || []).forEach(function(p) {
      if (p.api_player_id) playerMap[String(p.api_player_id)] = p;
    });
    log.push('DB players: ' + Object.keys(playerMap).length);

    var statsInserted = 0, statsSkipped = 0, fixtureErrors = 0;

    // Batch mode: process N fixtures per run to avoid timeout
    // Pass ?batch=0, ?batch=1 etc to process in chunks of 8
    var BATCH_SIZE = 8;
    var batchNum   = parseInt((req.query && req.query.batch) || '0', 10);
    var batchStart = batchNum * BATCH_SIZE;
    var batchEnd   = batchStart + BATCH_SIZE;
    var batchFixtures = allFixtures.slice(batchStart, batchEnd);
    var totalBatches  = Math.ceil(allFixtures.length / BATCH_SIZE);
    log.push('Batch ' + batchNum + '/' + (totalBatches-1) + ' — processing fixtures ' + batchStart + '-' + Math.min(batchEnd, allFixtures.length) + ' of ' + allFixtures.length);

    // 4. Process each fixture in this batch
    for (var fi = 0; fi < batchFixtures.length; fi++) {
      var f   = batchFixtures[fi];
      var fid = f.fixture && f.fixture.id;
      if (!fid) continue;
      try {
        var existing = await db.from('player_match_stats')
          .select('id', { count: 'exact', head: true }).eq('fixture_id', fid);
        if (existing.count > 0) { statsSkipped++; continue; }

        // Fetch lineups + events from API-Football
        var lineupsData = await apiFetch('/fixtures/lineups?fixture=' + fid, TOKEN);
        var eventsData  = await apiFetch('/fixtures/events?fixture='  + fid, TOKEN);
        var lineups     = lineupsData.response || [];
        var events      = eventsData.response  || [];

        // Goals conceded per team
        var goals = f.goals || {};
        var teamGoals = {};
        if (lineups.length >= 2) {
          var homeId = lineups[0].team && lineups[0].team.id;
          var awayId = lineups[1].team && lineups[1].team.id;
          teamGoals[homeId] = goals.away || 0;
          teamGoals[awayId] = goals.home || 0;
        }

        // Build player stats from lineups
        var fixtureStats = {};
        lineups.forEach(function(team) {
          var tid = team.team && team.team.id;
          var conceded = teamGoals[tid] || 0;

          (team.startXI || []).forEach(function(entry) {
            var p = entry.player || {};
            if (!p.id) return;
            fixtureStats[String(p.id)] = {
              api_player_id: p.id, team_id: tid,
              pos: normPos(p.pos || ''), minutes: 90,
              goals: 0, assists: 0, goalsConceded: conceded,
              saves: 0, penSaved: 0, penMissed: 0, yellowCards: 0, redCards: 0
            };
          });
          (team.substitutes || []).forEach(function(entry) {
            var p = entry.player || {};
            if (!p.id) return;
            fixtureStats[String(p.id)] = {
              api_player_id: p.id, team_id: tid,
              pos: normPos(p.pos || ''), minutes: 0,
              goals: 0, assists: 0, goalsConceded: conceded,
              saves: 0, penSaved: 0, penMissed: 0, yellowCards: 0, redCards: 0
            };
          });
        });

        // Overlay events
        events.forEach(function(e) {
          var pid    = e.player && e.player.id ? String(e.player.id) : null;
          var asstId = e.assist && e.assist.id ? String(e.assist.id) : null;
          var type   = (e.type   || '').toLowerCase();
          var detail = (e.detail || '').toLowerCase();
          var time   = (e.time   && e.time.elapsed) || 0;

          if (pid && !fixtureStats[pid]) {
            fixtureStats[pid] = {
              api_player_id: e.player.id, team_id: e.team && e.team.id,
              pos: 'MID', minutes: 0, goals: 0, assists: 0, goalsConceded: 0,
              saves: 0, penSaved: 0, penMissed: 0, yellowCards: 0, redCards: 0
            };
          }

          if (type === 'goal' && !detail.includes('own')) {
            if (pid    && fixtureStats[pid])    fixtureStats[pid].goals   += 1;
            if (asstId && fixtureStats[asstId]) fixtureStats[asstId].assists += 1;
          }
          if (type === 'goal' && detail.includes('missed penalty')) {
            if (pid && fixtureStats[pid]) fixtureStats[pid].penMissed += 1;
          }
          if (type === 'card') {
            if (detail.includes('yellow') && pid && fixtureStats[pid]) fixtureStats[pid].yellowCards += 1;
            if (detail.includes('red')    && pid && fixtureStats[pid]) fixtureStats[pid].redCards    += 1;
          }
          if (type === 'subst') {
            if (asstId && fixtureStats[asstId]) fixtureStats[asstId].minutes = Math.max(0, 90 - time);
            if (pid    && fixtureStats[pid])    fixtureStats[pid].minutes    = Math.min(fixtureStats[pid].minutes, time);
          }
        });

        // Write to Supabase
        for (var pidStr in fixtureStats) {
          var st  = fixtureStats[pidStr];
          var dbP = playerMap[pidStr];
          var pts = calcPoints({ pos: dbP ? normPos(dbP.position) : st.pos,
            minutes: st.minutes, goals: st.goals, assists: st.assists,
            goalsConceded: st.goalsConceded, saves: st.saves,
            penSaved: st.penSaved, penMissed: st.penMissed,
            yellowCards: st.yellowCards, redCards: st.redCards });

          await db.from('player_match_stats').upsert({
            fixture_id: fid, player_id: dbP ? dbP.id : null,
            api_player_id: String(st.api_player_id),
            minutes: st.minutes, goals: st.goals, assists: st.assists,
            goals_conceded: st.goalsConceded, saves: st.saves,
            yellow_cards: st.yellowCards, red_cards: st.redCards,
            fantasy_points: pts.total, points_breakdown: JSON.stringify(pts.breakdown),
            updated_at: new Date().toISOString()
          }, { onConflict: 'fixture_id,api_player_id' });
          statsInserted++;
        }
      } catch(fErr) {
        log.push('Fixture ' + fid + ' error: ' + fErr.message);
        fixtureErrors++;
      }
    }
    log.push('Stats: inserted=' + statsInserted + ' skipped=' + statsSkipped + ' errors=' + fixtureErrors);

    // 4b. Re-link player_id in player_match_stats where it's null
    // This happens when a player was in match stats before being imported to DB
    try {
      var { data: unlinkd } = await db.from('player_match_stats')
        .select('id, api_player_id').is('player_id', null).limit(500);
      if (unlinkd && unlinkd.length) {
        var relinked = 0;
        for (var ri = 0; ri < unlinkd.length; ri++) {
          var row = unlinkd[ri];
          var dbMatch = playerMap[String(row.api_player_id)];
          if (dbMatch) {
            await db.from('player_match_stats').update({ player_id: dbMatch.id }).eq('id', row.id);
            relinked++;
          }
        }
        log.push('Re-linked ' + relinked + ' match stat rows to DB players');
      }
    } catch(e) { log.push('Re-link warning: ' + e.message); }

    // 5. Aggregate season stats — keyed by api_player_id (more reliable than player_id)
    var { data: matchStats } = await db.from('player_match_stats')
      .select('api_player_id,player_id,fantasy_points,minutes,goals,assists,yellow_cards,red_cards,goals_conceded');
    var seasonMap = {};
    (matchStats || []).forEach(function(s) {
      // Use api_player_id as the key — always present
      var key = String(s.api_player_id || s.player_id || '');
      if (!key || key === 'null' || key === 'undefined') return;
      if (!seasonMap[key]) seasonMap[key] = {
        api_player_id: s.api_player_id, player_id: s.player_id,
        total_points: 0, apps: 0, goals: 0, assists: 0,
        yellow_cards: 0, red_cards: 0, clean_sheets: 0
      };
      seasonMap[key].total_points += (s.fantasy_points || 0);
      if ((s.minutes || 0) > 0) seasonMap[key].apps += 1;
      seasonMap[key].goals        += (s.goals         || 0);
      seasonMap[key].assists      += (s.assists       || 0);
      seasonMap[key].yellow_cards += (s.yellow_cards  || 0);
      seasonMap[key].red_cards    += (s.red_cards     || 0);
      if ((s.goals_conceded || 0) === 0 && (s.minutes || 0) >= 60) seasonMap[key].clean_sheets += 1;
    });
    log.push('Unique players in match stats: ' + Object.keys(seasonMap).length);

    var playersSynced = 0;
    for (var k in seasonMap) {
      var agg = seasonMap[k];
      var updateData = {
        total_points: agg.total_points, apps: agg.apps, goals: agg.goals,
        assists: agg.assists, yellow_cards: agg.yellow_cards, red_cards: agg.red_cards,
        clean_sheets: agg.clean_sheets, updated_at: new Date().toISOString()
      };

      var updated = false;

      // Try by DB player_id first (fastest)
      if (agg.player_id) {
        var r1 = await db.from('players').update(updateData).eq('id', agg.player_id);
        if (!r1.error) updated = true;
      }

      // Fallback: match by api_player_id column in players table
      if (!updated && agg.api_player_id) {
        var r2 = await db.from('players').update(updateData).eq('api_player_id', String(agg.api_player_id));
        if (!r2.error) updated = true;
      }

      if (updated) playersSynced++;
    }
    log.push('Players synced: ' + playersSynced);

    // 6. Recalculate profiles — squads stored in profiles.squad_data as JSON array
    var { data: profilesWithSquads } = await db.from('profiles')
      .select('id, squad_data, squad_count')
      .not('squad_data', 'is', null)
      .gt('squad_count', 0);

    var profilesUpdated = 0;
    for (var pi = 0; pi < (profilesWithSquads || []).length; pi++) {
      var prof = profilesWithSquads[pi];
      try {
        // Parse squad_data JSON — array of {id, name, position, ...}
        var squadArr = typeof prof.squad_data === 'string'
          ? JSON.parse(prof.squad_data)
          : prof.squad_data;
        if (!Array.isArray(squadArr) || !squadArr.length) continue;

        // Extract player IDs — stored as numeric id in squad_data
        var playerIds = squadArr.map(function(p) {
          return String(p.id || p.player_id || '');
        }).filter(Boolean);

        if (!playerIds.length) continue;

        // Get current total_points for each player
        var { data: pts } = await db.from('players')
          .select('id, total_points')
          .in('id', playerIds);

        var total = (pts || []).reduce(function(acc, p) {
          return acc + (p.total_points || 0);
        }, 0);

        await db.from('profiles')
          .update({ total_points: total, squad_count: squadArr.length })
          .eq('id', prof.id);

        profilesUpdated++;
      } catch(pe) {
        log.push('Profile ' + prof.id + ' error: ' + pe.message);
      }
    }
    log.push('Profiles updated: ' + profilesUpdated);

    return res.json({
      success: true, season_year: sy,
      fixtures_total: allFixtures.length,
      batch_current: batchNum,
      batch_total: totalBatches,
      batch_done: batchNum >= totalBatches - 1,
      next_batch: batchNum < totalBatches - 1 ? batchNum + 1 : null,
      stats_inserted: statsInserted, stats_skipped: statsSkipped,
      players_synced: playersSynced, profiles_updated: profilesUpdated, log
    });

  } catch(err) {
    console.error('[points-cron]', err.message);
    return res.status(500).json({ error: err.message, log });
  }
};

// ── Sync fixtures to Supabase ─────────────────────────────────────────────
async function syncFixtures(db, sy, log, statusFilter) {
  var apiStatus = statusFilter === 'NS' ? 'NS' : 'FT';
  var param     = statusFilter === 'NS' ? '&next=50' : '&last=50';
  var count = 0;
  var d = await apiFetch('/fixtures?league=' + PSL_LEAGUE + '&season=' + sy + '&status=' + apiStatus + param, process.env.APIFOOTBALL_KEY || '');
  for (var i = 0; i < (d.response || []).length; i++) {
    var f = d.response[i];
    var fix = f.fixture || {}, teams = f.teams || {}, goals = f.goals || {}, league = f.league || {};
    var fStatus = fix.status && fix.status.short || 'NS';
    var isFT = ['FT','AET','PEN'].indexOf(fStatus) > -1;
    await db.from('fixtures').upsert({
      api_fixture_id: fix.id,
      home_team: (teams.home && teams.home.name) || 'TBD',
      away_team: (teams.away && teams.away.name) || 'TBD',
      home_logo: (teams.home && teams.home.logo) || null,
      away_logo: (teams.away && teams.away.logo) || null,
      home_score: isFT ? goals.home : null,
      away_score: isFT ? goals.away : null,
      status: isFT ? 'FT' : 'NS',
      kickoff_at: fix.date,
      round: league.round || null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'api_fixture_id' });
    count++;
  }
  log.push(statusFilter + ' fixtures synced: ' + count);
  return count;
}
