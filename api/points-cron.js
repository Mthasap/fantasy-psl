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
//   - STRICT name matching applied to fix incorrect scoring
//   - Lightning-fast Parallel Ranking Updates added
//
// ════════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL          || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY   || '';
const ADMIN  = process.env.ADMIN_SECRET;

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // Auth
  const adminKey = (req.query && req.query.admin_key)
    || (req.headers && req.headers['x-admin-key']) || '';
  const isCron   = req.headers && req.headers['x-vercel-cron'] === '1';
  // Accept secret via header (preferred) OR query param (legacy admin panel support)
  // Also accept the admin key itself as the secret so one key covers both endpoints
  const syncSecretHeader = (req.headers && req.headers['x-sync-secret']) || '';
  const secretParam      = (req.query  && req.query.secret)              || '';
  const SYNC             = process.env.SYNC_SECRET || process.env.ADMIN_SECRET || '';
  const isSecret = SYNC && (
    syncSecretHeader === SYNC ||
    secretParam      === SYNC ||
    secretParam      === process.env.ADMIN_SECRET   // admin key doubles as secret
  );

  if (!isCron && !isSecret && adminKey !== ADMIN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  const db  = createClient(SB_URL, SB_KEY);
  const log = [];

  // Dry-run mode — just confirms auth works, does nothing else
  if (req.query && req.query.dry_run === '1') {
    return res.json({ success: true, message: 'Auth OK — ready to score', log: ['Auth check passed'] });
  }

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
    // Name-based strict lookup
    const gwStatsByName  = {};  

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
      // Index by raw name AND normalised name for maximum matching resilience
      if (row.player_name) {
        const rawKey  = row.player_name.toLowerCase().trim();
        const normKey = normStatName(row.player_name);
        const pts     = row.fantasy_points || 0;
        if (!gwStatsByName[rawKey]  || pts > (gwStatsByName[rawKey].fantasy_points  || 0)) gwStatsByName[rawKey]  = row;
        if (!gwStatsByName[normKey] || pts > (gwStatsByName[normKey].fantasy_points || 0)) gwStatsByName[normKey] = row;
      }
    }

    log.push('Players with GW' + currentGW + ' stats: ' + Object.keys(gwStatsByApiId).length);

    // ── Step 3: Build apifootball_id lookup from players table ───────────
    const { data: dbPlayers, error: playersErr } = await db
      .from('players')
      .select('id, psl_roster_id, apifootball_id, display_name, position, total_points');

    if (playersErr) throw new Error('players load: ' + playersErr.message);

    // Build maps for fast lookup
    // IMPORTANT: byDbId is keyed by Supabase UUID.
    // Squad entries save psl_roster_id as their 'id' field (integer), NOT the UUID.
    // So byDbId[squadEntry.id] will NEVER match. Use byRosterId for integer IDs.
    const byDbId     = {};   // UUID → player (for UUID-based squad entries)
    const byRosterId = {};   // psl_roster_id integer → player
    const byApiId    = {};   // apifootball_id → player
    const byName     = {};   // normalised name → player (both display_name AND name)

    function normName(s) {
      return (s || '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    }

    for (const p of (dbPlayers || [])) {
      byDbId[p.id] = p;
      if (p.psl_roster_id) byRosterId[p.psl_roster_id] = p;
      if (p.apifootball_id) byApiId[p.apifootball_id]  = p;
      if (p.display_name) {
        byName[p.display_name.toLowerCase().trim()] = p;
        byName[normName(p.display_name)]             = p;
      }
    }

    log.push('DB players loaded: ' + (dbPlayers || []).length);

    // ── Step 4: Build rosterPtsMap for season total fallback ─────────────
    const rosterPtsMap = {};
    for (const p of (dbPlayers || [])) {
      if (p.psl_roster_id) {
        rosterPtsMap[p.psl_roster_id] = p.total_points || 0;
      }
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
          if (prof.entry_gw && currentGW <= prof.entry_gw) {
            await db.from('gw_scores').upsert({
              user_id:        prof.id,
              gameweek:       currentGW,
              points:         0,
              player_scores:  [],
              chip_used:      null,
              transfer_deduction: 0,
              calculated_at:  new Date().toISOString()
            }, { onConflict: 'user_id,gameweek' });
            
            profilesUpdated++;
            continue; 
          }

          let sq;
          try {
            sq = typeof prof.squad_data === 'string'
              ? JSON.parse(prof.squad_data) : prof.squad_data;
          } catch (_) { continue; }

          if (!Array.isArray(sq)) continue;

          const validPlayers = sq.filter(p => p && (p.id || p.psl_roster_id || p.apifootball_id || p.name));
          
          if (validPlayers.length !== 15) {
            log.push(`Profile ${prof.id} skipped: Incomplete squad (${validPlayers.length}/15)`);
            continue; 
          }

          // Auto-heal: if entry_gw was never recorded (race condition during signup),
          // assign the current GW now so this user starts scoring and appears in rankings.
          if (prof.entry_gw === null || prof.entry_gw === undefined) {
            try {
              await db.from('profiles').update({
                entry_gw:            currentGW,
                squad_registered_at: new Date().toISOString()
              }).eq('id', prof.id);
              prof.entry_gw = currentGW;
              log.push('Auto-set entry_gw=' + currentGW + ' for profile ' + prof.id);
            } catch (e) {
              log.push('Could not auto-set entry_gw for ' + prof.id + ': ' + e.message);
              continue;
            }
          }

          const activeChip = prof.active_chip || null;
          let usedChips = [];
          try { usedChips = JSON.parse(prof.used_chips || '[]'); } catch(_) {}

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

          const isBB = activeChip === 'bb';
          const isTC = activeChip === 'tc';

          const scoringPlayers = isBB
            ? scoringSq                                           
            : scoringSq.filter(function(p) { return !p.onBench; }); 

          const captainEntry = scoringSq.find(function(p) { return p.isCaptain; });
          let captainPlayed = false;

          if (captainEntry) {
            const capApiId = resolveApiId(captainEntry, byDbId, byRosterId, byName);
            let capStat = capApiId ? gwStatsByApiId[capApiId] : null;
            
            // Captain name fallback — check 'name' and 'display_name', normalised
            if (!capStat) {
              const _nn = function(s){ return (s||'').toLowerCase().replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim(); };
              for (const cn of [captainEntry.name, captainEntry.display_name].filter(Boolean)) {
                let cHit = gwStatsByName[cn.toLowerCase().trim()] || gwStatsByName[_nn(cn)];
                if (cHit) { capStat = gwStatsByApiId[cHit.apifootball_player_id] || cHit; break; }
              }
            }
            if (capStat) captainPlayed = (capStat.minutes_played || 0) > 0;
          }

          let gwTotal = 0;
          const playerBreakdown = [];

          for (const sp of scoringPlayers) {
            const apiId  = resolveApiId(sp, byDbId, byRosterId, byName);
            let   gwStat = apiId ? gwStatsByApiId[apiId] : null;

            // Name fallback — check 'name' (squad field) AND 'display_name', raw + normalised
            if (!gwStat) {
              const _nn = function(s){ return (s||'').toLowerCase().replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim(); };
              for (const rawN of [sp.name, sp.display_name].filter(Boolean)) {
                let hit = gwStatsByName[rawN.toLowerCase().trim()] || gwStatsByName[_nn(rawN)];
                if (hit) { gwStat = gwStatsByApiId[hit.apifootball_player_id] || hit; break; }
              }
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

          if (gwOverride) {
            const { data: existing } = await db.from('gw_scores')
              .select('points, player_scores')
              .eq('user_id', prof.id)
              .eq('gameweek', currentGW)
              .single();

            if (existing) {
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

          const { data: allScores } = await db
            .from('gw_scores')
            .select('points')
            .eq('user_id', prof.id)
            .gte('gameweek', prof.entry_gw || 1);

          const seasonTotal = (allScores || []).reduce(function(s, r) {
            return s + (r.points || 0);
          }, 0);

          const chipUpdate = {};

          if (activeChip && !usedChips.includes(activeChip)) {
            usedChips.push(activeChip);
            chipUpdate.used_chips   = JSON.stringify(usedChips);
            chipUpdate.active_chip  = null;
          }

          if (activeChip === 'fh' && prof.fh_snapshot) {
            chipUpdate.squad_data   = prof.fh_snapshot; 
            chipUpdate.fh_snapshot  = null;             
          }

          const freeUsed    = Math.min(prof.transfers_this_gw || 0, prof.free_transfers || 1);
          const unused      = (prof.free_transfers || 1) - freeUsed;
          const newFreeXfers = Math.min(2, unused + 1); 

          // gw_points MUST be written here — the only place that updates
          // the current-GW display value. Without it the profile always shows
          // the previous GW's points (root cause of the stale-points bug).
          await db.from('profiles').update(Object.assign({
            total_points:       seasonTotal,
            gw_points:          gwTotal,
            squad_count:        sq.length,
            free_transfers:     newFreeXfers,
            transfers_this_gw:  0,
          }, chipUpdate)).eq('id', prof.id);

          profilesUpdated++;
        } catch (e) {
          profileErrors++;
          log.push('Profile error ' + prof.id + ': ' + e.message);
        }
      }
    }

    log.push('Profiles updated: ' + profilesUpdated + ' | Errors: ' + profileErrors);

    // ── Step 6: Update overall_rank on profiles (FAST PARALLEL BATCHING) ──
    const { data: ranked } = await db
      .from('profiles')
      .select('id, total_points')
      .eq('squad_registered', true)
      .order('total_points', { ascending: false })
      .limit(5000);

    if (ranked && ranked.length) {
      const rankUpdates = ranked.map((r, i) => ({ id: r.id, overall_rank: i + 1 }));
      
      // Process in chunks of 50 simultaneously to beat Vercel timeouts
      for (let ri = 0; ri < rankUpdates.length; ri += 50) {
        const batch = rankUpdates.slice(ri, ri + 50);
        await Promise.all(batch.map(upd => 
          db.from('profiles').update({ overall_rank: upd.overall_rank }).eq('id', upd.id)
        ));
      }
      log.push('Rankings updated lightning-fast: ' + ranked.length + ' profiles');
    }

    // ── Step 7: Advance GW if all fixtures finished ───────────────────────
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

// ── Helper: STRICT resolve apifootball_id from a squad entry ─────────────
// Priority: DB id → psl_roster_id → integer-as-roster-id → exact display_name
function resolveApiId(squadEntry, byDbId, byRosterId, byName) {
  if (!squadEntry) return null;

  const sid = squadEntry.id;
  function nn(s) { return (s||'').toLowerCase().replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim(); }

  // 1. psl_roster_id (integer) lookup — squad.id is stored as psl_roster_id not UUID
  const rosterId = squadEntry.psl_roster_id
    || (typeof sid === 'number' && sid > 0 ? sid : null)
    || (typeof sid === 'string' && !isNaN(parseInt(sid,10)) && parseInt(sid,10) > 0 ? parseInt(sid,10) : null);
  if (rosterId && byRosterId[rosterId] && byRosterId[rosterId].apifootball_id) {
    return byRosterId[rosterId].apifootball_id;
  }

  // 2. UUID lookup (only if id is a UUID string)
  if (typeof sid === 'string' && sid.includes('-') && byDbId[sid] && byDbId[sid].apifootball_id) {
    return byDbId[sid].apifootball_id;
  }

  // 3. Name fallback — squad saves 'name' field (= display_name from players table)
  const names = [squadEntry.name, squadEntry.display_name].filter(Boolean);
  for (const n of names) {
    const raw  = n.toLowerCase().trim();
    const norm = nn(n);
    const hit  = byName[raw] || byName[norm];
    if (hit && hit.apifootball_id) return hit.apifootball_id;
  }

  return null;
}
