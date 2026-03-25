// api/points-cron.js — Fantasy PSL Points Engine (v3 — Sportmonks)
// Runs nightly via Vercel cron (vercel.json: "0 21 * * *")
// Triggered manually from Admin Panel → Automation tab
//
// FLOW:
//   1. Get current season ID
//   2. Fetch all FT fixtures for season from Sportmonks
//   3. For each NEW fixture: fetch lineups + events (goals, assists, cards, subs)
//   4. Build per-player match stat rows with real minutes played
//   5. Calculate fantasy points using position-aware scoring rules
//   6. Update player_match_stats + players table + player_season_stats
//   7. Recalculate profile total_points from squad selections

const { createClient } = require('@supabase/supabase-js');
const { getSeasonId }  = require('./season-helper');

const TOKEN  = process.env.SPORTMONKS_TOKEN;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN  = process.env.ADMIN_SECRET || 'fpsl-admin-2026';
const BASE   = 'https://api.sportmonks.com/v3/football';

// ── Fantasy scoring rules ─────────────────────────────────────────────────
function calcPoints(s) {
  var pts = 0, breakdown = {};
  function add(k, v) { if (v) { breakdown[k] = v; pts += v; } }

  if (!s.minutes || s.minutes === 0) return { total: 0, breakdown: { dnp: 0 } };

  add('appearance', s.minutes >= 60 ? 2 : 1);

  if (s.goals > 0) {
    var gPts = (s.pos === 'GK' || s.pos === 'DEF') ? 6
             : s.pos === 'MID' ? 5 : 4;
    add('goals', s.goals * gPts);
  }
  if (s.assists      > 0) add('assists',         s.assists      * 3);
  if (s.minutes >= 60 && s.goalsConceded === 0) {
    if (s.pos === 'GK' || s.pos === 'DEF') add('clean_sheet', 4);
    else if (s.pos === 'MID')              add('clean_sheet', 1);
  }
  if ((s.pos === 'GK' || s.pos === 'DEF') && s.goalsConceded >= 2)
    add('goals_conceded', -Math.floor(s.goalsConceded / 2));
  if (s.pos === 'GK' && s.saves >= 3)
    add('saves_bonus', Math.floor(s.saves / 3));
  if (s.penSaved  > 0) add('penalty_saved',  s.penSaved  *  5);
  if (s.penMissed > 0) add('penalty_missed', s.penMissed * -2);
  if (s.yellowCards > 0) add('yellow_card', s.yellowCards * -1);
  if (s.redCards    > 0) add('red_card',    s.redCards    * -3);

  return { total: pts, breakdown };
}

function normPos(raw) {
  if (!raw) return 'MID';
  var r = raw.toUpperCase().trim();
  if (r === 'GK'  || r.includes('GOAL'))                       return 'GK';
  if (r === 'DEF' || r === 'D' || r.includes('DEFEN'))         return 'DEF';
  if (r === 'FWD' || r === 'F' || r === 'ST' ||
      r.includes('ATTACK') || r.includes('FORW'))               return 'FWD';
  return 'MID';
}

// ── Main handler ─────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  var adminKey = (req.query && req.query.admin_key) || (req.headers && req.headers['x-admin-key']);
  var isCron   = req.headers && req.headers['x-vercel-cron'] === '1';
  if (!isCron && adminKey !== ADMIN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!TOKEN || !SB_URL || !SB_KEY) {
    return res.status(500).json({ error: 'Missing env vars: SPORTMONKS_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_KEY' });
  }

  // mode param from admin buttons: 'fixtures', 'results', 'points', 'all'
  var mode = (req.query && req.query.mode) || 'all';

  var db  = createClient(SB_URL, SB_KEY);
  var log = [];

  try {
    var seasonId = await getSeasonId(db, TOKEN);
    log.push('Season: ' + seasonId);

    // ── mode=fixtures: sync only upcoming NS fixtures to Supabase ──────
    if (mode === 'fixtures') {
      var count = await syncFixtures(db, seasonId, log, 'NS');
      return res.json({ success: true, mode: 'fixtures', fixtures_synced: count, log });
    }

    // ── mode=results: sync only FT results to Supabase ─────────────────
    if (mode === 'results') {
      var count = await syncFixtures(db, seasonId, log, 'FT');
      return res.json({ success: true, mode: 'results', results_updated: count, log });
    }

    // ── mode=points or mode=all: full scoring run ───────────────────────
    // (fall through to existing scoring logic below)
    log.push('Mode: ' + mode + ' — running full scoring pipeline');

    // ── 2. Fetch all FT fixtures ───────────────────────────────────────
    var allFixtures = [];
    for (var page = 1; page <= 15; page++) {
      var fd = await smGet('/fixtures?filters=fixtureSeasons:' + seasonId + ';fixtureStates:5' +
        '&include=participants;scores&per_page=50&page=' + page);
      var rows = fd.data || [];
      if (!rows.length) break;
      allFixtures = allFixtures.concat(rows);
      if (!(fd.meta && fd.meta.pagination && fd.meta.pagination.has_next_page)) break;
    }
    log.push('FT fixtures: ' + allFixtures.length);

    // ── 3. Load Supabase players (api_player_id → {id, position}) ─────
    var { data: dbPlayers } = await db.from('players').select('id, api_player_id, position');
    var playerMap = {};
    (dbPlayers || []).forEach(function(p) {
      if (p.api_player_id) playerMap[String(p.api_player_id)] = p;
    });
    log.push('DB players: ' + Object.keys(playerMap).length);

    var statsInserted = 0, statsSkipped = 0, fixtureErrors = 0;

    // ── 4. Process each fixture ────────────────────────────────────────
    for (var fi = 0; fi < allFixtures.length; fi++) {
      var f = allFixtures[fi];
      try {
        // Skip if already processed
        var existing = await db.from('player_match_stats')
          .select('id', { count: 'exact', head: true })
          .eq('fixture_id', f.id);
        if (existing.count > 0) { statsSkipped++; continue; }

        // Fetch detail: lineups + events + scores
        var detail = await smGet('/fixtures/' + f.id +
          '?include=lineups.player.position;events;participants;scores');
        var fx = detail.data || {};

        // Parse final score per team (for goals conceded)
        var teamGoals = { home: 0, away: 0 };
        (fx.scores || []).forEach(function(s) {
          var desc = (s.description || '').toUpperCase();
          if (['CURRENT','FT','FULLTIME','2ND_HALF'].indexOf(desc) > -1 && s.score) {
            teamGoals[s.score.participant] = s.score.goals || 0;
          }
        });

        // Map team IDs to home/away
        var parts  = fx.participants || [];
        var homeId = null, awayId = null;
        parts.forEach(function(p) {
          if (p.meta && p.meta.location === 'home') homeId = p.id;
          if (p.meta && p.meta.location === 'away') awayId = p.id;
        });

        // Build player stat objects from lineups
        var fixtureStats = {};

        (fx.lineups || []).forEach(function(entry) {
          var pid = entry.player_id || (entry.player && entry.player.id);
          if (!pid) return;
          var pStr    = String(pid);
          var rawPos  = (entry.player && entry.player.position && entry.player.position.name) || '';
          var pos     = normPos(rawPos);
          var isHome  = entry.team_id === homeId;
          var conceded = isHome ? (teamGoals.away || 0) : (teamGoals.home || 0);
          // type_id 11 = starter, 12 = bench
          var isStarter = entry.type_id === 11;
          var minutes   = isStarter ? 90 : 0; // subs get updated via subst events

          fixtureStats[pStr] = {
            sportmonks_id: pid, pos: pos,
            team_id: entry.team_id, isHome: isHome,
            minutes: minutes, goals: 0, assists: 0,
            goalsConceded: conceded, saves: 0,
            penSaved: 0, penMissed: 0, yellowCards: 0, redCards: 0
          };
        });

        // Overlay events
        (fx.events || []).forEach(function(e) {
          var pid  = e.player_id; if (!pid) return;
          var pStr = String(pid);
          if (!fixtureStats[pStr]) {
            fixtureStats[pStr] = {
              sportmonks_id: pid, pos: 'MID', minutes: 90,
              goals: 0, assists: 0, goalsConceded: 0,
              saves: 0, penSaved: 0, penMissed: 0, yellowCards: 0, redCards: 0
            };
          }
          var s    = fixtureStats[pStr];
          var tid  = e.type_id || 0;
          var type = (e.type || '').toLowerCase();

          // Goals (type_id 14=goal, 16=penalty goal; 15=own goal — skip)
          if ((tid === 14 || tid === 16) && !type.includes('own')) s.goals += 1;

          // Assists via assist_player_id on goal events
          if ((tid === 14 || tid === 16) && e.assist_player_id) {
            var aStr = String(e.assist_player_id);
            if (!fixtureStats[aStr]) {
              fixtureStats[aStr] = {
                sportmonks_id: e.assist_player_id, pos: 'MID', minutes: 90,
                goals: 0, assists: 0, goalsConceded: 0,
                saves: 0, penSaved: 0, penMissed: 0, yellowCards: 0, redCards: 0
              };
            }
            fixtureStats[aStr].assists += 1;
          }

          // Cards
          if (tid === 83)                         s.yellowCards += 1;
          if (tid === 84 || tid === 85)           s.redCards    += 1;

          // GK saves (type_id 58)
          if (tid === 58)                         s.saves += 1;

          // Penalty saved/missed
          if (type.includes('penalty') && type.includes('save'))  s.penSaved  += 1;
          if (tid === 45 || (type.includes('penalty') && type.includes('miss'))) s.penMissed += 1;

          // Substitution (type_id 18): update minutes
          if (tid === 18) {
            s.minutes = e.minute ? Math.min(e.minute, 90) : s.minutes; // player coming OFF
            if (e.related_player_id) {
              var onStr = String(e.related_player_id);
              if (fixtureStats[onStr]) {
                fixtureStats[onStr].minutes = e.minute ? (90 - e.minute) : 30;
              }
            }
          }
        });

        // Write rows to Supabase
        for (var pStr in fixtureStats) {
          var st  = fixtureStats[pStr];
          var dbP = playerMap[pStr];
          var pts = calcPoints({
            pos:           dbP ? normPos(dbP.position) : st.pos,
            minutes:       st.minutes,
            goals:         st.goals,
            assists:       st.assists,
            goalsConceded: st.goalsConceded,
            saves:         st.saves,
            penSaved:      st.penSaved,
            penMissed:     st.penMissed,
            yellowCards:   st.yellowCards,
            redCards:      st.redCards
          });

          await db.from('player_match_stats').upsert({
            fixture_id:       f.id,
            player_id:        dbP ? dbP.id : null,
            sportmonks_pid:   st.sportmonks_id,
            minutes:          st.minutes,
            goals:            st.goals,
            assists:          st.assists,
            goals_conceded:   st.goalsConceded,
            saves:            st.saves,
            yellow_cards:     st.yellowCards,
            red_cards:        st.redCards,
            fantasy_points:   pts.total,
            points_breakdown: JSON.stringify(pts.breakdown),
            updated_at:       new Date().toISOString()
          }, { onConflict: 'fixture_id,sportmonks_pid' });

          statsInserted++;
        }

      } catch(fErr) {
        log.push('Fixture ' + f.id + ' error: ' + fErr.message);
        fixtureErrors++;
      }
    }

    log.push('Stats inserted: ' + statsInserted + ' | skipped: ' + statsSkipped + ' | errors: ' + fixtureErrors);

    // ── 5. Aggregate season stats per DB player ────────────────────────
    var { data: matchStats } = await db
      .from('player_match_stats')
      .select('player_id, fantasy_points, minutes, goals, assists, yellow_cards, red_cards, goals_conceded');

    var seasonMap = {};
    (matchStats || []).forEach(function(s) {
      if (!s.player_id) return;
      var key = String(s.player_id);
      if (!seasonMap[key]) seasonMap[key] = {
        player_id: s.player_id, total_points: 0, apps: 0,
        goals: 0, assists: 0, yellow_cards: 0, red_cards: 0, clean_sheets: 0
      };
      var agg = seasonMap[key];
      agg.total_points += (s.fantasy_points || 0);
      if ((s.minutes || 0) > 0) agg.apps += 1;
      agg.goals        += (s.goals         || 0);
      agg.assists      += (s.assists       || 0);
      agg.yellow_cards += (s.yellow_cards  || 0);
      agg.red_cards    += (s.red_cards     || 0);
      if ((s.goals_conceded || 0) === 0 && (s.minutes || 0) >= 60) agg.clean_sheets += 1;
    });

    var playersSynced = 0;
    for (var key in seasonMap) {
      var agg = seasonMap[key];
      await db.from('players').update({
        total_points: agg.total_points, apps: agg.apps,
        goals: agg.goals, assists: agg.assists,
        yellow_cards: agg.yellow_cards, red_cards: agg.red_cards,
        clean_sheets: agg.clean_sheets, updated_at: new Date().toISOString()
      }).eq('id', agg.player_id);

      await db.from('player_season_stats').upsert({
        player_id: agg.player_id, total_points: agg.total_points,
        apps: agg.apps, goals: agg.goals, assists: agg.assists,
        updated_at: new Date().toISOString()
      }, { onConflict: 'player_id' });

      playersSynced++;
    }
    log.push('Players synced: ' + playersSynced);

    // ── 6. Recalculate profile total_points ───────────────────────────
    var { data: squads } = await db.from('squads').select('user_id, player_id');
    var userSquads = {};
    (squads || []).forEach(function(sq) {
      if (!userSquads[sq.user_id]) userSquads[sq.user_id] = [];
      userSquads[sq.user_id].push(sq.player_id);
    });

    var profilesUpdated = 0;
    for (var uid in userSquads) {
      var pids = userSquads[uid];
      var { data: pts } = await db.from('players').select('total_points').in('id', pids);
      var total = (pts || []).reduce(function(acc, p) { return acc + (p.total_points || 0); }, 0);
      await db.from('profiles').update({ total_points: total }).eq('id', uid);
      profilesUpdated++;
    }
    log.push('Profiles updated: ' + profilesUpdated);

    return res.json({
      success: true,
      season_id: seasonId,
      fixtures_fetched: allFixtures.length,
      stats_inserted: statsInserted,
      stats_skipped: statsSkipped,
      players_synced: playersSynced,
      profiles_updated: profilesUpdated,
      log
    });

  } catch (err) {
    console.error('[points-cron]', err.message);
    return res.status(500).json({ error: err.message, log });
  }
};

// ── syncFixtures: upsert NS or FT fixtures into Supabase ─────────────────
// state: 'NS' (upcoming, fixtureState 1) or 'FT' (results, fixtureState 5)
async function syncFixtures(db, seasonId, log, state) {
  var stateCode = state === 'NS' ? 1 : 5;
  var count = 0;
  for (var page = 1; page <= 10; page++) {
    var d = await smGet(
      '/fixtures?filters=fixtureSeasons:' + seasonId + ';fixtureStates:' + stateCode +
      '&include=participants;scores&per_page=50&page=' + page
    );
    var rows = d.data || [];
    if (!rows.length) break;
    for (var i = 0; i < rows.length; i++) {
      var f     = rows[i];
      var parts = f.participants || [];
      var scores = { home: null, away: null };
      if (state === 'FT') {
        (f.scores || []).forEach(function(s) {
          var desc = (s.description || '').toUpperCase();
          if (['CURRENT','FT','FULLTIME','2ND_HALF'].indexOf(desc) > -1 && s.score) {
            scores[s.score.participant] = s.score.goals;
          }
        });
      }
      var home = parts.find(function(p){ return p.meta && p.meta.location === 'home'; }) || parts[0] || {};
      var away = parts.find(function(p){ return p.meta && p.meta.location === 'away'; }) || parts[1] || {};
      await db.from('fixtures').upsert({
        sportmonks_id: f.id,
        home_team:     home.name || 'TBD',
        away_team:     away.name || 'TBD',
        home_logo:     home.image_path || null,
        away_logo:     away.image_path || null,
        home_score:    scores.home,
        away_score:    scores.away,
        status:        state,
        kickoff_at:    f.starting_at,
        round:         (f.round && f.round.name) || null,
        updated_at:    new Date().toISOString()
      }, { onConflict: 'sportmonks_id' });
      count++;
    }
    if (!(d.meta && d.meta.pagination && d.meta.pagination.has_next_page)) break;
  }
  log.push(state + ' fixtures synced: ' + count);
  return count;
}

async function smGet(path) {
  var sep = path.indexOf('?') > -1 ? '&' : '?';
  var url = BASE + path + sep + 'api_token=' + TOKEN;
  var r   = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) {
    var b = await r.text().catch(function(){ return ''; });
    throw new Error('Sportmonks ' + r.status + ': ' + b.substring(0, 300));
  }
  var json = await r.json();
  if (json.errors) throw new Error('Sportmonks errors: ' + JSON.stringify(json.errors).substring(0, 300));
  return json;
}

  var sep = path.indexOf('?') > -1 ? '&' : '?';
  var url = BASE + path + sep + 'api_token=' + TOKEN;
  var r   = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) {
    var b = await r.text().catch(function(){ return ''; });
    throw new Error('Sportmonks ' + r.status + ': ' + b.substring(0, 300));
  }
  var json = await r.json();
  if (json.errors) throw new Error('Sportmonks errors: ' + JSON.stringify(json.errors).substring(0, 300));
  return json;
}
