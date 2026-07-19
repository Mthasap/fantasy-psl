// api/news-crawler.js — Fantasy Pro Soccer League — News Crawler v4
// ══════════════════════════════════════════════════════════════════════════
//
// ROOT CAUSE OF v3 FAILURE:
//   Vercel Hobby blocks outbound HTTP to domains not in the project's
//   network egress allowlist. ALL SA sports RSS sites returned 403.
//
// v4 SOLUTION — Three-tier approach:
//
//   TIER 1: GNews API (free 100 req/day, works from Vercel, real SA news)
//            Requires: GNEWS_API_KEY env var in Vercel
//            Sign up free: https://gnews.io (takes 2 minutes)
//
//   TIER 2: NewsData.io (free 200 req/day, works from Vercel)
//            Requires: NEWSDATA_API_KEY env var in Vercel (optional)
//            Sign up free: https://newsdata.io
//
//   TIER 3: Manual — admin posts articles via admin panel
//            Always works, no API key needed
//
// USAGE:
//   Trigger:  GET /api/news-crawler?action=fetch&admin_key=YOUR_KEY
//   Status:   GET /api/news-crawler?action=status&admin_key=YOUR_KEY
//
// ══════════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL       = process.env.SUPABASE_URL         || '';
const SB_KEY       = process.env.SUPABASE_SERVICE_KEY || '';
const ADMIN_KEY    = process.env.ADMIN_SECRET         || '';
const GNEWS_KEY    = process.env.GNEWS_API_KEY        || '';
const NEWSDATA_KEY = process.env.NEWSDATA_API_KEY     || '';

// ── Rate limiter ──────────────────────────────────────────────────────────
const _rl = new Map();
function rateLimit(ip, max = 20, ms = 60_000) {
  const now = Date.now();
  const rec = _rl.get(ip) || { c: 0, r: now + ms };
  if (now > rec.r) { rec.c = 0; rec.r = now + ms; }
  rec.c++; _rl.set(ip, rec);
  return rec.c > max;
}

// ── Build slug ────────────────────────────────────────────────────────────
function makeSlug(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .slice(0, 70)
    + '-' + Date.now().toString(36)
    + '-' + Math.random().toString(36).slice(2, 5);
}

// ── Build external_id ─────────────────────────────────────────────────────
function makeExtId(source, url) {
  const raw = (source + '||' + url).slice(0, 180);
  return Buffer.from(raw).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    .slice(0, 64);
}

// ── Map category from article data ────────────────────────────────────────
function getCategory(title, description) {
  const text = ((title || '') + ' ' + (description || '')).toLowerCase();
  if (text.includes('transfer') || text.includes('sign') || text.includes('join')) return 'Transfer News';
  if (text.includes('injury') || text.includes('injur') || text.includes('miss')) return 'Injury';
  if (text.includes('bafana') || text.includes('national team')) return 'Bafana';
  if (text.includes('mtn8') || text.includes('nedbank') || text.includes('cup')) return 'Cup';
  return 'PSL News';
}

// ── TIER 1: GNews API ─────────────────────────────────────────────────────
async function fetchGNews() {
  if (!GNEWS_KEY) return { items: [], error: 'GNEWS_API_KEY not set — sign up free at gnews.io' };

  const queries = [
    'Betway Premiership',
    'PSL soccer South Africa',
    'Kaizer Chiefs OR Orlando Pirates OR Mamelodi Sundowns',
  ];

  const all = [];
  const seen = new Set();

  for (const q of queries) {
    try {
      const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=en&country=za&max=10&apikey=${GNEWS_KEY}&sortby=publishedAt`;
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) {
        console.warn(`[gnews] HTTP ${r.status} for query: ${q}`);
        continue;
      }
      const data = await r.json();
      for (const a of (data.articles || [])) {
        const key = a.url;
        if (seen.has(key)) continue;
        seen.add(key);

        const extId = makeExtId('gnews', a.url);
        all.push({
          title:        (a.title || '').slice(0, 250),
          slug:         makeSlug(a.title || 'article'),
          summary:      (a.description || a.title || '').slice(0, 300),
          excerpt:      (a.description || a.title || '').slice(0, 300),
          content:      `<p>${(a.description || a.title || '').slice(0, 800)}</p><p><a href="${a.url}" target="_blank" rel="noopener noreferrer">Read full article on ${a.source?.name || 'source'} →</a></p>`,
          category:     getCategory(a.title, a.description),
          image_url:    a.image || null,
          published_at: a.publishedAt ? new Date(a.publishedAt).toISOString() : new Date().toISOString(),
          published:    true,
          author:       a.source?.name || 'GNews',
          source_url:   a.url,
          source_name:  a.source?.name || 'GNews',
          is_external:  true,
          external_id:  extId,
        });
      }
    } catch (e) {
      console.warn(`[gnews] Query failed: ${q} — ${e.message}`);
    }
    // Small delay between queries
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[gnews] Total articles fetched: ${all.length}`);
  return { items: all, error: null };
}

// ── TIER 2: NewsData.io ───────────────────────────────────────────────────
async function fetchNewsData() {
  if (!NEWSDATA_KEY) return { items: [], error: 'NEWSDATA_API_KEY not set — sign up free at newsdata.io' };

  try {
    const url = `https://newsdata.io/api/1/news?apikey=${NEWSDATA_KEY}&q=betway+premiership+OR+PSL+soccer&country=za&language=en&category=sports`;
    const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!r.ok) return { items: [], error: `HTTP ${r.status}` };

    const data = await r.json();
    const items = (data.results || []).map(a => ({
      title:        (a.title || '').slice(0, 250),
      slug:         makeSlug(a.title || 'article'),
      summary:      (a.description || a.title || '').slice(0, 300),
      excerpt:      (a.description || a.title || '').slice(0, 300),
      content:      `<p>${(a.description || a.content || a.title || '').slice(0, 800)}</p><p><a href="${a.link}" target="_blank" rel="noopener noreferrer">Read full article on ${a.source_id || 'source'} →</a></p>`,
      category:     getCategory(a.title, a.description),
      image_url:    a.image_url || null,
      published_at: a.pubDate ? new Date(a.pubDate).toISOString() : new Date().toISOString(),
      published:    true,
      author:       a.source_id || 'NewsData',
      source_url:   a.link,
      source_name:  a.source_id || 'NewsData',
      is_external:  true,
      external_id:  makeExtId('newsdata', a.link),
    }));

    console.log(`[newsdata] Fetched: ${items.length}`);
    return { items, error: null };
  } catch (e) {
    return { items: [], error: e.message };
  }
}

// ── Save articles to DB ───────────────────────────────────────────────────
async function saveArticles(db, items) {
  let published = 0;
  let skipped   = 0;
  const errors  = [];

  for (const item of items) {
    try {
      const { data: exists } = await db
        .from('news_posts').select('id').eq('external_id', item.external_id).maybeSingle();
      if (exists) { skipped++; continue; }

      const { error: insErr } = await db.from('news_posts').insert(item);
      if (insErr) {
        if (insErr.message?.includes('slug') || insErr.message?.includes('unique')) {
          const { error: e2 } = await db.from('news_posts').insert({
            ...item, slug: item.slug + '-' + Math.random().toString(36).slice(2, 6)
          });
          if (e2) errors.push(`${item.title.slice(0, 50)}: ${e2.message}`);
          else published++;
        } else {
          errors.push(`${item.title.slice(0, 50)}: ${insErr.message}`);
        }
      } else {
        published++;
      }
    } catch (e) { errors.push(e.message); }
  }

  return { published, skipped, errors };
}

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', 'https://www.fantasypsl.co.za');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'Supabase env vars missing' });

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  if (rateLimit(ip)) return res.status(429).json({ error: 'Rate limited' });

  const action = req.query.action || 'cached';
  const db     = createClient(SB_URL, SB_KEY);

  // ── STATUS ──────────────────────────────────────────────────────────────
  if (action === 'status') {
    try {
      const [{ count: total }, { count: ext }, { data: latest }] = await Promise.all([
        db.from('news_posts').select('*', { count: 'exact', head: true }),
        db.from('news_posts').select('*', { count: 'exact', head: true }).eq('is_external', true),
        db.from('news_posts').select('title, published_at, source_name')
          .eq('is_external', true).order('published_at', { ascending: false }).limit(3),
      ]);
      return res.json({
        success:           true,
        total_articles:    total  || 0,
        external_articles: ext    || 0,
        latest_3:          latest || [],
        gnews_configured:  !!GNEWS_KEY,
        newsdata_configured: !!NEWSDATA_KEY,
        setup_needed:      !GNEWS_KEY
          ? 'Add GNEWS_API_KEY to Vercel env vars. Free at https://gnews.io'
          : null,
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── CACHED — serve articles from DB ─────────────────────────────────────
  if (action === 'cached') {
    const { data, error } = await db
      .from('news_posts')
      .select('id, title, slug, excerpt, summary, category, image_url, published_at, author, source_name, source_url')
      .eq('published', true)
      .order('published_at', { ascending: false })
      .limit(30);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, count: (data || []).length, data: data || [] });
  }

  // ── FETCH — crawl news and save to DB ────────────────────────────────────
  if (action === 'fetch') {
    const key    = req.headers['x-admin-key'] || req.query.admin_key || '';
    const isCron = req.headers['x-vercel-cron'] === '1';
    if (!isCron && ADMIN_KEY && key !== ADMIN_KEY) {
      return res.status(401).json({ error: 'Admin key required' });
    }

    if (!GNEWS_KEY && !NEWSDATA_KEY) {
      return res.json({
        success: false,
        error:   'No news API keys configured',
        message: 'To enable automatic news, add GNEWS_API_KEY to your Vercel environment variables. Sign up free at https://gnews.io — takes 2 minutes.',
        manual:  'You can still post news manually via the admin panel at /admin',
      });
    }

    const startTime = Date.now();
    const allItems  = [];
    const tierLog   = [];

    // Tier 1: GNews
    const gnews = await fetchGNews();
    allItems.push(...gnews.items);
    tierLog.push({ tier: 'GNews API', found: gnews.items.length, error: gnews.error });

    // Tier 2: NewsData (if configured and GNews found less than 5)
    if (NEWSDATA_KEY && gnews.items.length < 5) {
      const nd = await fetchNewsData();
      allItems.push(...nd.items);
      tierLog.push({ tier: 'NewsData.io', found: nd.items.length, error: nd.error });
    }

    // Deduplicate across tiers by external_id
    const seen    = new Set();
    const deduped = allItems.filter(item => {
      if (seen.has(item.external_id)) return false;
      seen.add(item.external_id);
      return true;
    });

    const { published, skipped, errors } = await saveArticles(db, deduped);

    // Prune articles older than 21 days
    try {
      const cutoff = new Date(Date.now() - 21 * 86400000).toISOString();
      await db.from('news_posts').delete().eq('is_external', true).lt('published_at', cutoff);
    } catch (_) {}

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    return res.json({
      success:     true,
      duration:    `${duration}s`,
      total_found: deduped.length,
      published,
      skipped,
      errors:      errors.slice(0, 10),
      tiers:       tierLog,
      message:     published > 0
        ? `✅ ${published} new articles published — visible on site immediately`
        : skipped > 0
          ? `ℹ All ${skipped} articles already in database`
          : `⚠ No articles found — check API key configuration`,
    });
  }

  return res.status(400).json({
    error: `Unknown action: ${action}`,
    valid: ['fetch', 'status', 'cached'],
  });
};
