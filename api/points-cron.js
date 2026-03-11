// ══════════════════════════════════════════════════════════════════════════
// api/points-cron.js  —  Fantasy PSL  —  Automatic Points Calculation
// ══════════════════════════════════════════════════════════════════════════
//
// WHAT THIS DOES:
//   Runs automatically on a schedule (every 30 minutes during match days).
//   After each PSL match finishes, this job:
//
//   1. Fetches recently completed fixtures from API-Football
//   2. Checks which ones haven't been processed yet (idempotency guard)
//   3. For each new completed match:
//      a. Fetches all player stats from API-Football
//      b. Calculates each player's fantasy points
//      c. Stores player stats in player_gw_stats table
//   4. Reads every user's squad from profiles.squad_data
//   5. For each user: totals up points for players in their squad
//      (applying captain ×2, vice-captain ×2 if captain DNP)
//   6. Writes per-GW points to gw_scores table
//   7. Updates profiles.gw_points and profiles.total_points
//   8. Marks the fixture as processed so it never runs again
//
// WHY A CRON JOB INSTEAD OF DOING IT IN THE BROWSER:
//   If 1,000,000 users each calculated points in their own browser,
//   you'd get 1,000,000 simultaneous database writes → Supabase collapses.
//   The cron job runs ONCE on your server → ONE database write per user,
//   batched and controlled. Scales to any number of users.
//
// SCHEDULE (set in vercel.json):
//   Every 30 minutes: "*/30 * * * *"
//   This means it checks for newly completed matches every 30 minutes.
//   If no matches finished since last run → exits immediately (no API calls).
//
// API QUOTA USAGE:
//   - 1 call  to check for completed fixtures
//   - 1 call  per completed fixture for player stats
//   A full gameweek (8 matches) = 9 API calls total. Well within 100/day.
//
// SECURITY:
//   Protected by CRON_SECRET environment variable.
//   Vercel sets this automatically and sends it as a header.
//   No one on the internet can trigger this manually.
//
// ENVIRONMENT VARIABLES (set in Vercel Dashboard → Settings → Env Vars):
//   API_FOOTBALL_KEY        — your API-Football key
//   SUPABASE_URL            — your Supabase project URL
//   SUPABASE_SERVICE_KEY    — your Supabase service role key (bypasses RLS)
//   CRON_SECRET             — set by Vercel automatically (do not set manually)
//
// ══════════════════════════════════════════════════════════════════════════

const { createClient }          = require('@supabase/supabase-js');
const { calculateFantasyPoints, normalisePosition } = require('./football.js');

const API_KEY          = process.env.API_FOOTBALL_KEY    || '';
const SUPABASE_URL     = process.env.SUPABASE_URL        || '';
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const PSL_LEAGUE       = 288;
const SEASON           = 2024;
const BASE_URL         = 'https://v3.football.api-sports.io';

// ══════════════════════════════════════════════════════════════════════════
// MAIN HANDLER — called by Vercel on the cron schedule
// ══════════════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // ── Security: Vercel verifies the cron secret automatically.
  //    We add a manual check as a second layer of protection.
  const authHeader = req.headers['authorization'] || '';
  const cronSecret = process.env.CRON_SECRET || '';
  if (cronSecret && authHeader !== 'Bearer ' + cronSecret) {
    console.warn('[points-cron] Unauthorized request rejected');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Validate environment is configured ───────────────────────────────────
  if (!API_KEY)          return res.status(500).json({ error: 'API_FOOTBALL_KEY not set in Vercel env vars' });
  if (!SUPABASE_URL)     return res.status(500).json({ error: 'SUPABASE_URL not set in Vercel env vars' });
  if (!SUPABASE_SVC_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not set in Vercel env vars' });

  // ── Create Supabase client with SERVICE KEY (bypasses RLS)
  //    This is safe because this function only runs server-side in Vercel,
  //    never in a user's browser.
  const db = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);

  const log = [];    // we collect log messages to return in the response for debugging
  const report = {
    started_at:       new Date().toISOString(),
    fixtures_found:   0,
    fixtures_skipped: 0,
    fixtures_scored:  0,
    users_updated:    0,
    api_calls_used:   0,
    errors:           [],
    log
  };

  try {
    log.push('Step 1: Fetching recently completed PSL fixtures from API-Football...');
    const completedFixtures = await getRecentlyCompletedFixtures();
    report.api_calls_used += 1;
    log.push('Found ' + completedFixtures.length + ' completed fixtures from API-Football');

    if (!completedFixtures.length) {
      log.push('No completed fixtures found. Nothing to score. Exiting.');
      report.finished_at = new Date().toISOString();
      return res.json(report);
    }

    report.fixtures_found = completedFixtures.length;

    // ── Step 2: Filter out fixtures already processed ──────────────────────
    log.push('Step 2: Checking which fixtures have already been processed...');
    const alreadyProcessed = await getProcessedFixtureIds(db);
    const toProcess = completedFixtures.filter(function(f) {
      return !alreadyProcessed.has(f.fixture_id);
    });

    report.fixtures_skipped = completedFixtures.length - toProcess.length;
    log.push(alreadyProcessed.size + ' already processed, ' + toProcess.length + ' new to score');

    if (!toProcess.length) {
      log.push('All fixtures already processed. Exiting.');
      report.finished_at = new Date().toISOString();
      return res.json(report);
    }

    // ── Step 3: Get the current gameweek number ────────────────────────────
    log.push('Step 3: Fetching current gameweek from Supabase...');
    const currentGW = await getCurrentGameweek(db);
    log.push('Current gameweek: GW' + currentGW);

    // ── Step 4: Fetch player stats for each new completed fixture ──────────
    // Process one fixture at a time to stay within API quota limits
    for (const fixture of toProcess) {
      log.push('');
      log.push('── Processing: ' + fixture.home + ' vs ' + fixture.away + ' (ID: ' + fixture.fixture_id + ') ──');

      try {
        // ── 4a: Fetch player stats from API-Football ───────────────────────
        log.push('  Fetching player stats from API-Football...');
        const playerStats = await getFixturePlayerStats(fixture.fixture_id);
        report.api_calls_used += 1;
        log.push('  Got stats for ' + playerStats.length + ' players');

        if (!playerStats.length) {
          log.push('  WARNING: No player stats returned. Match may not be finalised yet. Skipping.');
          continue;
        }

        // ── 4b: Store player stats in player_gw_stats table ───────────────
        log.push('  Storing player stats in database...');
        await storePlayerStats(db, playerStats, fixture, currentGW);
        log.push('  Player stats stored successfully');

        // ── 4c: Build a lookup map: playerName → fantasyPoints ────────────
        //    Also store api_player_id → points for better matching
        const statsByName  = {};   // normalised name → stats object
        const statsById    = {};   // api_player_id → stats object
        playerStats.forEach(function(p) {
          statsByName[normaliseName(p.player_name)] = p;
          if (p.api_player_id) statsById[p.api_player_id] = p;
        });

        // ── Step 5: Load all users with squads ────────────────────────────
        log.push('  Loading all user squads...');
        const users = await getAllUsersWithSquads(db);
        log.push('  Found ' + users.length + ' users with squads');

        // ── Step 6: Calculate points for each user ────────────────────────
        log.push('  Calculating points for each user...');
        const gwScoreRows     = [];
        const profileUpdates  = [];
        let usersScored       = 0;

        for (const user of users) {
          let squad;
          try {
            squad = user.squad_data ? JSON.parse(user.squad_data) : [];
          } catch (e) {
            log.push('  WARN: Could not parse squad for user ' + user.id + '. Skipping.');
            continue;
          }

          if (!squad || !squad.length) continue;

          const { gwPts, playerBreakdown } = scoreUserForFixture(squad, statsByName, statsById);

          if (gwPts === 0 && !playerBreakdown.length) continue; // user has no players in this match

          usersScored++;
          gwScoreRows.push({
            user_id:       user.id,
            gameweek:      currentGW,
            points:        gwPts,
            breakdown:     { fixture_id: fixture.fixture_id, home: fixture.home, away: fixture.away },
            player_scores: playerBreakdown
          });

          profileUpdates.push({
            id:             user.id,
            gw_points:      gwPts,
            // total_points will be incremented separately to avoid race conditions
          });
        }

        // ── Step 7: Write gw_scores to Supabase in one batch ─────────────
        if (gwScoreRows.length) {
          log.push('  Writing ' + gwScoreRows.length + ' GW score rows to database...');
          await writeGWScores(db, gwScoreRows);

          // Increment total_points for each user (safe upsert)
          log.push('  Updating total_points for ' + profileUpdates.length + ' users...');
          await incrementTotalPoints(db, gwScoreRows);

          report.users_updated += usersScored;
          log.push('  Scored ' + usersScored + ' users for this fixture');
        } else {
          log.push('  No users had players in this match');
        }

        // ── Step 8: Mark fixture as processed (idempotency guard) ─────────
        log.push('  Marking fixture as processed...');
        await markFixtureProcessed(db, fixture, currentGW, usersScored, report.api_calls_used);

        report.fixtures_scored += 1;
        log.push('  Done with this fixture ✓');

      } catch (fixtureErr) {
        const errMsg = 'Error processing fixture ' + fixture.fixture_id + ': ' + fixtureErr.message;
        log.push('  ERROR: ' + errMsg);
        report.errors.push(errMsg);
        // Continue to next fixture — don't let one failure stop the whole batch
      }
    }

    report.finished_at = new Date().toISOString();
    const durationMs   = new Date(report.finished_at) - new Date(report.started_at);
    log.push('');
    log.push('Cron job complete in ' + durationMs + 'ms');
    log.push('Fixtures scored: ' + report.fixtures_scored);
    log.push('Users updated:   ' + report.users_updated);
    log.push('API calls used:  ' + report.api_calls_used);

    return res.json(report);

  } catch (err) {
    report.fatal_error = err.message;
    report.finished_at = new Date().toISOString();
    console.error('[points-cron] Fatal error:', err);
    return res.status(500).json(report);
  }
};

// ══════════════════════════════════════════════════════════════════════════
// SCORE ONE USER FOR ONE FIXTURE
//
// Takes a user's squad array and the player stats lookup maps,
// returns their fantasy points for this match + a per-player breakdown.
// ══════════════════════════════════════════════════════════════════════════
function scoreUserForFixture(squad, statsByName, statsById) {
  let gwPts = 0;
  const playerBreakdown = [];

  // Find captain — if captain didn't play, vice-captain gets ×2
  const captain    = squad.find(function(p) { return p.isCaptain; });
  const viceCap    = squad.find(function(p) { return p.isVC; });
  const captainKey = captain ? normaliseName(captain.name || captain.display_name || '') : '';

  // Did the captain play in this match?
  const captainStats = captain ? (statsByName[captainKey] || null) : null;
  const captainPlayed = captainStats && captainStats.minutes > 0;

  squad.forEach(function(squadPlayer) {
    // Skip bench players — they don't score points unless auto-substituted
    // (auto-sub logic is complex; for now bench players score 0)
    if (squadPlayer.onBench) return;

    const playerKey = normaliseName(squadPlayer.name || squadPlayer.display_name || '');

    // Try to match by name (primary) or API player ID (secondary)
    const stats = statsByName[playerKey] || null;
    if (!stats) return;  // player not in this match

    let pts = stats.fantasy_points || 0;

    // Apply captain multiplier
    if (squadPlayer.isCaptain) {
      pts = pts * 2;
    } else if (squadPlayer.isVC && !captainPlayed) {
      // Vice-captain gets double only if captain didn't play
      pts = pts * 2;
    }

    gwPts += pts;

    playerBreakdown.push({
      name:        squadPlayer.name || squadPlayer.display_name,
      position:    squadPlayer.position,
      minutes:     stats.minutes,
      goals:       stats.goals,
      assists:     stats.assists,
      base_pts:    stats.fantasy_points,
      final_pts:   pts,
      is_captain:  squadPlayer.isCaptain  || false,
      is_vc:       squadPlayer.isVC       || false,
      breakdown:   stats.points_breakdown
    });
  });

  return { gwPts, playerBreakdown };
}

// ══════════════════════════════════════════════════════════════════════════
// SUPABASE DATABASE OPERATIONS
// ══════════════════════════════════════════════════════════════════════════

async function getProcessedFixtureIds(db) {
  const { data, error } = await db
    .from('processed_fixtures')
    .select('fixture_id');

  if (error) throw new Error('Could not read processed_fixtures: ' + error.message);
  const ids = new Set();
  (data || []).forEach(function(row) { ids.add(row.fixture_id); });
  return ids;
}

async function getCurrentGameweek(db) {
  const { data, error } = await db
    .from('gameweeks')
    .select('number')
    .eq('is_current', true)
    .single();

  if (error || !data) {
    console.warn('[points-cron] Could not get current GW from DB, defaulting to 23');
    return 23;
  }
  return data.number;
}

async function getAllUsersWithSquads(db) {
  // Fetch all profiles that have a saved squad (squad_data is not null)
  const { data, error } = await db
    .from('profiles')
    .select('id, squad_data, total_points, gw_points')
    .not('squad_data', 'is', null);

  if (error) throw new Error('Could not load user squads: ' + error.message);
  return data || [];
}

async function storePlayerStats(db, playerStats, fixture, gameweek) {
  const rows = playerStats.map(function(p) {
    return {
      api_player_id:    p.api_player_id,
      player_name:      p.player_name,
      team:             p.team,
      fixture_id:       fixture.fixture_id,
      gameweek:         gameweek,
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
    };
  });

  // upsert — safe to run multiple times, won't duplicate
  const { error } = await db
    .from('player_gw_stats')
    .upsert(rows, { onConflict: 'api_player_id,fixture_id', ignoreDuplicates: false });

  if (error) throw new Error('Could not store player stats: ' + error.message);
}

async function writeGWScores(db, gwScoreRows) {
  // Upsert — if user already has a score for this GW, ADD to it
  // (because a GW has multiple matches, we accumulate)
  for (const row of gwScoreRows) {
    // First check if a row already exists for this user + GW
    const { data: existing } = await db
      .from('gw_scores')
      .select('id, points, player_scores')
      .eq('user_id', row.user_id)
      .eq('gameweek', row.gameweek)
      .single();

    if (existing) {
      // ADD to existing score (accumulate across multiple matches in same GW)
      const newTotal   = (existing.points || 0) + row.points;
      const allPlayers = (existing.player_scores || []).concat(row.player_scores || []);
      await db.from('gw_scores').update({
        points:        newTotal,
        player_scores: allPlayers,
        calculated_at: new Date().toISOString()
      }).eq('id', existing.id);
    } else {
      // First match of GW for this user
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
  // For each user, read their current total_points and add the new GW points
  // We do this one by one to avoid race conditions
  for (const row of gwScoreRows) {
    const { data: profile } = await db
      .from('profiles')
      .select('total_points')
      .eq('id', row.user_id)
      .single();

    const currentTotal = (profile && profile.total_points) || 0;
    await db.from('profiles').update({
      gw_points:    row.points,
      total_points: currentTotal + row.points,
      last_gw_scored: row.gameweek,
      updated_at:   new Date().toISOString()
    }).eq('id', row.user_id);
  }
}

async function markFixtureProcessed(db, fixture, gameweek, usersScored, apiCallsUsed) {
  const { error } = await db.from('processed_fixtures').upsert({
    fixture_id:   fixture.fixture_id,
    gameweek:     gameweek,
    home_team:    fixture.home,
    away_team:    fixture.away,
    home_score:   fixture.hg,
    away_score:   fixture.ag,
    match_date:   fixture.date,
    processed_at: new Date().toISOString(),
    users_scored: usersScored,
    api_calls_used: apiCallsUsed
  }, { onConflict: 'fixture_id' });

  if (error) throw new Error('Could not mark fixture as processed: ' + error.message);
}

// ══════════════════════════════════════════════════════════════════════════
// API-FOOTBALL CALLS
// ══════════════════════════════════════════════════════════════════════════

async function getRecentlyCompletedFixtures() {
  // Get fixtures that finished in the last 48 hours
  // (48h window handles matches that finish late at night and are processed next morning)
  const response = await fetch(
    BASE_URL + '/fixtures?league=' + PSL_LEAGUE + '&season=' + SEASON + '&status=FT-AET-PEN&last=10',
    {
      headers: {
        'x-apisports-key': API_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io'
      }
    }
  );

  if (!response.ok) throw new Error('API-Football HTTP ' + response.status + ' when fetching completed fixtures');
  const json = await response.json();
  if (json.errors && Object.keys(json.errors).length > 0) {
    throw new Error('API-Football error: ' + JSON.stringify(json.errors));
  }

  return (json.response || []).map(function(f) {
    const fixture = f.fixture || {};
    const teams   = f.teams   || {};
    const goals   = f.goals   || {};
    return {
      fixture_id: fixture.id,
      date:       fixture.date,
      home:       (teams.home && teams.home.name) || '',
      away:       (teams.away && teams.away.name) || '',
      hg:         goals.home,
      ag:         goals.away
    };
  });
}

async function getFixturePlayerStats(fixtureId) {
  const response = await fetch(
    BASE_URL + '/fixtures/players?fixture=' + fixtureId,
    {
      headers: {
        'x-apisports-key': API_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io'
      }
    }
  );

  if (!response.ok) throw new Error('API-Football HTTP ' + response.status + ' when fetching player stats for fixture ' + fixtureId);
  const json = await response.json();
  if (json.errors && Object.keys(json.errors).length > 0) {
    throw new Error('API-Football error: ' + JSON.stringify(json.errors));
  }

  const teams      = json.response || [];
  const allPlayers = [];

  teams.forEach(function(teamData) {
    const teamName = (teamData.team && teamData.team.name) || 'Unknown';
    (teamData.players || []).forEach(function(entry) {
      const player = entry.player   || {};
      const stats  = (entry.statistics && entry.statistics[0]) || {};

      const pos            = normalisePosition((stats.games && stats.games.position) || '');
      const minutes        = (stats.games && stats.games.minutes)             || 0;
      const goals          = (stats.goals && stats.goals.total)               || 0;
      const assists        = (stats.goals && stats.goals.assists)             || 0;
      const saves          = (stats.goals && stats.goals.saves)               || 0;
      const goalsConceded  = (stats.goals && stats.goals.conceded)            || 0;
      const yellowCards    = (stats.cards && stats.cards.yellow)              || 0;
      const redCards       = (stats.cards && stats.cards.red)                 || 0;
      const penSaved       = (stats.penalty && stats.penalty.saved)           || 0;
      const penMissed      = (stats.penalty && stats.penalty.missed)          || 0;

      const pts = calculateFantasyPoints({
        pos, minutes, goals, assists, saves, goalsConceded,
        yellowCards, redCards, penSaved, penMissed
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
// HELPERS
// ══════════════════════════════════════════════════════════════════════════

// Normalise a player name for fuzzy matching
// Handles: "Evidence Makgopa" == "E. Makgopa" == "evidence makgopa"
function normaliseName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')  // remove punctuation
    .replace(/\s+/g, ' ')       // collapse spaces
    .trim();
}
