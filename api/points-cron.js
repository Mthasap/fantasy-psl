// api/points-cron.js  —  Fantasy PSL  —  Nightly Data Sync  (Sportmonks v3)
const { createClient } = require('@supabase/supabase-js');
const { calculateFantasyPoints, normalisePosition } = require('./football_scoring');
const { getSeasonId } = require('./season-helper');

const TOKEN  = process.env.SPORTMONKS_TOKEN    || '';
const SB_URL = process.env.SUPABASE_URL        || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ADMIN  = process.env.ADMIN_SECRET        || 'fpsl-admin-2026';
const BASE   = 'https://api.sportmonks.com/v3/football';
const PSL_ID = 806;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  var adminKey = (req.query && req.query.admin_key) || '';
  var isAdmin  = adminKey === ADMIN;
  var isCron   = req.headers['x-vercel-cron'] === '1';

  if (!isCron && !isAdmin) return res.status(401).json({ error:'Unauthorized' });
  if (!TOKEN)              return res.status(500).json({ error:'SPORTMONKS_TOKEN missing' });
  if (!SB_URL || !SB_KEY)  return res.status(500).json({ error:'Supabase env vars missing' });

  var db   = createClient(SB_URL, SB_KEY);
  var log  = [];
  // ?step=sync  → only sync fixtures+standings (fast)
  // ?step=score → only score players (slow, makes many API calls)
  // ?step=points → only update user GW points (fast, no API calls)
  // no step → run all (used by nightly cron)
  var step = (req.query && req.query.step) || 'all';

  try {
    // ── Season ID ─────────────────────────────────────────────────────────
    // Env var override → Supabase cache → /seasons list (no bad filters)
    var seasonId = process.env.SPORTMONKS_SEASON_ID
      ? parseInt(process.env.SPORTMONKS_SEASON_ID, 10)
      : await getSeasonId(db, TOKEN);
    log.push('Season ID: ' + seasonId);

    // ── Steps: sync + standings ──────────────────────────────────────────
    if (step === 'all' || step === 'sync') {
    // fixtureStates:1 = Not Started / scheduled
    var upCount = 0;
    try {
      var upData = await smGet('/fixtures?filters=fixtureSeasons:' + seasonId + ';fixtureStates:1&include=participants;round&per_page=50');
      for (var i = 0; i < (upData.data || []).length; i++) {
        var f = upData.data[i];
        var parts = f.participants || [];
        await db.from('fixtures').upsert({
          sportmonks_id: f.id,
          home_team: getPart(parts,'home','name') || 'TBD',
          away_team: getPart(parts,'away','name') || 'TBD',
          home_logo: getPart(parts,'home','image_path') || null,
          away_logo: getPart(parts,'away','image_path') || null,
          home_score: null, away_score: null, status: 'NS',
          kickoff_at: f.starting_at,
          round: (f.round && f.round.name) || null,
          updated_at: new Date().toISOString()
        }, { onConflict:'sportmonks_id', ignoreDuplicates: false });
        upCount++;
      }
      log.push('Upcoming fixtures: ' + upCount);
    } catch(e) { log.push('Upcoming error: ' + e.message); }

    // ── Sync past results ─────────────────────────────────────────────────
    // fixtureStates:5 = Finished/FT
    var pastCount = 0;
    try {
      var pastData = await smGet('/fixtures?filters=fixtureSeasons:' + seasonId + ';fixtureStates:5&include=participants;scores&per_page=50');
      for (var pi = 0; pi < (pastData.data || []).length; pi++) {
        var pf = pastData.data[pi];
        var pp = pf.participants || [];
        var hs = null, as_ = null;
        (pf.scores || []).forEach(function(s) {
          var d = (s.description || '').toUpperCase();
          if (['CURRENT','FT','FULLTIME','2ND_HALF'].indexOf(d) > -1) {
            if (s.score && s.score.participant === 'home') hs  = s.score.goals;
            if (s.score && s.score.participant === 'away') as_ = s.score.goals;
          }
        });
        await db.from('fixtures').upsert({
          sportmonks_id: pf.id,
          home_team: getPart(pp,'home','name') || 'TBD',
          away_team: getPart(pp,'away','name') || 'TBD',
          home_logo: getPart(pp,'home','image_path') || null,
          away_logo: getPart(pp,'away','image_path') || null,
          home_score: hs, away_score: as_, status: 'FT',
          kickoff_at: pf.starting_at,
          round: (pf.round && pf.round.name) || null,
          updated_at: new Date().toISOString()
        }, { onConflict:'sportmonks_id', ignoreDuplicates: false });
        pastCount++;
      }
      log.push('Past results: ' + pastCount);
    } catch(e) { log.push('Past results error: ' + e.message); }

    // ── Sync standings ────────────────────────────────────────────────────
    var standCount = 0;
    try {
      var standData = await smGet('/standings/seasons/' + seasonId);
      var standRows = flattenStandings(standData.data || []);
      if (standRows.length) {
        await db.from('standings').upsert(standRows, { onConflict:'id' });
        standCount = standRows.length;
      }
      log.push('Standings: ' + standCount + ' teams');
    } catch(e) { log.push('Standings error: ' + e.message); }
    } // end sync step

    if (step === 'all' || step === 'score') {
    // ── Calculate fantasy points from existing player_match_stats ─────────
    // NO Sportmonks API calls — uses data already in DB from previous runs
    // This avoids all timeout issues on Vercel free tier

    var forceRescore = req.query && req.query.force === 'true';

    // Get all rows from player_match_stats that need points calculated
    // (where fantasy_points is 0 or null, unless force=true)
    var pmsQuery = db.from('player_match_stats')
      .select('id,fixture_id,player_id,player_name,team_name,position,minutes,goals,assists,yellow_cards,red_cards,saves,pen_saved,pen_missed,goals_conceded,fantasy_points')
      .limit(2000);

    if (!forceRescore) {
      pmsQuery = pmsQuery.eq('fantasy_points', 0);
    }

    var pmsRes = await pmsQuery;
    var pmsRows = pmsRes.data || [];
    log.push('player_match_stats rows to score: ' + pmsRows.length);

    if (!pmsRows.length && !forceRescore) {
      log.push('All players already have points — use ?force=true to recalculate');
    }

    var pointsProcessed = 0;
    var updateBatch = [];

    for (var pi2 = 0; pi2 < pmsRows.length; pi2++) {
      var row = pmsRows[pi2];
      var result = calculateFantasyPoints({
        minutes:       row.minutes       || 0,
        goals:         row.goals         || 0,
        assists:       row.assists       || 0,
        goalsConceded: row.goals_conceded|| 0,
        saves:         row.saves         || 0,
        penSaved:      row.pen_saved     || 0,
        penMissed:     row.pen_missed    || 0,
        yellowCards:   row.yellow_cards  || 0,
        redCards:      row.red_cards     || 0,
        pos:           row.position      || 'MID'
      });

      if (result.total !== row.fantasy_points) {
        updateBatch.push({ id: row.id, fantasy_points: result.total, points_breakdown: result.breakdown });
      }
      pointsProcessed++;
    }

    // Bulk update fantasy_points
    log.push('Updating ' + updateBatch.length + ' player point values');
    for (var ub = 0; ub < updateBatch.length; ub++) {
      await db.from('player_match_stats').update({
        fantasy_points:   updateBatch[ub].fantasy_points,
        points_breakdown: updateBatch[ub].points_breakdown,
        updated_at:       new Date().toISOString()
      }).eq('id', updateBatch[ub].id);
    }

    // Update players table season totals from player_match_stats
    if (updateBatch.length > 0 || forceRescore) {
      // Reset player season stats then sum from player_match_stats
      var resetRes = await db.from('players').update({
        goals: 0, assists: 0, yellow_cards: 0, red_cards: 0,
        clean_sheets: 0, apps: 0, total_points: 0,
        updated_at: new Date().toISOString()
      }).gte('id', 0); // update all
      if (resetRes.error) log.push('Reset error: ' + resetRes.error.message);

      // Get all stats grouped by player
      var allStatsRes = await db.from('player_match_stats')
        .select('player_id,minutes,goals,assists,yellow_cards,red_cards,saves,goals_conceded,fantasy_points,position')
        .limit(2000);

      var playerTotals = {};
      (allStatsRes.data || []).forEach(function(r) {
        var pid = String(r.player_id);
        if (!playerTotals[pid]) playerTotals[pid] = { goals:0,assists:0,yellow_cards:0,red_cards:0,apps:0,clean_sheets:0,total_points:0 };
        var t = playerTotals[pid];
        t.goals        += r.goals         || 0;
        t.assists      += r.assists       || 0;
        t.yellow_cards += r.yellow_cards  || 0;
        t.red_cards    += r.red_cards     || 0;
        t.total_points += r.fantasy_points|| 0;
        if ((r.minutes||0) > 0) t.apps++;
        var pos = r.position || '';
        if (r.goals_conceded === 0 && (r.minutes||0) >= 60 && (pos==='GK'||pos==='DEF')) t.clean_sheets++;
      });

      // Update each player in the players table
      var playerIds = Object.keys(playerTotals);
      log.push('Updating season totals for ' + playerIds.length + ' players');
      for (var pk = 0; pk < playerIds.length; pk++) {
        var pid = playerIds[pk];
        var tot = playerTotals[pid];
        await db.from('players').update({
          goals:        tot.goals,
          assists:      tot.assists,
          yellow_cards: tot.yellow_cards,
          red_cards:    tot.red_cards,
          clean_sheets: tot.clean_sheets,
          apps:         tot.apps,
          total_points: tot.total_points,
          updated_at:   new Date().toISOString()
        }).eq('api_player_id', pid);
      }
    }

    log.push('Players scored: ' + pointsProcessed);
    } // end score step


    // ── Update user GW points ─────────────────────────────────────────────
    if (step === 'all' || step === 'score' || step === 'points') {
    try {
      var gwDbg = await updateUserGWPoints(db);
      (gwDbg||[]).forEach(function(l){ log.push('GWpts: '+l); });
    } catch(e) { log.push('GW points error: '+e.message); }
    } // end points step

    if (step === 'all' || step === 'sync') {
    // ── Top scorers (weekly) ──────────────────────────────────────────────
    var scorersSynced = false;
    try {
      var tcRes = await db.from('api_cache').select('updated_at').eq('key','topscorers_last_sync').single();
      var tc = tcRes.data;
      var needTop = isAdmin||!tc||!tc.updated_at||(Date.now()-new Date(tc.updated_at).getTime())>7*24*60*60*1000;
      if (needTop) {
        var tsData = await smGet('/topscorers/seasons/'+seasonId+'?include=player;participant&per_page=30');
        var scorerRows = (tsData.data||[]).map(function(e,i){
          return {
            season_id:seasonId, player_id:e.player_id,
            player_name:(e.player&&(e.player.display_name||e.player.name))||'Unknown',
            team_name:(e.participant&&e.participant.name)||'',
            goals:e.total||e.goals||0, rank:i+1,
            updated_at:new Date().toISOString()
          };
        });
        if (scorerRows.length) {
          await db.from('player_season_stats').upsert(scorerRows,{ onConflict:'season_id,player_id' });
          scorersSynced = true;
          log.push('Top scorers: '+scorerRows.length);
        }
        await db.from('api_cache').upsert({ key:'topscorers_last_sync', value:new Date().toISOString(), updated_at:new Date().toISOString() },{ onConflict:'key' });
      }
    } catch(e) { log.push('Top scorers error: '+e.message); }
    } // end topscorers sync step

    return res.json({
      success:true, season_id:seasonId,
      upcoming_synced:upCount, past_synced:pastCount,
      standings_synced:standCount, players_scored:pointsProcessed,
      top_scorers_synced:scorersSynced, log,
      message: isAdmin?'Manual refresh done':'Cron OK'
    });

  } catch(err) {
    console.error('[points-cron]',err.message);
    return res.status(500).json({ error:err.message, log });
  }
};

// ── User GW points — aggregates ALL fixtures, called once after scoring ──
async function updateUserGWPoints(db) {
  var dbg = [];

  // Get current GW
  var gwRes = await db.from('gameweeks').select('id,number').eq('is_current',true).limit(1);
  if (!gwRes.data||!gwRes.data.length) { dbg.push('No current GW found'); return dbg; }
  var gw = gwRes.data[0];
  dbg.push('GW: '+gw.number);

  // Fetch player totals in pages to avoid Supabase 1000-row default limit
  var smIdTotals = {};
  var page = 0;
  var pageSize = 1000;
  while (true) {
    var statsRes = await db.from('player_match_stats')
      .select('player_id,fantasy_points')
      .range(page * pageSize, (page + 1) * pageSize - 1);
    var rows = statsRes.data || [];
    if (!rows.length) break;
    for (var i = 0; i < rows.length; i++) {
      var key = String(rows[i].player_id);
      smIdTotals[key] = (smIdTotals[key]||0) + (rows[i].fantasy_points||0);
    }
    if (rows.length < pageSize) break;
    page++;
  }
  dbg.push('Unique players with points: '+Object.keys(smIdTotals).length);

  if (!Object.keys(smIdTotals).length) {
    dbg.push('No scored players found — run step=score first');
    return dbg;
  }

  // Map: supabase players.id → sportmonks api_player_id
  var playersRes = await db.from('players').select('id,api_player_id').limit(2000);
  var supaToSm = {};
  (playersRes.data||[]).forEach(function(p) {
    if (p.api_player_id) supaToSm[String(p.id)] = String(p.api_player_id);
  });
  dbg.push('Players with api_player_id: '+Object.keys(supaToSm).length);

  // Get all profiles with squads
  var prRes = await db.from('profiles').select('id,squad').limit(500);
  var profiles = prRes.data || [];
  dbg.push('Profiles: '+profiles.length);

  var updated = 0;
  for (var pi = 0; pi < profiles.length; pi++) {
    var pr = profiles[pi];
    if (!pr.squad||!Array.isArray(pr.squad)||!pr.squad.length) continue;

    var totalPts = 0, matched = 0;
    for (var j = 0; j < pr.squad.length; j++) {
      var sp = pr.squad[j];
      var smId = supaToSm[String(sp.id)] || String(sp.api_player_id||'');
      var pts = smIdTotals[smId] || 0;
      if (!pts) continue;
      matched++;
      totalPts += (sp.isCaptain||sp.is_captain) ? pts*2 : pts;
    }
    dbg.push('Profile '+String(pr.id).substring(0,8)+' matched:'+matched+'/'+pr.squad.length+' pts:'+totalPts);

    if (totalPts > 0) {
      var ur = await db.from('user_gw_points').upsert({
        user_id:pr.id, gw_id:gw.id, gw_number:gw.number,
        points:totalPts, updated_at:new Date().toISOString()
      }, { onConflict:'user_id,gw_number' });
      if (ur.error) dbg.push('upsert err: '+ur.error.message);

      var upRes = await db.from('profiles').update({
        gw_points:totalPts, total_points:totalPts,
        updated_at:new Date().toISOString()
      }).eq('id',pr.id);
      if (upRes.error) dbg.push('profile err: '+upRes.error.message);
      updated++;
    }
  }
  dbg.push('Profiles updated: '+updated);
  return dbg;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function getPart(parts, loc, field) {
  var p = parts.find(function(x){ return x.meta&&x.meta.location===loc; });
  return p ? p[field] : null;
}

function flattenStandings(data) {
  var rows = [];
  data.forEach(function(g) {
    var items = (g.standings&&Array.isArray(g.standings))?g.standings:(g.position?[g]:[]);
    items.forEach(function(s) {
      var det=s.details||[]; var part=s.participant||{};
      function dv(tid){ var d=det.find(function(x){return x.type_id===tid;}); return d?(d.value||0):0; }
      rows.push({
        id:s.participant_id||part.id||(rows.length+1),
        team_name:part.name||s.team_name||'Unknown',
        team_logo:part.image_path||null,
        position:s.position||rows.length+1,
        played:dv(129)||s.games_played||0, won:dv(130)||s.won||0,
        drawn:dv(131)||s.draw||0,          lost:dv(132)||s.lost||0,
        goals_for:dv(133)||s.goals_scored||0,
        goals_against:dv(134)||s.goals_conceded||0,
        goal_diff:dv(135)||s.goal_difference||0,
        points:s.points||0,
        form:Array.isArray(s.form)?s.form.slice(-5).join(','):(s.form||''),
        updated_at:new Date().toISOString()
      });
    });
  });
  return rows;
}

async function smGet(path) {
  var sep = path.indexOf('?')>-1?'&':'?';
  var url = BASE+path+sep+'api_token='+TOKEN;
  console.log('[SM GET]', path.split('?')[0]);
  var r = await fetch(url,{headers:{Accept:'application/json'}});
  if (!r.ok){ var b=await r.text().catch(function(){return'';}); throw new Error('Sportmonks '+r.status+': '+b.substring(0,300)); }
  var json = await r.json();
  if (json.errors) throw new Error('Sportmonks errors: '+JSON.stringify(json.errors).substring(0,300));
  return json;
}
