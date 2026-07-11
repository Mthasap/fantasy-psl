// api/cron-orchestrator.js — Fantasy PSL — Master Daily Cron
// ══════════════════════════════════════════════════════════════════════
// Replaces all 4 individual crons with ONE daily job (Vercel Hobby limit).
// Runs at 02:00 UTC daily via vercel.json cron schedule.
// Can also be triggered manually by admin.
//
// Schedule: 0 2 * * *  (02:00 UTC = 04:00 SAST daily)
// ══════════════════════════════════════════════════════════════════════

'use strict';

const ADMIN = process.env.ADMIN_SECRET || '';

// Calls our own API endpoints internally
async function callInternal(path) {
  const base = process.env.VERCEL_URL
    ? 'https://' + process.env.VERCEL_URL
    : (process.env.SITE_URL || 'https://www.fantasypsl.co.za');

  const url = base + path;
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'x-vercel-cron':  '1',
        'x-admin-key':    ADMIN,
        'x-sync-secret':  process.env.SYNC_SECRET || ADMIN,
      },
      signal: AbortSignal.timeout(50_000),
    });
    const data = await r.json().catch(() => ({ status: r.status }));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: {}, error: e.message };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // Auth: Vercel cron header OR admin key
  const isCron   = req.headers['x-vercel-cron'] === '1';
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key || '';
  const isAdmin  = ADMIN && adminKey === ADMIN;

  if (!isCron && !isAdmin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const job = req.query.job || 'all';
  const log = [`[cron] job=${job} started at ${new Date().toISOString()}`];
  const results = {};

  // ── Step 1: Sync fixtures from API-Football ──────────────────────────
  log.push('Step 1: Fixture sync (apifootball-sync phase=1)');
  const r1 = await callInternal('/api/apifootball-sync?phase=1');
  results.fixtures = { ok: r1.ok, count: r1.data?.fixtures_processed };
  log.push('  ' + (r1.ok ? `✅ ${r1.data?.fixtures_processed || 0} fixtures` : `❌ ${r1.error || 'HTTP ' + r1.status}`));

  // ── Step 2: Sync match player stats ────────────────────────────────
  log.push('Step 2: Match stats (apifootball-sync phase=2)');
  const r2 = await callInternal('/api/apifootball-sync?phase=2');
  results.stats = { ok: r2.ok, count: r2.data?.players_updated };
  log.push('  ' + (r2.ok ? `✅ ${r2.data?.players_updated || 0} player stats` : `❌ ${r2.error || 'HTTP ' + r2.status}`));

  // ── Step 3: Recalculate player season totals ────────────────────────
  log.push('Step 3: Season totals (apifootball-sync phase=3)');
  const r3 = await callInternal('/api/apifootball-sync?phase=3');
  results.totals = { ok: r3.ok };
  log.push('  ' + (r3.ok ? '✅ totals updated' : `❌ ${r3.error || 'HTTP ' + r3.status}`));

  // ── Step 4: Sync injury statuses ────────────────────────────────────
  log.push('Step 4: Injuries (apifootball-sync phase=4)');
  const r4 = await callInternal('/api/apifootball-sync?phase=4');
  results.injuries = { ok: r4.ok };
  log.push('  ' + (r4.ok ? '✅ injuries updated' : `❌ ${r4.error || 'HTTP ' + r4.status}`));

  // ── Step 5: Score all user squads ───────────────────────────────────
  log.push('Step 5: Points calculation (points-cron)');
  const r5 = await callInternal('/api/points-cron?cron=1');
  results.points = { ok: r5.ok, updated: r5.data?.profiles_updated };
  log.push('  ' + (r5.ok ? `✅ ${r5.data?.profiles_updated || 0} squads scored` : `❌ ${r5.error || 'HTTP ' + r5.status}`));

  // ── Step 6: Crawl SA football RSS news ──────────────────────────────
  log.push('Step 6: News crawler (RSS feeds)');
  const r6 = await callInternal('/api/news-crawler?action=fetch');
  results.news = { ok: r6.ok, published: r6.data?.published };
  log.push('  ' + (r6.ok ? `✅ ${r6.data?.published || 0} articles published` : `❌ ${r6.error || 'HTTP ' + r6.status}`));

  const allOk = Object.values(results).every(r => r.ok);
  log.push(`\nDone at ${new Date().toISOString()} — ${allOk ? 'all steps OK ✅' : 'some steps failed ⚠️'}`);

  console.log(log.join('\n'));
  return res.status(200).json({ success: true, job, results, log });
};
