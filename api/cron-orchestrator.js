// api/cron-orchestrator.js — Fantasy PSL — Master Cron Orchestrator
// ══════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Combines all scheduled jobs into 2 cron endpoints to stay
//   within Vercel Hobby free tier limit of 2 cron jobs.
//
//   CRON A (daily at 01:00 UTC): fixtures + stats + points
//     → apifootball-sync phase 1 (fixtures)
//     → apifootball-sync phase 2 (match stats)
//     → apifootball-sync phase 3 (player totals)
//     → apifootball-sync phase 4 (injuries)
//     → points-cron (score all squads)
//
//   CRON B (every 6 hours): content + news
//     → news-crawler (RSS feeds → PSL articles)
//     → news-agent (AI-generated articles)
//
// ENDPOINTS:
//   GET /api/cron-orchestrator?job=daily   ← Vercel cron at 01:00 UTC daily
//   GET /api/cron-orchestrator?job=content ← Vercel cron every 6 hours
//
// ══════════════════════════════════════════════════════════════════════════

'use strict';

const BASE_URL = process.env.VERCEL_URL
  ? 'https://' + process.env.VERCEL_URL
  : (process.env.SITE_URL || 'https://www.fantasypsl.co.za');

// Internal fetch helper — calls our own API endpoints
async function callInternal(path, method = 'GET', body = null) {
  const url  = BASE_URL + path;
  const opts = {
    method,
    headers: {
      'x-vercel-cron': '1',                               // bypasses auth on endpoints
      'x-admin-key':   process.env.ADMIN_SECRET || '',
      'x-sync-secret': process.env.SYNC_SECRET  || process.env.ADMIN_SECRET || '',
      'Content-Type':  'application/json',
    },
    signal: AbortSignal.timeout(55_000),                  // Vercel function timeout is 60s
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({ status: r.status }));
  return { status: r.status, ok: r.ok, data };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // Only allow Vercel cron or admin key
  const isCron     = req.headers['x-vercel-cron'] === '1';
  const adminKey   = req.headers['x-admin-key'] || req.query.admin_key || '';
  const ADMIN      = process.env.ADMIN_SECRET || '';
  const isAdmin    = ADMIN && adminKey === ADMIN;

  if (!isCron && !isAdmin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const job = req.query.job || 'daily';
  const log = [`[cron-orchestrator] job=${job} at ${new Date().toISOString()}`];
  const results = {};

  // ── JOB A: daily — sync stats + score points ────────────────────────────
  if (job === 'daily') {
    log.push('Step 1: apifootball-sync phase=1 (fixtures)');
    try {
      const r1 = await callInternal('/api/apifootball-sync?phase=1');
      results.fixtures = { ok: r1.ok, fixtures: r1.data?.fixtures_processed };
      log.push('  → ' + (r1.ok ? `✅ ${r1.data?.fixtures_processed || 0} fixtures` : `❌ HTTP ${r1.status}`));
    } catch (e) { results.fixtures = { ok: false, error: e.message }; log.push('  → ❌ ' + e.message); }

    log.push('Step 2: apifootball-sync phase=2 (match stats)');
    try {
      const r2 = await callInternal('/api/apifootball-sync?phase=2');
      results.stats = { ok: r2.ok, players: r2.data?.players_updated };
      log.push('  → ' + (r2.ok ? `✅ ${r2.data?.players_updated || 0} player stats` : `❌ HTTP ${r2.status}`));
    } catch (e) { results.stats = { ok: false, error: e.message }; log.push('  → ❌ ' + e.message); }

    log.push('Step 3: apifootball-sync phase=3 (totals)');
    try {
      const r3 = await callInternal('/api/apifootball-sync?phase=3');
      results.totals = { ok: r3.ok };
      log.push('  → ' + (r3.ok ? '✅ totals recalculated' : `❌ HTTP ${r3.status}`));
    } catch (e) { results.totals = { ok: false, error: e.message }; log.push('  → ❌ ' + e.message); }

    log.push('Step 4: apifootball-sync phase=4 (injuries)');
    try {
      const r4 = await callInternal('/api/apifootball-sync?phase=4');
      results.injuries = { ok: r4.ok };
      log.push('  → ' + (r4.ok ? '✅ injuries updated' : `❌ HTTP ${r4.status}`));
    } catch (e) { results.injuries = { ok: false, error: e.message }; log.push('  → ❌ ' + e.message); }

    log.push('Step 5: points-cron (score squads)');
    try {
      const r5 = await callInternal('/api/points-cron?cron=1');
      results.points = { ok: r5.ok, updated: r5.data?.profiles_updated };
      log.push('  → ' + (r5.ok ? `✅ ${r5.data?.profiles_updated || 0} profiles scored` : `❌ HTTP ${r5.status}`));
    } catch (e) { results.points = { ok: false, error: e.message }; log.push('  → ❌ ' + e.message); }
  }

  // ── JOB B: content — news crawler + AI agent ───────────────────────────
  else if (job === 'content') {
    log.push('Step 1: news-crawler (RSS feeds)');
    try {
      const r1 = await callInternal('/api/news-crawler?action=fetch');
      results.crawler = { ok: r1.ok, published: r1.data?.published, fetched: r1.data?.fetched };
      log.push('  → ' + (r1.ok ? `✅ ${r1.data?.published || 0} articles published` : `❌ HTTP ${r1.status}`));
    } catch (e) { results.crawler = { ok: false, error: e.message }; log.push('  → ❌ ' + e.message); }

    log.push('Step 2: news-agent (AI articles)');
    try {
      const r2 = await callInternal('/api/news-agent?action=generate-batch');
      results.agent = { ok: r2.ok, published: r2.data?.published };
      log.push('  → ' + (r2.ok ? `✅ ${r2.data?.published || 0} AI articles generated` : `❌ HTTP ${r2.status}`));
    } catch (e) { results.agent = { ok: false, error: e.message }; log.push('  → ❌ ' + e.message); }
  }

  else {
    return res.status(400).json({ error: 'Unknown job: ' + job + '. Use ?job=daily or ?job=content' });
  }

  const allOk = Object.values(results).every(r => r.ok);
  log.push(`\nJob ${job} ${allOk ? 'COMPLETED ✅' : 'COMPLETED WITH ERRORS ⚠️'}`);

  console.log(log.join('\n'));
  return res.json({ success: allOk, job, results, log });
};
