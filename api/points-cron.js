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

  var db  = createClient(SB_URL, SB_KEY);
  var log = [];

  try {
    // ── Season ID ─────────────────────────────────────────────────────────
    // Env var override → Supabase cache → /seasons list (no bad filters)
    var seasonId = process.env.SPORTMONKS_SEASON_ID
      ? parseInt(process.env.SPORTMONKS_SEASON_ID, 10)
      : await getSeasonId(db, TOKEN);
    log.push('Season ID: ' + seasonId);

    // ── Sync upcoming fixtures ────────────────────────────────────────────
    var upCount = 0;
    try {
      var upData = await smGet('/fixtures/upcoming/season/' + seasonId + '?include=participants;round&per_page=50');
      for (var i = 0; i < (upData.data || []).length; i++) {
        var f = upData.data[i];
        var parts = f.participants || [];
        await db.from('fixtures').upsert({
          id: f.id, sportmonks_id: f.id,
          home_team: getPart(parts,'home','name') || 'TBD',
          away_team: getPart(parts,'away','name') || 'TBD',
          home_logo: getPart(parts,'home','image_path') || null,
          away_logo: getPart(parts,'away','image_path') || null,
          home_score: null, away_score: null, status: 'NS',
          kickoff_at: f.starting_at,
          round: (f.round && f.round.name) || null,
          updated_at: new Date().toISOString()
        }, { onConflict:'id' });
        upCount++;
      }
      log.push('Upcoming fixtures: ' + upCount);
    } catch(e) { log.push('Upcoming error: ' + e.message); }

    // ── Sync past results ─────────────────────────────────────────────────
    var pastCount = 0;
    try {
      var pastData = await smGet('/fixtures/past/season/' + seasonId + '?include=participants;scores&per_page=50');
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
          id: pf.id, sportmonks_id: pf.id,
          home_team: getPart(pp,'home','name') || 'TBD',
          away_team: getPart(pp,'away','name') || 'TBD',
          home_logo: getPart(pp,'home','image_path') || null,
          away_logo: getPart(pp,'away','image_path') || null,
          home_score: hs, away_score: as_, status: 'FT',
          kickoff_at: pf.starting_at,
          round: (pf.round && pf.round.name) || null,
          updated_at: new Date().toISOString()
        }, { onConflict:'id' });
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

    // ── Score completed matches ───────────────────────────────────────────
    var oneWeekAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString();
    var compRes = await db.from('fixtures')
      .select('id,status,kickoff_at,home_score,away_score')
      .eq('status','FT').gte('kickoff_at', oneWeekAgo)
      .order('kickoff_at',{ ascending:false });
    var completed = compRes.data || [];
    var pointsProcessed = 0;

    for (var fi = 0; fi < completed.length; fi++) {
      var fix = completed[fi];
      try {
        var existRes = await db.from('player_match_stats').select('id').eq('fixture_id', fix.id).limit(1);
        if (existRes.data && existRes.data.length && !isAdmin) {
          log.push('Fixture ' + fix.id + ': already scored');
          continue;
        }

        var fData = await smGet(
          '/fixtures/' + fix.id +
          '?include=events.type;lineups.player;lineups.position;statistics.type;participants'
        );
        var fixture = fData.data;
        if (!fixture) continue;

        var participants = fixture.participants || [];
        var homePart = participants.find(function(p){ return p.meta&&p.meta.location==='home'; });

        // Build player map from lineups
        var playerMap = {};
        (fixture.lineups || []).forEach(function(ln) {
          var p = ln.player || {};
          if (!p.id) return;
          var team   = participants.find(function(t){ return t.id === ln.team_id; });
          var pos    = normalisePosition((ln.position&&(ln.position.name||ln.position.developer_name))||'');
          var isHome = homePart && team && team.id === homePart.id;
          var conc   = isHome ? (fix.away_score||0) : (fix.home_score||0);
          var isSub  = !!ln.is_substitute;
          var minIn  = ln.player_in_minute !== null && ln.player_in_minute !== undefined ? ln.player_in_minute : (isSub ? null : 0);
          var minOut = ln.player_out_minute || 90;
          var mins   = minIn !== null ? Math.max(0, minOut - minIn) : (isSub ? 0 : 90);
          playerMap[p.id] = {
            player_id:p.id, fixture_id:fix.id,
            player_name:p.display_name||p.name||'Unknown',
            team_name:(team&&team.name)||'',
            position:pos, minutes:mins,
            goals:0, assists:0, yellow_cards:0, red_cards:0,
            saves:0, pen_saved:0, pen_missed:0,
            goals_conceded:(pos==='GK'||pos==='DEF') ? conc : 0
          };
        });

        // Events → stats
        (fixture.events || []).forEach(function(ev) {
          var tid  = (ev.type&&ev.type.id)||ev.type_id;
          var dn   = ((ev.type&&ev.type.developer_name)||'').toUpperCase();
          var pid  = ev.player_id||(ev.player&&ev.player.id);
          var rpid = ev.related_player_id||(ev.related_player&&ev.related_player.id);

          if (tid===16||tid===19||dn==='GOAL'||dn==='GOAL_NORMAL'||dn==='GOAL_PENALTY') {
            if (pid  && playerMap[pid])  playerMap[pid].goals++;
            if (rpid && playerMap[rpid]) playerMap[rpid].assists++;
          } else if (tid===20||dn==='MISSED_PENALTY'||dn==='PENALTY_MISSED') {
            if (pid && playerMap[pid]) playerMap[pid].pen_missed++;
          } else if (tid===58||dn==='PENALTY_SAVED') {
            if (pid && playerMap[pid]) playerMap[pid].pen_saved++;
          } else if (tid===84||dn==='YELLOWCARD'||dn==='YELLOW_CARD') {
            if (pid && playerMap[pid]) playerMap[pid].yellow_cards++;
          } else if (tid===83||dn==='REDCARD'||dn==='RED_CARD'||dn==='YELLOWRED'||dn==='YELLOW_RED_CARD') {
            if (pid && playerMap[pid]) playerMap[pid].red_cards++;
          }
        });

        // Statistics → saves
        (fixture.statistics || []).forEach(function(stat) {
          var tn = ((stat.type&&stat.type.developer_name)||'').toUpperCase();
          if (tn==='SAVES'||tn==='GOALKEEPER_SAVES') {
            var pid = stat.player_id||(stat.player&&stat.player.id);
            if (pid && playerMap[pid]) playerMap[pid].saves = (stat.value&&stat.value.total)||0;
          }
        });

        // Calculate points
        var statsRows = [];
        Object.keys(playerMap).forEach(function(key) {
          var p = playerMap[key];
          var r = calculateFantasyPoints({
            minutes:p.minutes, goals:p.goals, assists:p.assists,
            goalsConceded:p.goals_conceded, saves:p.saves,
            penSaved:p.pen_saved, penMissed:p.pen_missed,
            yellowCards:p.yellow_cards, redCards:p.red_cards, pos:p.position
          });
          statsRows.push(Object.assign({},p,{
            fantasy_points:r.total, points_breakdown:r.breakdown,
            updated_at:new Date().toISOString()
          }));
        });

        if (statsRows.length) {
          await db.from('player_match_stats').upsert(statsRows,{ onConflict:'fixture_id,player_id' });
        }

        // Update season totals on players table
        for (var ri = 0; ri < statsRows.length; ri++) {
          var row = statsRows[ri];
          var fr = await db.from('players')
            .select('id,goals,assists,yellow_cards,red_cards,apps,clean_sheets,total_points')
            .eq('api_player_id',String(row.player_id)).limit(1);
          if (!fr.data||!fr.data.length) continue;
          var ex = fr.data[0];
          var cs = (row.goals_conceded===0&&row.minutes>=60&&(row.position==='GK'||row.position==='DEF'))?1:0;
          await db.from('players').update({
            goals:       (ex.goals       ||0)+row.goals,
            assists:     (ex.assists     ||0)+row.assists,
            yellow_cards:(ex.yellow_cards||0)+row.yellow_cards,
            red_cards:   (ex.red_cards   ||0)+row.red_cards,
            clean_sheets:(ex.clean_sheets||0)+cs,
            apps:        (ex.apps        ||0)+(row.minutes>0?1:0),
            total_points:(ex.total_points||0)+row.fantasy_points,
            updated_at:  new Date().toISOString()
          }).eq('id',ex.id);
        }

        await updateUserGWPoints(db, fix.id, statsRows);
        pointsProcessed += statsRows.length;
        log.push('Fixture '+fix.id+': scored '+statsRows.length+' players');

      } catch(e) { log.push('Fixture '+fix.id+' error: '+e.message); }
    }

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

// ── User GW points ────────────────────────────────────────────────────────
async function updateUserGWPoints(db, fixtureId, statsRows) {
  var gwRes = await db.from('gameweeks').select('id,number').eq('is_current',true).limit(1);
  if (!gwRes.data||!gwRes.data.length) return;
  var gw = gwRes.data[0];
  var prRes = await db.from('profiles').select('id,squad');
  for (var i=0;i<(prRes.data||[]).length;i++) {
    var pr=prRes.data[i]; if(!pr.squad||!Array.isArray(pr.squad)) continue;
    var pts=0;
    for (var j=0;j<pr.squad.length;j++) {
      var sp=pr.squad[j];
      var ms=statsRows.find(function(s){return String(s.player_id)===String(sp.api_player_id)||String(s.player_id)===String(sp.player_id);});
      if (!ms) continue;
      pts += sp.is_captain ? (ms.fantasy_points||0)*2 : (ms.fantasy_points||0);
    }
    if (pts>0) {
      await db.from('user_gw_points').upsert({ user_id:pr.id,gw_id:gw.id,gw_number:gw.number,points:pts,updated_at:new Date().toISOString() },{ onConflict:'user_id,gw_id' });
      var hist = await db.from('user_gw_points').select('points').eq('user_id',pr.id);
      var total = (hist.data||[]).reduce(function(s,r){return s+(r.points||0);},0);
      await db.from('profiles').update({ gw_points:pts,total_points:total,updated_at:new Date().toISOString() }).eq('id',pr.id);
    }
  }
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
