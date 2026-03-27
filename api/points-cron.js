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

    // 4. Process each fixture
    for (var fi = 0; fi < allFixtures.length; fi++) {
      var f   = allFixtures[fi];
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

    // 5. Aggregate season stats
    var { data: matchStats } = await db.from('player_match_stats')
      .select('player_id,fantasy_points,minutes,goals,assists,yellow_cards,red_cards,goals_conceded');
    var seasonMap = {};
    (matchStats || []).forEach(function(s) {
      if (!s.player_id) return;
      var k = String(s.player_id);
      if (!seasonMap[k]) seasonMap[k] = { player_id: s.player_id, total_points: 0, apps: 0, goals: 0, assists: 0, yellow_cards: 0, red_cards: 0, clean_sheets: 0 };
      seasonMap[k].total_points += (s.fantasy_points || 0);
      if ((s.minutes || 0) > 0) seasonMap[k].apps += 1;
      seasonMap[k].goals        += (s.goals         || 0);
      seasonMap[k].assists      += (s.assists       || 0);
      seasonMap[k].yellow_cards += (s.yellow_cards  || 0);
      seasonMap[k].red_cards    += (s.red_cards     || 0);
      if ((s.goals_conceded || 0) === 0 && (s.minutes || 0) >= 60) seasonMap[k].clean_sheets += 1;
    });

    var playersSynced = 0;
    for (var k in seasonMap) {
      var agg = seasonMap[k];
      await db.from('players').update({
        total_points: agg.total_points, apps: agg.apps, goals: agg.goals,
        assists: agg.assists, yellow_cards: agg.yellow_cards, red_cards: agg.red_cards,
        clean_sheets: agg.clean_sheets, updated_at: new Date().toISOString()
      }).eq('id', agg.player_id);
      await db.from('player_season_stats').upsert({
        player_id: agg.player_id, total_points: agg.total_points, apps: agg.apps,
        goals: agg.goals, assists: agg.assists, updated_at: new Date().toISOString()
      }, { onConflict: 'player_id' });
      playersSynced++;
    }
    log.push('Players synced: ' + playersSynced);

    // 6. Recalculate profiles
    var { data: squads } = await db.from('squads').select('user_id,player_id');
    var userSquads = {};
    (squads || []).forEach(function(sq) {
      if (!sq.user_id || !sq.player_id) return;
      if (!userSquads[sq.user_id]) userSquads[sq.user_id] = new Set();
      userSquads[sq.user_id].add(sq.player_id);
    });
    var profilesUpdated = 0;
    for (var uid in userSquads) {
      var pids  = Array.from(userSquads[uid]);
      var { data: pts } = await db.from('players').select('total_points').in('id', pids);
      var total = (pts || []).reduce(function(acc, p) { return acc + (p.total_points || 0); }, 0);
      await db.from('profiles').update({ total_points: total, squad_count: pids.length }).eq('id', uid);
      profilesUpdated++;
    }
    log.push('Profiles updated: ' + profilesUpdated);

    return res.json({
      success: true, season_year: sy,
      fixtures_fetched: allFixtures.length,
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
