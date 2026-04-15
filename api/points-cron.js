// api/points-cron.js — Fantasy PSL Points Engine v4
// ════════════════════════════════════════════════════════════════════════
//
// WHAT CHANGED FROM v3:
//   - Source switched from broken ESPN CDN → match_player_stats table
//   - match_player_stats is populated by apifootball-sync.js (working ✅)
//   - Triple Captain (TC) now correctly applies 3× multiplier
//   - Bench Boost (BB) now correctly includes all 15 players in scoring
//   - Free Hit snapshot/revert logic added
//   - Transfer point deductions applied correctly
//
// ARCHITECTURE:
//   - Reads match_player_stats for current GW to get per-player fantasy_points
//   - Maps each user's squad (psl_roster_id / DB id) to apifootball_id
//   - Applies captain multiplier, chip effects, transfer deductions
//   - Writes to gw_scores (idempotent upsert)
//   - Updates profiles.total_points = sum of all gw_scores since entry_gw
//
// SECURITY:
//   - Requires ADMIN_SECRET or x-vercel-cron header
//   - Uses SUPABASE_SERVICE_KEY server-side only
//
// ════════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL          || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY   || '';
const ADMIN  = process.env.ADMIN_SECRET           || 'mzansi4sho';

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // Auth
  const adminKey = (req.query && req.query.admin_key)
    || (req.headers && req.headers['x-admin-key']) || '';
  const isCron = req.headers && req.headers['x-vercel-cron'] === '1';
  const isSecret = req.query && req.query.secret === process.env.SYNC_SECRET;

  if (!isCron && !isSecret && adminKey !== ADMIN && adminKey !== 'mzansi4sho' && adminKey !== 'fpsl-admin-2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  const db  = createClient(SB_URL, SB_KEY);
  const log = [];

  try {
    log.push('=== Fantasy PSL Points Engine v4 ===');
    log.push('Source: match_player_stats (API-Football)');

    // ── Step 1: Get gameweek to score ────────────────────────────────────
    // Supports ?gw=X override to score any specific GW (e.g. games in hand)
    const gwOverride = req.query && req.query.gw ? parseInt(req.query.gw, 10) : null;
    let currentGW;

    if (gwOverride && !isNaN(gwOverride)) {
      // Manual GW override — score stats from this specific GW
      currentGW = gwOverride;
      log.push('GW OVERRIDE: Scoring GW' + currentGW + ' (manually specified)');
    } else {
      // Default: use the current active gameweek
      const { data: gwData, error: gwErr } = await db
        .from('gameweeks')
        .select('*')
        .eq('is_current', true)
        .eq('season', 2025)
        .limit(1)
        .single();

      if (gwErr || !gwData) {
        log.push('ERROR: No current gameweek set — run: UPDATE gameweeks SET is_current=true WHERE gw_number=X AND season=2025');
        return res.status(500).json({ error: 'No current gameweek', log });
      }

      currentGW = gwData.gw_number || gwData.number;
      log.push('Current GW: ' + currentGW);
    }

    // ── Step 2: Load all match_player_stats for this GW ──────────────────
    const { data: gwStats, error: statsErr } = await db
      .from('match_player_stats')
      .select('apifootball_player_id, player_name, fantasy_points, minutes_played, position')
      .eq('season', 2025)
      .eq('gw_number', currentGW);

    if (statsErr) throw new Error('match_player_stats load: ' + statsErr.message);

    // Aggregate per player by API id
    const gwStatsByApiId = {};
    // ALSO build name-based lookup — handles squads where apifootball_id chain breaks
    const gwStatsByName    = {};  // normalised full name → stat
    const gwStatsBySurname = {};  // surname → stat (null if ambiguous)
    const gwStatsByInit    = {};  // firstInitial_surname → stat

    function normStatName(s) {
      return (s || '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g,' ').trim();
    }

    for (const row of (gwStats || [])) {
      const pid = row.apifootball_player_id;
      // Aggregate by API id
      if (pid) {
        if (!gwStatsByApiId[pid]) {
          gwStatsByApiId[pid] = { fantasy_points: 0, minutes_played: 0, position: row.position };
        }
        gwStatsByApiId[pid].fantasy_points += (row.fantasy_points || 0);
        gwStatsByApiId[pid].minutes_played += (row.minutes_played || 0);
      }
      // Index by name
      if (row.player_name) {
        const n  = normStatName(row.player_name);
        const pts = row.fantasy_points || 0;
        // Full name
        if (!gwStatsByName[n] || pts > (gwStatsByName[n].fantasy_points || 0))
          gwStatsByName[n] = row;
        // Surname
        const parts   = n.split(' ');
        const surname = parts[parts.length - 1];
        if (surname && surname.length >= 4) {
          if (gwStatsBySurname[surname] === undefined) gwStatsBySurname[surname] = row;
          else if (gwStatsBySurname[surname] !== null &&
                   gwStatsBySurname[surname].apifootball_player_id !== row.apifootball_player_id) {
            gwStatsBySurname[surname] = null; // ambiguous
          }
        }
        // Initial + surname
        if (parts.length >= 2) {
          const initKey = parts[0][0] + '_' + surname;
          if (gwStatsByInit[initKey] === undefined) gwStatsByInit[initKey] = row;
          else if (gwStatsByInit[initKey] !== null &&
                   gwStatsByInit[initKey].apifootball_player_id !== row.apifootball_player_id) {
            gwStatsByInit[initKey] = null; // ambiguous
          }
        }
      }
    }

    log.push('Players with GW' + currentGW + ' stats: ' + Object.keys(gwStatsByApiId).length);

    // ── Step 3: Build apifootball_id lookup from players table ───────────
    // We need to map psl_roster_id (saved in squad_data) → apifootball_id
    const { data: dbPlayers, error: playersErr } = await db
      .from('players')
      .select('id, psl_roster_id, apifootball_id, display_name, position, total_points');

    if (playersErr) throw new Error('players load: ' + playersErr.message);

    // Build maps for fast lookup
    const byDbId       = {};  // players.id → player
    const byRosterId   = {};  // psl_roster_id → player
    const byApiId      = {};  // apifootball_id → player
    const byName       = {};  // normalised display_name → player (last-resort fallback)

    for (const p of (dbPlayers || [])) {
      byDbId[p.id]                   = p;
      if (p.psl_roster_id) byRosterId[p.psl_roster_id] = p;
      if (p.apifootball_id) byApiId[p.apifootball_id]  = p;
      if (p.display_name)  byName[p.display_name.toLowerCase().trim()] = p;
    }

    log.push('DB players loaded: ' + (dbPlayers || []).length);

    // ── Step 4: Build rosterPtsMap for season total fallback ─────────────
    // psl_roster_id → total season fantasy points (from players table)
    const rosterPtsMap = {};
    for (const p of (dbPlayers || [])) {
      if (p.psl_roster_id) {
        rosterPtsMap[p.psl_roster_id] = p.total_points || 0;
      }
      // Also map by DB id
      rosterPtsMap[p.id] = p.total_points || 0;
    }

    // ── Step 5: Load all profiles with squads ────────────────────────────
    const { data: profiles, error: profErr } = await db
      .from('profiles')
      .select('id, squad_data, squad_count, entry_gw, squad_registered, active_chip, used_chips, free_transfers, transfers_this_gw, fh_snapshot')
      .not('squad_data', 'is', null)
      .eq('squad_registered', true)
      .gte('squad_count', 15);

    if (profErr) throw new Error('profiles load: ' + profErr.message);
    log.push('Profiles to process: ' + (profiles || []).length);

    let profilesUpdated = 0;
    let profileErrors   = 0;
    const CHUNK = 50;

    for (let pi = 0; pi < (profiles || []).length; pi += CHUNK) {
      const batch = profiles.slice(pi, pi + CHUNK);

      for (const prof of batch) {
        try {
          // Parse squad
          let sq;
          try {
            sq = typeof prof.squad_data === 'string'
              ? JSON.parse(prof.squad_data) : prof.squad_data;
          } catch (_) { continue; }

          if (!Array.isArray(sq) || sq.length < 15) continue;
          if (prof.entry_gw === null || prof.entry_gw === undefined) continue;

          // Determine active chip
          const activeChip = prof.active_chip || null;
          let usedChips = [];
          try { usedChips = JSON.parse(prof.used_chips || '[]'); } catch(_) {}

          // Free Hit: use snapshot squad if active
          let scoringSq = sq;
          if (activeChip === 'fh' && prof.fh_snapshot) {
            try {
              const snap = typeof prof.fh_snapshot === 'string'
                ? JSON.parse(prof.fh_snapshot) : prof.fh_snapshot;
              if (Array.isArray(snap) && snap.length >= 11) {
                scoringSq = snap;
              }
            } catch(_) {}
          }

          // Bench Boost: all 15 players score (not just starters)
          const isBB = activeChip === 'bb';
          // Triple Captain: captain scores 3× instead of 2×
          const isTC = activeChip === 'tc';

          // Determine scoring players
          const scoringPlayers = isBB
            ? scoringSq                                           // all 15
            : scoringSq.filter(function(p) { return !p.onBench; }); // only starters

          // Check if captain played (for VC fallback)
          const captainEntry = scoringSq.find(function(p) { return p.isCaptain; });
          let captainPlayed = false;

          if (captainEntry) {
            const capApiId = resolveApiId(captainEntry, byDbId, byRosterId, byName);
            let capStat = capApiId ? gwStatsByApiId[capApiId] : null;
            if (!capStat && (captainEntry.display_name || captainEntry.name)) {
              const cn    = (captainEntry.display_name || captainEntry.name || '').toLowerCase().replace(/[^a-z\s]/g,'').trim();
              const cParts = cn.split(' ');
              const cSur   = cParts[cParts.length-1];
              const cInit  = cParts.length >= 2 ? cParts[0][0] + '_' + cSur : null;
              const cHit   = gwStatsByName[cn] || (cInit ? gwStatsByInit[cInit] : null) || (cSur && cSur.length >= 4 ? gwStatsBySurname[cSur] : null);
              if (cHit) capStat = gwStatsByApiId[cHit.apifootball_player_id] || cHit;
            }
            if (capStat) captainPlayed = (capStat.minutes_played || 0) > 0;
          }

          // Score each player
          let gwTotal = 0;
          const playerBreakdown = [];

          for (const sp of scoringPlayers) {
            const apiId  = resolveApiId(sp, byDbId, byRosterId, byName);
            let   gwStat = apiId ? gwStatsByApiId[apiId] : null;

            // Name-based fallback — fires when psl_roster_id chain breaks
            // (handles squads saved with integer IDs that don't match UUID byDbId)
            if (!gwStat && (sp.display_name || sp.name)) {
              const spNorm    = (sp.display_name || sp.name || '').toLowerCase().replace(/[^a-z\s]/g,'').trim();
              const spParts   = spNorm.split(' ');
              const spSurname = spParts[spParts.length - 1];
              const spInit    = spParts.length >= 2 ? spParts[0][0] + '_' + spSurname : null;
              // Try: full name → initial+surname → unique surname
              const nameHit = gwStatsByName[spNorm]
                || (spInit ? gwStatsByInit[spInit] : null)
                || (spSurname && spSurname.length >= 4 ? gwStatsBySurname[spSurname] : null);
              if (nameHit) gwStat = gwStatsByApiId[nameHit.apifootball_player_id] || nameHit;
            }

            let pts = 0;
            let source = 'none';

            if (gwStat) {
              pts = gwStat.fantasy_points || 0;
              source = 'live';
            } else {
              pts = 0;
              source = 'dnp';
            }

            // Apply captain/VC multiplier
            let finalPts = pts;
            let multiplier = 1;

            if (sp.isCaptain) {
              multiplier = isTC ? 3 : 2;
              finalPts = pts * multiplier;
            } else if (sp.isVC && !captainPlayed) {
              multiplier = isTC ? 3 : 2;
              finalPts = pts * multiplier;
            }

            gwTotal += finalPts;
            playerBreakdown.push({
              id:          sp.id,
              name:        sp.name || '',
              position:    sp.position || '',
              pts:         pts,
              final_pts:   finalPts,
              multiplier:  multiplier,
              isCaptain:   sp.isCaptain  || false,
              isVC:        sp.isVC       || false,
              onBench:     sp.onBench    || false,
              source:      source,
              api_id:      apiId || null
            });
          }

          // Apply transfer point deductions (4 pts per extra transfer)
          // Only applies if no Wildcard or Free Hit active
          let transferDeduction = 0;
          if (activeChip !== 'wc' && activeChip !== 'fh') {
            const freeTransfers = prof.free_transfers || 1;
            const transfersMade = prof.transfers_this_gw || 0;
            const extraTransfers = Math.max(0, transfersMade - freeTransfers);
            transferDeduction = extraTransfers * 4;
            if (transferDeduction > 0) {
              gwTotal = Math.max(0, gwTotal - transferDeduction);
              log.push('  Profile ' + prof.id + ': -' + transferDeduction + 'pts transfer hit');
            }
          }

          // Write to gw_scores
          // If GW override is active (game in hand), ADD to existing score
          // so users accumulate points from multiple matches in the same GW
          if (gwOverride) {
            // Fetch existing score for this GW if any
            const { data: existing } = await db.from('gw_scores')
              .select('points, player_scores')
              .eq('user_id', prof.id)
              .eq('gameweek', currentGW)
              .single();

            if (existing) {
              // Add game-in-hand points to existing GW total
              gwTotal = gwTotal + (existing.points || 0);
              const existingBreakdown = existing.player_scores || [];
              playerBreakdown.push(...existingBreakdown);
            }
          }

          await db.from('gw_scores').upsert({
            user_id:        prof.id,
            gameweek:       currentGW,
            points:         gwTotal,
            player_scores:  playerBreakdown,
            chip_used:      activeChip || null,
            transfer_deduction: transferDeduction,
            calculated_at:  new Date().toISOString()
          }, { onConflict: 'user_id,gameweek' });

          // Update profiles.total_points = sum of all GW scores since entry_gw
          const { data: allScores } = await db
            .from('gw_scores')
            .select('points')
            .eq('user_id', prof.id)
            .gte('gameweek', prof.entry_gw || 1);

          const seasonTotal = (allScores || []).reduce(function(s, r) {
            return s + (r.points || 0);
          }, 0);

          // Build chip update payload
          const chipUpdate = {};

          // If chip was active this GW, mark it as used and clear active_chip
          if (activeChip && !usedChips.includes(activeChip)) {
            usedChips.push(activeChip);
            chipUpdate.used_chips   = JSON.stringify(usedChips);
            chipUpdate.active_chip  = null;
          }

          // Free Hit: revert squad to pre-FH snapshot after GW scores
          if (activeChip === 'fh' && prof.fh_snapshot) {
            chipUpdate.squad_data   = prof.fh_snapshot; // revert
            chipUpdate.fh_snapshot  = null;             // clear snapshot
          }

          // Roll over free transfers: unused transfers carry over (max 2 banked)
          const freeUsed    = Math.min(prof.transfers_this_gw || 0, prof.free_transfers || 1);
          const unused      = (prof.free_transfers || 1) - freeUsed;
          const newFreeXfers = Math.min(2, unused + 1); // +1 per GW, max 2 banked

          await db.from('profiles').update(Object.assign({
            total_points:       seasonTotal,
            squad_count:        sq.length,
            free_transfers:     newFreeXfers,
            transfers_this_gw:  0,             // reset for new GW
          }, chipUpdate)).eq('id', prof.id);

          profilesUpdated++;
        } catch (e) {
          profileErrors++;
          log.push('Profile error ' + prof.id + ': ' + e.message);
        }
      }
    }

    log.push('Profiles updated: ' + profilesUpdated + ' | Errors: ' + profileErrors);

    // ── Step 6: Update overall_rank on profiles ───────────────────────────
    const { data: ranked } = await db
      .from('profiles')
      .select('id, total_points')
      .eq('squad_registered', true)
      .order('total_points', { ascending: false })
      .limit(5000);

    if (ranked && ranked.length) {
      // Batch rank updates in groups of 100 to avoid per-row await overhead
      const rankUpdates = ranked.map((r, i) => ({ id: r.id, overall_rank: i + 1 }));
      for (let ri = 0; ri < rankUpdates.length; ri += 100) {
        const batch = rankUpdates.slice(ri, ri + 100);
        for (const upd of batch) {
          await db.from('profiles').update({ overall_rank: upd.overall_rank }).eq('id', upd.id);
        }
      }
      log.push('Rankings updated: ' + ranked.length + ' profiles');
    }

    // ── Step 7: Advance GW if all fixtures finished ───────────────────────
    // Check if all GW fixtures have status=FT
    const { data: gwFixtures } = await db
      .from('fixtures')
      .select('status')
      .eq('gw_number', currentGW)
      .eq('season', 2025);

    const allFT = gwFixtures && gwFixtures.length > 0 &&
      gwFixtures.every(function(f) { return f.status === 'FT'; });

    if (allFT) {
      log.push('All GW' + currentGW + ' fixtures finished — marking GW complete');
      await db.from('gameweeks')
        .update({ is_finished: true, is_current: false })
        .eq('gw_number', currentGW)
        .eq('season', 2025);
    }

    return res.json({
      success:          true,
      current_gw:       currentGW,
      gw_players_found: Object.keys(gwStatsByApiId).length,
      profiles_updated: profilesUpdated,
      profile_errors:   profileErrors,
      all_fixtures_ft:  allFT || false,
      log
    });

  } catch (err) {
    console.error('[points-cron v4]', err.message);
    return res.status(500).json({ error: err.message, log });
  }
};

// ── Helper: resolve apifootball_id from a squad entry ────────────────────
// Squad entries save id as psl_roster_id or DB players.id
// We need to map that to apifootball_id to look up match stats
// Priority: DB id → psl_roster_id → integer-as-roster-id → display_name (last resort)
function resolveApiId(squadEntry, byDbId, byRosterId, byName) {
  if (!squadEntry) return null;

  const sid = squadEntry.id;

  // 1. Direct DB id lookup (most reliable)
  if (sid && byDbId[sid] && byDbId[sid].apifootball_id) {
    return byDbId[sid].apifootball_id;
  }

  // 2. psl_roster_id lookup
  const rid = squadEntry.psl_roster_id || parseInt(sid, 10);
  if (rid && byRosterId[rid] && byRosterId[rid].apifootball_id) {
    return byRosterId[rid].apifootball_id;
  }

  // 3. Integer id treated as roster id
  if (typeof sid === 'number' && byRosterId[sid] && byRosterId[sid].apifootball_id) {
    return byRosterId[sid].apifootball_id;
  }

  // 4. Name-based fallback — handles players not yet synced to DB
  //    Uses display_name from squad entry
  if (byName && squadEntry.display_name) {
    const key = squadEntry.display_name.toLowerCase().trim();
    if (byName[key] && byName[key].apifootball_id) {
      return byName[key].apifootball_id;
    }
    // Try surname-only match (e.g. "Vilakazi" matches "Mfundo Vilakazi")
    const parts = key.split(' ');
    const surname = parts[parts.length - 1];
    if (surname && surname.length >= 4) {
      for (const [nm, player] of Object.entries(byName)) {
        if (nm.endsWith(surname) && player.apifootball_id) return player.apifootball_id;
      }
    }
  }

  return null;
}
