/**
 * Fantasy PSL — Player ID Mapping Script
 * ========================================
 * File: /api/map-player-ids.js
 *
 * Matches your existing players table to API-Football player IDs
 * using two strategies:
 *
 * Strategy 1 — Exact name match (fast, reliable)
 *   Matches display_name in players table against player_name
 *   in match_player_stats
 *
 * Strategy 2 — Fuzzy name match (catches abbreviations & variations)
 *   e.g. "D. Johnson" matches "Darren Johnson"
 *        "T. Kutumela" matches "Thabiso Kutumela"
 *
 * Strategy 3 — Team + position match for remaining unmatched players
 *   Last resort, flags for manual review
 *
 * Usage:
 *   GET /api/map-player-ids?secret=mzansi4show           → dry run (shows matches, no DB writes)
 *   GET /api/map-player-ids?secret=mzansi4show&apply=true → applies matches to DB
 *   GET /api/map-player-ids?secret=mzansi4show&apply=true&team=AmaZulu → one team only
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Team name mapping ────────────────────────────────────────────────────────
// Maps your players.team strings to API-Football team IDs
const TEAM_ID_MAP = {
  'Orlando Pirates':    2700,
  'Mamelodi Sundowns':  2699,
  'Kaizer Chiefs':      2691,
  'AmaZulu':            2669,
  'Amazulu':            2669,
  'Cape Town City':     2697,
  'Stellenbosch':       4905,
  'Sekhukhune United':  15537,
  'Golden Arrows':      2690,
  'TS Galaxy':          8074,
  'Richards Bay':       10567,
  'Chippa United':      2698,
  'Polokwane City':     2693,
  'Marumo Gallants':    2682,
  'Supersport United':  2694,
  'Royal AM':           10566,
  'Orbit College':      10582,
  'Magesi':             19999,
  'Magesi FC':          19999,
  'Casric Stars':       19997,
  // 2025 season teams
  'Durban City':        null,
  'Siwelele':           null,
};

// ─── Name normalisation ───────────────────────────────────────────────────────
function normaliseName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/[^a-z\s]/g, '')        // keep only letters and spaces
    .trim();
}

// Extract last name (last word) for fuzzy matching
function lastName(name) {
  const parts = normaliseName(name).split(/\s+/);
  return parts[parts.length - 1];
}

// Extract first initial
function firstInitial(name) {
  const parts = normaliseName(name).split(/\s+/);
  return parts[0]?.[0] ?? '';
}

// Check if abbreviated name matches full name
// e.g. "D. Johnson" matches "Darren Johnson"
// e.g. "T. Kutumela" matches "Thabiso Kutumela"
function abbreviationMatches(shortName, fullName) {
  const shortNorm = normaliseName(shortName);
  const fullNorm  = normaliseName(fullName);

  // Direct contains check
  if (fullNorm.includes(shortNorm) || shortNorm.includes(fullNorm)) return true;

  // Initial + last name check
  const shortParts = shortNorm.split(/\s+/);
  const fullParts  = fullNorm.split(/\s+/);

  if (shortParts.length >= 2 && fullParts.length >= 2) {
    const shortInitial  = shortParts[0][0];
    const shortLastName = shortParts[shortParts.length - 1];
    const fullInitial   = fullParts[0][0];
    const fullLastName  = fullParts[fullParts.length - 1];

    if (shortInitial === fullInitial && shortLastName === fullLastName) return true;
  }

  return false;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const isAuthorized = req.query.secret === process.env.SYNC_SECRET;
  if (!isAuthorized) return res.status(401).json({ error: 'Unauthorized' });

  const applyChanges = req.query.apply === 'true';
  const teamFilter   = req.query.team ?? null;

  const results = {
    matched_exact:   [],
    matched_fuzzy:   [],
    unmatched:       [],
    already_mapped:  [],
    applied:         0,
  };

  // ── Step 1: Fetch all players from your DB ──────────────────────────────────
  let playersQuery = supabase
    .from('players')
    .select('id, display_name, psl_roster_id, apifootball_id, apifootball_team_id, team');

  if (teamFilter) playersQuery = playersQuery.eq('team', teamFilter);

  const { data: players, error: playersError } = await playersQuery;
  if (playersError) return res.status(500).json({ error: playersError.message });

  // ── Step 2: Fetch all unique players from match_player_stats ───────────────
  // This gives us the ground truth: API-Football player IDs + names + team IDs
  const { data: statsPlayers, error: statsError } = await supabase
    .from('match_player_stats')
    .select('apifootball_player_id, player_name, apifootball_team_id, position')
    .eq('season', 2025);

  if (statsError) return res.status(500).json({ error: statsError.message });

  // Deduplicate stats players — one entry per player ID
  const apiPlayerMap = {};
  for (const row of statsPlayers) {
    const pid = row.apifootball_player_id;
    if (!apiPlayerMap[pid]) {
      apiPlayerMap[pid] = {
        apifootball_player_id: pid,
        player_name:           row.player_name,
        apifootball_team_id:   row.apifootball_team_id,
        position:              row.position,
      };
    }
  }
  const apiPlayers = Object.values(apiPlayerMap);

  // ── Step 3: Match each DB player to an API-Football player ─────────────────
  for (const player of players) {
    // Skip already mapped
    if (player.apifootball_id) {
      results.already_mapped.push({
        psl_roster_id: player.psl_roster_id,
        display_name:  player.display_name,
        apifootball_id: player.apifootball_id,
      });
      continue;
    }

    const teamId = TEAM_ID_MAP[player.team];
    const displayName = player.display_name ?? '';

    // Filter API players to same team if we know the team ID
    const teamApiPlayers = teamId
      ? apiPlayers.filter(p => p.apifootball_team_id === teamId)
      : apiPlayers;

    // Strategy 1: Exact name match (case-insensitive, normalised)
    const normDisplay = normaliseName(displayName);
    let match = teamApiPlayers.find(p =>
      normaliseName(p.player_name) === normDisplay
    );

    if (match) {
      results.matched_exact.push({
        psl_roster_id:         player.psl_roster_id,
        db_id:                 player.id,
        display_name:          displayName,
        api_name:              match.player_name,
        apifootball_player_id: match.apifootball_player_id,
        apifootball_team_id:   match.apifootball_team_id,
        strategy:              'exact',
      });
      continue;
    }

    // Strategy 2: Fuzzy / abbreviation match
    match = teamApiPlayers.find(p =>
      abbreviationMatches(displayName, p.player_name) ||
      abbreviationMatches(p.player_name, displayName)
    );

    if (match) {
      results.matched_fuzzy.push({
        psl_roster_id:         player.psl_roster_id,
        db_id:                 player.id,
        display_name:          displayName,
        api_name:              match.player_name,
        apifootball_player_id: match.apifootball_player_id,
        apifootball_team_id:   match.apifootball_team_id,
        strategy:              'fuzzy',
      });
      continue;
    }

    // Strategy 3: Last name only match within same team
    const displayLast = lastName(displayName);
    if (displayLast.length > 2) {
      match = teamApiPlayers.find(p => lastName(p.player_name) === displayLast);
      if (match) {
        results.matched_fuzzy.push({
          psl_roster_id:         player.psl_roster_id,
          db_id:                 player.id,
          display_name:          displayName,
          api_name:              match.player_name,
          apifootball_player_id: match.apifootball_player_id,
          apifootball_team_id:   match.apifootball_team_id,
          strategy:              'last_name',
        });
        continue;
      }
    }

    // No match found
    results.unmatched.push({
      psl_roster_id: player.psl_roster_id,
      db_id:         player.id,
      display_name:  displayName,
      team:          player.team,
      team_id:       teamId ?? 'unknown',
    });
  }

  // ── Step 4: Apply matches to DB if requested ────────────────────────────────
  if (applyChanges) {
    const allMatches = [...results.matched_exact, ...results.matched_fuzzy];

    for (const match of allMatches) {
      const { error } = await supabase
        .from('players')
        .update({
          apifootball_id:      match.apifootball_player_id,
          apifootball_team_id: match.apifootball_team_id,
          updated_at:          new Date().toISOString(),
        })
        .eq('id', match.db_id);

      if (!error) results.applied++;
    }
  }

  // ── Response ────────────────────────────────────────────────────────────────
  return res.status(200).json({
    summary: {
      total_players:    players.length,
      already_mapped:   results.already_mapped.length,
      matched_exact:    results.matched_exact.length,
      matched_fuzzy:    results.matched_fuzzy.length,
      unmatched:        results.unmatched.length,
      applied_to_db:    results.applied,
      dry_run:          !applyChanges,
    },
    // Fuzzy matches shown for review — check these are correct before applying
    fuzzy_matches_to_review: results.matched_fuzzy,
    // Unmatched players need manual linking
    unmatched_players: results.unmatched,
    // Exact matches — safe, no review needed
    exact_matches: results.matched_exact,
  });
};
