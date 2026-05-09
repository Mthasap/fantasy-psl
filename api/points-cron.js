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

  if (req.query && req.query.dry_run === '1') {
    return res.json({ success: true, message: 'Auth OK', log: ['Auth check passed'] });
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
    // STRATEGY: Do NOT rely on gw_number in match_player_stats — apifootball-sync
    // may not write it.  Instead, get fixture IDs for this GW from the fixtures
    // table and filter match_player_stats by those IDs.  Fall back to gw_number
    // filter if no fixture IDs are found (belt-and-suspenders).

    // 2a. Get all fixture IDs for the current GW
    const { data: gwFixtureRows } = await db
      .from('fixtures')
      .select('api_fixture_id, id')
      .eq('gw_number', currentGW);

    const fixtureApiIds = (gwFixtureRows || [])
      .map(function(r) { return r.api_fixture_id; })
      .filter(Boolean);

    log.push('GW' + currentGW + ' fixture IDs: ' + (fixtureApiIds.length ? fixtureApiIds.join(', ') : 'none found'));

    let gwStats, statsErr;

    if (fixtureApiIds.length > 0) {
      // Primary: filter by fixture IDs — works even when gw_number is NULL in stats table
      const r = await db
        .from('match_player_stats')
        .select('apifootball_player_id, player_name, fantasy_points, minutes_played, position, apifootball_fixture_id')
        .in('apifootball_fixture_id', fixtureApiIds);
      gwStats  = r.data;
      statsErr = r.error;
      log.push('Stats loaded via fixture IDs: ' + (gwStats || []).length + ' rows');
    } else {
      // Fallback: filter by gw_number (works if apifootball-sync writes it)
      log.push('WARN: No fixture IDs for GW' + currentGW + ' — falling back to gw_number filter');
      const r = await db
        .from('match_player_stats')
        .select('apifootball_player_id, player_name, fantasy_points, minutes_played, position')
        .eq('season', 2025)
        .eq('gw_number', currentGW);
      gwStats  = r.data;
      statsErr = r.error;
      log.push('Stats loaded via gw_number fallback: ' + (gwStats || []).length + ' rows');
    }

    if (statsErr) throw new Error('match_player_stats load: ' + statsErr.message);

    // DIAGNOSTIC: warn if 0 stats found — this is the #1 cause of zero points
    if (!gwStats || gwStats.length === 0) {
      log.push('⚠️  ZERO stats found for GW' + currentGW + '.');
      log.push('   → Run /api/sync?action=force-sync&admin_key=XXX to sync fixtures');
      log.push('   → Then run /api/points-cron?admin_key=XXX&gw=' + currentGW + ' again');
    }

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
      // Index by raw AND normalised name for maximum matching resilience
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
    const byDbId       = {};  
    const byRosterId   = {};  
    const byApiId      = {};  
    const byName       = {};  

    function normPlayerName(s) {
      return (s || '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    }

    for (const p of (dbPlayers || [])) {
      byDbId[p.id] = p;
      if (p.psl_roster_id) byRosterId[p.psl_roster_id] = p;
      if (p.apifootball_id) byApiId[p.apifootball_id]  = p;
      // Index by both raw and normalised name — squad entries use 'name' not 'display_name'
      if (p.display_name) {
        const raw  = p.display_name.toLowerCase().trim();
        const norm = normPlayerName(p.display_name);
        byName[raw]  = p;
        byName[norm] = p;
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

    // ── Step 5: Load ALL profiles with 15+ players ───────────────────────
    // IMPORTANT: Query by squad_count >= 15 NOT just squad_registered = true
    // Some users have full squads but squad_registered was never set to true
    // (race condition on first save, or legacy registrations).
    // We use OR logic: squad_registered=true OR squad_count>=15
    // Supabase doesn't support OR across columns in one query, so we fetch both
    // and deduplicate.

    const [regRes, countRes] = await Promise.all([
      db.from('profiles')
        .select('id, squad_data, squad_count, entry_gw, squad_registered, active_chip, used_chips, free_transfers, transfers_this_gw, fh_snapshot')
        .eq('squad_registered', true)
        .not('squad_data', 'is', null),
      db.from('profiles')
        .select('id, squad_data, squad_count, entry_gw, squad_registered, active_chip, used_chips, free_transfers, transfers_this_gw, fh_snapshot')
        .gte('squad_count', 15)
        .not('squad_data', 'is', null)
    ]);

    if (regRes.error)   throw new Error('profiles load (registered): '  + regRes.error.message);
    if (countRes.error) throw new Error('profiles load (count>=15): ' + countRes.error.message);

    // Deduplicate by id — union of both result sets
    const profileMap = {};
    for (const p of [...(regRes.data || []), ...(countRes.data || [])]) {
      profileMap[p.id] = p;
    }
    const profiles = Object.values(profileMap);

    // Auto-heal: fix squad_registered flag for anyone with 15+ players
    const toHeal = profiles.filter(function(p) { return !p.squad_registered && (p.squad_count || 0) >= 15; });
    if (toHeal.length > 0) {
      log.push('Auto-healing ' + toHeal.length + ' profiles: setting squad_registered=true');
      for (const p of toHeal) {
        await db.from('profiles').update({ squad_registered: true }).eq('id', p.id);
        p.squad_registered = true;
      }
    }

    log.push('Profiles to process: ' + profiles.length + ' (' + toHeal.length + ' auto-healed)');

    let profilesUpdated = 0;
    let profileErrors   = 0;
    const CHUNK = 50;

    for (let pi = 0; pi < (profiles || []).length; pi += CHUNK) {
      const batch = profiles.slice(pi, pi + CHUNK);

      for (const prof of batch) {
        try {
          // Only skip if GW being scored is BEFORE the user joined.
          // entry_gw = the first GW the user is eligible for.
          // So: if currentGW < entry_gw → not yet eligible → write 0 and skip.
          // If currentGW >= entry_gw → user is eligible → score them fully.
          if (prof.entry_gw && currentGW < prof.entry_gw) {
            await db.from('gw_scores').upsert({
              user_id:        prof.id,
              gameweek:       currentGW,
              points:         0,
              player_scores:  [],
              chip_used:      null,
              transfer_deduction: 0,
              calculated_at:  new Date().toISOString()
            }, { onConflict: 'user_id,gameweek' });
            log.push('Profile ' + prof.id + ' not yet eligible for GW' + currentGW + ' (entry_gw=' + prof.entry_gw + ')');
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

          // Auto-heal: if entry_gw was never recorded, set it to GW1
          // so the user is eligible for all past GWs when backfilling.
          // (Setting it to currentGW would permanently block backfill.)
          if (prof.entry_gw === null || prof.entry_gw === undefined) {
            const healGW = gwOverride ? Math.min(currentGW, 1) : 1;
            try {
              await db.from('profiles').update({
                entry_gw:            healGW,
                squad_registered:    true,
                squad_registered_at: new Date().toISOString()
              }).eq('id', prof.id);
              prof.entry_gw = healGW;
              log.push('Auto-healed entry_gw=' + healGW + ' for profile ' + prof.id);
            } catch (e) {
              log.push('Could not auto-heal entry_gw for ' + prof.id + ': ' + e.message);
              // Still try to score — don't skip
              prof.entry_gw = 1;
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
            
            // Captain name fallback — check both name and display_name
            if (!capStat) {
              const _nn = s => (s||'').toLowerCase().replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim();
              for (const cn of [captainEntry.name, captainEntry.display_name].filter(Boolean)) {
                const cHit = gwStatsByName[cn.toLowerCase().trim()] || gwStatsByName[_nn(cn)];
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

            // Name fallback — check 'name' (squad save field) AND 'display_name'
            if (!gwStat) {
              const _nn = s => (s||'').toLowerCase().replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim();
              for (const rawN of [sp.name, sp.display_name].filter(Boolean)) {
                const hit = gwStatsByName[rawN.toLowerCase().trim()] || gwStatsByName[_nn(rawN)];
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

          // NOTE: gwOverride used to ADD points to existing — this caused doubling
          // on re-runs. Now we always REPLACE (upsert overwrites) which is correct.
          // The upsert below handles both new and re-run cases safely.

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

    // ── Step 6: Update overall_rank (catches ALL users with 15+ players) ──
    const [rankedReg, rankedCount] = await Promise.all([
      db.from('profiles').select('id, total_points').eq('squad_registered', true),
      db.from('profiles').select('id, total_points').gte('squad_count', 15)
    ]);
    const rankedMap = {};
    for (const p of [...(rankedReg.data || []), ...(rankedCount.data || [])]) {
      rankedMap[p.id] = p;
    }
    // Sort by total_points desc so rank numbers are correct
    const ranked = Object.values(rankedMap).sort(function(a, b) {
      return (b.total_points || 0) - (a.total_points || 0);
    });

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
    // Use the same fixture IDs we already loaded — no second query needed
    let allFT = false;
    if (fixtureApiIds.length > 0) {
      const { data: gwFixturesStatus } = await db
        .from('fixtures')
        .select('status')
        .in('api_fixture_id', fixtureApiIds);
      allFT = !!(gwFixturesStatus && gwFixturesStatus.length > 0 &&
        gwFixturesStatus.every(function(f) { return f.status === 'FT'; }));
    } else {
      // Fallback: query by gw_number column
      const { data: gwFixturesStatus } = await db
        .from('fixtures')
        .select('status')
        .eq('gw_number', currentGW);
      allFT = !!(gwFixturesStatus && gwFixturesStatus.length > 0 &&
        gwFixturesStatus.every(function(f) { return f.status === 'FT'; }));
    }

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

  // 1. psl_roster_id integer lookup — squad.id IS the psl_roster_id (not UUID)
  const rosterId = squadEntry.psl_roster_id
    || (typeof sid === 'number' && sid > 0 ? sid : null)
    || (typeof sid === 'string' && /^\d+$/.test(sid) ? parseInt(sid,10) : null);
  if (rosterId && byRosterId[rosterId] && byRosterId[rosterId].apifootball_id) {
    return byRosterId[rosterId].apifootball_id;
  }

  // 2. UUID lookup (only if id is a proper UUID string)
  if (typeof sid === 'string' && sid.includes('-') && byDbId[sid] && byDbId[sid].apifootball_id) {
    return byDbId[sid].apifootball_id;
  }

  // 3. Name fallback — check BOTH 'name' (squad field) and 'display_name'
  const nameCandidates = [squadEntry.name, squadEntry.display_name].filter(Boolean);
  for (const n of nameCandidates) {
    const raw  = n.toLowerCase().trim();
    const norm = nn(n);
    const hit  = byName[raw] || byName[norm];
    if (hit && hit.apifootball_id) return hit.apifootball_id;
  }

  return null;
}
