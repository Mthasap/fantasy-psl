/**
 * Fantasy PSL — API-Football Stats Sync v2
 * ==========================================
 * File: /api/apifootball-sync.js
 *
 * FIXES vs v1:
 *   1. PLAYER STATS NEVER WORKED: root cause was the `is('photo', null)` filter
 *      on the injury update — it silently skipped most players. Removed that filter.
 *   2. DEDUPLICATION: added fixture+player composite key dedup BEFORE upsert
 *      to prevent duplicate rows in match_player_stats.
 *   3. gw_number is now always written to match_player_stats rows so points-cron
 *      can use the gw_number fallback path without missing data.
 *   4. API header fixed: was using 'x-rapidapi-key' in some places, 'x-apisports-key'
 *      in others. Unified to 'x-apisports-key' throughout.
 *   5. PSL_SEASON reads from env var (consistent with other files).
 *   6. Phase 2 now retries LIVE fixtures every run (stats can change mid-match).
 *   7. syncMatchStats now also supports `api_fixture_id` column variant (sync.js).
 */

const { createClient } = require('@supabase/supabase-js');

const API_KEY    = process.env.APIFOOTBALL_KEY;
const API_BASE   = 'https://v3.football.api-sports.io';
const PSL_LEAGUE = 288;
const PSL_SEASON = process.env.APIFOOTBALL_SEASON ? parseInt(process.env.APIFOOTBALL_SEASON) : 2026;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── API-Football fetch helper ─────────────────────────────────────────────
async function apiFetch(endpoint) {
  const url = `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    headers: { 'x-apisports-key': API_KEY },
  });
  if (!res.ok) throw new Error(`API-Football ${res.status}: ${url}`);
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    const errStr = JSON.stringify(data.errors);
    if (!errStr.includes('{}') && errStr !== '{}') {
      throw new Error(`API-Football error: ${errStr}`);
    }
  }
  return data;
}

// ─── Fantasy Points Calculator ────────────────────────────────────────────
function calculateFantasyPoints(stats, position, homeScore, awayScore, teamId, homeTeamId) {
  const breakdown = {};
  let points = 0;

  const mins     = stats.games?.minutes ?? 0;
  const isGK     = position === 'G';
  const isDEF    = position === 'D';
  const isMID    = position === 'M';
  const played60 = mins >= 60;

  if (mins > 0 && mins < 60)  { points += 1; breakdown.appearance = 1; }
  else if (mins >= 60)         { points += 2; breakdown.appearance = 2; }

  const goals = stats.goals?.total ?? 0;
  if (goals > 0) {
    const goalPts = (isGK || isDEF) ? 6 : isMID ? 5 : 4;
    const total   = goalPts * goals;
    points += total;
    breakdown.goals = total;
  }

  const assists = stats.goals?.assists ?? 0;
  if (assists > 0) {
    const total = 3 * assists;
    points += total;
    breakdown.assists = total;
  }

  const isHome     = teamId === homeTeamId;
  const oppScore   = isHome ? awayScore : homeScore;
  const cleanSheet = oppScore === 0 && played60;

  if (cleanSheet) {
    if (isGK || isDEF) { points += 4; breakdown.clean_sheet = 4; }
    else if (isMID)    { points += 1; breakdown.clean_sheet = 1; }
  }

  if (isGK) {
    const saves = stats.goals?.saves ?? 0;
    if (saves >= 3) {
      const savePts = Math.floor(saves / 3);
      points += savePts;
      breakdown.saves = savePts;
    }
  }

  if ((isGK || isDEF) && played60) {
    const conceded = stats.goals?.conceded ?? 0;
    if (conceded >= 2) {
      const concededPts = -Math.floor(conceded / 2);
      points += concededPts;
      breakdown.goals_conceded = concededPts;
    }
  }

  const yellows = stats.cards?.yellow ?? 0;
  if (yellows > 0) { const t = -1 * yellows; points += t; breakdown.yellow_card = t; }

  const reds = stats.cards?.red ?? 0;
  if (reds > 0) { const t = -3 * reds; points += t; breakdown.red_card = t; }

  if (isGK) {
    const penSaved = stats.penalty?.saved ?? 0;
    if (penSaved > 0) { const t = 5 * penSaved; points += t; breakdown.penalty_saved = t; }
  }

  const penMissed = stats.penalty?.missed ?? 0;
  if (penMissed > 0) { const t = -2 * penMissed; points += t; breakdown.penalty_missed = t; }

  // Own goals: -2 each. API-Football exposes this inconsistently depending on
  // endpoint/plan, so we check every field name it is known to use and fall
  // back to 0. Safe if absent — never throws, never guesses.
  const ownGoals = stats.goals?.own
                ?? stats.goals?.own_goals
                ?? stats.own_goals
                ?? 0;
  if (ownGoals > 0) { const t = -2 * ownGoals; points += t; breakdown.own_goals = t; }

  return { points, breakdown, cleanSheet };
}

// ─── Round string → GW number ─────────────────────────────────────────────
function parseGwNumber(roundStr) {
  const match = roundStr?.match(/Regular Season - (\d+)/);
  return match ? parseInt(match[1]) : null;
}

// ─── Phase 0: Sync Player Photos ─────────────────────────────────────────
const PSL_TEAM_IDS = [
  569, 570, 571, 572, 573, 574, 575, 576,
  577, 578, 579, 580, 581, 582, 583, 584,
];

async function syncPlayerPhotos(log) {
  log.push('Phase 0: Syncing player photos');
  let updated = 0;
  for (const teamId of PSL_TEAM_IDS) {
    try {
      const json = await apiFetch(`/players/squads?team=${teamId}`);
      const players = json.response?.[0]?.players || [];
      for (const pl of players) {
        if (!pl.id || !pl.photo) continue;
        // FIX: removed `.is('photo', null)` — that filter was silently skipping
        // all players who already had a photo, so stats never got written.
        // Now we always update the photo (idempotent).
        const { error } = await supabase.from('players')
          .update({ photo: pl.photo, updated_at: new Date().toISOString() })
          .eq('apifootball_id', pl.id);
        if (!error) updated++;
      }
    } catch (e) {
      log.push(`  ⚠️ Photo sync failed for team ${teamId}: ${e.message}`);
    }
  }
  log.push(`  ✅ Phase 0 complete: ${updated} player photos updated`);
}

// ─── Phase 1: Sync Fixtures ───────────────────────────────────────────────
async function syncFixtures(log) {
  log.push('Phase 1: Fetching all fixtures for season ' + PSL_SEASON);

  const data     = await apiFetch(`/fixtures?league=${PSL_LEAGUE}&season=${PSL_SEASON}`);
  const fixtures = data.response ?? [];
  log.push(`  Found ${fixtures.length} total fixtures`);

  let upserted = 0;
  const rows = fixtures.map(f => {
    const gwNumber = parseGwNumber(f.league?.round);
    return {
      apifootball_fixture_id: f.fixture.id,
      // Also write api_fixture_id for sync.js compatibility
      api_fixture_id:  f.fixture.id,
      season:          PSL_SEASON,
      gw_number:       gwNumber,
      api_round:       f.league?.round,
      home_team_id:    f.teams?.home?.id,
      away_team_id:    f.teams?.away?.id,
      home_team_name:  f.teams?.home?.name,
      away_team_name:  f.teams?.away?.name,
      home_team:       f.teams?.home?.name,  // sync.js column
      away_team:       f.teams?.away?.name,  // sync.js column
      home_team_logo:  f.teams?.home?.logo,
      away_team_logo:  f.teams?.away?.logo,
      home_logo:       f.teams?.home?.logo,  // sync.js column
      away_logo:       f.teams?.away?.logo,  // sync.js column
      kickoff_time:    f.fixture?.date,
      kickoff_at:      f.fixture?.date,      // sync.js column
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

  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { error } = await supabase
      .from('fixtures')
      .upsert(batch, { onConflict: 'apifootball_fixture_id' });
    if (error) throw new Error('Fixtures upsert error: ' + error.message);
    upserted += batch.length;

    // Remove pre-season placeholder fixtures (seeded with negative IDs) once
    // the real API fixtures for that gameweek have landed — prevents the
    // Match Centre showing each GW1 fixture twice.
    try {
      const realGws = [...new Set(batch.map(r => r.gw_number).filter(Boolean))];
      if (realGws.length) {
        await supabase.from('fixtures')
          .delete()
          .lt('apifootball_fixture_id', 0)
          .eq('season', PSL_SEASON)
          .in('gw_number', realGws);
      }
    } catch (_) { /* non-fatal */ }
  }

  // Upsert gameweeks from unique rounds
  const rounds = [...new Set(fixtures.map(f => f.league?.round).filter(Boolean))];
  const gwRows = rounds.map(round => {
    const gwNumber = parseGwNumber(round);
    if (!gwNumber) return null;
    const roundFixtures  = fixtures.filter(f => f.league?.round === round);
    const dates          = roundFixtures.map(f => f.fixture?.date).filter(Boolean).sort();
    const finishedCount  = roundFixtures.filter(f => f.fixture?.status?.short === 'FT').length;
    return {
      season:      PSL_SEASON,
      gw_number:   gwNumber,
      api_round:   round,
      start_date:  dates[0] ?? null,
      end_date:    dates[dates.length - 1] ?? null,
      // A gameweek is only "finished" if it HAS fixtures and ALL of them are FT.
      // Without the length>0 guard, an empty gameweek (0 fixtures) evaluated as
      // 0===0 = true, so future empty gameweeks were flagged finished and the
      // "first unfinished gameweek" advance skipped ahead (showing GW10 at GW5).
      is_finished: roundFixtures.length > 0 && finishedCount === roundFixtures.length,
    };
  }).filter(Boolean);

  if (gwRows.length > 0) {
    const { error } = await supabase
      .from('gameweeks')
      .upsert(gwRows, { onConflict: 'season,gw_number' });
    if (error) log.push('  ⚠️  Gameweeks upsert warning: ' + error.message);
    else log.push(`  ✅ Upserted ${gwRows.length} gameweeks`);
  }

  // ── Auto-set is_current ───────────────────────────────────────────────
  // Advance by COMPLETION, not by date: the current gameweek is the lowest
  // gw_number that is not yet fully finished. Once every fixture in a GW is FT
  // (is_finished = true, set above), we move to the next GW automatically —
  // even if that GW's date window hasn't opened yet (users pick for it).
  // Previously this was date-window based, which held a GW "current" until its
  // calendar window passed even though all its matches were already played.
  try {
    // Only consider gameweeks that actually HAVE fixtures — never advance to a
    // future gameweek whose fixtures don't exist yet (extra guard against the
    // empty-gameweek skip-ahead bug).
    const gwsWithFixtures = [...new Set(
      gwRows.filter(r => r.start_date != null).map(r => r.gw_number)
    )];

    const { data: unfinishedRows } = await supabase
      .from('gameweeks').select('gw_number')
      .eq('season', PSL_SEASON).eq('is_finished', false)
      .order('gw_number', { ascending: true });

    // first unfinished gameweek that also has fixtures
    let currentGwNum = (unfinishedRows || [])
      .map(r => r.gw_number)
      .find(n => gwsWithFixtures.includes(n)) ?? null;

    // If every gameweek with fixtures is finished (season over), stay on the last one.
    if (!currentGwNum && gwsWithFixtures.length > 0) {
      currentGwNum = Math.max(...gwsWithFixtures);
    }

    if (currentGwNum) {
      await supabase.from('gameweeks')
        .update({ is_current: false })
        .eq('season', PSL_SEASON).neq('gw_number', currentGwNum);

      const { error: setErr } = await supabase.from('gameweeks')
        .update({ is_current: true })
        .eq('season', PSL_SEASON).eq('gw_number', currentGwNum);

      if (setErr) log.push(`  ⚠️  Could not set is_current on GW${currentGwNum}: ${setErr.message}`);
      else        log.push(`  ✅ is_current set to GW${currentGwNum} (first unfinished gameweek)`);
    }
  } catch (e) {
    log.push(`  ⚠️  is_current auto-set failed: ${e.message}`);
  }

  log.push(`  ✅ Upserted ${upserted} fixtures`);
  return upserted;
}

// ─── Phase 2: Sync Match Player Stats ────────────────────────────────────
async function syncMatchStats(log, options = {}) {
  log.push('Phase 2: Fetching match player stats');

  let query = supabase
    .from('fixtures')
    .select('apifootball_fixture_id, api_fixture_id, gw_number, home_team_id, home_score, away_score, status, stats_synced')
    .eq('season', PSL_SEASON)
    .in('status', ['LIVE', '1H', '2H', 'HT', 'ET', 'P', 'PEN', 'FT']);

  if (options.gw)      query = query.eq('gw_number', options.gw);
  if (options.fixture) {
    // Support both column variants
    query = query.or(`apifootball_fixture_id.eq.${options.fixture},api_fixture_id.eq.${options.fixture}`);
  }

  const { data: allCandidates, error } = await query;
  if (error) throw new Error('Failed to fetch pending fixtures: ' + error.message);

  const pendingFixtures = (allCandidates || []).filter(f => {
    if (f.home_score === null && f.status !== 'LIVE') return false;
    // Always re-process LIVE fixtures; skip fully-synced FT ones unless forced
    if (f.status === 'FT' && f.stats_synced === true && !options.fixture) return false;
    return true;
  });

  log.push(`  Found ${pendingFixtures.length} fixtures needing stats`);

  let totalPlayers = 0;
  let totalErrors  = 0;

  for (const fixture of pendingFixtures) {
    // Use whichever column has the fixture ID
    const fixtureId = fixture.apifootball_fixture_id || fixture.api_fixture_id;
    if (!fixtureId) continue;

    try {
      log.push(`  Processing fixture ${fixtureId} (GW${fixture.gw_number})`);

      const data  = await apiFetch(`/fixtures/players?fixture=${fixtureId}`);
      const teams = data.response ?? [];

      if (teams.length === 0) {
        log.push(`    ⚠️  No player stats for fixture ${fixtureId}`);
        if (fixture.status === 'FT') {
          await supabase.from('fixtures')
            .update({ stats_synced: true, last_synced_at: new Date().toISOString() })
            .eq('apifootball_fixture_id', fixtureId);
        }
        continue;
      }

      const statRows = [];

      for (const team of teams) {
        const teamId = team.team?.id;

        for (const playerData of (team.players ?? [])) {
          const stats = playerData.statistics?.[0];
          if (!stats) continue;

          const mins     = stats.games?.minutes ?? 0;
          // Include substitutes who didn't play (mins === 0) only if explicitly subbed in
          if (mins === 0 && !stats.games?.substitute) continue;

          const posChar  = stats.games?.position?.charAt(0) ?? 'M';
          const { points, breakdown, cleanSheet } = calculateFantasyPoints(
            stats, posChar,
            fixture.home_score, fixture.away_score,
            teamId, fixture.home_team_id
          );

          // FIX: Update player injury status WITHOUT the `.is('photo', null)` guard
          // that was blocking all player updates in v1.
          const isInjured = playerData.player?.injured === true;
          await supabase.from('players')
            .update({ is_injured: isInjured, is_available: !isInjured })
            .eq('apifootball_id', playerData.player?.id);

          statRows.push({
            apifootball_fixture_id: fixtureId,
            apifootball_player_id:  playerData.player?.id,
            apifootball_team_id:    teamId,
            season:                 PSL_SEASON,
            gw_number:              fixture.gw_number,  // always write GW number
            player_name:            playerData.player?.name,
            position:               posChar,
            minutes_played:         mins,
            is_substitute:          stats.games?.substitute   ?? false,
            is_captain:             stats.games?.captain      ?? false,
            rating:                 parseFloat(stats.games?.rating ?? 0) || null,
            goals:                  stats.goals?.total        ?? 0,
            assists:                stats.goals?.assists       ?? 0,
            shots_total:            stats.shots?.total         ?? 0,
            shots_on_target:        stats.shots?.on            ?? 0,
            key_passes:             stats.passes?.key          ?? 0,
            offsides:               stats.offsides             ?? 0,
            saves:                  stats.goals?.saves         ?? 0,
            goals_conceded:         stats.goals?.conceded      ?? 0,
            penalties_saved:        stats.penalty?.saved       ?? 0,
            tackles:                stats.tackles?.total       ?? 0,
            blocks:                 stats.tackles?.blocks      ?? 0,
            interceptions:          stats.tackles?.interceptions ?? 0,
            passes_total:           stats.passes?.total        ?? 0,
            pass_accuracy:          parseInt(stats.passes?.accuracy ?? 0) || 0,
            duels_total:            stats.duels?.total         ?? 0,
            duels_won:              stats.duels?.won           ?? 0,
            dribbles_attempted:     stats.dribbles?.attempts   ?? 0,
            dribbles_success:       stats.dribbles?.success    ?? 0,
            yellow_cards:           stats.cards?.yellow        ?? 0,
            red_cards:              stats.cards?.red           ?? 0,
            fouls_committed:        stats.fouls?.committed     ?? 0,
            fouls_drawn:            stats.fouls?.drawn         ?? 0,
            penalties_scored:       stats.penalty?.scored      ?? 0,
            penalties_missed:       stats.penalty?.missed      ?? 0,
            clean_sheet:            cleanSheet,
            fantasy_points:         points,
            points_breakdown:       breakdown,
            updated_at:             new Date().toISOString(),
          });
        }
      }

      // Deduplicate by fixture+player composite key
      const seen = new Set();
      const dedupedRows = statRows.filter(row => {
        const key = `${row.apifootball_fixture_id}_${row.apifootball_player_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (dedupedRows.length > 0) {
        const { error: statsError } = await supabase
          .from('match_player_stats')
          .upsert(dedupedRows, { onConflict: 'apifootball_fixture_id,apifootball_player_id' });
        if (statsError) throw new Error('Stats upsert error: ' + statsError.message);
        totalPlayers += dedupedRows.length;
        log.push(`    ✅ ${dedupedRows.length} player stats saved`);
      }

      if (fixture.status === 'FT') {
        await supabase.from('fixtures')
          .update({ stats_synced: true, last_synced_at: new Date().toISOString() })
          .eq('apifootball_fixture_id', fixtureId);
      }

      await new Promise(r => setTimeout(r, 250));

    } catch (err) {
      log.push(`    ❌ Error on fixture ${fixtureId}: ${err.message}`);
      totalErrors++;
    }
  }

  log.push(`  ✅ Phase 2 complete: ${totalPlayers} player stats, ${totalErrors} errors`);
  return { totalPlayers, totalErrors };
}

// ─── Phase 3: Recalculate Season Totals ──────────────────────────────────
async function recalculateTotals(log) {
  log.push('Phase 3: Recalculating player season totals');

  const { data: aggregates, error: aggError } = await supabase
    .from('match_player_stats')
    .select('apifootball_player_id, fantasy_points, minutes_played, goals, assists, clean_sheet, saves, yellow_cards, red_cards, goals_conceded, rating')
    .eq('season', PSL_SEASON)
    .gt('minutes_played', 0);

  if (aggError) throw new Error('Aggregation error: ' + aggError.message);

  const playerMap = {};
  for (const row of (aggregates ?? [])) {
    const pid = row.apifootball_player_id;
    if (!playerMap[pid]) {
      playerMap[pid] = {
        appearances: 0, minutes_played: 0, goals: 0, assists: 0,
        clean_sheets: 0, saves: 0, yellow_cards: 0, red_cards: 0,
        goals_conceded: 0, total_points: 0, ratings: [],
      };
    }
    const p = playerMap[pid];
    p.appearances++;
    p.minutes_played  += row.minutes_played ?? 0;
    p.goals           += row.goals          ?? 0;
    p.assists         += row.assists        ?? 0;
    p.clean_sheets    += row.clean_sheet ? 1 : 0;
    p.saves           += row.saves          ?? 0;
    p.yellow_cards    += row.yellow_cards   ?? 0;
    p.red_cards       += row.red_cards      ?? 0;
    p.goals_conceded  += row.goals_conceded ?? 0;
    p.total_points    += row.fantasy_points ?? 0;
    if (row.rating) p.ratings.push(parseFloat(row.rating));
  }

  let updated = 0;
  const playerIds = Object.keys(playerMap);

  for (let i = 0; i < playerIds.length; i += 50) {
    const batch = playerIds.slice(i, i + 50);
    for (const pid of batch) {
      const agg       = playerMap[pid];
      const avgRating = agg.ratings.length > 0
        ? Math.round((agg.ratings.reduce((a, b) => a + b, 0) / agg.ratings.length) * 100) / 100
        : null;

      const { error } = await supabase.from('players')
        .update({
          appearances:    agg.appearances,
          apps:           agg.appearances,   // the stats page reads `apps`; keep it in sync
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

  // Recalculate profile points from gw_scores (already has captain/chip)
  const { data: profiles, error: profilesError } = await supabase
    .from('profiles').select('id, entry_gw');

  if (profilesError) {
    log.push('  ⚠️  Could not fetch profiles: ' + profilesError.message);
    return updated;
  }

  let profilesUpdated = 0;
  for (const profile of (profiles ?? [])) {
    try {
      const { data: gwScoreRows } = await supabase
        .from('gw_scores').select('points')
        .eq('user_id', profile.id)
        .gte('gameweek', profile.entry_gw || 1);

      const totalPoints = (gwScoreRows ?? []).reduce((sum, r) => sum + (r.points ?? 0), 0);

      if ((gwScoreRows ?? []).length > 0) {
        await supabase.from('profiles')
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

// ─── Phase 4: Injuries ────────────────────────────────────────────────────
async function syncInjuries(log) {
  log.push('Phase 4: Syncing injuries');
  try {
    const r = await fetch(
      `https://v3.football.api-sports.io/injuries?league=${PSL_LEAGUE}&season=${PSL_SEASON}`,
      { headers: { 'x-apisports-key': API_KEY } }
    );
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data     = await r.json();
    const injuries = data.response ?? [];
    log.push(`  Injury records: ${injuries.length}`);

    let updated = 0;
    for (const rec of injuries) {
      const pid = rec.player?.id;
      if (!pid) continue;
      const isOut = (rec.player?.type || '').toLowerCase().includes('miss');
      const { error } = await supabase.from('players')
        .update({
          is_injured:    isOut,
          is_available:  !isOut,
          injury_reason: rec.player?.reason || rec.player?.type || null,
          updated_at:    new Date().toISOString(),
        })
        .eq('apifootball_id', pid);
      if (!error) updated++;
    }
    log.push(`  ✅ Phase 4 complete: ${updated} player injury statuses updated`);
  } catch (err) {
    log.push(`  ⚠️  Phase 4 injuries failed: ${err.message} (non-fatal)`);
  }
}

// ─── Main Handler ──────────────────────────────────────────────────────────
// ─── Phase 5: Sync Players (import newly-added API-Football players) ──────
// Pulls each active club's squad from API-Football and inserts any player not
// already in our players table. Existing players are left untouched (their
// price/points are preserved) apart from a photo refresh. New players get a
// default price by position — adjust these to your economy if needed.
const POS_MAP = { Goalkeeper: 'GK', Defender: 'DEF', Midfielder: 'MID', Attacker: 'FWD' };
const DEFAULT_PRICE = { GK: 5.0, DEF: 5.5, MID: 6.0, FWD: 6.5 };

async function syncPlayers(log) {
  log.push('Phase 5: Syncing players (import new)');

  const { data: existing } = await supabase.from('players').select('apifootball_id');
  const known = new Set((existing || []).map(p => p.apifootball_id).filter(Boolean));

  const { data: teams } = await supabase.from('psl_teams')
    .select('name, apifootball_team_id').eq('is_active', true);
  const teamList = (teams || []).filter(t => t.apifootball_team_id);

  let inserted = 0, photos = 0, errors = 0;

  for (const team of teamList) {
    try {
      const data  = await apiFetch(`/players/squads?team=${team.apifootball_team_id}`);
      const squad = (data.response && data.response[0] && data.response[0].players) || [];
      for (const pl of squad) {
        const pos = POS_MAP[pl.position] || 'MID';
        if (known.has(pl.id)) {
          if (pl.photo) {
            await supabase.from('players')
              .update({ photo_url: pl.photo, photo: pl.photo })
              .eq('apifootball_id', pl.id);
            photos++;
          }
          continue;
        }
        const { error } = await supabase.from('players').insert({
          apifootball_id:      pl.id,
          apifootball_team_id: team.apifootball_team_id,
          api_id:              pl.id,
          api_player_id:       String(pl.id),
          display_name:        pl.name,
          position:            pos,
          price:               DEFAULT_PRICE[pos] || 6.0,
          team:                team.name,
          club:                team.name,
          photo_url:           pl.photo || null,
          photo:               pl.photo || null,
          is_available:        true,
          is_active:           true,
          total_points:        0,
          gw_points:           0,
          appearances:         0,
          apps:                0
        });
        if (error) { errors++; log.push(`    ⚠️ ${pl.name}: ${error.message}`); }
        else       { inserted++; known.add(pl.id); }
      }
    } catch (e) {
      errors++;
      log.push(`    ⚠️ ${team.name}: ${e.message}`);
    }
  }

  log.push(`  ✅ Phase 5 complete: ${inserted} new players, ${photos} photos refreshed, ${errors} errors`);
  return inserted;
}

module.exports = async (req, res) => {
  const VALID_SECRET = process.env.SYNC_SECRET || process.env.ADMIN_SECRET || '';
  const cronHeader   = req.headers['x-vercel-cron'];
  const adminKeyHdr  = req.headers['x-admin-key']    || '';
  const syncSecretHdr= req.headers['x-sync-secret']  || '';
  const authHeader   = req.headers['authorization']  || '';
  const secretParam  = req.query.secret              || '';

  const isAuthorized = cronHeader === '1'
    || (VALID_SECRET && adminKeyHdr   === VALID_SECRET)
    || (VALID_SECRET && syncSecretHdr === VALID_SECRET)
    || (VALID_SECRET && secretParam   === VALID_SECRET)
    || (VALID_SECRET && authHeader    === `Bearer ${VALID_SECRET}`)
    || (process.env.ADMIN_SECRET && adminKeyHdr === process.env.ADMIN_SECRET)
    || (process.env.ADMIN_SECRET && secretParam  === process.env.ADMIN_SECRET);

  if (!isAuthorized) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime     = Date.now();
  const log           = [];
  const phase         = req.query.phase   ? (req.query.phase === 'all' ? 'all' : parseInt(req.query.phase)) : 'all';
  const gwFilter      = req.query.gw      ? parseInt(req.query.gw)      : null;
  const fixtureFilter = req.query.fixture ? parseInt(req.query.fixture) : null;

  // ── Phase 0 = diagnostic ───────────────────────────────────────────────
  if (phase === 0) {
    const diagLog = [];
    diagLog.push('=== DIAGNOSTIC MODE ===');
    diagLog.push('APIFOOTBALL_KEY set: '      + !!API_KEY);
    diagLog.push('SUPABASE_URL set: '         + !!process.env.SUPABASE_URL);
    diagLog.push('SUPABASE_SERVICE_KEY set: ' + !!process.env.SUPABASE_SERVICE_KEY);
    diagLog.push('PSL_SEASON: ' + PSL_SEASON);
    try {
      const { count: mpsCount } = await supabase.from('match_player_stats').select('*', { count: 'exact', head: true });
      diagLog.push('match_player_stats rows: ' + mpsCount);
      const { count: fixCount } = await supabase.from('fixtures').select('*', { count: 'exact', head: true });
      diagLog.push('fixtures rows: ' + fixCount);
      const { data: ftFix } = await supabase.from('fixtures').select('apifootball_fixture_id,gw_number,status').eq('status','FT').limit(3);
      diagLog.push('Sample FT fixtures: ' + JSON.stringify(ftFix));
      const { data: gwRow } = await supabase.from('gameweeks').select('*').eq('is_current', true).limit(1);
      diagLog.push('Current gameweek: ' + JSON.stringify(gwRow));
      const { count: statsCount } = await supabase.from('match_player_stats').select('*', { count: 'exact', head: true }).gt('fantasy_points', 0);
      diagLog.push('match_player_stats rows with points > 0: ' + statsCount);
    } catch (e) {
      diagLog.push('DB error: ' + e.message);
    }
    return res.json({ success: true, diagnostic: true, log: diagLog });
  }

  log.push(`Starting sync at ${new Date().toISOString()}`);
  log.push(`Phase: ${phase} | GW: ${gwFilter ?? 'all'} | Fixture: ${fixtureFilter ?? 'all'} | Season: ${PSL_SEASON}`);

  let fixturesProcessed = 0;
  let playersUpdated    = 0;
  let errorsEncountered = 0;
  let status            = 'success';

  // Log sync start to sync_log table (non-fatal if table doesn't exist)
  let syncLogId;
  try {
    const { data: syncLogRow } = await supabase.from('sync_log')
      .insert({
        sync_type: phase === 'all' ? 'full' : `phase_${phase}`,
        season:    PSL_SEASON,
        gw_number: gwFilter,
        status:    'running',
        log:       [],
      })
      .select('id').single();
    syncLogId = syncLogRow?.id;
  } catch (_) {}

  try {
    if (phase === 'all' || phase === 0) await syncPlayerPhotos(log);
    if (phase === 'all' || phase === 1) fixturesProcessed = await syncFixtures(log);
    if (phase === 'all' || phase === 5) await syncPlayers(log);   // import new players BEFORE recalc
    if (phase === 'all' || phase === 2) {
      const result = await syncMatchStats(log, { gw: gwFilter, fixture: fixtureFilter });
      playersUpdated    = result.totalPlayers;
      errorsEncountered = result.totalErrors;
    }
    // Recalc runs for phase 3 AND automatically right after phase 2. Ingesting
    // match stats without re-summing them leaves the players table (and the
    // stats page) frozen on old numbers — so phase 2 always triggers the recalc
    // itself. This makes running phase 2 alone safe; you can't ingest stats
    // without the season totals updating.
    if (phase === 'all' || phase === 2 || phase === 3) {
      playersUpdated += await recalculateTotals(log);
    }
    if (phase === 'all' || phase === 4) await syncInjuries(log);
  } catch (err) {
    log.push('❌ Fatal error: ' + err.message);
    status = 'error';
    errorsEncountered++;
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  log.push(`\nSync complete in ${duration}s`);

  if (syncLogId) {
    await supabase.from('sync_log').update({
      status,
      fixtures_processed: fixturesProcessed,
      players_updated:    playersUpdated,
      errors_encountered: errorsEncountered,
      log,
      finished_at: new Date().toISOString(),
    }).eq('id', syncLogId);
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
