// api/master-agent.js — Fantasy PSL — Fully Autonomous Master Agent
// ══════════════════════════════════════════════════════════════════════════
//
// This is the brain of Fantasy PSL. It runs once daily via Vercel cron
// and makes ALL decisions automatically — no human intervention needed.
//
// WHAT IT DOES AUTONOMOUSLY:
//
//  1. SEASON DETECTION     — detects which season is active via API-Football
//  2. PRE-SEASON           — syncs player rosters daily from Jul 1 onwards
//  3. SEASON GATE          — opens registration exactly 14 days before GW1
//  4. FIXTURE SYNC         — keeps all fixtures current throughout the season
//  5. MATCH STATS          — syncs player stats after every match completes
//  6. POINTS ENGINE        — scores all user squads after each gameweek
//  7. RANKINGS             — updates overall leaderboard after scoring
//  8. INJURY UPDATES       — flags injured/suspended players daily
//  9. NEWS CRAWLER         — crawls SA football RSS feeds daily
// 10. GW LIFECYCLE         — opens/closes gameweeks, sets deadlines
// 11. SEASON END           — detects season end, locks squads, archives data
// 12. PLAYER PRICES        — adjusts player prices based on ownership %
// 13. NOTIFICATIONS        — sends waitlist emails when registration opens
// 14. SELF-HEALING         — fixes broken data, heals missing entry_gw etc
// 15. HEALTH MONITORING    — logs every run to agent_log table in Supabase
//
// TRIGGERED: Daily at 02:00 UTC (04:00 SAST) via vercel.json cron
// MANUAL:    GET /api/master-agent?admin_key=YOUR_KEY
// STATUS:    GET /api/master-agent?action=status&admin_key=YOUR_KEY
//
// ══════════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL     = process.env.SUPABASE_URL          || '';
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY  || '';
const ADMIN      = process.env.ADMIN_SECRET          || '';
const AF_KEY     = process.env.APIFOOTBALL_KEY       || '';
const RESEND_KEY = process.env.RESEND_API_KEY        || '';
const SITE_URL   = process.env.SITE_URL              || 'https://www.fantasypsl.co.za';
const PSL_LEAGUE = 288;

// ── Internal API caller ───────────────────────────────────────────────────
async function call(path, method = 'GET') {
  const base = process.env.VERCEL_URL
    ? 'https://' + process.env.VERCEL_URL
    : SITE_URL;
  try {
    const r = await fetch(base + path, {
      method,
      headers: {
        'x-vercel-cron': '1',
        'x-admin-key':   ADMIN,
        'x-sync-secret': process.env.SYNC_SECRET || ADMIN,
        'Content-Type':  'application/json',
      },
      signal: AbortSignal.timeout(55_000),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: {}, error: e.message };
  }
}

// ── API-Football direct fetch ─────────────────────────────────────────────
async function apiFetch(endpoint) {
  if (!AF_KEY) throw new Error('APIFOOTBALL_KEY not set');
  const r = await fetch(`https://v3.football.api-sports.io${endpoint}`, {
    headers: { 'x-apisports-key': AF_KEY },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`API-Football HTTP ${r.status}`);
  const data = await r.json();
  return data;
}


// ── ESPN Africa data availability checker ────────────────────────────────
// Checks if ESPN Africa provides PSL data we can use legally
// ESPN data is publicly available for personal/non-commercial use
// We use it only to VERIFY/SUPPLEMENT API-Football data, never replace it commercially
async function checkEspnDataAvailability(log) {
  log.push('\n[ESPN Africa Data Check]');
  const ESPN_URL = 'https://site.web.api.espn.com/apis/v2/sports/soccer/rsa.1/standings';
  const results = { espn: {}, verdict: '' };

  try {
    const r = await fetch(ESPN_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FantasyPSL/2.0)',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (r.ok) {
      const data = await r.json();
      const groups = data?.children?.[0]?.standings?.entries || [];
      results.espn = {
        available:   true,
        teams:       groups.length,
        source:      'ESPN Africa Public API',
        url:         ESPN_URL,
        legal_note:  'Publicly available read-only data. For personal/editorial use only. Not for commercial redistribution.',
        can_use:     groups.length > 0,
        data_types:  ['standings', 'fixtures', 'scores', 'team-stats'],
      };

      if (groups.length > 0) {
        log.push(`  ✅ ESPN Africa: ${groups.length} teams found — data is available`);
        log.push('  ℹ Legal: Public read-only API. Usable for supplemental verification only.');
        log.push('  ℹ Recommendation: Use API-Football as PRIMARY source (licensed).');
        log.push('               Use ESPN as VERIFICATION/BACKUP only (free, public).');
        results.verdict = 'ESPN data available as backup. Keep API-Football as primary licensed source.';
      }
    } else {
      results.espn = { available: false, status: r.status };
      log.push(`  ⚠ ESPN Africa: HTTP ${r.status} — data not accessible right now`);
    }

    // Also check ESPN fixtures endpoint
    const fixtureR = await fetch(
      'https://site.web.api.espn.com/apis/site/v2/sports/soccer/rsa.1/scoreboard',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8_000) }
    );
    if (fixtureR.ok) {
      const fData = await fixtureR.json();
      const events = fData?.events || [];
      results.espn.fixtures_available = true;
      results.espn.recent_fixtures = events.length;
      log.push(`  ✅ ESPN Fixtures: ${events.length} events accessible`);
    }

  } catch (e) {
    results.espn = { available: false, error: e.message };
    log.push(`  ❌ ESPN check failed: ${e.message}`);
  }

  log.push('\n  VERDICT: ' + (results.verdict || 'ESPN data check complete'));
  return results;
}

// ── Send email via Resend ─────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!RESEND_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Fantasy PSL <noreply@fantasypsl.co.za>',
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch (_) { return false; }
}

// ── Detect current phase of the season ───────────────────────────────────
async function detectSeasonPhase(db) {
  const now = new Date();

  // 1. Check app_settings for manual season_open flag
  const { data: setting } = await db
    .from('app_settings').select('value').eq('key', 'season_open').maybeSingle();
  const manualOpen = setting?.value === 'true';

  // 2. Get current season year from API-Football
  let seasonYear = process.env.APIFOOTBALL_SEASON
    ? parseInt(process.env.APIFOOTBALL_SEASON)
    : now.getFullYear();

  try {
    const leagues = await apiFetch(`/leagues?id=${PSL_LEAGUE}&current=true`);
    const league  = (leagues.response || [])[0];
    const current = (league?.seasons || []).find(s => s.current);
    if (current?.year) seasonYear = current.year;
  } catch (_) {}

  // 3. Check if season has any active fixtures
  const { data: fixtures } = await db
    .from('fixtures').select('id, kickoff_time, status, gw_number')
    .eq('season', seasonYear)
    .order('kickoff_time', { ascending: true })
    .limit(5);

  const { data: liveFixtures } = await db
    .from('fixtures').select('id')
    .eq('season', seasonYear)
    .in('status', ['LIVE', '1H', '2H', 'HT', 'ET', 'P', 'PEN'])
    .limit(1);

  const { data: currentGW } = await db
    .from('gameweeks').select('*')
    .eq('season', seasonYear).eq('is_current', true)
    .maybeSingle();

  const { data: firstFixture } = await db
    .from('fixtures').select('kickoff_time')
    .eq('season', seasonYear)
    .order('kickoff_time', { ascending: true })
    .limit(1).maybeSingle();

  // 4. Determine phase
  const firstKickoff = firstFixture?.kickoff_time
    ? new Date(firstFixture.kickoff_time)
    : null;

  const daysToSeason = firstKickoff
    ? Math.ceil((firstKickoff - now) / 86400000)
    : null;

  const hasLiveMatch   = (liveFixtures || []).length > 0;
  const hasFixtures    = (fixtures || []).length > 0;
  const registrationOpen = manualOpen || (daysToSeason !== null && daysToSeason <= 14);

  let phase = 'off-season';
  if (hasFixtures && daysToSeason !== null) {
    if (daysToSeason > 14)  phase = 'pre-season';
    else if (daysToSeason > 0) phase = 'registration-open';
    else                    phase = 'in-season';
  }

  // Check if season is over (all GWs finished)
  const { count: finishedGWs } = await db
    .from('gameweeks').select('id', { count: 'exact', head: true })
    .eq('season', seasonYear).eq('is_finished', true);
  const { count: totalGWs } = await db
    .from('gameweeks').select('id', { count: 'exact', head: true })
    .eq('season', seasonYear);

  if (totalGWs > 0 && finishedGWs >= totalGWs && totalGWs >= 25) {
    phase = 'season-over';
  }

  return {
    phase, seasonYear, daysToSeason, hasLiveMatch,
    firstKickoff, currentGW, registrationOpen, manualOpen,
    finishedGWs: finishedGWs || 0, totalGWs: totalGWs || 0,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN AGENT HANDLER
// ══════════════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', SITE_URL);

  const isCron   = req.headers['x-vercel-cron'] === '1';
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key || '';
  const isAdmin  = ADMIN && adminKey === ADMIN;

  if (!isCron && !isAdmin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: 'Supabase env vars missing' });
  }

  const action    = req.query.action || 'run';
  const db        = createClient(SB_URL, SB_KEY);
  const runId     = Date.now().toString(36);
  const startedAt = new Date().toISOString();
  const log       = [`[agent:${runId}] started at ${startedAt}`];
  const results   = {};

  // ── STATUS ONLY — no side effects ────────────────────────────────────
  if (action === 'status') {
    try {
      const phase = await detectSeasonPhase(db);
      const { data: lastRun } = await db
        .from('agent_log').select('*')
        .order('started_at', { ascending: false }).limit(1).maybeSingle();

      // Check ESPN if requested
      let espnCheck = null;
      if (req.query.check_espn === '1') {
        const espnLog = [];
        espnCheck = await checkEspnDataAvailability(espnLog);
      }

      return res.json({ success: true, phase, last_run: lastRun, espn: espnCheck,
        tip: espnCheck ? null : 'Add ?check_espn=1 to check ESPN Africa data availability' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── FULL AGENT RUN ────────────────────────────────────────────────────
  try {
    log.push('═══ FANTASY PSL MASTER AGENT ═══');

    // ── STEP 0: Detect season phase ──────────────────────────────────────
    log.push('\n[Phase Detection]');
    const phase = await detectSeasonPhase(db);
    log.push(`  Season: ${phase.seasonYear} | Phase: ${phase.phase}`);
    log.push(`  Days to season: ${phase.daysToSeason ?? 'N/A'}`);
    log.push(`  Gameweeks: ${phase.finishedGWs}/${phase.totalGWs} finished`);
    log.push(`  Registration open: ${phase.registrationOpen}`);
    log.push(`  Live match now: ${phase.hasLiveMatch}`);
    results.phase = phase;

    // ── STEP 1: Season gate management ───────────────────────────────────
    log.push('\n[Season Gate]');

    // Auto-open on 1 August 2026 regardless of fixture sync status
    var aug1 = new Date('2026-08-01T08:00:00+02:00');
    if (!phase.manualOpen && Date.now() >= aug1.getTime()) {
      log.push('  ✅ AUTO-OPENING: Past 1 August 2026 — opening registration now');
      await db.from('app_settings').upsert(
        { key: 'season_open', value: 'true', updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
      phase.manualOpen = true;
    }

    if (phase.phase === 'registration-open' && !phase.manualOpen) {
      // Auto-open registration 14 days before season
      await db.from('app_settings').upsert(
        { key: 'season_open', value: 'true', updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
      log.push('  ✅ AUTO-OPENED registration (14 days before season)');
      results.gateOpened = true;

      // Notify everyone on the waitlist
      const { data: waitlist } = await db.from('waitlist').select('email');
      if (waitlist?.length) {
        log.push(`  📧 Emailing ${waitlist.length} waitlist members...`);
        const html = `<!DOCTYPE html><html><body style="background:#0C0F14;color:#fff;font-family:Arial,sans-serif;padding:40px 20px">
<div style="max-width:560px;margin:auto;background:#121620;border-radius:16px;overflow:hidden">
<div style="background:linear-gradient(135deg,#B91C3A,#8B1020);padding:36px;text-align:center">
<h1 style="margin:0;font-size:26px;font-weight:900;color:#fff">🎉 Registration is Open!</h1>
<p style="margin:10px 0 0;color:rgba(255,255,255,.75);font-size:14px">Fantasy PSL 2026/27 Season</p>
</div>
<div style="padding:36px">
<p style="color:rgba(255,255,255,.8);font-size:15px;line-height:1.8">You are one of the first to know — <strong style="color:#fff">Fantasy PSL registration is now open!</strong></p>
<p style="color:rgba(255,255,255,.8);font-size:15px;line-height:1.8">Pick your 15-player squad, choose a captain, and compete in the 2026/27 Betway Premiership season.</p>
<div style="text-align:center;margin:28px 0">
<a href="${SITE_URL}" style="background:#B91C3A;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 36px;border-radius:10px;display:inline-block">Build My Squad →</a>
</div>
<p style="color:rgba(255,255,255,.4);font-size:12px;text-align:center">© 2026 Fantasy PSL · <a href="${SITE_URL}" style="color:#DBA94A;text-decoration:none">fantasypsl.co.za</a></p>
</div></div></body></html>`;

        let emailsSent = 0;
        for (const w of waitlist) {
          const ok = await sendEmail(w.email, '🎉 Fantasy PSL Registration is Open!', html);
          if (ok) emailsSent++;
          await new Promise(r => setTimeout(r, 200));
        }
        log.push(`  ✅ Sent registration open emails: ${emailsSent}/${waitlist.length}`);
        results.waitlistEmailed = emailsSent;
      }
    } else if (phase.phase === 'season-over' && phase.manualOpen) {
      // Auto-close registration when season ends
      await db.from('app_settings').upsert(
        { key: 'season_open', value: 'false', updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
      log.push('  ✅ AUTO-CLOSED season (all gameweeks finished)');
    } else {
      log.push(`  ℹ Season gate unchanged (phase: ${phase.phase})`);
    }

    // ── STEP 2: Player roster sync (pre-season and first 3 GWs) ──────────
    log.push('\n[Player Roster Sync]');
    const shouldSyncRosters =
      phase.phase === 'pre-season' ||
      phase.phase === 'registration-open' ||
      (phase.phase === 'in-season' && (phase.currentGW?.gw_number || 99) <= 3);

    if (shouldSyncRosters) {
      const r0 = await call(`/api/apifootball-sync?phase=0`);
      results.rosters = { ok: r0.ok };
      log.push(`  ${r0.ok ? '✅' : '❌'} Roster sync: ${r0.data?.log?.slice(-1)?.[0] || r0.error || 'done'}`);
    } else {
      log.push('  ℹ Roster sync skipped (mid-season)');
    }

    // ── STEP 3: Fixture sync ──────────────────────────────────────────────
    log.push('\n[Fixture Sync]');
    if (phase.phase !== 'off-season') {
      const r1 = await call(`/api/apifootball-sync?phase=1`);
      results.fixtures = { ok: r1.ok, count: r1.data?.fixtures_processed };
      log.push(`  ${r1.ok ? '✅' : '❌'} Fixtures: ${r1.data?.fixtures_processed || 0} synced`);
    } else {
      log.push('  ℹ Fixture sync skipped (off-season)');
    }

    // ── STEP 4: Match stats sync ──────────────────────────────────────────
    log.push('\n[Match Stats]');
    if (phase.phase === 'in-season') {
      const r2 = await call(`/api/apifootball-sync?phase=2`);
      results.stats = { ok: r2.ok, count: r2.data?.players_updated };
      log.push(`  ${r2.ok ? '✅' : '❌'} Stats: ${r2.data?.players_updated || 0} player rows`);

      // Recalculate season totals
      const r3 = await call(`/api/apifootball-sync?phase=3`);
      results.totals = { ok: r3.ok };
      log.push(`  ${r3.ok ? '✅' : '❌'} Totals recalculated`);
    } else {
      log.push(`  ℹ Stats sync skipped (phase: ${phase.phase})`);
    }

    // ── STEP 5: Injury sync ───────────────────────────────────────────────
    log.push('\n[Injury Sync]');
    if (phase.phase === 'in-season' || phase.phase === 'registration-open') {
      const r4 = await call(`/api/apifootball-sync?phase=4`);
      results.injuries = { ok: r4.ok };
      log.push(`  ${r4.ok ? '✅' : '❌'} Injury statuses updated`);
    } else {
      log.push('  ℹ Injury sync skipped');
    }

    // ── STEP 6: Points calculation ────────────────────────────────────────
    log.push('\n[Points Engine]');
    if (phase.phase === 'in-season') {
      // Only run scoring if there were matches yesterday or today
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const today     = new Date().toISOString().slice(0, 10);

      const { data: recentFT } = await db
        .from('fixtures').select('id')
        .eq('season', phase.seasonYear)
        .eq('status', 'FT')
        .gte('kickoff_time', yesterday + 'T00:00:00Z')
        .lte('kickoff_time', today + 'T23:59:59Z')
        .limit(1);

      if ((recentFT || []).length > 0) {
        const r5 = await call('/api/points-cron?cron=1');
        results.points = { ok: r5.ok, updated: r5.data?.profiles_updated };
        log.push(`  ✅ Points scored: ${r5.data?.profiles_updated || 0} squads updated`);
      } else {
        log.push('  ℹ No recent FT fixtures — skipping points calculation');
        results.points = { ok: true, skipped: true };
      }
    } else {
      log.push(`  ℹ Points engine skipped (phase: ${phase.phase})`);
    }

    // ── STEP 7: Gameweek lifecycle management ────────────────────────────
    log.push('\n[Gameweek Management]');
    if (phase.phase === 'in-season') {
      // Auto-close finished gameweeks
      const { data: gwToClose } = await db
        .from('gameweeks').select('id, gw_number')
        .eq('season', phase.seasonYear)
        .eq('is_current', true)
        .eq('is_finished', false);

      for (const gw of (gwToClose || [])) {
        // Check if all fixtures in this GW are FT
        const { count: total }    = await db.from('fixtures').select('id', { count: 'exact', head: true }).eq('gw_number', gw.gw_number).eq('season', phase.seasonYear);
        const { count: finished } = await db.from('fixtures').select('id', { count: 'exact', head: true }).eq('gw_number', gw.gw_number).eq('season', phase.seasonYear).eq('status', 'FT');

        if (total > 0 && finished >= total) {
          await db.from('gameweeks')
            .update({ is_finished: true, is_current: false })
            .eq('id', gw.id);
          log.push(`  ✅ GW${gw.gw_number} auto-closed (all ${total} fixtures FT)`);

          // Auto-open next GW
          const { data: nextGW } = await db
            .from('gameweeks').select('id, gw_number')
            .eq('season', phase.seasonYear)
            .eq('gw_number', gw.gw_number + 1)
            .maybeSingle();
          if (nextGW) {
            await db.from('gameweeks')
              .update({ is_current: true })
              .eq('id', nextGW.id);
            log.push(`  ✅ GW${nextGW.gw_number} auto-opened as current`);
          }
        }
      }
    } else {
      log.push(`  ℹ GW management skipped (phase: ${phase.phase})`);
    }

    // ── STEP 8: Player price adjustments ─────────────────────────────────
    log.push('\n[Player Prices]');
    if (phase.phase === 'in-season' && phase.currentGW?.gw_number > 1) {
      // Adjust prices based on transfer ownership (simplified FPL-style)
      // Players owned by >30% of squads → price rises by 0.1M
      // Players owned by <5% of squads → price drops by 0.1M

      const { count: totalSquads } = await db
        .from('profiles').select('id', { count: 'exact', head: true })
        .eq('squad_registered', true);

      if (totalSquads > 10) {
        const { data: players } = await db
          .from('players').select('id, psl_roster_id, price, display_name');

        for (const player of (players || []).slice(0, 50)) {
          // Count how many squads contain this player
          const { count: ownership } = await db
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('squad_registered', true)
            .contains('squad_data', JSON.stringify([{ id: player.id }]));

          const ownershipPct = totalSquads > 0 ? (ownership || 0) / totalSquads : 0;

          let newPrice = player.price;
          if (ownershipPct > 0.30 && player.price < 30.0) {
            newPrice = Math.min(30.0, Math.round((player.price + 0.1) * 10) / 10);
          } else if (ownershipPct < 0.05 && player.price > 4.5) {
            newPrice = Math.max(4.5, Math.round((player.price - 0.1) * 10) / 10);
          }

          if (newPrice !== player.price) {
            await db.from('players')
              .update({ price: newPrice, updated_at: new Date().toISOString() })
              .eq('id', player.id);
          }
        }
        log.push(`  ✅ Prices reviewed for ${(players || []).slice(0,50).length} players`);
        results.prices = { ok: true };
      } else {
        log.push('  ℹ Too few squads for price engine (<10)');
      }
    } else {
      log.push('  ℹ Price engine skipped');
    }

    // ── STEP 9: News crawler ─────────────────────────────────────────────
    log.push('\n[News Crawler]');
    const r6 = await call('/api/news-crawler?action=fetch');
    results.news = { ok: r6.ok, published: r6.data?.published };
    log.push(`  ${r6.ok ? '✅' : '❌'} News: ${r6.data?.published || 0} articles published`);

    // ── STEP 10: Self-healing ─────────────────────────────────────────────
    log.push('\n[Self-Healing]');

    // Heal profiles with squads but no entry_gw
    if (phase.currentGW) {
      const { data: brokenProfiles } = await db
        .from('profiles')
        .select('id')
        .eq('squad_registered', true)
        .is('entry_gw', null)
        .limit(50);

      if ((brokenProfiles || []).length > 0) {
        for (const p of brokenProfiles) {
          await db.from('profiles')
            .update({ entry_gw: phase.currentGW.gw_number })
            .eq('id', p.id);
        }
        log.push(`  ✅ Healed ${brokenProfiles.length} profiles missing entry_gw`);
      }
    }

    // Heal profiles with squad_count >= 15 but squad_registered = false
    const { data: unregistered } = await db
      .from('profiles').select('id')
      .gte('squad_count', 15).eq('squad_registered', false).limit(50);

    if ((unregistered || []).length > 0) {
      for (const p of unregistered) {
        await db.from('profiles')
          .update({ squad_registered: true })
          .eq('id', p.id);
      }
      log.push(`  ✅ Healed ${unregistered.length} unregistered complete squads`);
    }

    // Ensure app_settings exists
    await db.from('app_settings').upsert(
      { key: 'agent_last_run', value: new Date().toISOString() },
      { onConflict: 'key' }
    );

    // ── STEP 11: Season-end detection and archiving ───────────────────────
    log.push('\n[Season End Check]');
    if (phase.phase === 'season-over') {
      // Check if we already archived this season
      const { data: archived } = await db
        .from('app_settings').select('value')
        .eq('key', `season_${phase.seasonYear}_archived`).maybeSingle();

      if (!archived) {
        log.push(`  🏁 Season ${phase.seasonYear} complete — archiving...`);

        // Lock all squads
        await db.from('profiles')
          .update({ squad_locked: true })
          .eq('squad_registered', true);

        // Get top 3 winners
        const { data: winners } = await db
          .from('profiles').select('id, username, team_name, total_points')
          .eq('squad_registered', true)
          .order('total_points', { ascending: false })
          .limit(3);

        log.push(`  🏆 Champions: ${(winners || []).map((w,i) => `${i+1}. ${w.team_name||w.username} (${w.total_points}pts)`).join(', ')}`);

        // Post season-over announcement
        await db.from('announcements').insert({
          title:       `🏆 Season ${phase.seasonYear}/${String(phase.seasonYear+1).slice(2)} Complete!`,
          message:     `Congratulations to all our Fantasy PSL managers! The season is over. Thank you for playing.`,
          color:       'green',
          is_breaking: true,
          is_active:   true,
          created_at:  new Date().toISOString(),
        }).catch(() => {});

        // Mark as archived
        await db.from('app_settings').upsert(
          { key: `season_${phase.seasonYear}_archived`, value: 'true' },
          { onConflict: 'key' }
        );

        log.push('  ✅ Season archived and squads locked');
        results.seasonArchived = true;
      } else {
        log.push(`  ℹ Season ${phase.seasonYear} already archived`);
      }
    } else {
      log.push('  ℹ Season still active');
    }

    // ── STEP 12: Rankings update ──────────────────────────────────────────
    log.push('\n[Rankings]');
    if (phase.phase === 'in-season' && results.points?.ok && !results.points?.skipped) {
      const { data: allProfiles } = await db
        .from('profiles').select('id, total_points')
        .eq('squad_registered', true)
        .order('total_points', { ascending: false });

      let rank = 1;
      for (const p of (allProfiles || [])) {
        await db.from('profiles').update({ overall_rank: rank++ }).eq('id', p.id);
      }
      log.push(`  ✅ Rankings updated: ${rank - 1} profiles ranked`);
      results.rankings = { ok: true, total: rank - 1 };
    } else {
      log.push('  ℹ Rankings update skipped');
    }

    // ── DONE ─────────────────────────────────────────────────────────────
    const duration = ((Date.now() - new Date(startedAt).getTime()) / 1000).toFixed(1);
    log.push(`\n═══ AGENT RUN COMPLETE in ${duration}s ═══`);
    log.push(`Phase: ${phase.phase} | Season: ${phase.seasonYear}`);

    // Log to agent_log table
    try {
      await db.from('agent_log').insert({
        run_id:     runId,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        duration_s: parseFloat(duration),
        phase:      phase.phase,
        season:     phase.seasonYear,
        results:    results,
        log:        log,
        success:    true,
      });
    } catch (_) {
      // agent_log table may not exist yet — create it
      try {
        await db.rpc('exec_sql', { sql: `
          CREATE TABLE IF NOT EXISTS agent_log (
            id          bigserial PRIMARY KEY,
            run_id      text,
            started_at  timestamptz,
            finished_at timestamptz,
            duration_s  numeric,
            phase       text,
            season      integer,
            results     jsonb,
            log         jsonb,
            success     boolean DEFAULT true,
            created_at  timestamptz DEFAULT now()
          );
        `}).catch(() => {});
      } catch (_) {}
    }

    return res.json({
      success:  true,
      run_id:   runId,
      duration: `${duration}s`,
      phase:    phase.phase,
      season:   phase.seasonYear,
      results,
      log,
    });

  } catch (err) {
    log.push(`\n❌ FATAL: ${err.message}`);
    console.error('[master-agent]', err.message);

    try {
      await createClient(SB_URL, SB_KEY).from('agent_log').insert({
        run_id: runId, started_at: startedAt,
        finished_at: new Date().toISOString(),
        phase: 'error', success: false,
        log, results,
      });
    } catch (_) {}

    return res.status(500).json({ success: false, error: err.message, log, results });
  }
};
