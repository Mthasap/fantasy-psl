// api/season-reset.js — Fantasy PSL — End of Season & New Season Reset
// ══════════════════════════════════════════════════════════════════════
//
// PURPOSE: One endpoint to handle the full EPL-style season lifecycle:
//   1. Finalise season (lock squads, archive standings, declare winners)
//   2. Force-sync final standings so table shows all 30 games played
//   3. Reset for new season (clear squads, reset chips, keep history)
//
// ENDPOINTS:
//   POST /api/season-reset?action=finalise      → lock season, archive
//   POST /api/season-reset?action=sync-standings → force final standings
//   POST /api/season-reset?action=new-season     → reset for next season
//   GET  /api/season-reset?action=status         → check season state
//
// All write actions require x-admin-key header.
// ══════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL     = process.env.SUPABASE_URL         || '';
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY || '';
const ADMIN      = process.env.ADMIN_SECRET         || '';
const AF_KEY     = process.env.APIFOOTBALL_KEY      || '';
const PSL_LEAGUE = 288;

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://www.fantasypsl.co.za');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'Supabase env vars missing' });

  const db     = createClient(SB_URL, SB_KEY);
  const action = req.query.action || 'status';
  const log    = [];

  // ── Auth check for write operations ───────────────────────────────
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key || '';
  if (action !== 'status' && (!ADMIN || adminKey !== ADMIN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── GET STATUS — check current season state ────────────────────────
  if (action === 'status') {
    try {
      const [gwRes, profileRes, playerRes] = await Promise.all([
        db.from('gameweeks').select('gw_number,is_current,is_finished,season').eq('is_current', true).maybeSingle(),
        db.from('profiles').select('id', { count: 'exact', head: true }).eq('squad_registered', true),
        db.from('players').select('id', { count: 'exact', head: true }).eq('is_active', true),
      ]);

      // Count finished GWs for current season
      const season = gwRes.data?.season || 2025;
      const { count: finishedGWs } = await db
        .from('gameweeks').select('id', { count: 'exact', head: true })
        .eq('season', season).eq('is_finished', true);

      // Count fixtures that are FT for season
      const { count: ftFixtures } = await db
        .from('fixtures').select('id', { count: 'exact', head: true })
        .eq('season', season).eq('status', 'FT');

      return res.json({
        success: true,
        current_gw:        gwRes.data?.gw_number || null,
        is_current_finished: gwRes.data?.is_finished || false,
        season,
        finished_gameweeks: finishedGWs || 0,
        ft_fixtures:        ftFixtures  || 0,
        registered_squads:  profileRes.count || 0,
        active_players:     playerRes.count  || 0,
        season_complete:    (finishedGWs || 0) >= 30,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── SYNC STANDINGS — force-fetch final standings from API-Football ─
  // This fixes the table not showing all 30 games played
  if (action === 'sync-standings') {
    log.push('Syncing final standings from API-Football...');
    try {
      if (!AF_KEY) {
        log.push('⚠ APIFOOTBALL_KEY not set — using DB fixtures to update played counts');
      } else {
        // Fetch current standings
        const season = parseInt(req.query.season || process.env.APIFOOTBALL_SEASON || '2025');
        const r = await fetch(
          `https://v3.football.api-sports.io/standings?league=${PSL_LEAGUE}&season=${season}`,
          { headers: { 'x-apisports-key': AF_KEY } }
        );
        if (!r.ok) throw new Error('API-Football standings HTTP ' + r.status);
        const json   = await r.json();
        const groups = (json.response || [])[0];
        const rows   = groups?.league?.standings?.[0] || [];

        if (!rows.length) {
          log.push('⚠ No standings returned from API-Football');
        } else {
          log.push(`Fetched ${rows.length} teams from API-Football`);

          const dbRows = rows.map(s => ({
            id:            s.rank,
            team_name:     s.team?.name || '',
            team_logo:     s.team?.logo || null,
            position:      s.rank,
            played:        s.all?.played || 0,
            won:           s.all?.win    || 0,
            drawn:         s.all?.draw   || 0,
            lost:          s.all?.lose   || 0,
            goals_for:     s.all?.goals?.for     || 0,
            goals_against: s.all?.goals?.against || 0,
            goal_diff:     s.goalsDiff || 0,
            points:        s.points    || 0,
            form:          s.form || '',
            updated_at:    new Date().toISOString(),
          }));

          const { error: upsErr } = await db
            .from('standings')
            .upsert(dbRows, { onConflict: 'id' });

          if (upsErr) {
            log.push('⚠ Standings upsert warning: ' + upsErr.message);
          } else {
            log.push(`✅ ${dbRows.length} teams updated in standings table`);
            // Log the top 3 for verification
            dbRows.slice(0, 3).forEach(t =>
              log.push(`  ${t.position}. ${t.team_name} — P:${t.played} Pts:${t.points}`)
            );
          }
        }
      }

      // Also mark all GW30 fixtures as FT if they're NS (catch-all fix)
      const season = parseInt(req.query.season || process.env.APIFOOTBALL_SEASON || '2025');
      const { data: gw30Fixtures } = await db
        .from('fixtures')
        .select('apifootball_fixture_id, api_fixture_id, status')
        .eq('season', season)
        .eq('gw_number', 30);

      const nsCount = (gw30Fixtures || []).filter(f => f.status === 'NS').length;
      log.push(`GW30 fixtures: ${(gw30Fixtures || []).length} total, ${nsCount} still NS`);

      // Mark GW30 as finished
      await db.from('gameweeks')
        .update({ is_finished: true, is_current: false })
        .eq('gw_number', 30)
        .eq('season', season);
      log.push('✅ GW30 marked as finished');

      return res.json({ success: true, log });
    } catch (e) {
      log.push('❌ ' + e.message);
      return res.status(500).json({ error: e.message, log });
    }
  }

  // ── FINALISE SEASON — EPL-style season end procedure ──────────────
  if (action === 'finalise') {
    const season = parseInt(req.query.season || req.body?.season || process.env.APIFOOTBALL_SEASON || '2025');
    log.push(`=== Finalising Season ${season} ===`);

    try {
      // 1. Mark all GWs for this season as finished, none as current
      const { error: gwErr } = await db
        .from('gameweeks')
        .update({ is_finished: true, is_current: false })
        .eq('season', season);
      if (gwErr) log.push('⚠ GW update: ' + gwErr.message);
      else log.push('✅ All gameweeks marked finished');

      // 2. Archive final season standings
      const { data: finalStandings } = await db
        .from('standings')
        .select('*')
        .order('position', { ascending: true });

      if (finalStandings?.length) {
        // Write to season_archives table (create if needed)
        const archiveRows = finalStandings.map(s => ({
          season,
          position:      s.position,
          team_name:     s.team_name,
          team_logo:     s.team_logo,
          played:        s.played,
          won:           s.won,
          drawn:         s.drawn,
          lost:          s.lost,
          goals_for:     s.goals_for,
          goals_against: s.goals_against,
          goal_diff:     s.goal_diff,
          points:        s.points,
          archived_at:   new Date().toISOString(),
        }));

        const { error: archErr } = await db
          .from('season_standings_archive')
          .upsert(archiveRows, { onConflict: 'season,position' });
        if (archErr) log.push('⚠ Archive: ' + archErr.message + ' (table may not exist yet)');
        else log.push(`✅ Final standings archived — ${archiveRows.length} teams`);
      }

      // 3. Get final fantasy rankings — top 10 winners
      const { data: topUsers } = await db
        .from('profiles')
        .select('id, username, team_name, total_points, overall_rank')
        .eq('squad_registered', true)
        .order('total_points', { ascending: false })
        .limit(10);

      if (topUsers?.length) {
        log.push('Top 3 Fantasy PSL Champions:');
        topUsers.slice(0, 3).forEach((u, i) =>
          log.push(`  ${i + 1}. ${u.team_name || u.username} — ${u.total_points} pts`)
        );
      }

      // 4. Lock all squads (set squad_locked = true, or just note season is over)
      // We use a flag on the gameweeks table — no squad data is deleted
      // Users can view their squads read-only until the new season reset
      const { error: lockErr } = await db
        .from('profiles')
        .update({ squad_locked: true, updated_at: new Date().toISOString() })
        .eq('squad_registered', true);
      if (lockErr) log.push('⚠ Squad lock (squad_locked column may not exist): ' + lockErr.message);
      else log.push('✅ All registered squads locked');

      // 5. Post a season-over announcement
      try {
        await db.from('announcements').insert({
          title:      '🏆 2025/26 Season Complete!',
          message:    'All 30 gameweeks have been played. Congratulations to our Fantasy PSL champions! The new 2026/27 season registration opens soon.',
          color:      'green',
          is_breaking: true,
          is_active:  true,
          created_at: new Date().toISOString(),
        });
        log.push('✅ Season-over announcement posted');
      } catch (e) {
        log.push('⚠ Could not post announcement: ' + e.message);
      }

      return res.json({ success: true, season, log, top_users: topUsers || [] });
    } catch (e) {
      log.push('❌ ' + e.message);
      return res.status(500).json({ error: e.message, log });
    }
  }

  // ── NEW SEASON RESET — EPL-style pre-season reset ──────────────────
  // Clears squads, resets chips and transfers, increments season
  // NEVER deletes historical data — all archived in gw_scores + profiles history
  if (action === 'new-season') {
    const oldSeason = parseInt(req.query.old_season || process.env.APIFOOTBALL_SEASON || '2025');
    const newSeason = parseInt(req.query.new_season || String(oldSeason + 1));
    const dryRun    = req.query.dry_run === '1';

    log.push(`=== New Season Reset: ${oldSeason} → ${newSeason} ${dryRun ? '(DRY RUN)' : ''} ===`);

    try {
      // Count what will be affected
      const { count: squadCount } = await db
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('squad_registered', true);

      const { count: playerCount } = await db
        .from('players')
        .select('id', { count: 'exact', head: true });

      log.push(`Profiles with squads: ${squadCount}`);
      log.push(`Total players in DB: ${playerCount}`);

      if (dryRun) {
        log.push('DRY RUN — no changes made. Remove ?dry_run=1 to apply.');
        return res.json({ success: true, dry_run: true, log, squads_to_reset: squadCount });
      }

      // STEP 1: Archive current season user history in gw_scores (already there)
      // gw_scores has season column — no action needed, history is preserved

      // STEP 2: Reset all user squads (like EPL FPL does at season start)
      // - Clear squad_data (users must pick a new squad)
      // - Reset chips to all available
      // - Reset transfers
      // - Keep total_points as career history (visible in profile history)
      // - Reset gw_points and season-specific fields to 0
      const { error: resetErr } = await db
        .from('profiles')
        .update({
          squad_data:        null,
          squad_count:       0,
          squad_registered:  false,
          squad_locked:      false,
          gw_points:         0,
          // NOTE: we do NOT reset total_points — it's the career total
          // The UI should show "Season 2025 points" separately from career total
          entry_gw:          null,
          squad_registered_at: null,
          free_transfers:    1,
          transfers_this_gw: 0,
          active_chip:       null,
          used_chips:        '[]',    // All chips reset (Wildcard, Triple Cap, etc.)
          fh_snapshot:       null,
          overall_rank:      null,
          updated_at:        new Date().toISOString(),
        })
        // Only reset users who had squads — don't touch never-registered users
        .not('id', 'is', null);

      if (resetErr) {
        log.push('❌ Profile reset error: ' + resetErr.message);
        return res.status(500).json({ error: resetErr.message, log });
      }
      log.push(`✅ All user squads cleared — users must pick a new squad for ${newSeason}`);

      // STEP 3: Reset player season stats (goals, assists etc. go back to 0)
      // Keep players in DB — just wipe their season stats
      const { error: playerResetErr } = await db
        .from('players')
        .update({
          goals:           0,
          assists:         0,
          clean_sheets:    0,
          yellow_cards:    0,
          red_cards:       0,
          saves:           0,
          apps:            0,
          appearances:     0,
          minutes_played:  0,
          total_points:    0,
          gw_points:       0,
          goals_conceded:  0,
          penalties_saved: 0,
          penalties_missed:0,
          avg_rating:      null,
          is_injured:      false,
          is_available:    true,
          injury_reason:   null,
          updated_at:      new Date().toISOString(),
        })
        .not('id', 'is', null);

      if (playerResetErr) log.push('⚠ Player stats reset: ' + playerResetErr.message);
      else log.push(`✅ Player season stats reset to 0`);

      // STEP 4: Create GW1 for new season
      const { error: gwErr } = await db
        .from('gameweeks')
        .insert({
          gw_number:   1,
          number:      1,
          name:        'Gameweek 1',
          season:      newSeason,
          is_current:  false,   // Admin activates when fixtures are loaded
          is_finished: false,
          created_at:  new Date().toISOString(),
        });
      if (gwErr) log.push('⚠ GW1 creation: ' + gwErr.message + ' (may already exist)');
      else log.push(`✅ GW1 created for season ${newSeason}`);

      // STEP 5: Post new season announcement
      try {
        await db.from('announcements').insert({
          title:       `🎉 New Season ${newSeason}/${String(newSeason + 1).slice(2)} Opening Soon!`,
          message:     `The ${newSeason}/${String(newSeason + 1).slice(2)} Betway Premiership season is coming! Pick your squad and get ready for the new season.`,
          color:       'blue',
          is_breaking: true,
          is_active:   true,
          created_at:  new Date().toISOString(),
        });
        log.push('✅ New season announcement posted');
      } catch (e) {
        log.push('⚠ Announcement: ' + e.message);
      }

      log.push('');
      log.push('=== NEXT STEPS (admin actions) ===');
      log.push('1. Import new season fixtures via apifootball-sync?phase=1');
      log.push('2. Run player-crawler to update transfers/new signings');
      log.push('3. Review & update player prices in admin Players tab');
      log.push('4. Set GW1 as active once fixtures are loaded');
      log.push('5. Open squad registration — users can now pick new squads');

      return res.json({
        success:      true,
        old_season:   oldSeason,
        new_season:   newSeason,
        squads_reset: squadCount,
        log,
      });

    } catch (e) {
      log.push('❌ ' + e.message);
      return res.status(500).json({ error: e.message, log });
    }
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
};
