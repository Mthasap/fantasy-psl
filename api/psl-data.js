// ══════════════════════════════════════════════════════════════════════════
// api/psl-data.js  —  Fantasy PSL  —  Supabase Data Bundle
// ══════════════════════════════════════════════════════════════════════════
// Serves fixtures, table, stats and news from Supabase to the frontend.
// The nightly points-cron.js keeps Supabase up to date from Sportmonks.
// This means the frontend ALWAYS gets live data — no hardcoding needed.
//
// ENDPOINTS:
//   GET /api/psl-data          → full bundle (fixtures + table + news)
//   GET /api/psl-data?type=live → live scores from Sportmonks (via football.js)
//
// ENV VARS:
//   SUPABASE_URL         — your Supabase project URL
//   SUPABASE_SERVICE_KEY — your Supabase service role key
// ══════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL        || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const CACHE = { bundle: { data: null, ts: 0, ttl: 5 * 60 * 1000 } }; // 5 min

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (!SUPABASE_URL) return res.status(500).json({ error: 'SUPABASE_URL not set' });

  try {
    const cached = CACHE.bundle;
    if (cached.data && (Date.now() - cached.ts) < cached.ttl) {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      return res.json(cached.data);
    }

    // Fetch everything in parallel from Supabase
    const [gwRes, fixturesRes, standingsRes] = await Promise.all([
      sbGet('/gameweeks?is_current=eq.true&limit=1'),
      sbGet('/fixtures?order=kickoff_at.asc&limit=100'),
      sbGet('/profiles?select=username,team_name,total_points&order=total_points.desc&limit=100')
    ]);

    const currentGW = (gwRes[0] || {}).number || null;

    // Split fixtures into FT, NS, LIVE
    const FT   = fixturesRes.filter(function(f) { return f.status === 'FT'; });
    const NS   = fixturesRes.filter(function(f) { return f.status === 'NS'; });
    const live = fixturesRes.filter(function(f) { return f.status === 'LIVE'; });

    const bundle = {
      currentGW: currentGW,
      FT:        FT,
      NS:        NS,
      live:      live,
      standings: standingsRes,
      ts:        Date.now()
    };

    CACHE.bundle = { data: bundle, ts: Date.now(), ttl: CACHE.bundle.ttl };
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.json(bundle);

  } catch (err) {
    console.error('[psl-data]', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Supabase REST helper ──────────────────────────────────────────────────
async function sbGet(path) {
  const url = SUPABASE_URL + '/rest/v1' + path;
  const r = await fetch(url, {
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Accept':        'application/json'
    }
  });
  if (!r.ok) throw new Error('Supabase HTTP ' + r.status + ' for ' + path);
  return r.json();
}
