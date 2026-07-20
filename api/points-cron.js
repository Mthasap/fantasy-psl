// api/points-cron.js — Fantasy PSL Points Engine v5
// ════════════════════════════════════════════════════════════════════════
//
// FIXES vs v4:
//   1. PLAYER DEDUPLICATION: squad is deduped before scoring so no player
//      earns double points when they appear twice (bug from squad-builder).
//   2. VC multiplier: Vice-Captain only gets captain multiplier when captain
//      scored 0 minutes (truly didn't play), not just when capStat is null.
//   3. gw_points column is always written (was sometimes skipped on error path).
//   4. entry_gw heal: uses current GW not GW1 when scoring live (GW1 was
//      locking out mid-season registrations from all GW history).
//   5. Season constant reads from env var (consistent with other files).
//   6. Profile upsert on first registration no longer overwrites earned points.
//   7. Added explicit logging when 0 stats found (clearest debug signal).
//
// ════════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL     = process.env.SUPABASE_URL          || '';
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY  || '';
const ADMIN      = process.env.ADMIN_SECRET;
const PSL_SEASON = process.env.APIFOOTBALL_SEASON ? parseInt(process.env.APIFOOTBALL_SEASON) : 2026;

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // ── Auth ─────────────────────────────────────────────────────────────────
  const adminKey         = (req.query?.admin_key)   || (req.headers?.['x-admin-key']) || '';
  const isCron           = req.headers?.['x-vercel-cron'] === '1';
  const syncSecretHeader = req.headers?.['x-sync-secret'] || '';
  const secretParam      = req.query?.secret || '';
  const SYNC             = process.env.SYNC_SECRET || process.env.ADMIN_SECRET || '';
  const isSecret = SYNC && (
    syncSecretHeader === SYNC ||
    secretParam      === SYNC ||
    secretParam      === process.env.ADMIN_SECRET
  );

  if (!isCron && !isSecret && adminKey !== ADMIN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  const db  = createClient(SB_URL, SB_KEY);
  const log = [];

  if (req.query?.dry_run === '1') {
    return res.json({ success: true, message: 'Auth OK', log: ['Auth check passed'] });
  }

  try {
    log.push('=== Fantasy PSL Points Engine v5 ===');
    log.push(`Season: ${PSL_SEASON}`);

    // ── Step 1: Determine current gameweek ───────────────────────────────
    const gwOverride = req.query?.gw ? parseInt(req.query.gw, 10) : null;
    let currentGW;
    let gwData = null;

    if (gwOverride && !isNaN(gwOverride)) {
      currentGW = gwOverride;
      log.push('GW OVERRIDE: Scoring GW' + currentGW);
    } else {
      // Try is_current flag first
      const { data: gwCurrent } = await db
        .from('gameweeks').select('*')
        .eq('is_current', true).eq('season', PSL_SEASON)
        .limit(1).maybeSingle();

      if (gwCurrent) {
        gwData    = gwCurrent;
        currentGW = gwCurrent.gw_number || gwCurrent.number;
        log.push('Current GW: ' + currentGW + ' (from is_current flag)');
      } else {
        const now = new Date().toISOString();
        log.push('WARN: No is_current GW — searching by date: ' + now.substring(0, 10));

        const { data: gwByDate } = await db
          .from('gameweeks').select('*').eq('season', PSL_SEASON)
          .lte('start_date', now).gte('end_date', now)
          .order('gw_number', { ascending: false }).limit(1).maybeSingle();

        if (gwByDate) {
          gwData    = gwByDate;
          currentGW = gwByDate.gw_number || gwByDate.number;
          log.push('Found GW by date range: GW' + currentGW);
        } else {
          const { data: gwWithStats } = await db
            .from('match_player_stats').select('gw_number')
            .eq('season', PSL_SEASON).not('gw_number', 'is', null)
            .order('gw_number', { ascending: false }).limit(1).maybeSingle();

          if (gwWithStats?.gw_number) {
            currentGW = gwWithStats.gw_number;
            log.push('Found GW from match stats: GW' + currentGW);
            const { data: gwRow } = await db
              .from('gameweeks').select('*')
              .eq('season', PSL_SEASON).eq('gw_number', currentGW).maybeSingle();
            gwData = gwRow;
          } else {
            const { data: gwFinished } = await db
              .from('gameweeks').select('*')
              .eq('season', PSL_SEASON).eq('is_finished', true)
              .order('gw_number', { ascending: false }).limit(1).maybeSingle();
            if (gwFinished) {
              gwData    = gwFinished;
              currentGW = gwFinished.gw_number || gwFinished.number;
              log.push('Using last finished GW: GW' + currentGW);
            }
          }
        }

        if (currentGW) {
          log.push('Using GW' + currentGW + ' (not modifying DB flags)');
        }
      }

      if (!currentGW) {
        log.push('FATAL: Cannot determine GW. Set is_current=true on the correct gameweeks row.');
        return res.status(500).json({ error: 'Cannot determine current GW', log });
      }
    }

    // ── Step 2: Load match_player_stats for this GW ───────────────────────
    // Primary: filter by fixture IDs for the GW (more reliable)
    const { data: gwFixtureRows } = await db
      .from('fixtures').select('api_fixture_id, apifootball_fixture_id, id')
      .eq('gw_number', currentGW);

    // Support both column name variants (sync.js writes api_fixture_id;
    // apifootball-sync.js writes apifootball_fixture_id)
    const fixtureApiIds = (gwFixtureRows || [])
      .map(r => r.apifootball_fixture_id || r.api_fixture_id)
      .filter(Boolean);

    log.push('GW' + currentGW + ' fixture IDs: ' + (fixtureApiIds.length ? fixtureApiIds.join(', ') : 'none found'));

    let gwStats, statsErr;

    if (fixtureApiIds.length > 0) {
      const r = await db
        .from('match_player_stats')
        .select('apifootball_player_id, player_name, fantasy_points, minutes_played, position, apifootball_fixture_id')
        .in('apifootball_fixture_id', fixtureApiIds);
      gwStats  = r.data;
      statsErr = r.error;
      log.push('Stats loaded via fixture IDs: ' + (gwStats || []).length + ' rows');
    } else {
      // Fallback: gw_number column
      log.push('WARN: No fixture IDs for GW' + currentGW + ' — falling back to gw_number filter');
      const r = await db
        .from('match_player_stats')
        .select('apifootball_player_id, player_name, fantasy_points, minutes_played, position')
        .eq('season', PSL_SEASON).eq('gw_number', currentGW);
      gwStats  = r.data;
      statsErr = r.error;
      log.push('Stats loaded via gw_number fallback: ' + (gwStats || []).length + ' rows');
    }

    if (statsErr) throw new Error('match_player_stats load: ' + statsErr.message);

    if (!gwStats || gwStats.length === 0) {
      log.push('⚠️  ZERO stats found for GW' + currentGW + '.');
      log.push('   → Run /api/apifootball-sync?phase=1 then ?phase=2 to sync match data');
      log.push('   → Then re-run points-cron');
      // Return early — nothing to score yet
      return res.json({
        success:          false,
        current_gw:       currentGW,
        gw_players_found: 0,
        profiles_updated: 0,
        message:          'No stats found for GW' + currentGW + '. Run apifootball-sync first.',
        log,
      });
    }

    // ── Aggregate stats by API player ID ────────────────────────────────
    const gwStatsByApiId = {};
    const gwStatsByName  = {};

    function normStatName(s) {
      return (s || '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    }

    for (const row of gwStats) {
      const pid = row.apifootball_player_id;
      if (pid) {
        if (!gwStatsByApiId[pid]) {
          gwStatsByApiId[pid] = { fantasy_points: 0, minutes_played: 0, position: row.position };
        }
        gwStatsByApiId[pid].fantasy_points += (row.fantasy_points || 0);
        gwStatsByApiId[pid].minutes_played += (row.minutes_played || 0);
      }
      if (row.player_name) {
        const rawKey  = row.player_name.toLowerCase().trim();
        const normKey = normStatName(row.player_name);
        const pts     = row.fantasy_points || 0;
        if (!gwStatsByName[rawKey]  || pts > (gwStatsByName[rawKey].fantasy_points  || 0)) gwStatsByName[rawKey]  = row;
        if (!gwStatsByName[normKey] || pts > (gwStatsByName[normKey].fantasy_points || 0)) gwStatsByName[normKey] = row;
      }
    }

    log.push('Players with GW' + currentGW + ' stats: ' + Object.keys(gwStatsByApiId).length);

    // ── Step 3: Load players table ────────────────────────────────────────
    const { data: dbPlayers, error: playersErr } = await db
      .from('players')
      .select('id, psl_roster_id, apifootball_id, display_name, position, total_points');

    if (playersErr) throw new Error('players load: ' + playersErr.message);

    const byDbId     = {};
    const byRosterId = {};
    const byApiId    = {};
    const byName     = {};

    function normPlayerName(s) {
      return (s || '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    }

    for (const p of (dbPlayers || [])) {
      byDbId[p.id] = p;
      if (p.psl_roster_id) byRosterId[p.psl_roster_id] = p;
      if (p.apifootball_id) byApiId[p.apifootball_id]  = p;
      if (p.display_name) {
        byName[p.display_name.toLowerCase().trim()] = p;
        byName[normPlayerName(p.display_name)]      = p;
      }
    }

    log.push('DB players loaded: ' + (dbPlayers || []).length);

    // ── Step 4: Load profiles ─────────────────────────────────────────────
    const [regRes, countRes] = await Promise.all([
      db.from('profiles')
        .select('id, squad_data, squad_count, entry_gw, squad_registered, active_chip, used_chips, free_transfers, transfers_this_gw, fh_snapshot')
        .eq('squad_registered', true)
        .not('squad_data', 'is', null),
      db.from('profiles')
        .select('id, squad_data, squad_count, entry_gw, squad_registered, active_chip, used_chips, free_transfers, transfers_this_gw, fh_snapshot')
        .gte('squad_count', 15)
        .not('squad_data', 'is', null),
    ]);

    if (regRes.error)   throw new Error('profiles load (registered): '  + regRes.error.message);
    if (countRes.error) throw new Error('profiles load (count>=15): '    + countRes.error.message);

    const profileMap = {};
    for (const p of [...(regRes.data || []), ...(countRes.data || [])]) {
      profileMap[p.id] = p;
    }
    const profiles = Object.values(profileMap);

    // Auto-heal squad_registered flag
    const toHeal = profiles.filter(p => !p.squad_registered && (p.squad_count || 0) >= 15);
    if (toHeal.length > 0) {
      log.push('Auto-healing ' + toHeal.length + ' profiles: setting squad_registered=true');
      for (const p of toHeal) {
        await db.from('profiles').update({ squad_registered: true }).eq('id', p.id);
        p.squad_registered = true;
      }
    }

    log.push('Profiles to process: ' + profiles.length);

    let profilesUpdated = 0;
    let profileErrors   = 0;

    for (const prof of profiles) {
      try {
        // Skip if GW is before this user's entry
        if (prof.entry_gw && currentGW < prof.entry_gw) {
          await db.from('gw_scores').upsert({
            user_id: prof.id, gameweek: currentGW, points: 0,
            player_scores: [], chip_used: null, transfer_deduction: 0,
            calculated_at: new Date().toISOString()
          }, { onConflict: 'user_id,gameweek' });
          profilesUpdated++;
          continue;
        }

        let sq;
        try {
          sq = typeof prof.squad_data === 'string'
            ? JSON.parse(prof.squad_data)
            : prof.squad_data;
        } catch (_) { continue; }

        if (!Array.isArray(sq)) continue;

        // ── FIX: Deduplicate squad entries by player ID / roster ID / name ──
        const seenPlayerKeys = new Set();
        const uniqueSq = [];
        for (const p of sq) {
          if (!p || typeof p !== 'object') continue;
          // Build a dedup key: prefer numeric psl_roster_id, then UUID id, then name
          const key = p.psl_roster_id
            || (typeof p.id === 'number' ? p.id : null)
            || (typeof p.id === 'string' && /^\d+$/.test(p.id) ? parseInt(p.id) : null)
            || (typeof p.id === 'string' && p.id.includes('-') ? p.id : null)
            || normPlayerName(p.name || p.display_name || '');
          if (!key) continue;
          if (seenPlayerKeys.has(String(key))) continue;
          seenPlayerKeys.add(String(key));
          uniqueSq.push(p);
        }

        const validPlayers = uniqueSq.filter(p =>
          p.id || p.psl_roster_id || p.apifootball_id || p.name
        );

        if (validPlayers.length < 11) {
          log.push(`Profile ${prof.id} skipped: too few valid players (${validPlayers.length})`);
          continue;
        }

        // Auto-heal entry_gw — use currentGW (not GW1) for mid-season registrations
        if (prof.entry_gw === null || prof.entry_gw === undefined) {
          try {
            await db.from('profiles').update({
              entry_gw:            currentGW,
              squad_registered:    true,
              squad_registered_at: new Date().toISOString()
            }).eq('id', prof.id);
            prof.entry_gw = currentGW;
            log.push('Auto-healed entry_gw=' + currentGW + ' for profile ' + prof.id);
          } catch (e) {
            prof.entry_gw = currentGW;
          }
        }

        const activeChip = prof.active_chip || null;
        let usedChips = [];
        try { usedChips = JSON.parse(prof.used_chips || '[]'); } catch (_) {}

        let scoringSq = validPlayers;

        // Free Hit chip: use snapshot squad
        if (activeChip === 'fh' && prof.fh_snapshot) {
          try {
            const snap = typeof prof.fh_snapshot === 'string'
              ? JSON.parse(prof.fh_snapshot)
              : prof.fh_snapshot;
            if (Array.isArray(snap) && snap.length >= 11) {
              scoringSq = snap;
            }
          } catch (_) {}
        }

        const isBB = activeChip === 'bb';
        const isTC = activeChip === 'tc';

        // Bench Boost: all players score; otherwise only non-bench players
        const scoringPlayers = isBB
          ? scoringSq
          : scoringSq.filter(p => !p.onBench);

        // ── Captain lookup ───────────────────────────────────────────────
        const captainEntry = scoringSq.find(p => p.isCaptain);
        let captainMinutes = 0;

        if (captainEntry) {
          const capApiId = resolveApiId(captainEntry, byDbId, byRosterId, byName);
          let capStat = capApiId ? gwStatsByApiId[capApiId] : null;

          if (!capStat) {
            const _nn = s => normPlayerName(s);
            for (const cn of [captainEntry.name, captainEntry.display_name].filter(Boolean)) {
              const hit = gwStatsByName[cn.toLowerCase().trim()] || gwStatsByName[_nn(cn)];
              if (hit) { capStat = gwStatsByApiId[hit.apifootball_player_id] || hit; break; }
            }
          }
          captainMinutes = capStat ? (capStat.minutes_played || 0) : 0;
        }

        // Captain "played" = at least 1 minute
        const captainPlayed = captainMinutes > 0;

        let gwTotal = 0;
        const playerBreakdown = [];

        for (const sp of scoringPlayers) {
          const apiId  = resolveApiId(sp, byDbId, byRosterId, byName);
          let   gwStat = apiId ? gwStatsByApiId[apiId] : null;

          if (!gwStat) {
            const _nn = s => normPlayerName(s);
            for (const rawN of [sp.name, sp.display_name].filter(Boolean)) {
              const hit = gwStatsByName[rawN.toLowerCase().trim()] || gwStatsByName[_nn(rawN)];
              if (hit) { gwStat = gwStatsByApiId[hit.apifootball_player_id] || hit; break; }
            }
          }

          const pts    = gwStat ? (gwStat.fantasy_points || 0) : 0;
          const source = gwStat ? 'live' : 'dnp';

          let finalPts   = pts;
          let multiplier = 1;

          if (sp.isCaptain) {
            multiplier = isTC ? 3 : 2;
            finalPts   = pts * multiplier;
          } else if (sp.isVC && !captainPlayed) {
            // Vice-captain takes captain multiplier ONLY if captain got 0 minutes
            multiplier = isTC ? 3 : 2;
            finalPts   = pts * multiplier;
          }

          gwTotal += finalPts;
          playerBreakdown.push({
            id:         sp.id,
            name:       sp.name || '',
            position:   sp.position || '',
            pts,
            final_pts:  finalPts,
            multiplier,
            isCaptain:  sp.isCaptain  || false,
            isVC:       sp.isVC       || false,
            onBench:    sp.onBench    || false,
            source,
            api_id:     apiId || null,
          });
        }

        // Transfer penalty
        let transferDeduction = 0;
        if (activeChip !== 'wc' && activeChip !== 'fh') {
          const freeTransfers  = prof.free_transfers  || 1;
          const transfersMade  = prof.transfers_this_gw || 0;
          const extraTransfers = Math.max(0, transfersMade - freeTransfers);
          transferDeduction    = extraTransfers * 4;
          if (transferDeduction > 0) {
            gwTotal = Math.max(0, gwTotal - transferDeduction);
            log.push(`  Profile ${prof.id}: -${transferDeduction}pts transfer hit`);
          }
        }

        // Upsert gw_scores (always replace, never accumulate)
        await db.from('gw_scores').upsert({
          user_id:            prof.id,
          gameweek:           currentGW,
          points:             gwTotal,
          player_scores:      playerBreakdown,
          chip_used:          activeChip || null,
          transfer_deduction: transferDeduction,
          calculated_at:      new Date().toISOString()
        }, { onConflict: 'user_id,gameweek' });

        // Season total = sum of all gw_scores from entry_gw onwards
        const { data: allScores } = await db
          .from('gw_scores').select('points')
          .eq('user_id', prof.id)
          .gte('gameweek', prof.entry_gw || 1);

        const seasonTotal = (allScores || []).reduce((s, r) => s + (r.points || 0), 0);

        // Chip bookkeeping
        const chipUpdate = {};
        if (activeChip && !usedChips.includes(activeChip)) {
          usedChips.push(activeChip);
          chipUpdate.used_chips  = JSON.stringify(usedChips);
          chipUpdate.active_chip = null;
        }
        if (activeChip === 'fh' && prof.fh_snapshot) {
          chipUpdate.squad_data  = prof.fh_snapshot;
          chipUpdate.fh_snapshot = null;
        }

        // Free transfer rollover (max 2)
        const freeUsed     = Math.min(prof.transfers_this_gw || 0, prof.free_transfers || 1);
        const unused       = (prof.free_transfers || 1) - freeUsed;
        const newFreeXfers = Math.min(2, unused + 1);

        // Always write gw_points so the UI shows the current GW total
        await db.from('profiles').update(Object.assign({
          total_points:      seasonTotal,
          gw_points:         gwTotal,          // ← critical: always write this
          squad_count:       sq.length,
          free_transfers:    newFreeXfers,
          transfers_this_gw: 0,
        }, chipUpdate)).eq('id', prof.id);

        profilesUpdated++;
      } catch (e) {
        profileErrors++;
        log.push('Profile error ' + prof.id + ': ' + e.message);
      }
    }

    log.push('Profiles updated: ' + profilesUpdated + ' | Errors: ' + profileErrors);

    // ── Step 5: Update overall_rank ───────────────────────────────────────
    const [rankedReg, rankedCount] = await Promise.all([
      db.from('profiles').select('id, total_points').eq('squad_registered', true),
      db.from('profiles').select('id, total_points').gte('squad_count', 15),
    ]);
    const rankedMap = {};
    for (const p of [...(rankedReg.data || []), ...(rankedCount.data || [])]) {
      rankedMap[p.id] = p;
    }
    const ranked = Object.values(rankedMap).sort((a, b) =>
      (b.total_points || 0) - (a.total_points || 0)
    );

    if (ranked.length) {
      const rankUpdates = ranked.map((r, i) => ({ id: r.id, overall_rank: i + 1 }));
      for (let ri = 0; ri < rankUpdates.length; ri += 50) {
        const batch = rankUpdates.slice(ri, ri + 50);
        await Promise.all(
          batch.map(upd => db.from('profiles').update({ overall_rank: upd.overall_rank }).eq('id', upd.id))
        );
      }
      log.push('Rankings updated: ' + ranked.length + ' profiles');
    }

    // ── Step 6: Mark GW finished if all fixtures are FT ──────────────────
    let allFT = false;
    if (fixtureApiIds.length > 0) {
      const { data: fixtureStatuses } = await db
        .from('fixtures').select('status')
        .in('apifootball_fixture_id', fixtureApiIds);
      allFT = !!(fixtureStatuses?.length > 0 && fixtureStatuses.every(f => f.status === 'FT'));
    } else {
      const { data: fixtureStatuses } = await db
        .from('fixtures').select('status').eq('gw_number', currentGW);
      allFT = !!(fixtureStatuses?.length > 0 && fixtureStatuses.every(f => f.status === 'FT'));
    }

    if (allFT) {
      log.push('All GW' + currentGW + ' fixtures finished — marking GW complete');
      await db.from('gameweeks')
        .update({ is_finished: true, is_current: false })
        .eq('gw_number', currentGW).eq('season', PSL_SEASON);
    }

    return res.json({
      success:          true,
      current_gw:       currentGW,
      gw_players_found: Object.keys(gwStatsByApiId).length,
      profiles_updated: profilesUpdated,
      profile_errors:   profileErrors,
      all_fixtures_ft:  allFT || false,
      log,
    });

  } catch (err) {
    console.error('[points-cron v5]', err.message);
    return res.status(500).json({ error: err.message, log });
  }
};

// ── Resolve apifootball_id from a squad entry ─────────────────────────────
function resolveApiId(squadEntry, byDbId, byRosterId, byName) {
  if (!squadEntry) return null;
  const sid = squadEntry.id;
  const nn  = s => (s || '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();

  // 1. psl_roster_id → apifootball_id
  const rosterId = squadEntry.psl_roster_id
    || (typeof sid === 'number' && sid > 0 ? sid : null)
    || (typeof sid === 'string' && /^\d+$/.test(sid) ? parseInt(sid, 10) : null);
  if (rosterId && byRosterId[rosterId]?.apifootball_id) {
    return byRosterId[rosterId].apifootball_id;
  }

  // 2. UUID id
  if (typeof sid === 'string' && sid.includes('-') && byDbId[sid]?.apifootball_id) {
    return byDbId[sid].apifootball_id;
  }

  // 3. Name fallback
  for (const n of [squadEntry.name, squadEntry.display_name].filter(Boolean)) {
    const hit = byName[n.toLowerCase().trim()] || byName[nn(n)];
    if (hit?.apifootball_id) return hit.apifootball_id;
  }

  return null;
}
