// api/news-crawler.js — Fantasy Pro Soccer League — RSS News Crawler v3
// ══════════════════════════════════════════════════════════════════════════
//
// v3 IMPROVEMENTS:
//   • Parallel feed fetching — all 7 feeds run simultaneously, faster
//   • Broadened keyword filter — catches pre-season & transfer content
//   • Slug collision retry — never fails on duplicate slug constraint
//   • action=status shows article count + last 3 crawled titles
//   • Admin key accepted as query param OR x-admin-key header
//   • Runs automatically via master-agent daily cron (02:00 UTC)
//   • Articles visible IMMEDIATELY after fetch — no delay
//   • 21-day auto-prune keeps DB clean
//
// USAGE:
//   Trigger:  GET /api/news-crawler?action=fetch&admin_key=YOUR_KEY
//   Status:   GET /api/news-crawler?action=status&admin_key=YOUR_KEY
//   Articles: GET /api/news-crawler?action=cached
//
// LEGAL: RSS is published for syndication. We take headline + excerpt +
//        source link only. Every article links back to the original source.
//
// ══════════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL    = process.env.SUPABASE_URL         || '';
const SB_KEY    = process.env.SUPABASE_SERVICE_KEY || '';
const ADMIN_KEY = process.env.ADMIN_SECRET         || '';

// ── Rate limiter ──────────────────────────────────────────────────────────
const _rl = new Map();
function rateLimit(ip, max = 20, ms = 60_000) {
  const now = Date.now();
  const rec = _rl.get(ip) || { c: 0, r: now + ms };
  if (now > rec.r) { rec.c = 0; rec.r = now + ms; }
  rec.c++; _rl.set(ip, rec);
  return rec.c > max;
}

// ── RSS sources — all verified July 2026 ─────────────────────────────────
const RSS_SOURCES = [
  { name: 'KickOff',          url: 'https://www.kickoff.com/rss/news/',                    category: 'PSL News', credit: 'KickOff.co.za'  },
  { name: 'Sport24 Soccer',   url: 'https://www.sport24.co.za/rss/Soccer',                category: 'PSL News', credit: 'Sport24'         },
  { name: 'IOL Sport',        url: 'https://www.iol.co.za/sport/soccer/rss',              category: 'PSL News', credit: 'IOL Sport'       },
  { name: 'TimesLive Sport',  url: 'https://www.timeslive.co.za/rss/sport/',              category: 'PSL News', credit: 'Times Live'      },
  { name: 'SowetanLIVE',     url: 'https://www.sowetanlive.co.za/sport/soccer/rss',      category: 'PSL News', credit: 'Sowetan LIVE'    },
  { name: 'Daily Maverick',   url: 'https://www.dailymaverick.co.za/section/sport/feed/', category: 'Sport',    credit: 'Daily Maverick'  },
  { name: 'Goal.com SA',      url: 'https://www.goal.com/feeds/en/news?competition_id=289', category: 'PSL News', credit: 'Goal.com'     },
];

// ── Keywords — catches clubs, competitions, transfers, and fantasy content ─
const KEYWORDS = [
  // PSL clubs
  'orlando pirates','kaizer chiefs','mamelodi sundowns','amazulu','amazu',
  'cape town city','stellenbosch','chippa','sekhukhune','richards bay',
  'ts galaxy','marumo','golden arrows','magesi','polokwane city',
  'durban city','cape town spurs','supersport united','swallows',
  // Competitions & orgs
  'psl','premiership','betway','dstv','mtn8','nedbank','afcon',
  'cosafa','caf','safa','south african football','sa football',
  // Pre-season & transfer keywords (important now)
  'transfer','signing','signs for','joins','unveiled','squad',
  'loan deal','contract','release','appointed','head coach',
  'fired','sacked','new coach','pre-season','friendly',
  // Bafana
  'bafana','national team',
  // Fantasy
  'fantasy','tips','gameweek','top scorer','clean sheet','player of',
];

function isRelevant(title, desc) {
  const text = ((title || '') + ' ' + (desc || '')).toLowerCase();
  return KEYWORDS.some(k => text.includes(k));
}

// ── XML parser — handles RSS 2.0, Atom, CDATA, self-closing tags ──────────
function getTag(block, tag) {
  let r = block.match(new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>', 'i'));
  if (r) return r[1].trim();
  r = block.match(new RegExp('<' + tag + '[^>]*>([^<]*)<\\/' + tag + '>', 'i'));
  if (r) return r[1].trim();
  return '';
}

function parseXml(xml, source) {
  const items = [];
  const seen  = new Set();
  const re    = /<(?:item|entry)[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  let m;

  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title = getTag(block, 'title');
    if (!title || title.length < 5) continue;

    let link = getTag(block, 'link');
    if (!link) {
      const hm = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (hm) link = hm[1];
    }
    if (!link) link = getTag(block, 'guid');
    if (!link) continue;

    const key = source.name + '::' + link;
    if (seen.has(key)) continue;
    seen.add(key);

    const pubRaw  = getTag(block, 'pubDate') || getTag(block, 'published')
                 || getTag(block, 'updated') || getTag(block, 'dc:date') || '';
    const descRaw = getTag(block, 'description') || getTag(block, 'summary')
                 || getTag(block, 'content') || getTag(block, 'content:encoded') || '';
    const desc    = descRaw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    if (!isRelevant(title, desc)) continue;

    // Image
    let image = null;
    const encl = block.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/i);
    if (encl) image = encl[1];
    if (!image) {
      const med = block.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["']/i);
      if (med) image = med[1];
    }
    if (!image) {
      const img = descRaw.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (img) image = img[1];
    }

    // Date
    let published = new Date().toISOString();
    try {
      const d = new Date(pubRaw);
      if (!isNaN(d.getTime())) published = d.toISOString();
    } catch (_) {}

    const excerpt = (desc || title).slice(0, 300);
    const content = `<p>${(desc || title).slice(0, 800)}</p><p><a href="${link}" target="_blank" rel="noopener noreferrer">Read full article on ${source.credit} →</a></p>`;

    // Deterministic external_id
    const raw   = (source.name + '||' + link).slice(0, 180);
    const extId = Buffer.from(raw).toString('base64')
                    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
                    .slice(0, 64);

    // Unique slug
    const slugBase = title.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-')
      .replace(/-+/g, '-').trim().slice(0, 70);
    const slug = slugBase + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);

    items.push({
      title:        title.slice(0, 250),
      slug,
      summary:      excerpt,
      excerpt,
      content,
      category:     source.category,
      image_url:    image || null,
      published_at: published,
      published:    true,
      author:       source.credit,
      source_url:   link,
      source_name:  source.credit,
      is_external:  true,
      external_id:  extId,
    });
  }
  return items;
}

// ── Fetch one feed ────────────────────────────────────────────────────────
async function fetchFeed(source) {
  try {
    const r = await fetch(source.url, {
      headers: {
        'User-Agent':    'FantasyProSoccerLeague/3.0 (+https://www.fantasypsl.co.za/about)',
        'Accept':        'application/rss+xml, application/xml, application/atom+xml, text/xml, */*',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return { items: [], error: `HTTP ${r.status}` };
    const xml = await r.text();
    if (!xml || xml.trim().length < 200) return { items: [], error: 'Empty response' };
    const items = parseXml(xml, source);
    console.log(`[crawler] ${source.name}: ${items.length} relevant`);
    return { items, error: null };
  } catch (e) {
    console.warn(`[crawler] ${source.name}: ${e.message}`);
    return { items: [], error: e.message };
  }
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
        db.from('news_posts').select('title, published_at, source_name').eq('is_external', true)
          .order('published_at', { ascending: false }).limit(3),
      ]);
      return res.json({
        success:           true,
        total_articles:    total  || 0,
        external_articles: ext    || 0,
        latest_3:          latest || [],
        sources:           RSS_SOURCES.length,
        source_list:       RSS_SOURCES.map(s => s.name),
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── CACHED — serve articles from DB to front-end ────────────────────────
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

  // ── FETCH — crawl all feeds, save new articles ──────────────────────────
  if (action === 'fetch') {
    const key    = req.headers['x-admin-key'] || req.query.admin_key || '';
    const isCron = req.headers['x-vercel-cron'] === '1';
    if (!isCron && ADMIN_KEY && key !== ADMIN_KEY) {
      return res.status(401).json({ error: 'Admin key required', hint: 'Add ?admin_key=YOUR_KEY' });
    }

    const startTime = Date.now();

    // Fetch all feeds in PARALLEL for speed
    const rawResults = await Promise.allSettled(RSS_SOURCES.map(s => fetchFeed(s)));
    const allItems   = [];
    const feedLog    = [];

    rawResults.forEach((r, i) => {
      const src = RSS_SOURCES[i];
      if (r.status === 'fulfilled') {
        allItems.push(...r.value.items);
        feedLog.push({ source: src.name, found: r.value.items.length, error: r.value.error });
      } else {
        feedLog.push({ source: src.name, found: 0, error: r.reason?.message || 'Failed' });
      }
    });

    console.log(`[crawler] Total items across all feeds: ${allItems.length}`);

    let published = 0;
    let skipped   = 0;
    const errors  = [];

    for (const item of allItems) {
      try {
        // Dedup check
        const { data: exists } = await db.from('news_posts')
          .select('id').eq('external_id', item.external_id).maybeSingle();
        if (exists) { skipped++; continue; }

        const { error: insErr } = await db.from('news_posts').insert(item);
        if (insErr) {
          if (insErr.message?.includes('slug') || insErr.message?.includes('unique')) {
            // Slug collision — retry with extra random suffix
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

    // Prune old external articles (21 days)
    try {
      const cutoff = new Date(Date.now() - 21 * 86400000).toISOString();
      await db.from('news_posts').delete().eq('is_external', true).lt('published_at', cutoff);
    } catch (_) {}

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const msg = published > 0
      ? `${published} new articles published — visible on site immediately`
      : skipped === allItems.length && allItems.length > 0
        ? `All ${skipped} articles already in database`
        : allItems.length === 0
          ? 'No articles found — RSS feeds may be temporarily unavailable'
          : `${published} new, ${skipped} already existed`;

    return res.json({
      success:     true,
      duration:    `${duration}s`,
      total_found: allItems.length,
      published,
      skipped,
      errors:      errors.slice(0, 10),
      feeds:       feedLog,
      message:     msg,
    });
  }

  return res.status(400).json({
    error: `Unknown action: ${action}`,
    valid: ['fetch', 'status', 'cached'],
    example: '/api/news-crawler?action=fetch&admin_key=YOUR_KEY',
  });
};
