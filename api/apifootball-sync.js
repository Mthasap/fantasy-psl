/**
 * Fantasy PSL — API-Football Stats Sync
 * =======================================
 * File: /api/apifootball-sync.js
 *
 * Handles three sync phases in one endpoint:
 *   Phase 1 — Sync all fixtures for the season (dates, scores, status)
 *   Phase 2 — For each finished fixture not yet stat-synced, fetch /fixtures/players
 *              calculate fantasy points, store in match_player_stats
 *   Phase 3 — Recalculate player season totals + profile points
 *
 * Usage:
 *   GET /api/apifootball-sync              → runs full sync (all phases)
 *   GET /api/apifootball-sync?phase=1      → fixtures only
 *   GET /api/apifootball-sync?phase=2      → match stats only
 *   GET /api/apifootball-sync?phase=3      → recalculate totals only
 *   GET /api/apifootball-sync?gw=5         → phase 2 for specific GW only
 *   GET /api/apifootball-sync?fixture=1302280 → single fixture stats
 *
 * Cron (vercel.json): "0 2 * * *" — runs at 2am daily
 */

const { createClient } = require('@supabase/supabase-js');

// ─── Config ──────────────────────────────────────────────────────────────────

const API_KEY      = process.env.APIFOOTBALL_KEY;
const API_BASE     = 'https://v3.football.api-sports.io';
const PSL_LEAGUE   = 288;
const PSL_SEASON   = 2025;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // use service key for server-side writes
);

// ─── API-Football fetch helper ────────────────────────────────────────────────

async function apiFetch(endpoint) {
  const url = `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    headers: {
      'x-rapidapi-key':  API_KEY,
      'x-rapidapi-host': 'v3.football.api-sports.io',
    },
  });
  if (!res.ok) throw new Error(`API-Football ${res.status}: ${url}`);
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(`API-Football error: ${JSON.stringify(data.errors)}`);
  }
  return data;
}

// ─── Scoring Engine ───────────────────────────────────────────────────────────
// Takes a player stats row from /fixtures/players and returns fantasy points
// Also returns a breakdown object for transparency

function calculateFantasyPoints(stats, position, homeScore, awayScore, teamId, homeTeamId) {
  const breakdown = {};
  let points = 0;

  const mins     = stats.games?.minutes ?? 0;
  const isGK     = position === 'G';
  const isDEF    = position === 'D';
  const isMID    = position === 'M';
  const isFWD    = position === 'F';
  const played60 = mins >= 60;

  // ── Appearance ──────────────────────────────────────────────────────────
  if (mins > 0 && mins < 60) {
    points += 1;
    breakdown.appearance = 1;
  } else if (mins >= 60) {
    points += 2;
    breakdown.appearance = 2;
  }

  // ── Goals ────────────────────────────────────────────────────────────────
  const goals = stats.goals?.total ?? 0;
  if (goals > 0) {
    let goalPts = 0;
    if (isGK || isDEF) goalPts = 6;
    else if (isMID)    goalPts = 5;
    else if (isFWD)    goalPts = 4;
    const total = goalPts * goals;
    points += total;
    breakdown.goals = total;
  }

  // ── Assists ──────────────────────────────────────────────────────────────
  const assists = stats.goals?.assists ?? 0;
  if (assists > 0) {
    const total = 3 * assists;
    points += total;
    breakdown.assists = total;
  }

  // ── Clean Sheet ──────────────────────────────────────────────────────────
  // Team kept a clean sheet if the opposing team scored 0
  const isHome     = teamId === homeTeamId;
  const oppScore   = isHome ? awayScore : homeScore;
  const cleanSheet = oppScore === 0 && played60;

  if (cleanSheet) {
    if (isGK || isDEF) {
      points += 4;
      breakdown.clean_sheet = 4;
    } else if (isMID) {
      points += 1;
      breakdown.clean_sheet = 1;
    }
  }

  // ── Saves (GK) ───────────────────────────────────────────────────────────
  if (isGK) {
    const saves = stats.goals?.saves ?? 0;
    if (saves >= 3) {
      const savePts = Math.floor(saves / 3);
      points += savePts;
      breakdown.saves = savePts;
    }
  }

  // ── Goals Conceded (GK / DEF, 60+ mins) ─────────────────────────────────
  if ((isGK || isDEF) && played60) {
    const conceded = stats.goals?.conceded ?? 0;
    if (conceded >= 2) {
      const concededPts = -Math.floor(conceded / 2);
      points += concededPts;
      breakdown.goals_conceded = concededPts;
    }
  }

  // ── Yellow Card ──────────────────────────────────────────────────────────
  const yellows = stats.cards?.yellow ?? 0;
  if (yellows > 0) {
    const total = -1 * yellows;
    points += total;
    breakdown.yellow_card = total;
  }

  // ── Red Card ─────────────────────────────────────────────────────────────
  const reds = stats.cards?.red ?? 0;
  if (reds > 0) {
    const total = -3 * reds;
    points += total;
    breakdown.red_card = total;
  }

  // ── Penalty Saved (GK) ───────────────────────────────────────────────────
  if (isGK) {
    const penSaved = stats.penalty?.saved ?? 0;
    if (penSaved > 0) {
      const total = 5 * penSaved;
      points += total;
      breakdown.penalty_saved = total;
    }
  }

  // ── Penalty Missed ───────────────────────────────────────────────────────
  const penMissed = stats.penalty?.missed ?? 0;
  if (penMissed > 0) {
    const total = -2 * penMissed;
    points += total;
    breakdown.penalty_missed = total;
  }

  // Rating bonus intentionally removed — not part of the published scoring rules.
  // All displayed stats must match what users see in the scoring guide exactly.

  return { points, breakdown, cleanSheet };
}

// ─── Round string → GW number ────────────────────────────────────────────────
function parseGwNumber(roundStr) {
  // "Regular Season - 5" → 5
  const match = roundStr?.match(/Regular Season - (\d+)/);
  return match ? parseInt(match[1]) : null;
}

// ─── Phase 1: Sync Fixtures ──────────────────────────────────────────────────

async function syncFixtures(log) {
  log.push('Phase 1: Fetching all fixtures for season ' + PSL_SEASON);

  const data = await apiFetch(
    `/fixtures?league=${PSL_LEAGUE}&season=${PSL_SEASON}`
  );
  const fixtures = data.response ?? [];
  log.push(`  Found ${fixtures.length} total fixtures`);

  let upserted = 0;
  const rows = fixtures.map(f => {
    const gwNumber = parseGwNumber(f.league?.round);
    return {
      apifootball_fixture_id: f.fixture.id,
      season:          PSL_SEASON,
      gw_number:       gwNumber,
      api_round:       f.league?.round,
      home_team_id:    f.teams?.home?.id,
      away_team_id:    f.teams?.away?.id,
      home_team_name:  f.teams?.home?.name,
      away_team_name:  f.teams?.away?.name,
      home_team_logo:  f.teams?.home?.logo,
      away_team_logo:  f.teams?.away?.logo,
      kickoff_time:    f.fixture?.date,
      venue_name:      f.fixture?.venue?.name,
      venue_city:      f.fixture?.venue?.city,
      referee:         f.fixture?.referee,
      status:          f.fixture?.status?.short,
      elapsed_minutes: f.fixture?.status?.elapsed,
      home_score:      f.goals?.home,
      away_score:      f.goals?.away,
      home_score_ht:   f.score?.halftime?.home,
      away_score_ht:   f.score?.halftime?.away,
      updated_at:      new Date().toISOString(),
    };
  });

  // Upsert in batches of 50
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { error } = await supabase
      .from('fixtures')
      .upsert(batch, { onConflict: 'apifootball_fixture_id' });
    if (error) throw new Error('Fixtures upsert error: ' + error.message);
    upserted += batch.length;
  }

  // Also upsert gameweeks from unique rounds
  const rounds = [...new Set(fixtures.map(f => f.league?.round).filter(Boolean))];
  const gwRows = rounds.map(round => {
    const gwNumber = parseGwNumber(round);
    if (!gwNumber) return null;
    const roundFixtures = fixtures.filter(f => f.league?.round === round);
    const dates = roundFixtures.map(f => f.fixture?.date).filter(Boolean).sort();
    const finishedCount = roundFixtures.filter(f => f.fixture?.status?.short === 'FT').length;
    return {
      season:      PSL_SEASON,
      gw_number:   gwNumber,
      api_round:   round,
      start_date:  dates[0] ?? null,
      end_date:    dates[dates.length - 1] ?? null,
      is_finished: finishedCount === roundFixtures.length,
    };
  }).filter(Boolean);

  if (gwRows.length > 0) {
    const { error } = await supabase
      .from('gameweeks')
      .upsert(gwRows, { onConflict: 'season,gw_number' });
    if (error) log.push('  ⚠️  Gameweeks upsert warning: ' + error.message);
    else log.push(`  ✅ Upserted ${gwRows.length} gameweeks`);
  }

  // ── AUTO-SET is_current ───────────────────────────────────────────────────
  // Determine which GW is "current" based on today's date:
  //   • A GW is current if today falls between its start_date and end_date
  //   • If no GW window contains today, pick the GW with the highest gw_number
  //     whose start_date is in the past (i.e. the most recently started GW)
  // Then: clear is_current on ALL other GWs and set it only on the correct one.
  try {
    const now = new Date().toISOString();

    // First: find a GW whose window contains today
    const { data: inWindow } = await supabase
      .from('gameweeks')
      .select('gw_number')
      .eq('season', PSL_SEASON)
      .lte('start_date', now)
      .gte('end_date', now)
      .order('gw_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    let currentGwNum = inWindow ? inWindow.gw_number : null;

    // Second fallback: highest GW whose start_date has passed
    if (!currentGwNum) {
      const { data: started } = await supabase
        .from('gameweeks')
        .select('gw_number')
        .eq('season', PSL_SEASON)
        .lte('start_date', now)
        .order('gw_number', { ascending: false })
        .limit(1)
        .maybeSingle();
      currentGwNum = started ? started.gw_number : null;
    }

    // Third fallback: just the highest gw_number we have
    if (!currentGwNum && gwRows.length > 0) {
      currentGwNum = Math.max(...gwRows.map(r => r.gw_number));
    }

    if (currentGwNum) {
      // Clear is_current on all GWs for this season
      await supabase
        .from('gameweeks')
        .update({ is_current: false })
        .eq('season', PSL_SEASON)
        .neq('gw_number', currentGwNum);

      // Set is_current only on the correct GW
      const { error: setErr } = await supabase
        .from('gameweeks')
        .update({ is_current: true })
        .eq('season', PSL_SEASON)
        .eq('gw_number', currentGwNum);

      if (setErr) {
        log.push(`  ⚠️  Could not set is_current on GW${currentGwNum}: ${setErr.message}`);
      } else {
        log.push(`  ✅ is_current set to GW${currentGwNum} (auto-detected from date)`);
      }
    }
  } catch (e) {
    log.push(`  ⚠️  is_current auto-set failed: ${e.message}`);
  }
  // ─────────────────────────────────────────────────────────────────────────

  log.push(`  ✅ Upserted ${upserted} fixtures`);
  return upserted;
}

// ─── Phase 2: Sync Match Player Stats ────────────────────────────────────────

async function syncMatchStats(log, options = {}) {
  log.push('Phase 2: Fetching match player stats');

  // Find fixtures that are either LIVE, or FT but haven't been synced yet
  let query = supabase
    .from('fixtures')
    .select('apifootball_fixture_id, gw_number, home_team_id, home_score, away_score, status, stats_synced')
    .eq('season', PSL_SEASON)
    .in('status', ['LIVE', '1H', '2H', 'HT', 'ET', 'P', 'PEN', 'FT']);

  if (options.gw)      query = query.eq('gw_number', options.gw);
  if (options.fixture) query = query.eq('apifootball_fixture_id', options.fixture);

  const { data: allCandidates, error } = await query;
  if (error) throw new Error('Failed to fetch pending fixtures: ' + error.message);

  // ── FIX: Filter intelligently to bypass any database glitches ──
  const pendingFixtures = (allCandidates || []).filter(f => {
    if (f.home_score === null) return false; // Skip if no score data at all
    if (f.status === 'FT' && f.stats_synced === true) return false; // Skip if fully finished & synced
    return true; // If we reach here, it's either LIVE, or FT and needing a sync!
  });

  log.push(`  Found ${pendingFixtures.length} fixtures needing stats`);

  let totalPlayers = 0;
  let totalErrors  = 0;

  for (const fixture of (pendingFixtures ?? [])) {
    try {
      log.push(`  Processing fixture ${fixture.apifootball_fixture_id} (GW${fixture.gw_number})`);

      const data = await apiFetch(
        `/fixtures/players?fixture=${fixture.apifootball_fixture_id}`
      );
      const teams = data.response ?? [];

      if (teams.length === 0) {
        log.push(`    ⚠️  No player stats returned for fixture ${fixture.apifootball_fixture_id}`);
        // Only mark as permanently synced if it's full time, otherwise we want it to retry while live
        if (fixture.status === 'FT') {
          await supabase
            .from('fixtures')
            .update({ stats_synced: true, last_synced_at: new Date().toISOString() })
            .eq('apifootball_fixture_id', fixture.apifootball_fixture_id);
        }
        continue;
      }

      const statRows = [];

      for (const team of teams) {
        const teamId = team.team?.id;

        for (const playerData of (team.players ?? [])) {
          const stats = playerData.statistics?.[0];
          if (!stats) continue;

          const mins = stats.games?.minutes ?? 0;
          if (mins === 0 && !stats.games?.substitute) continue; // skip truly unused

          const position = stats.games?.position?.charAt(0) ?? 'M'; // G, D, M, F
          const { points, breakdown, cleanSheet } = calculateFantasyPoints(
            stats,
            position,
            fixture.home_score,
            fixture.away_score,
            teamId,
            fixture.home_team_id
          );

          // ── ADDED: Extract Injury Status & Update Players Table ──
          const isInjured = playerData.update && playerData.update.injured === true;
          
          await supabase
            .from('players')
            .update({ 
              is_injured: isInjured, 
              is_available: !isInjured 
            })
            .eq('apifootball_id', playerData.player && playerData.player.id);
          // ─────────────────────────────────────────────────────────

          // NO DUPLICATES HERE: Just the clean push
          statRows.push({
            apifootball_fixture_id: fixture.apifootball_fixture_id,
            apifootball_player_id:  playerData.player?.id,
            apifootball_team_id:    teamId,
            season:                 PSL_SEASON,
            gw_number:              fixture.gw_number,
            player_name:            playerData.player?.name,
            position:               position,
            minutes_played:         mins,
            is_substitute:          stats.games?.substitute ?? false,
            is_captain:             stats.games?.captain ?? false,
            rating:                 parseFloat(stats.games?.rating ?? 0) || null,
            goals:                  stats.goals?.total ?? 0,
            assists:                stats.goals?.assists ?? 0,
            shots_total:            stats.shots?.total ?? 0,
            shots_on_target:        stats.shots?.on ?? 0,
            key_passes:             stats.passes?.key ?? 0,
            offsides:               stats.offsides ?? 0,
            saves:                  stats.goals?.saves ?? 0,
            goals_conceded:         stats.goals?.conceded ?? 0,
            penalties_saved:        stats.penalty?.saved ?? 0,
            tackles:                stats.tackles?.total ?? 0,
            blocks:                 stats.tackles?.blocks ?? 0,
            interceptions:          stats.tackles?.interceptions ?? 0,
            passes_total:           stats.passes?.total ?? 0,
            pass_accuracy:          parseInt(stats.passes?.accuracy ?? 0) || 0,
            duels_total:            stats.duels?.total ?? 0,
            duels_won:              stats.duels?.won ?? 0,
            dribbles_attempted:     stats.dribbles?.attempts ?? 0,
            dribbles_success:       stats.dribbles?.success ?? 0,
            yellow_cards:           stats.cards?.yellow ?? 0,
            red_cards:              stats.cards?.red ?? 0,
            fouls_committed:        stats.fouls?.committed ?? 0,
            fouls_drawn:            stats.fouls?.drawn ?? 0,
            penalties_scored:       stats.penalty?.scored ?? 0,
            penalties_missed:       stats.penalty?.missed ?? 0,
            clean_sheet:            cleanSheet,
            fantasy_points:         points,
            points_breakdown:       breakdown,
            updated_at:             new Date().toISOString(),
          });
        }
      }

      // ── Deduplicate by player ID ──────────────────────────────────────────
      const seen = new Set();
      const dedupedRows = statRows.filter(row => {
        const key = `${row.apifootball_fixture_id}_${row.apifootball_player_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Upsert all player stats for this fixture
      if (dedupedRows.length > 0) {
        const { error: statsError } = await supabase
          .from('match_player_stats')
          .upsert(dedupedRows, {
            onConflict: 'apifootball_fixture_id,apifootball_player_id'
          });
        if (statsError) throw new Error('Stats upsert error: ' + statsError.message);
        totalPlayers += dedupedRows.length;
        log.push(`    ✅ ${dedupedRows.length} player stats saved`);
      }

      // Only mark fixture as completely synced if it is Full Time
      if (fixture.status === 'FT') {
        await supabase
          .from('fixtures')
          .update({ stats_synced: true, last_synced_at: new Date().toISOString() })
          .eq('apifootball_fixture_id', fixture.apifootball_fixture_id);
      }

      // Small delay to be polite to the API
      await new Promise(r => setTimeout(r, 200));

    } catch (err) {
      log.push(`    ❌ Error on fixture ${fixture.apifootball_fixture_id}: ${err.message}`);
      totalErrors++;
    }
  }

  log.push(`  ✅ Phase 2 complete: ${totalPlayers} player stats, ${totalErrors} errors`);
  return { totalPlayers, totalErrors };
}


// ─── Phase 3: Recalculate Totals ─────────────────────────────────────────────

async function recalculateTotals(log) {
  log.push('Phase 3: Recalculating player season totals');

  // Aggregate from match_player_stats into players table
  const { data: aggregates, error: aggError } = await supabase
    .from('match_player_stats')
    .select(`
      apifootball_player_id,
      fantasy_points,
      minutes_played,
      goals,
      assists,
      clean_sheet,
      saves,
      yellow_cards,
      red_cards,
      goals_conceded,
      rating
    `)
    .eq('season', PSL_SEASON)
    .gt('minutes_played', 0);

  if (aggError) throw new Error('Aggregation error: ' + aggError.message);

  // Group by player
  const playerMap = {};
  for (const row of (aggregates ?? [])) {
    const pid = row.apifootball_player_id;
    if (!playerMap[pid]) {
      playerMap[pid] = {
        appearances: 0, minutes_played: 0, goals: 0, assists: 0,
        clean_sheets: 0, saves: 0, yellow_cards: 0, red_cards: 0,
        goals_conceded: 0, total_points: 0, ratings: []
      };
    }
    const p = playerMap[pid];
    p.appearances++;
    p.minutes_played  += row.minutes_played ?? 0;
    p.goals           += row.goals ?? 0;
    p.assists         += row.assists ?? 0;
    p.clean_sheets    += row.clean_sheet ? 1 : 0;
    p.saves           += row.saves ?? 0;
    p.yellow_cards    += row.yellow_cards ?? 0;
    p.red_cards       += row.red_cards ?? 0;
    p.goals_conceded  += row.goals_conceded ?? 0;
    p.total_points    += row.fantasy_points ?? 0;
    if (row.rating) p.ratings.push(parseFloat(row.rating));
  }

  // Update each player
  let updated = 0;
  const playerIds = Object.keys(playerMap);

  for (let i = 0; i < playerIds.length; i += 50) {
    const batch = playerIds.slice(i, i + 50);
    for (const pid of batch) {
      const agg = playerMap[pid];
      const avgRating = agg.ratings.length > 0
        ? Math.round((agg.ratings.reduce((a, b) => a + b, 0) / agg.ratings.length) * 100) / 100
        : null;

      const { error } = await supabase
        .from('players')
        .update({
          appearances:    agg.appearances,
          minutes_played: agg.minutes_played,
          goals:          agg.goals,
          assists:        agg.assists,
          clean_sheets:   agg.clean_sheets,
          saves:          agg.saves,
          yellow_cards:   agg.yellow_cards,
          red_cards:      agg.red_cards,
          goals_conceded: agg.goals_conceded,
          total_points:   agg.total_points,
          avg_rating:     avgRating,
          updated_at:     new Date().toISOString(),
        })
        .eq('apifootball_id', parseInt(pid));

      if (!error) updated++;
    }
  }

  log.push(`  ✅ Updated ${updated} player season totals`);

  // Recalculate profile points
  const { data: profiles, error: profilesError } = await supabase
    .from('profiles')
    .select('id, squad_data');

  if (profilesError) {
    log.push('  ⚠️  Could not fetch profiles: ' + profilesError.message);
    return updated;
  }

  let profilesUpdated = 0;
  for (const profile of (profiles ?? [])) {
    try {
      const squadData = profile.squad_data;
      if (!squadData) continue;

      // squad_data can be an array OR { players: [...] } — handle both
      const squadArr = Array.isArray(squadData) ? squadData : (squadData?.players ?? []);
      const rosterIds = squadArr
        .map(p => p?.psl_roster_id ?? p?.id)
        .filter(id => id && (typeof id === 'number' || (typeof id === 'string' && id.trim() !== '')))
        .map(id => (typeof id === 'string' ? parseInt(id, 10) : id))
        .filter(id => !isNaN(id));

      if (rosterIds.length === 0) continue;

      // Use gw_scores table — this already accounts for captain/chip multipliers
      // (points-cron writes correctly calculated scores there)
      const { data: gwScoreRows } = await supabase
        .from('gw_scores')
        .select('points')
        .eq('user_id', profile.id);

      const totalPoints = (gwScoreRows ?? [])
        .reduce((sum, r) => sum + (r.points ?? 0), 0);

      // Only update if we have score data — don't zero out if no rows yet
      if ((gwScoreRows ?? []).length > 0) {
        await supabase
          .from('profiles')
          .update({ total_points: totalPoints })
          .eq('id', profile.id);
      }

      profilesUpdated++;
    } catch (e) {
      log.push(`  ⚠️  Profile ${profile.id} error: ${e.message}`);
    }
  }

  log.push(`  ✅ Updated ${profilesUpdated} profile point totals`);
  return updated;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // Security: accept cron, x-admin-key, x-sync-secret, Bearer token, or ?secret param.
  // Admin panel sends x-admin-key; crons send x-vercel-cron.
  // SYNC_SECRET falls back to ADMIN_SECRET so one env var covers everything.
  const VALID_SECRET = process.env.SYNC_SECRET || process.env.ADMIN_SECRET || '';
  const cronHeader   = req.headers['x-vercel-cron'];
  const adminKeyHdr  = req.headers['x-admin-key']    || '';
  const syncSecretHdr= req.headers['x-sync-secret']  || '';
  const authHeader   = req.headers['authorization']  || '';
  const secretParam  = req.query.secret              || '';

  const isAuthorized = cronHeader === '1'
    || (VALID_SECRET && adminKeyHdr  === VALID_SECRET)
    || (VALID_SECRET && syncSecretHdr=== VALID_SECRET)
    || (VALID_SECRET && secretParam  === VALID_SECRET)
    || (VALID_SECRET && authHeader   === `Bearer ${VALID_SECRET}`)
    // Also accept ADMIN_SECRET directly so one key covers both endpoints
    || (process.env.ADMIN_SECRET && adminKeyHdr === process.env.ADMIN_SECRET)
    || (process.env.ADMIN_SECRET && secretParam  === process.env.ADMIN_SECRET);

  if (!isAuthorized) {
    console.warn('[apifootball-sync] 401 — no valid auth. Headers:', 
      Object.keys(req.headers).join(','), '| secretParam present:', !!secretParam);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();
  const log = [];
  const phase         = req.query.phase   ? parseInt(req.query.phase)   : 'all';
  const gwFilter      = req.query.gw      ? parseInt(req.query.gw)      : null;
  const fixtureFilter = req.query.fixture ? parseInt(req.query.fixture) : null;

  // Phase 0 = diagnostic — confirms env, DB counts, does no writes
  if (phase === 0) {
    const diagLog = [];
    diagLog.push('=== DIAGNOSTIC MODE ===');
    diagLog.push('APIFOOTBALL_KEY set: ' + !!API_KEY);
    diagLog.push('SUPABASE_URL set: ' + !!process.env.SUPABASE_URL);
    diagLog.push('SUPABASE_SERVICE_KEY set: ' + !!process.env.SUPABASE_SERVICE_KEY);
    diagLog.push('ADMIN_SECRET set: ' + !!process.env.ADMIN_SECRET);
    diagLog.push('SYNC_SECRET set: ' + !!process.env.SYNC_SECRET);
    diagLog.push('Auth passed: YES (you would not see this if auth failed)');
    try {
      const { count: mpsCount } = await supabase.from('match_player_stats').select('*', { count: 'exact', head: true });
      diagLog.push('match_player_stats rows: ' + mpsCount);
      const { count: fixCount } = await supabase.from('fixtures').select('*', { count: 'exact', head: true });
      diagLog.push('fixtures rows: ' + fixCount);
      const { data: ftFix } = await supabase.from('fixtures').select('apifootball_fixture_id,gw_number,status').eq('status','FT').limit(3);
      diagLog.push('Sample FT fixtures: ' + JSON.stringify(ftFix));
      const { data: gwRow } = await supabase.from('gameweeks').select('*').eq('is_current',true).limit(1);
      diagLog.push('Current gameweek: ' + JSON.stringify(gwRow));
    } catch(e) {
      diagLog.push('DB error: ' + e.message);
    }
    return res.json({ success: true, diagnostic: true, log: diagLog });
  }

  log.push(`Starting sync at ${new Date().toISOString()}`);
  log.push(`Phase: ${phase} | GW: ${gwFilter ?? 'all'} | Fixture: ${fixtureFilter ?? 'all'}`);

  let fixturesProcessed = 0;
  let playersUpdated    = 0;
  let errorsEncountered = 0;
  let status            = 'success';

  // Log to sync_log table
  const { data: syncLogRow } = await supabase
    .from('sync_log')
    .insert({
      sync_type: phase === 'all' ? 'full' : `phase_${phase}`,
      season:    PSL_SEASON,
      gw_number: gwFilter,
      status:    'running',
      log:       [],
    })
    .select('id')
    .single();

  const syncLogId = syncLogRow?.id;

  try {
    if (phase === 'all' || phase === 1) {
      fixturesProcessed = await syncFixtures(log);
    }

    if (phase === 'all' || phase === 2) {
      const result = await syncMatchStats(log, {
        gw:      gwFilter,
        fixture: fixtureFilter,
      });
      playersUpdated    = result.totalPlayers;
      errorsEncountered = result.totalErrors;
    }

    if (phase === 'all' || phase === 3) {
      playersUpdated += await recalculateTotals(log);
    }

  } catch (err) {
    log.push('❌ Fatal error: ' + err.message);
    status = 'error';
    errorsEncountered++;
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  log.push(`\nSync complete in ${duration}s`);

  // Update sync log
  if (syncLogId) {
    await supabase
      .from('sync_log')
      .update({
        status,
        fixtures_processed: fixturesProcessed,
        players_updated:    playersUpdated,
        errors_encountered: errorsEncountered,
        log,
        finished_at: new Date().toISOString(),
      })
      .eq('id', syncLogId);
  }

  return res.status(200).json({
    status,
    duration:           `${duration}s`,
    fixtures_processed: fixturesProcessed,
    players_updated:    playersUpdated,
    errors_encountered: errorsEncountered,
    log,
  });
};
