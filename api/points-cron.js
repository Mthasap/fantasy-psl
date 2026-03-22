// ══════════════════════════════════════════════════════════════════════════
// api/points-cron.js  —  Fantasy PSL  —  Nightly Data Sync
// Data provider: Sportmonks v3 ONLY
// Correct endpoints confirmed via sportmonks-setup.js diagnostics
// ══════════════════════════════════════════════════════════════════════════
const { createClient } = require('@supabase/supabase-js');
const { calculateFantasyPoints, normalisePosition } = require('./football_scoring');

const TOKEN    = process.env.SPORTMONKS_TOKEN    || '';
const SB_URL   = process.env.SUPABASE_URL        || '';
const SB_KEY   = process.env.SUPABASE_SERVICE_KEY || '';
const ADMIN    = process.env.ADMIN_SECRET        || 'fpsl-admin-2026';
const PSL_ID   = 806;
const BASE_URL = 'https://api.sportmonks.com/v3/football';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  var adminKey = (req.query && req.query.admin_key) || '';
  var isAdmin  = adminKey === ADMIN;
  var isCron   = req.headers['x-vercel-cron'] === '1';

  if (!isCron && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  if (!TOKEN)              return res.status(500).json({ error: 'SPORTMONKS_TOKEN missing' });
  if (!SB_URL || !SB_KEY)  return res.status(500).json({ error: 'Supabase env vars missing' });

  var db  = createClient(SB_URL, SB_KEY);
  var log = [];

  try {

    // ── STEP 1: Get / cache current season ID ─────────────────────────────
    // Uses correct Sportmonks v3 endpoints — no bad filter params
    var seasonId;
    var seasonCacheRes = await db.from('api_cache')
      .select('value').eq('key', 'psl_current_season_id').single();
    var seasonCache = seasonCacheRes.data;

    if (seasonCache && seasonCache.value) {
      seasonId = parseInt(seasonCache.value, 10);
      log.push('Season ID from cache: ' + seasonId);
    } else {
      // Primary: league endpoint with currentSeason include
      var leagueData = await smGet('/leagues/' + PSL_ID + '?include=currentSeason');
      var cs = leagueData.data && (leagueData.data.currentSeason || leagueData.data.current_season);
      seasonId = cs && cs.id;

      if (!seasonId) {
        // Fallback: list seasons filtered by league (correct Sportmonks v3 filter name)
        var seasonsData = await smGet('/seasons?filters=leagueId:' + PSL_ID + '&per_page=10');
        var seasonsList = (seasonsData.data || []).sort(function(a, b) { return b.id - a.id; });
        seasonId = seasonsList[0] && seasonsList[0].id;
        log.push('Season ID from seasons list: ' + seasonId);
      } else {
        log.push('Season ID from league include: ' + seasonId);
      }

      if (!seasonId) throw new Error('Could not determine current PSL season ID. Run /api/sportmonks-setup?admin_key=fpsl-admin-2026&action=diagnose to debug.');

      await db.from('api_cache').upsert({
        key: 'psl_current_season_id',
        value: seasonId.toString(),
        updated_at: new Date().toISOString()
      }, { onConflict: 'key' });
    }

    // ── STEP 2: Sync upcoming fixtures ────────────────────────────────────
    // Correct endpoint: /fixtures/upcoming/season/{id}  (NO filters= param needed)
    var upcomingUpserted = 0;
    try {
      var upcomingData = await smGet('/fixtures/upcoming/season/' + seasonId + '?include=participants;round&per_page=50');
      var upcomingFixtures = upcomingData.data || [];
      for (var i = 0; i < upcomingFixtures.length; i++) {
        var f = upcomingFixtures[i];
        var parts = f.participants || [];
        var home     = (parts.find(function(p){ return p.meta && p.meta.location === 'home'; }) || {}).name || 'TBD';
        var away     = (parts.find(function(p){ return p.meta && p.meta.location === 'away'; }) || {}).name || 'TBD';
        var homeLogo = (parts.find(function(p){ return p.meta && p.meta.location === 'home'; }) || {}).image_path || null;
        var awayLogo = (parts.find(function(p){ return p.meta && p.meta.location === 'away'; }) || {}).image_path || null;
        await db.from('fixtures').upsert({
          id: f.id, sportmonks_id: f.id,
          home_team: home, away_team: away,
          home_logo: homeLogo, away_logo: awayLogo,
          home_score: null, away_score: null,
          status: 'NS', kickoff_at: f.starting_at,
          round: (f.round && f.round.name) || null,
          updated_at: new Date().toISOString()
        }, { onConflict: 'id' });
        upcomingUpserted++;
      }
      log.push('Upcoming fixtures synced: ' + upcomingUpserted);
    } catch(e) {
      log.push('Upcoming fixtures error (non-fatal): ' + e.message);
    }

    // ── STEP 3: Sync past results ─────────────────────────────────────────
    // Correct endpoint: /fixtures/past/season/{id}
    var pastUpserted = 0;
    try {
      var pastData = await smGet('/fixtures/past/season/' + seasonId + '?include=participants;scores&per_page=50');
      var pastFixtures = pastData.data || [];
      for (var j = 0; j < pastFixtures.length; j++) {
        var pf = pastFixtures[j];
        var pparts = pf.participants || [];
        var phome     = (pparts.find(function(p){ return p.meta && p.meta.location === 'home'; }) || {}).name || 'TBD';
        var paway     = (pparts.find(function(p){ return p.meta && p.meta.location === 'away'; }) || {}).name || 'TBD';
        var phomeLogo = (pparts.find(function(p){ return p.meta && p.meta.location === 'home'; }) || {}).image_path || null;
        var pawayLogo = (pparts.find(function(p){ return p.meta && p.meta.location === 'away'; }) || {}).image_path || null;
        var homeScore = null, awayScore = null;
        (pf.scores || []).forEach(function(s) {
          var desc = (s.description || '').toUpperCase();
          if (['CURRENT','FT','FULLTIME','2ND_HALF'].indexOf(desc) > -1) {
            if (s.score && s.score.participant === 'home') homeScore = s.score.goals;
            if (s.score && s.score.participant === 'away') awayScore = s.score.goals;
          }
        });
        await db.from('fixtures').upsert({
          id: pf.id, sportmonks_id: pf.id,
          home_team: phome, away_team: paway,
          home_logo: phomeLogo, away_logo: pawayLogo,
          home_score: homeScore, away_score: awayScore,
          status: 'FT', kickoff_at: pf.starting_at,
          round: (pf.round && pf.round.name) || null,
          updated_at: new Date().toISOString()
        }, { onConflict: 'id' });
        pastUpserted++;
      }
      log.push('Past fixtures synced: ' + pastUpserted);
    } catch(e) {
      log.push('Past fixtures error (non-fatal): ' + e.message);
    }

    // ── STEP 4: Sync standings ────────────────────────────────────────────
    var standingsSynced = 0;
    try {
      var standData = await smGet('/standings/seasons/' + seasonId);
      var standGroups = standData.data || [];
      // Data can be nested groups or flat array
      var standRows = [];
      standGroups.forEach(function(g) {
        if (g.standings && Array.isArray(g.standings)) {
          standRows = standRows.concat(g.standings);
        } else if (g.position) {
          standRows.push(g);
        }
      });

      if (standRows.length) {
        var upsertRows = standRows.map(function(s, idx) {
          var det = s.details || [];
          function dv(typeId) {
            var d = det.find(function(x) { return x.type_id === typeId; });
            return d ? (d.value || 0) : 0;
          }
          var participant = s.participant || {};
          return {
            id:            s.participant_id || participant.id || (idx + 1),
            team_name:     participant.name  || s.team_name || 'Unknown',
            team_logo:     participant.image_path || null,
            position:      s.position || idx + 1,
            played:        dv(129) || s.games_played || 0,
            won:           dv(130) || s.won   || 0,
            drawn:         dv(131) || s.draw  || 0,
            lost:          dv(132) || s.lost  || 0,
            goals_for:     dv(133) || s.goals_scored   || 0,
            goals_against: dv(134) || s.goals_conceded || 0,
            goal_diff:     dv(135) || s.goal_difference || 0,
            points:        s.points || 0,
            form:          Array.isArray(s.form) ? s.form.slice(-5).join(',') : (s.form || ''),
            updated_at:    new Date().toISOString()
          };
        });
        await db.from('standings').upsert(upsertRows, { onConflict: 'id' });
        standingsSynced = upsertRows.length;
        log.push('Standings synced: ' + standingsSynced + ' teams');
      }
    } catch(e) {
      log.push('Standings error (non-fatal): ' + e.message);
    }

    // ── STEP 5: Score completed matches ───────────────────────────────────
    // Fetch recently completed fixtures from Supabase (already synced in step 3)
    var oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    var completedRes = await db.from('fixtures')
      .select('id,status,kickoff_at,home_team,away_team,home_score,away_score')
      .eq('status', 'FT')
      .gte('kickoff_at', oneWeekAgo)
      .order('kickoff_at', { ascending: false });
    var completedFixtures = completedRes.data || [];

    var pointsProcessed = 0;

    for (var fi = 0; fi < completedFixtures.length; fi++) {
      var fix = completedFixtures[fi];
      try {
        // Skip if already scored (unless admin forcing refresh)
        var existRes = await db.from('player_match_stats').select('id').eq('fixture_id', fix.id).limit(1);
        if (existRes.data && existRes.data.length && !isAdmin) {
          log.push('Fixture ' + fix.id + ': already scored, skipping');
          continue;
        }

        // Fetch full fixture: lineups + events + statistics
        var fData = await smGet(
          '/fixtures/' + fix.id +
          '?include=events.type;lineups.player;lineups.position;statistics.type;participants'
        );
        var fixture = fData.data;
        if (!fixture) { log.push('Fixture ' + fix.id + ': no data returned'); continue; }

        var participants = fixture.participants || [];
        var homeTeam = participants.find(function(p) { return p.meta && p.meta.location === 'home'; });
        var awayTeam = participants.find(function(p) { return p.meta && p.meta.location === 'away'; });

        // Build player map from lineups
        var playerMap = {};
        (fixture.lineups || []).forEach(function(lineup) {
          var p   = lineup.player || {};
          var pid = p.id;
          if (!pid) return;

          var team     = participants.find(function(t) { return t.id === lineup.team_id; });
          var pos      = normalisePosition((lineup.position && (lineup.position.name || lineup.position.developer_name)) || '');
          var isStart  = !lineup.is_substitute;
          var minIn    = (lineup.player_in_minute !== undefined && lineup.player_in_minute !== null) ? lineup.player_in_minute : (isStart ? 0 : null);
          var minOut   = lineup.player_out_minute || 90;
          var minutes  = (minIn !== null) ? Math.max(0, minOut - minIn) : (isStart ? 90 : 0);
          var isHome   = homeTeam && team && team.id === homeTeam.id;
          var teamConc = isHome ? (fix.away_score || 0) : (fix.home_score || 0);

          playerMap[pid] = {
            player_id:     pid,
            fixture_id:    fix.id,
            player_name:   p.display_name || p.name || 'Unknown',
            player_image:  p.image_path || null,
            team_name:     (team && team.name) || '',
            position:      pos,
            minutes:       minutes,
            goals:         0, assists:      0,
            yellow_cards:  0, red_cards:    0,
            saves:         0, pen_saved:    0, pen_missed: 0,
            goals_conceded: (pos === 'GK' || pos === 'DEF') ? teamConc : 0
          };
        });

        // Process events → goals, assists, cards, pens
        (fixture.events || []).forEach(function(ev) {
          var typeId  = (ev.type && ev.type.id) || ev.type_id;
          var devName = ((ev.type && ev.type.developer_name) || '').toUpperCase();
          var pid     = ev.player_id || (ev.player && ev.player.id);
          var relPid  = ev.related_player_id || (ev.related_player && ev.related_player.id);

          // Goals (normal + penalty)
          if (typeId === 16 || typeId === 19 ||
              devName === 'GOAL' || devName === 'GOAL_NORMAL' || devName === 'GOAL_PENALTY') {
            if (pid    && playerMap[pid])    playerMap[pid].goals++;
            if (relPid && playerMap[relPid]) playerMap[relPid].assists++;
          }
          // Penalty missed
          else if (typeId === 20 || devName === 'MISSED_PENALTY' || devName === 'PENALTY_MISSED') {
            if (pid && playerMap[pid]) playerMap[pid].pen_missed++;
          }
          // Penalty saved (goalkeeper)
          else if (typeId === 58 || devName === 'PENALTY_SAVED') {
            if (pid && playerMap[pid]) playerMap[pid].pen_saved++;
          }
          // Yellow card
          else if (typeId === 84 || devName === 'YELLOWCARD' || devName === 'YELLOW_CARD') {
            if (pid && playerMap[pid]) playerMap[pid].yellow_cards++;
          }
          // Red card or second yellow = red
          else if (typeId === 83 || devName === 'REDCARD' || devName === 'RED_CARD' ||
                   devName === 'YELLOWRED' || devName === 'YELLOW_RED_CARD') {
            if (pid && playerMap[pid]) playerMap[pid].red_cards++;
          }
        });

        // GK saves from statistics
        (fixture.statistics || []).forEach(function(stat) {
          var tn = ((stat.type && stat.type.developer_name) || '').toUpperCase();
          if (tn === 'SAVES' || tn === 'GOALKEEPER_SAVES') {
            var pid = stat.player_id || (stat.player && stat.player.id);
            if (pid && playerMap[pid]) {
              playerMap[pid].saves = (stat.value && stat.value.total) || 0;
            }
          }
        });

        // Calculate fantasy points for each player
        var statsRows = [];
        Object.keys(playerMap).forEach(function(key) {
          var p = playerMap[key];
          var result = calculateFantasyPoints({
            minutes:       p.minutes,
            goals:         p.goals,
            assists:       p.assists,
            goalsConceded: p.goals_conceded,
            saves:         p.saves,
            penSaved:      p.pen_saved,
            penMissed:     p.pen_missed,
            yellowCards:   p.yellow_cards,
            redCards:      p.red_cards,
            pos:           p.position
          });
          statsRows.push({
            fixture_id:       p.fixture_id,
            player_id:        p.player_id,
            player_name:      p.player_name,
            team_name:        p.team_name,
            position:         p.position,
            minutes:          p.minutes,
            goals:            p.goals,
            assists:          p.assists,
            yellow_cards:     p.yellow_cards,
            red_cards:        p.red_cards,
            saves:            p.saves,
            pen_saved:        p.pen_saved,
            pen_missed:       p.pen_missed,
            goals_conceded:   p.goals_conceded,
            fantasy_points:   result.total,
            points_breakdown: result.breakdown,
            updated_at:       new Date().toISOString()
          });
        });

        if (statsRows.length) {
          await db.from('player_match_stats').upsert(statsRows, { onConflict: 'fixture_id,player_id' });
        }

        // Update player season totals in players table
        for (var ri = 0; ri < statsRows.length; ri++) {
          var row = statsRows[ri];
          var foundRes = await db.from('players')
            .select('id,goals,assists,yellow_cards,red_cards,apps,clean_sheets,total_points')
            .eq('api_player_id', String(row.player_id)).limit(1);
          if (!foundRes.data || !foundRes.data.length) continue;
          var ex = foundRes.data[0];
          var cs = (row.goals_conceded === 0 && row.minutes >= 60 &&
            (row.position === 'GK' || row.position === 'DEF')) ? 1 : 0;
          await db.from('players').update({
            goals:        (ex.goals        || 0) + row.goals,
            assists:      (ex.assists      || 0) + row.assists,
            yellow_cards: (ex.yellow_cards || 0) + row.yellow_cards,
            red_cards:    (ex.red_cards    || 0) + row.red_cards,
            clean_sheets: (ex.clean_sheets || 0) + cs,
            apps:         (ex.apps         || 0) + (row.minutes > 0 ? 1 : 0),
            total_points: (ex.total_points || 0) + row.fantasy_points,
            updated_at:   new Date().toISOString()
          }).eq('id', ex.id);
        }

        // Update user GW points
        await updateUserGWPoints(db, fix.id, statsRows);

        pointsProcessed += statsRows.length;
        log.push('Fixture ' + fix.id + ': scored ' + statsRows.length + ' players');

      } catch(e) {
        log.push('Fixture ' + fix.id + ' error (non-fatal): ' + e.message);
      }
    }

    // ── STEP 6: Top scorers (weekly or forced) ────────────────────────────
    var scorersSynced = false;
    var topCacheRes = await db.from('api_cache')
      .select('updated_at').eq('key', 'topscorers_last_sync').single();
    var topCache = topCacheRes.data;

    var needTop = isAdmin || !topCache || !topCache.updated_at ||
      (Date.now() - new Date(topCache.updated_at).getTime()) > 7 * 24 * 60 * 60 * 1000;

    if (needTop) {
      try {
        // Correct Sportmonks v3 endpoint for top scorers
        var tsData = await smGet('/topscorers/seasons/' + seasonId + '?include=player;participant&per_page=30');
        var scorerRows = (tsData.data || []).map(function(entry, i) {
          return {
            season_id:   seasonId,
            player_id:   entry.player_id,
            player_name: (entry.player && (entry.player.display_name || entry.player.name)) || 'Unknown',
            team_name:   (entry.participant && entry.participant.name) || '',
            goals:       entry.total || entry.goals || 0,
            rank:        i + 1,
            updated_at:  new Date().toISOString()
          };
        });

        if (scorerRows.length) {
          await db.from('player_season_stats').upsert(scorerRows, { onConflict: 'season_id,player_id' });
          scorersSynced = true;
          log.push('Top scorers synced: ' + scorerRows.length);
        }

        await db.from('api_cache').upsert({
          key: 'topscorers_last_sync',
          value: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' });

      } catch(e) {
        log.push('Top scorers error (non-fatal): ' + e.message);
      }
    }

    return res.json({
      success:            true,
      season_id:          seasonId,
      upcoming_synced:    upcomingUpserted,
      past_synced:        pastUpserted,
      standings_synced:   standingsSynced,
      players_scored:     pointsProcessed,
      top_scorers_synced: scorersSynced,
      log:                log,
      message: isAdmin ? 'Manual full refresh completed' : 'Cron run OK'
    });

  } catch(err) {
    console.error('[points-cron] FATAL:', err.message);
    return res.status(500).json({ error: err.message, log: log });
  }
};

// ── Update user GW points ─────────────────────────────────────────────────
async function updateUserGWPoints(db, fixtureId, statsRows) {
  var gwRes = await db.from('gameweeks').select('id,number').eq('is_current', true).limit(1);
  if (!gwRes.data || !gwRes.data.length) return;
  var gw = gwRes.data[0];

  var profilesRes = await db.from('profiles').select('id,squad,gw_points,total_points');
  if (!profilesRes.data || !profilesRes.data.length) return;

  for (var i = 0; i < profilesRes.data.length; i++) {
    var profile = profilesRes.data[i];
    var squad = profile.squad;
    if (!squad || !Array.isArray(squad)) continue;

    var gwPoints = 0;
    for (var j = 0; j < squad.length; j++) {
      var sp = squad[j];
      var matchStat = statsRows.find(function(s) {
        return String(s.player_id) === String(sp.api_player_id) ||
               String(s.player_id) === String(sp.player_id);
      });
      if (!matchStat) continue;
      var pts = matchStat.fantasy_points || 0;
      if (sp.is_captain) pts *= 2;
      gwPoints += pts;
    }

    if (gwPoints > 0) {
      await db.from('user_gw_points').upsert({
        user_id:    profile.id,
        gw_id:      gw.id,
        gw_number:  gw.number,
        points:     gwPoints,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,gw_id' });

      var histRes = await db.from('user_gw_points').select('points').eq('user_id', profile.id);
      var total = (histRes.data || []).reduce(function(sum, r) { return sum + (r.points || 0); }, 0);
      await db.from('profiles').update({
        gw_points:    gwPoints,
        total_points: total,
        updated_at:   new Date().toISOString()
      }).eq('id', profile.id);
    }
  }
}

// ── Sportmonks GET helper ─────────────────────────────────────────────────
async function smGet(path) {
  var sep = path.indexOf('?') > -1 ? '&' : '?';
  var url = BASE_URL + path + sep + 'api_token=' + TOKEN;
  console.log('[SM GET]', path.split('?')[0]);
  var r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) {
    var body = await r.text().catch(function() { return ''; });
    throw new Error('Sportmonks ' + r.status + ': ' + body.substring(0, 300));
  }
  var json = await r.json();
  if (json.errors) throw new Error('Sportmonks errors: ' + JSON.stringify(json.errors).substring(0, 300));
  return json;
}
