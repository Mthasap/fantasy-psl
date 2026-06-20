// tests/test-suite.js — Fantasy PSL — Full Test Suite
// ══════════════════════════════════════════════════════════════════════════
// Run with: node tests/test-suite.js
// Or add to package.json: "test": "node tests/test-suite.js"
//
// No external test framework needed — pure Node.js.
// Set TEST_BASE_URL env var to run against staging, otherwise uses localhost.
// ══════════════════════════════════════════════════════════════════════════

'use strict';

const BASE    = process.env.TEST_BASE_URL || 'https://www.fantasypsl.co.za';
const ADMIN_KEY = process.env.ADMIN_SECRET || process.env.TEST_ADMIN_KEY || '';

// ── Tiny test harness ─────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ status: 'PASS', name });
    process.stdout.write('\x1b[32m✓\x1b[0m ' + name + '\n');
  } catch(e) {
    failed++;
    results.push({ status: 'FAIL', name, error: e.message });
    process.stdout.write('\x1b[31m✗\x1b[0m ' + name + '\n  → ' + e.message + '\n');
  }
}

function skip(name, reason) {
  skipped++;
  results.push({ status: 'SKIP', name, reason });
  process.stdout.write('\x1b[33m○\x1b[0m ' + name + ' (skipped: ' + reason + ')\n');
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error((msg || 'Expected equal') + `: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

async function get(path, headers = {}) {
  const r = await fetch(BASE + path, { headers });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}

async function post(path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body:    JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ══════════════════════════════════════════════════════════════════════════
// TEST GROUPS
// ══════════════════════════════════════════════════════════════════════════

async function runSecurityTests() {
  console.log('\n\x1b[1m── Security & Rate Limiting ──\x1b[0m');

  await test('Admin API rejects missing key', async () => {
    const r = await post('/api/admin-api', { action: 'select', table: 'profiles' });
    assert(r.status === 401, 'Expected 401, got ' + r.status);
  });

  await test('Admin API rejects wrong key', async () => {
    const r = await post('/api/admin-api', { action: 'select', table: 'profiles' }, { 'x-admin-key': 'wrong-key-xyz' });
    assert(r.status === 401, 'Expected 401, got ' + r.status);
  });

  await test('Admin API rejects disallowed table', async () => {
    if (!ADMIN_KEY) { skip('Admin API table guard', 'no ADMIN_KEY set'); return; }
    const r = await post('/api/admin-api', { action: 'select', table: 'auth.users' }, { 'x-admin-key': ADMIN_KEY });
    assert(r.status === 403 || r.body?.error?.includes('not permitted'), 'Expected 403, got ' + r.status);
  });

  await test('Save-squad rejects unauthenticated request', async () => {
    const r = await post('/api/save-squad', { squad_data: [] });
    assert(r.status === 401, 'Expected 401 for missing token, got ' + r.status);
  });

  await test('Save-squad rejects invalid JWT', async () => {
    const r = await post('/api/save-squad', { squad_data: [] }, { Authorization: 'Bearer not-a-real-token' });
    assert(r.status === 401, 'Expected 401 for bad token, got ' + r.status);
  });

  await test('News crawler rejects unauthenticated fetch action', async () => {
    const r = await get('/api/news-crawler?action=fetch', { origin: 'https://www.fantasypsl.co.za' });
    assert(r.status === 401, 'Expected 401, got ' + r.status);
  });

  await test('Points cron rejects unauthenticated request', async () => {
    const r = await post('/api/points-cron', {});
    assert(r.status === 401, 'Expected 401, got ' + r.status);
  });

  await test('API responds with security headers', async () => {
    const r = await fetch(BASE + '/api/football?type=standings');
    const xct = r.headers.get('x-content-type-options');
    assert(xct === 'nosniff', 'Missing X-Content-Type-Options: nosniff, got: ' + xct);
  });
}

async function runApiTests() {
  console.log('\n\x1b[1m── API Endpoints ──\x1b[0m');

  await test('Football API returns standings', async () => {
    const r = await get('/api/football?type=standings');
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(r.body !== null, 'Expected JSON response');
  });

  await test('Football API returns fixtures', async () => {
    const r = await get('/api/football?type=fixtures');
    assert(r.status === 200, 'Expected 200, got ' + r.status);
  });

  await test('News crawler status endpoint', async () => {
    const r = await get('/api/news-crawler?action=status');
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(typeof r.body?.sources === 'number', 'Expected sources count in response');
  });

  await test('News crawler cached endpoint returns array', async () => {
    const r = await get('/api/news-crawler?action=cached');
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(Array.isArray(r.body?.data), 'Expected data array, got: ' + JSON.stringify(r.body));
  });

  await test('Sitemap.xml returns valid XML', async () => {
    const r = await fetch(BASE + '/sitemap.xml');
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    const text = await r.text();
    assert(text.includes('<sitemapindex'), 'Expected sitemap XML, got: ' + text.slice(0, 100));
  });

  await test('robots.txt is served', async () => {
    const r = await fetch(BASE + '/robots.txt');
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    const text = await r.text();
    assert(text.includes('User-agent'), 'Expected robots.txt content');
  });

  await test('manifest.json is valid JSON with required fields', async () => {
    const r = await fetch(BASE + '/manifest.json');
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    const j = await r.json();
    assert(j.name, 'Missing name in manifest');
    assert(j.icons && j.icons.length > 0, 'Missing icons in manifest');
    assert(j.start_url, 'Missing start_url in manifest');
  });

  await test('Season reset status endpoint', async () => {
    const r = await get('/api/season-reset?action=status');
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(typeof r.body?.season === 'number' || r.body?.season === null, 'Expected season in response');
  });
}

async function runAdminTests() {
  if (!ADMIN_KEY) {
    console.log('\n\x1b[1m── Admin API ──\x1b[0m');
    skip('All admin tests', 'TEST_ADMIN_KEY not set — set it in env to run admin tests');
    return;
  }

  console.log('\n\x1b[1m── Admin API ──\x1b[0m');

  await test('Admin API select players returns array', async () => {
    const r = await post('/api/admin-api', {
      action: 'select', table: 'players', select: 'id,display_name,position', limit: 5
    }, { 'x-admin-key': ADMIN_KEY });
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(Array.isArray(r.body?.data), 'Expected data array');
  });

  await test('Admin API select gameweeks returns array', async () => {
    const r = await post('/api/admin-api', {
      action: 'select', table: 'gameweeks', select: 'gw_number,is_current,is_finished', limit: 5
    }, { 'x-admin-key': ADMIN_KEY });
    assert(r.status === 200, 'Expected 200, got ' + r.status);
  });

  await test('Admin list-users endpoint', async () => {
    const r = await get('/api/admin-api?action=list-users&limit=5', { 'x-admin-key': ADMIN_KEY });
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(Array.isArray(r.body?.users), 'Expected users array');
  });

  await test('Apifootball sync diagnostic (phase=0)', async () => {
    const r = await get('/api/apifootball-sync?phase=0', {
      'x-admin-key': ADMIN_KEY, 'x-sync-secret': ADMIN_KEY
    });
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(Array.isArray(r.body?.log), 'Expected log array');
  });
}

async function runScoringTests() {
  console.log('\n\x1b[1m── Scoring Logic ──\x1b[0m');

  // Import scoring module directly (unit test)
  let scoring;
  try {
    scoring = require('./football_scoring.js');
  } catch(e) {
    skip('All scoring unit tests', 'Cannot require football_scoring.js: ' + e.message);
    return;
  }

  const { calculateFantasyPoints } = scoring;

  await test('GK: 90 mins, clean sheet = 6 pts', async () => {
    const r = calculateFantasyPoints({ minutes: 90, pos: 'GK', goals: 0, assists: 0, goalsConceded: 0, saves: 0, penSaved: 0, penMissed: 0, yellowCards: 0, redCards: 0 });
    assertEqual(r.total, 6, 'GK 90min clean sheet');  // 2 app + 4 clean
  });

  await test('FWD: goal + assist = 9 pts', async () => {
    const r = calculateFantasyPoints({ minutes: 90, pos: 'FWD', goals: 1, assists: 1, goalsConceded: 0, saves: 0, penSaved: 0, penMissed: 0, yellowCards: 0, redCards: 0 });
    assertEqual(r.total, 9, 'FWD goal+assist');  // 2 app + 4 goal + 3 assist
  });

  await test('MID: goal = 7 pts', async () => {
    const r = calculateFantasyPoints({ minutes: 90, pos: 'MID', goals: 1, assists: 0, goalsConceded: 0, saves: 0, penSaved: 0, penMissed: 0, yellowCards: 0, redCards: 0 });
    assertEqual(r.total, 7, 'MID goal');  // 2 app + 5 goal
  });

  await test('DEF: goal + clean sheet = 12 pts', async () => {
    const r = calculateFantasyPoints({ minutes: 90, pos: 'DEF', goals: 1, assists: 0, goalsConceded: 0, saves: 0, penSaved: 0, penMissed: 0, yellowCards: 0, redCards: 0 });
    assertEqual(r.total, 12, 'DEF goal+clean');  // 2 app + 6 goal + 4 clean
  });

  await test('Red card deduction', async () => {
    const r = calculateFantasyPoints({ minutes: 90, pos: 'MID', goals: 0, assists: 0, goalsConceded: 0, saves: 0, penSaved: 0, penMissed: 0, yellowCards: 0, redCards: 1 });
    assertEqual(r.total, -1, 'MID red card');  // 2 app - 3 red
  });

  await test('0 minutes played = 0 points', async () => {
    const r = calculateFantasyPoints({ minutes: 0, pos: 'FWD', goals: 1, assists: 0, goalsConceded: 0, saves: 0, penSaved: 0, penMissed: 0, yellowCards: 0, redCards: 0 });
    assertEqual(r.total, 0, '0 minutes = 0 pts regardless of stats');
  });

  await test('GK: 9 saves = +3 bonus', async () => {
    const r = calculateFantasyPoints({ minutes: 90, pos: 'GK', goals: 0, assists: 0, goalsConceded: 0, saves: 9, penSaved: 0, penMissed: 0, yellowCards: 0, redCards: 0 });
    assertEqual(r.total, 9, 'GK 9 saves + clean');  // 2 app + 4 clean + 3 saves
  });
}

async function runPwaTests() {
  console.log('\n\x1b[1m── PWA / App Store Readiness ──\x1b[0m');

  await test('Service worker is served with correct headers', async () => {
    const r = await fetch(BASE + '/sw.js');
    assert(r.status === 200, 'sw.js returned ' + r.status);
    const cc = r.headers.get('cache-control') || '';
    assert(cc.includes('no-cache') || cc.includes('no-store'), 'sw.js must not be cached, got: ' + cc);
  });

  await test('App is served with PWA meta tags', async () => {
    const r = await fetch(BASE + '/');
    assert(r.status === 200, 'Home page returned ' + r.status);
    const html = await r.text();
    assert(html.includes('manifest.json'), 'Missing manifest link');
    assert(html.includes('apple-mobile-web-app-capable'), 'Missing Apple PWA meta');
    assert(html.includes('theme-color'), 'Missing theme-color meta');
  });

  await test('Confirm page exists', async () => {
    const r = await fetch(BASE + '/confirm');
    assert(r.status === 200, '/confirm returned ' + r.status);
  });

  await test('About page exists', async () => {
    const r = await fetch(BASE + '/about');
    assert(r.status === 200, '/about returned ' + r.status);
  });

  await test('Terms page exists', async () => {
    const r = await fetch(BASE + '/terms');
    assert(r.status === 200, '/terms returned ' + r.status);
  });

  await test('Privacy page exists', async () => {
    const r = await fetch(BASE + '/privacy');
    // Either 200 or redirect (301/302) is OK — page must exist
    assert(r.status < 400, '/privacy returned ' + r.status);
  });
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('\x1b[1mFantasy PSL Test Suite\x1b[0m');
  console.log('Target:', BASE);
  console.log('Admin key:', ADMIN_KEY ? '✓ set' : '✗ not set (admin tests will be skipped)');
  console.log('');

  await runSecurityTests();
  await runApiTests();
  await runAdminTests();
  await runScoringTests();
  await runPwaTests();

  console.log('\n\x1b[1m── Results ──\x1b[0m');
  console.log(`\x1b[32m✓ ${passed} passed\x1b[0m  \x1b[31m✗ ${failed} failed\x1b[0m  \x1b[33m○ ${skipped} skipped\x1b[0m`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log('  ✗ ' + r.name + '\n    ' + r.error);
    });
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
