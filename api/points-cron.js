// ══════════════════════════════════════════════════════════════════════════
// api/points-cron.js  —  Fantasy PSL  —  FULLY AUTOMATED SYSTEM
// ══════════════════════════════════════════════════════════════════════════
//
// Runs once daily at 23:00 UTC (01:00 SAST). Handles EVERYTHING:
//
//  STEP 1 — SYNC FIXTURES    : Fetch upcoming PSL fixtures → Supabase
//                              This is how new schedule releases appear automatically.
//  STEP 2 — SYNC RESULTS     : Fetch completed match scores → update fixtures table
//                              This is how scorelines appear after games finish.
//  STEP 3 — CALC POINTS      : Calculate fantasy points for every user
//  STEP 4 — MANAGE GAMEWEEKS : Auto-close finished GW, auto-open next GW,
//                              roll over free transfers
//  STEP 5 — UPDATE PRICES    : Adjust player prices based on form (±0.1M)
//
// Can also be triggered manually from the admin panel by sending:
//   POST /api/points-cron  with header  x-admin-key: <ADMIN_SECRET>
//
// ENVIRONMENT VARIABLES (set in Vercel Dashboard → Settings → Env Vars):
//   API_FOOTBALL_KEY      — your API-Football key
//   SUPABASE_URL          — your Supabase project URL
//   SUPABASE_SERVICE_KEY  — your Supabase service role key
//   ADMIN_SECRET          — secret key for admin panel to trigger manually
//
// ══════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const { calculateFantasyPoints, normalisePosition } = require('./football.js');

const API_KEY          = process.env.API_FOOTBALL_KEY     || '';
const SUPABASE_URL     = process.env.SUPABASE_URL         || '';
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const PSL_LEAGUE       = 288;
const SEASON           = 2024;
const BASE_URL         = 'https://v3.football.api-sports.io';

// ── Team name mapping: API-Football names → our DB names ─────────────────
// API-Football uses slightly different names for some clubs.
// Add more mappings here if a team's name ever doesn't match.
const TEAM_MAP = {
  'Mamelodi Sundowns':         'Mamelodi Sundowns',
  'Orlando Pirates':           'Orlando Pirates',
  'Kaizer Chiefs':             'Kaizer Chiefs',
  'Stellenbosch':              'Stellenbosch FC',
  'Stellenbosch FC':           'Stellenbosch FC',
  'AmaZulu':                   'AmaZulu FC',
  'AmaZulu FC':                'AmaZulu FC',
  'Chippa United':             'Chippa United',
  'Golden Arrows':             'Golden Arrows',
  'Lamontville Golden Arrows': 'Golden Arrows',
  'Sekhukhune United':         'Sekhukhune United',
  'TS Galaxy':                 'TS Galaxy',
  'Polokwane City':            'Polokwane City',
  'Marumo Gallants':           'Marumo Gallants',
  'Richards Bay':              'Richards Bay',
  'Richards Bay FC':           'Richards Bay',
  'Magesi':                    'Magesi FC',
  'Magesi FC':                 'Magesi FC',
  'Durban City':               'Durban City',
  'Durban City FC':            'Durban City',
  'Orbit College':             'Orbit College FC',
  'Orbit College FC':          'Orbit College FC',
  'Siwelele':                  'Siwelele',
  'Siwelele FC':               'Siwelele',
  'Cape Town City':            'Cape Town City',
  'SuperSport United':         'SuperSport United',
  'Moroka Swallows':           'Moroka Swallows',
};

function mapTeamName(apiName) {
  return TEAM_MAP[apiName] || apiName;
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN HANDLER — called by Vercel cron schedule or admin panel
// ══════════════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // ── Security: accept either Vercel cron secret OR admin panel key ────────
  const authHeader = req.headers['authorization'] || '';
  const cronSecret = process.env.CRON_SECRET      || '';
  const adminKey   = req.headers['x-admin-key']   || req.query.admin_key || '';
  const isAdmin    = adminKey && adminKey === (process.env.ADMIN_SECRET || '');
  const isCron     = cronSecret && authHeader === 'Bearer ' + cronSecret;

  if (!isAdmin && !isCron && cronSecret) {
    console.warn('[points-cron] Unauthorized request rejected');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!API_KEY)          return res.status(500).json({ error: 'API_FOOTBALL_KEY not set in Vercel env vars' });
  if (!SUPABASE_URL)     return res.status(500).json({ error: 'SUPABASE_URL not set in Vercel env vars' });
  if (!SUPABASE_SVC_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not set in Vercel env vars' });

  const db  = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);
  const log = [];

  const report = {
    started_at:       new Date().toISOString(),
    triggered_by:     isAdmin ? 'admin_panel' : 'cron_schedule',
    steps_completed:  [],
    fixtures_synced:  0,
    results_updated:  0,
    fixtures_scored:  0,
    users_updated:    0,
    gw_action:        null,
    prices_updated:   0,
    api_calls_used:   0,
    errors:           [],
    log
  };

  try {

    // ════════════════════════════════════════════════════════════════════
    // STEP 1: SYNC UPCOMING FIXTURES
    //
    // Fetches the next 30 scheduled PSL matches from API-Football
    // and upserts them into our fixtures table.
    //
    // WHY: The PSL releases fixtures a few weeks at a time. Each time
    // new games are announced, they appear on API-Football within 24hrs.
    // This step means they automatically appear in our app too — no
    // manual SQL needed.
    //
    // API cost: 1 call
    // ════════════════════════════════════════════════════════════════════
    log.push('━━ STEP 1: Syncing upcoming fixtures from API-Football ━━');
    try {
      const upcomingRes = await apiGet('/fixtures?league=' + PSL_LEAGUE + '&season=' + SEASON + '&status=NS&next=40');
      report.api_calls_used++;

      const currentGW  = await getCurrentGameweek(db);
      const toUpsert   = [];

      for (const f of (upcomingRes.response || [])) {
        const fix   = f.fixture || {};
        const teams = f.teams   || {};
        const lg    = f.league  || {};

        const home = mapTeamName((teams.home && teams.home.name) || '');
        const away = mapTeamName((teams.away && teams.away.name) || '');

        if (!home || !away || !fix.date) continue;

        // API-Football returns round as "Regular Season - 23" etc.
        // We extract the number from that string.
        let gw = currentGW;
        if (lg.round) {
          const match = (lg.round + '').match(/(\d+)/);
          if (match) gw = parseInt(match[1]);
        }

        toUpsert.push({
          gameweek:       gw,
          home_team:      home,
          away_team:      away,
          status:         'NS',
          kickoff_at:     fix.date,
          venue:          (fix.venue && fix.venue.name) || null,
          api_fixture_id: fix.id || null
        });
      }

      log.push('  Found ' + toUpsert.length + ' upcoming fixtures from API-Football');

      // Upsert each one — if it already exists (same GW + teams), skip it.
      // ignoreDuplicates: true means existing fixtures are never overwritten here.
      for (const row of toUpsert) {
        const { error } = await db.from('fixtures').upsert(row, {
          onConflict:      'gameweek,home_team,away_team',
          ignoreDuplicates: true
        });
        if (!error) report.fixtures_synced++;
      }

      log.push('  Upserted ' + report.fixtures_synced + ' fixtures (new ones added, existing ones untouched)');
      report.steps_completed.push('sync_fixtures ✓');

    } catch (e) {
      const msg = 'sync_fixtures: ' + e.message;
      log.push('  WARN: ' + msg);
      report.errors.push(msg);
      report.steps_completed.push('sync_fixtures ✗');
    }


    // ════════════════════════════════════════════════════════════════════
    // STEP 2: SYNC MATCH RESULTS
    //
    // Fetches the last 15 completed PSL matches from API-Football
    // and updates their scorelines + status in our fixtures table.
    //
    // WHY: After a game ends, API-Football marks it FT and records the
    // score. This step copies that into our DB so the Results section
    // of the app updates automatically — no manual SQL needed.
    //
    // API cost: 1 call
    // ════════════════════════════════════════════════════════════════════
    log.push('━━ STEP 2: Syncing completed match results ━━');
    try {
      const completedRes = await apiGet('/fixtures?league=' + PSL_LEAGUE + '&season=' + SEASON + '&status=FT-AET-PEN&last=15');
      report.api_calls_used++;

      const completed = completedRes.response || [];
      log.push('  Found ' + completed.length + ' recently completed matches');

      for (const f of completed) {
        const fix   = f.fixture || {};
        const teams = f.teams   || {};
        const goals = f.goals   || {};

        const home      = mapTeamName((teams.home && teams.home.name) || '');
        const away      = mapTeamName((teams.away && teams.away.name) || '');
        const homeScore = goals.home;
        const awayScore = goals.away;

        if (!home || !away || homeScore === null || homeScore === undefined) continue;

        // Update the fixture row — only if it's not already marked FT
        // (avoids unnecessary writes on matches processed days ago)
        const { data: existing } = await db.from('fixtures')
          .select('id, status')
          .eq('home_team', home)
          .eq('away_team', away)
          .neq('status', 'FT')
          .limit(1);

        if (existing && existing.length > 0) {
          const { error } = await db.from('fixtures')
            .update({
              home_score:     homeScore,
              away_score:     awayScore,
              status:         'FT',
              kickoff_at:     fix.date || null,
              api_fixture_id: fix.id   || null
            })
            .eq('id', existing[0].id);

          if (!error) {
            report.results_updated++;
            log.push('  ✓ ' + home + ' ' + homeScore + '-' + awayScore + ' ' + away);
          }
        }
      }

      log.push('  Updated ' + report.results_updated + ' match results');
      report.steps_completed.push('sync_results ✓');

    } catch (e) {
      const msg = 'sync_results: ' + e.message;
      log.push('  WARN: ' + msg);
      report.errors.push(msg);
      report.steps_completed.push('sync_results ✗');
    }


    // ════════════════════════════════════════════════════════════════════
    // STEP 3: CALCULATE FANTASY POINTS
    //
    // For each completed match that hasn't been processed yet:
    //   - Fetch player-level stats from API-Football
    //   - Calculate each player's fantasy points
    //   - Store stats in player_gw_stats table
    //   - Loop through all user squads and add points for their players
    //   - Write results to gw_scores and update profiles.total_points
    //   - Mark fixture as processed (so it's never double-counted)
    //
    // API cost: 1 call per unprocessed match (typically 1–2 per night)
    // ════════════════════════════════════════════════════════════════════
    log.push('━━ STEP 3: Calculating fantasy points ━━');
    try {
      const alreadyProcessed = await getProcessedFixtureIds(db);
      const currentGW        = await getCurrentGameweek(db);

      // Re-use the results we already fetched in Step 2 (API-efficient)
      const recentRes = await apiGet('/fixtures?league=' + PSL_LEAGUE + '&season=' + SEASON + '&status=FT-AET-PEN&last=15');
      report.api_calls_used++;

      const toProcess = (recentRes.response || []).filter(f => {
        return f.fixture && f.fixture.id && !alreadyProcessed.has(f.fixture.id);
      });

      log.push('  ' + alreadyProcessed.size + ' already processed, ' + toProcess.length + ' new to score');

      for (const f of toProcess) {
        const fix   = f.fixture || {};
        const teams = f.teams   || {};
        const goals = f.goals   || {};

        const fixtureObj = {
          fixture_id: fix.id,
          date:       fix.date,
          home:       mapTeamName((teams.home && teams.home.name) || ''),
          away:       mapTeamName((teams.away && teams.away.name) || ''),
          hg:         goals.home,
          ag:         goals.away
        };

        log.push('  Processing: ' + fixtureObj.home + ' ' + fixtureObj.hg + '-' + fixtureObj.ag + ' ' + fixtureObj.away + ' (API ID: ' + fix.id + ')');

        try {
          // Fetch player stats for this specific match
          const statsRes = await apiGet('/fixtures/players?fixture=' + fix.id);
          report.api_calls_used++;

          const playerStats = extractPlayerStats(statsRes.response || []);
          log.push('  Got stats for ' + playerStats.length + ' players');

          if (!playerStats.length) {
            log.push('  No player stats returned yet — skipping (will retry tomorrow)');
            continue;
          }

          // Store raw stats in DB (useful for player profile pages later)
          await storePlayerStats(db, playerStats, fixtureObj, currentGW);

          // Build name → stats lookup for fast user scoring
          const statsByName = {};
          playerStats.forEach(p => {
            statsByName[normaliseName(p.player_name)] = p;
          });

          // Score every user
          const users        = await getAllUsersWithSquads(db);
          const gwScoreRows  = [];

          for (const user of users) {
            let squad;
            try { squad = user.squad_data ? JSON.parse(user.squad_data) : []; }
            catch (e) { continue; }
            if (!squad || !squad.length) continue;

            const { gwPts, playerBreakdown } = scoreUserForFixture(squad, statsByName);
            if (gwPts === 0 && !playerBreakdown.length) continue;

            gwScoreRows.push({
              user_id:       user.id,
              gameweek:      currentGW,
              points:        gwPts,
              breakdown:     { fixture_id: fix.id, home: fixtureObj.home, away: fixtureObj.away },
              player_scores: playerBreakdown
            });
          }

          if (gwScoreRows.length) {
            await writeGWScores(db, gwScoreRows);
            await incrementTotalPoints(db, gwScoreRows);
            report.users_updated += gwScoreRows.length;
            log.push('  Scored ' + gwScoreRows.length + ' users');
          } else {
            log.push('  No users had players in this match');
          }

          // Mark as processed — this fixture will never be scored again
          await markFixtureProcessed(db, fixtureObj, currentGW, gwScoreRows.length, report.api_calls_used);
          report.fixtures_scored++;
          log.push('  ✓ Fixture marked as processed');

        } catch (e) {
          const msg = 'fixture_' + fix.id + ': ' + e.message;
          log.push('  ERROR: ' + msg);
          report.errors.push(msg);
        }
      }

      report.steps_completed.push('calc_points ✓');

    } catch (e) {
      const msg = 'calc_points: ' + e.message;
      log.push('  WARN: ' + msg);
      report.errors.push(msg);
      report.steps_completed.push('calc_points ✗');
    }


    // ════════════════════════════════════════════════════════════════════
    // STEP 4: GAMEWEEK MANAGEMENT
    //
    // Checks if ALL matches in the current GW have finished.
    // If yes:
    //   1. Closes the current GW (is_current = false, is_finished = true)
    //   2. Opens the next GW (is_current = true)
    //   3. Creates the next GW row if it doesn't exist yet
    //   4. Rolls over unused free transfers (unused FTs carry over, max 5)
    //
    // WHY: This removes the need to manually run SQL to switch GWs.
    // The app automatically moves to the next GW when all games are done.
    //
    // API cost: 0 (uses Supabase only)
    // ════════════════════════════════════════════════════════════════════
    log.push('━━ STEP 4: Managing gameweeks ━━');
    try {
      const currentGW = await getCurrentGameweek(db);

      const { data: gwFixtures } = await db
        .from('fixtures')
        .select('status')
        .eq('gameweek', currentGW);

      const total    = (gwFixtures || []).length;
      const finished = (gwFixtures || []).filter(f =>
        f.status === 'FT' || f.status === 'AET' || f.status === 'PEN'
      ).length;

      log.push('  GW' + currentGW + ': ' + finished + '/' + total + ' matches finished');

      if (total > 0 && finished === total) {
        // All done — close this GW
        log.push('  All matches done! Closing GW' + currentGW + ' and opening GW' + (currentGW + 1));

        await db.from('gameweeks')
          .update({ is_current: false, is_finished: true })
          .eq('number', currentGW);

        const nextGW = currentGW + 1;

        // Check if next GW already exists in DB
        const { data: nextExists } = await db
          .from('gameweeks')
          .select('number')
          .eq('number', nextGW)
          .maybeSingle();

        if (nextExists) {
          await db.from('gameweeks').update({ is_current: true }).eq('number', nextGW);
        } else {
          // Create next GW row automatically
          await db.from('gameweeks').insert({
            number:      nextGW,
            name:        'Gameweek ' + nextGW,
            is_current:  true,
            is_finished: false
          });
          log.push('  Created new GW' + nextGW + ' row in database');
        }

        // Roll over free transfers
        // Rule: 1 new FT each GW + unused FTs carry over, max 5 total
        const { data: allUsers } = await db
          .from('profiles')
          .select('id, free_transfers, transfers_this_gw');

        let transfersRolled = 0;
        for (const user of (allUsers || [])) {
          const used    = user.transfers_this_gw || 0;
          const banked  = user.free_transfers    || 1;
          const unused  = Math.max(0, banked - used);
          const newFree = Math.min(5, 1 + unused); // 1 new + rollover, cap at 5
          await db.from('profiles')
            .update({ free_transfers: newFree, transfers_this_gw: 0 })
            .eq('id', user.id);
          transfersRolled++;
        }

        report.gw_action = 'Closed GW' + currentGW + ' → Opened GW' + nextGW + ' | Rolled transfers for ' + transfersRolled + ' users';
        log.push('  ✓ ' + report.gw_action);

      } else if (total === 0) {
        log.push('  No fixtures found for GW' + currentGW + ' — check fixtures table');
        report.gw_action = 'No fixtures for GW' + currentGW;
      } else {
        log.push('  GW' + currentGW + ' still in progress (' + (total - finished) + ' matches remaining)');
        report.gw_action = 'GW' + currentGW + ' in progress: ' + finished + '/' + total + ' done';
      }

      report.steps_completed.push('manage_gameweeks ✓');

    } catch (e) {
      const msg = 'manage_gameweeks: ' + e.message;
      log.push('  WARN: ' + msg);
      report.errors.push(msg);
      report.steps_completed.push('manage_gameweeks ✗');
    }


    // ════════════════════════════════════════════════════════════════════
    // STEP 5: UPDATE PLAYER PRICES
    //
    // Reviews each player's fantasy points over the last 3 gameweeks.
    // Players performing well above their position benchmark → +0.1M
    // Players performing well below their position benchmark → -0.1M
    // Prices are capped: min 4.0M, max 15.0M
    //
    // WHY: Just like real FPL, prices should fluctuate based on form.
    // This makes team selection more strategic over time.
    //
    // API cost: 0 (uses Supabase only)
    // ════════════════════════════════════════════════════════════════════
    log.push('━━ STEP 5: Updating player prices based on form ━━');
    try {
      const currentGW = await getCurrentGameweek(db);

      // Get player stats for last 3 GWs
      const { data: recentStats } = await db
        .from('player_gw_stats')
        .select('player_id, fantasy_points, gameweek')
        .gte('gameweek', currentGW - 3)
        .not('player_id', 'is', null);

      if (!recentStats || recentStats.length < 10) {
        log.push('  Not enough stat history yet for price updates (need at least 10 records)');
        report.steps_completed.push('update_prices — skipped (insufficient data)');
      } else {
        // Group fantasy_points by player_id
        const playerPoints = {};
        recentStats.forEach(s => {
          if (!playerPoints[s.player_id]) playerPoints[s.player_id] = [];
          playerPoints[s.player_id].push(s.fantasy_points || 0);
        });

        const { data: players } = await db.from('players').select('id, price, position');

        // Position average benchmarks — points above/below these trigger price changes
        const benchmarks = { GK: 4, DEF: 5, MID: 6, FWD: 6 };

        for (const player of (players || [])) {
          const pts = playerPoints[player.id];
          if (!pts || pts.length < 2) continue; // need 2+ GWs of data

          const avgPts  = pts.reduce((a, b) => a + b, 0) / pts.length;
          const bench   = benchmarks[player.position] || 5;
          let newPrice  = player.price;

          if (avgPts >= bench * 1.5) {
            // Strong form → price up
            newPrice = Math.min(15.0, +(player.price + 0.1).toFixed(1));
          } else if (avgPts <= bench * 0.4) {
            // Poor form → price down
            newPrice = Math.max(4.0, +(player.price - 0.1).toFixed(1));
          }

          if (newPrice !== player.price) {
            const { error } = await db.from('players')
              .update({ price: newPrice, price_updated_at: new Date().toISOString() })
              .eq('id', player.id);
            if (!error) report.prices_updated++;
          }
        }

        log.push('  ✓ Updated prices for ' + report.prices_updated + ' players');
        report.steps_completed.push('update_prices ✓');
      }

    } catch (e) {
      const msg = 'update_prices: ' + e.message;
      log.push('  WARN: ' + msg);
      report.errors.push(msg);
      report.steps_completed.push('update_prices ✗');
    }


    // ════════════════════════════════════════════════════════════════════
    // DONE
    // ════════════════════════════════════════════════════════════════════
    report.finished_at = new Date().toISOString();
    report.duration_ms = new Date(report.finished_at) - new Date(report.started_at);

    log.push('');
    log.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log.push('COMPLETE in ' + report.duration_ms + 'ms | API calls used: ' + report.api_calls_used);
    log.push('Fixtures synced: ' + report.fixtures_synced);
    log.push('Results updated: ' + report.results_updated);
    log.push('Fixtures scored: ' + report.fixtures_scored);
    log.push('Users updated:   ' + report.users_updated);
    log.push('GW action:       ' + (report.gw_action || 'none'));
    log.push('Prices updated:  ' + report.prices_updated);
    if (report.errors.length) {
      log.push('Errors:          ' + report.errors.join(', '));
    }
    log.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    return res.json(report);

  } catch (err) {
    report.fatal_error = err.message;
    report.finished_at = new Date().toISOString();
    console.error('[points-cron] Fatal error:', err);
    return res.status(500).json(report);
  }
};


// ══════════════════════════════════════════════════════════════════════════
// API-FOOTBALL HELPER
// Centralised fetch with error handling so every API call is consistent.
// ══════════════════════════════════════════════════════════════════════════
async function apiGet(path) {
  const response = await fetch(BASE_URL + path, {
    headers: {
      'x-apisports-key': API_KEY,
      'x-rapidapi-host': 'v3.football.api-sports.io'
    }
  });
  if (!response.ok) throw new Error('API-Football HTTP ' + response.status + ' → ' + path);
  const json = await response.json();
  if (json.errors && Object.keys(json.errors).length > 0) {
    throw new Error('API-Football returned errors: ' + JSON.stringify(json.errors));
  }
  return json;
}


// ══════════════════════════════════════════════════════════════════════════
// PLAYER STATS EXTRACTION
// Takes raw API-Football /fixtures/players response and returns clean array
// ══════════════════════════════════════════════════════════════════════════
function extractPlayerStats(teamsArray) {
  const allPlayers = [];

  teamsArray.forEach(function(teamData) {
    const teamName = mapTeamName((teamData.team && teamData.team.name) || 'Unknown');

    (teamData.players || []).forEach(function(entry) {
      const player = entry.player || {};
      const stats  = (entry.statistics && entry.statistics[0]) || {};

      const pos           = normalisePosition((stats.games && stats.games.position) || '');
      const minutes       = (stats.games && stats.games.minutes)          || 0;
      const goals         = (stats.goals && stats.goals.total)            || 0;
      const assists       = (stats.goals && stats.goals.assists)          || 0;
      const saves         = (stats.goals && stats.goals.saves)            || 0;
      const goalsConceded = (stats.goals && stats.goals.conceded)         || 0;
      const yellowCards   = (stats.cards && stats.cards.yellow)           || 0;
      const redCards      = (stats.cards && stats.cards.red)              || 0;
      const penSaved      = (stats.penalty && stats.penalty.saved)        || 0;
      const penMissed     = (stats.penalty && stats.penalty.missed)       || 0;

      const pts = calculateFantasyPoints({
        pos, minutes, goals, assists, saves,
        goalsConceded, yellowCards, redCards, penSaved, penMissed
      });

      allPlayers.push({
        api_player_id:    player.id   || null,
        player_name:      player.name || 'Unknown',
        team:             teamName,
        position:         pos,
        minutes,
        goals,
        assists,
        yellow_cards:     yellowCards,
        red_cards:        redCards,
        saves,
        goals_conceded:   goalsConceded,
        penalties_saved:  penSaved,
        penalties_missed: penMissed,
        fantasy_points:   pts.total,
        points_breakdown: pts.breakdown
      });
    });
  });

  return allPlayers;
}


// ══════════════════════════════════════════════════════════════════════════
// SCORE ONE USER FOR ONE FIXTURE
// Given a user's squad and a name→stats lookup, returns their GW points.
// ══════════════════════════════════════════════════════════════════════════
function scoreUserForFixture(squad, statsByName) {
  let gwPts = 0;
  const playerBreakdown = [];

  const captain   = squad.find(p => p.isCaptain);
  const capKey    = captain ? normaliseName(captain.name || captain.display_name || '') : '';
  const capStats  = capKey ? (statsByName[capKey] || null) : null;
  const capPlayed = capStats && capStats.minutes > 0;

  squad.forEach(function(sp) {
    if (sp.onBench) return; // bench players don't score

    const key   = normaliseName(sp.name || sp.display_name || '');
    const stats = statsByName[key];
    if (!stats) return; // player not in this match

    let pts = stats.fantasy_points || 0;

    if (sp.isCaptain) {
      pts = pts * 2;                              // captain always doubles
    } else if (sp.isVC && !capPlayed) {
      pts = pts * 2;                              // vice-cap doubles if captain DNP
    }

    gwPts += pts;

    playerBreakdown.push({
      name:       sp.name || sp.display_name,
      position:   sp.position,
      minutes:    stats.minutes,
      goals:      stats.goals,
      assists:    stats.assists,
      base_pts:   stats.fantasy_points,
      final_pts:  pts,
      is_captain: sp.isCaptain || false,
      is_vc:      sp.isVC      || false,
      breakdown:  stats.points_breakdown
    });
  });

  return { gwPts, playerBreakdown };
}


// ══════════════════════════════════════════════════════════════════════════
// DATABASE HELPERS
// ══════════════════════════════════════════════════════════════════════════

async function getCurrentGameweek(db) {
  const { data, error } = await db
    .from('gameweeks')
    .select('number')
    .eq('is_current', true)
    .single();
  if (error || !data) {
    console.warn('[points-cron] Could not get current GW, defaulting to 23');
    return 23;
  }
  return data.number;
}

async function getProcessedFixtureIds(db) {
  const { data } = await db.from('processed_fixtures').select('fixture_id');
  const ids = new Set();
  (data || []).forEach(r => ids.add(r.fixture_id));
  return ids;
}

async function getAllUsersWithSquads(db) {
  const { data, error } = await db
    .from('profiles')
    .select('id, squad_data, total_points, gw_points')
    .not('squad_data', 'is', null);
  if (error) throw new Error('Could not load user squads: ' + error.message);
  return data || [];
}

async function storePlayerStats(db, playerStats, fixture, gameweek) {
  const rows = playerStats.map(p => ({
    api_player_id:    p.api_player_id,
    player_name:      p.player_name,
    team:             p.team,
    fixture_id:       fixture.fixture_id,
    gameweek,
    minutes:          p.minutes,
    goals:            p.goals,
    assists:          p.assists,
    yellow_cards:     p.yellow_cards,
    red_cards:        p.red_cards,
    saves:            p.saves,
    goals_conceded:   p.goals_conceded,
    penalties_saved:  p.penalties_saved,
    penalties_missed: p.penalties_missed,
    fantasy_points:   p.fantasy_points,
    points_breakdown: p.points_breakdown
  }));

  const { error } = await db
    .from('player_gw_stats')
    .upsert(rows, { onConflict: 'api_player_id,fixture_id', ignoreDuplicates: false });

  if (error) throw new Error('Could not store player stats: ' + error.message);
}

async function writeGWScores(db, gwScoreRows) {
  for (const row of gwScoreRows) {
    const { data: existing, error: fetchErr } = await db
      .from('gw_scores')
      .select('id, points, player_scores')
      .eq('user_id', row.user_id)
      .eq('gameweek', row.gameweek)
      .maybeSingle();

    if (existing) {
      // Accumulate — a GW has multiple matches
      await db.from('gw_scores').update({
        points:        (existing.points || 0) + row.points,
        player_scores: (existing.player_scores || []).concat(row.player_scores || []),
        calculated_at: new Date().toISOString()
      }).eq('id', existing.id);
    } else {
      await db.from('gw_scores').insert({
        user_id:       row.user_id,
        gameweek:      row.gameweek,
        points:        row.points,
        breakdown:     row.breakdown,
        player_scores: row.player_scores
      });
    }
  }
}

async function incrementTotalPoints(db, gwScoreRows) {
  for (const row of gwScoreRows) {
    const { data: profile } = await db
      .from('profiles')
      .select('total_points')
      .eq('id', row.user_id)
      .maybeSingle();

    const currentTotal = (profile && profile.total_points) || 0;

    await db.from('profiles').update({
      gw_points:      row.points,
      total_points:   currentTotal + row.points,
      last_gw_scored: row.gameweek,
      updated_at:     new Date().toISOString()
    }).eq('id', row.user_id);
  }
}

async function markFixtureProcessed(db, fixture, gameweek, usersScored, apiCallsUsed) {
  const { error } = await db.from('processed_fixtures').upsert({
    fixture_id:     fixture.fixture_id,
    gameweek,
    home_team:      fixture.home,
    away_team:      fixture.away,
    home_score:     fixture.hg,
    away_score:     fixture.ag,
    match_date:     fixture.date,
    processed_at:   new Date().toISOString(),
    users_scored:   usersScored,
    api_calls_used: apiCallsUsed
  }, { onConflict: 'fixture_id' });

  if (error) throw new Error('Could not mark fixture processed: ' + error.message);
}

function normaliseName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
