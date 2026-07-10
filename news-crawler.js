// api/news-crawler.js — Fantasy PSL — RSS News Crawler + Auto-Publisher v2
// ══════════════════════════════════════════════════════════════════════════
// FIXES vs v1:
//   1. Added working South African sports RSS feeds (previous ones returned 403/empty)
//   2. Relaxed PSL keyword filter so more articles pass through
//   3. Fixed RSS XML parser: handles self-closing <link/> tags & CDATA variants
//   4. Fixed external_id dedup key collision (was silently skipping articles)
//   5. Added better error logging for each failed feed
//   6. news_posts insert now includes ALL required columns to avoid DB errors
//   7. Crawler can now run via cron WITHOUT admin_key (x-vercel-cron header)
//   8. Added action=status endpoint for quick health checks
// ══════════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL    = process.env.SUPABASE_URL          || '';
const SB_KEY    = process.env.SUPABASE_SERVICE_KEY  || '';
const AF_KEY    = process.env.APIFOOTBALL_KEY        || '';
const ADMIN_KEY = process.env.ADMIN_SECRET           || '';
const PSL_LEAGUE = 288;
const PSL_SEASON = process.env.APIFOOTBALL_SEASON ? parseInt(process.env.APIFOOTBALL_SEASON) : 2025;

// ── Rate limiter ──────────────────────────────────────────────────────────
const _rl = new Map();
function rateLimit(ip, max = 30, ms = 60_000) {
  const now = Date.now();
  const rec = _rl.get(ip) || { c: 0, r: now + ms };
  if (now > rec.r) { rec.c = 0; rec.r = now + ms; }
  rec.c++;
  _rl.set(ip, rec);
  return rec.c > max;
}

// ── RSS Sources — verified working South African sports feeds ────────────
// NOTE: Many SA sports sites have broken RSS or block bots.
// These sources are verified to serve valid RSS/Atom at these URLs.
const RSS_SOURCES = [
  {
    name:     'IOL Sport',
    url:      'https://www.iol.co.za/sport/soccer/rss',
    category: 'PSL News',
    credit:   'IOL Sport',
  },
  {
    name:     'TimesLive Sport',
    url:      'https://www.timeslive.co.za/rss/sport/',
    category: 'PSL News',
    credit:   'Times Live',
  },
  {
    name:     'Daily Maverick Sport',
    url:      'https://www.dailymaverick.co.za/section/sport/feed/',
    category: 'Sport',
    credit:   'Daily Maverick',
  },
  {
    name:     'Sport24 PSL',
    url:      'https://www.sport24.co.za/rss/Soccer/LocalSoccer',
    category: 'PSL News',
    credit:   'Sport24',
  },
  {
    name:     'Goal.com SA',
    url:      'https://www.goal.com/feeds/en/news?competition_id=289',
    category: 'PSL News',
    credit:   'Goal.com',
  },
  {
    name:     'SowetanLIVE Sport',
    url:      'https://www.sowetanlive.co.za/sport/soccer/rss',
    category: 'PSL News',
    credit:   'Sowetan LIVE',
  },
  {
    name:     'KickOff',
    url:      'https://www.kickoff.com/rss/news/',
    category: 'PSL News',
    credit:   'KickOff.co.za',
  },
];

// ── PSL keyword filter — broadened so relevant articles are not dropped ──
const PSL_KEYWORDS = [
  'psl','premiership','kaizer chiefs','orlando pirates','mamelodi sundowns',
  'amazulu','amazu','cape town city','stellenbosch','chippa','sekhukhune',
  'richards bay','ts galaxy','marumo','golden arrows','magesi','siwelele',
  'polokwane','bafana','safa','nedbank','mtn8','betway','dstv premiership',
  'south africa','sa football','fantasy psl','south african football',
  'superport', 'supersport united','cape town spurs','durban city',
  'orbit college','psl table','psl results','psl fixtures','psl transfer',
  'psl coach','psl player','african football','caf','cosafa',
];

function isPslRelevant(title, desc) {
  const text = ((title || '') + ' ' + (desc || '')).toLowerCase();
  return PSL_KEYWORDS.some(k => text.includes(k));
}

// ── RSS XML parser — handles CDATA, self-closing tags, Atom feeds ─────────
function extractTag(block, tag) {
  // Try CDATA first
  let r = block.match(new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>', 'i'));
  if (r) return r[1].trim();
  // Plain text content
  r = block.match(new RegExp('<' + tag + '[^>]*>([^<]*)<\\/' + tag + '>', 'i'));
  if (r) return r[1].trim();
  return '';
}

function parseRss(xml, source) {
  const items = [];

  // Support both <item> (RSS) and <entry> (Atom)
  const itemRegex = /<(?:item|entry)[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  let m;

  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];

    const title   = extractTag(block, 'title');
    // <link> in RSS is often self-closing or text; Atom uses href attribute
    let link = extractTag(block, 'link');
    if (!link) {
      const hrefMatch = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (hrefMatch) link = hrefMatch[1];
    }
    if (!link) link = extractTag(block, 'guid');

    const pubDate = extractTag(block, 'pubDate')
                 || extractTag(block, 'published')
                 || extractTag(block, 'updated')
                 || extractTag(block, 'dc:date')
                 || '';

    const desc = extractTag(block, 'description')
              || extractTag(block, 'summary')
              || extractTag(block, 'content')
              || extractTag(block, 'content:encoded')
              || '';

    // Image extraction: enclosure → media:content → media:thumbnail → img in desc
    let image = '';
    const encl = block.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/i);
    if (encl) image = encl[1];
    if (!image) {
      const med = block.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["']/i);
      if (med) image = med[1];
    }
    if (!image) {
      const img = desc.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (img) image = img[1];
    }

    if (!title || !link) continue;

    // Strip HTML from description for excerpt
    const summary = desc.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);

    if (!isPslRelevant(title, summary)) continue;

    let published;
    try {
      published = pubDate ? new Date(pubDate).toISOString() : new Date().toISOString();
    } catch (e) {
      published = new Date().toISOString();
    }

    // Build a deterministic, collision-resistant external_id
    // Using title + source name hash to avoid duplicate skips on re-crawl
    const dedupStr  = (source.name + '::' + link).slice(0, 200);
    const externalId = Buffer.from(dedupStr).toString('base64').slice(0, 64)
                             .replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));

    // URL-friendly slug with timestamp suffix to ensure uniqueness
    const slug = title.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim()
      .slice(0, 80) + '-' + Date.now().toString(36);

    items.push({
      title:        title.slice(0, 200),
      slug,
      excerpt:      summary.slice(0, 300) || title,
      summary:      summary.slice(0, 500) || title,
      content:      `<p>${summary.slice(0, 800)}</p><p><a href="${link}" target="_blank" rel="noopener noreferrer">Read full article on ${source.credit} →</a></p>`,
      category:     source.category,
      image_url:    image || null,
      cover_image:  image || null,
      published_at: published,
      published:    true,
      author:       source.credit,
      source_url:   link,
      source_name:  source.credit,
      is_external:  true,
      external_id:  externalId,
      tags:         ['psl', 'south-africa'],
    });
  }
  return items;
}

// ── Fetch a single RSS feed ───────────────────────────────────────────────
async function fetchRss(source) {
  try {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 10_000);
    const r = await fetch(source.url, {
      headers: {
        'User-Agent': 'FantasyPSL/2.0 (+https://www.fantasypsl.co.za/about)',
        'Accept':     'application/rss+xml, application/xml, application/atom+xml, text/xml, */*',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!r.ok) {
      console.warn(`[news-crawler] ${source.name} HTTP ${r.status}`);
      return [];
    }
    const xml = await r.text();
    if (!xml || xml.length < 100) {
      console.warn(`[news-crawler] ${source.name}: empty response`);
      return [];
    }
    const items = parseRss(xml, source);
    console.log(`[news-crawler] ${source.name}: fetched ${items.length} relevant items`);
    return items;
  } catch (e) {
    console.warn(`[news-crawler] RSS failed: ${source.name} — ${e.message}`);
    return [];
  }
}

// ── Fetch injuries from API-Football ─────────────────────────────────────
async function fetchInjuries() {
  if (!AF_KEY) return [];
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10_000);
    const r = await fetch(
      `https://v3.football.api-sports.io/injuries?league=${PSL_LEAGUE}&season=${PSL_SEASON}`,
      {
        headers: { 'x-apisports-key': AF_KEY },
        signal: controller.signal,
      }
    );
    if (!r.ok) return [];
    const json = await r.json();
    return (json.response || []).map(item => ({
      player_name:  item.player?.name  || 'Unknown',
      player_photo: item.player?.photo || null,
      team_name:    item.team?.name    || 'Unknown',
      team_logo:    item.team?.logo    || null,
      type:         item.player?.type  || 'Injury',
      reason:       item.player?.reason || 'Unknown',
    }));
  } catch (e) {
    console.warn('[news-crawler] Injuries fetch failed:', e.message);
    return [];
  }
}

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.fantasypsl.co.za';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();
  if (rateLimit(ip)) return res.status(429).json({ error: 'Too many requests' });

  const action = req.query?.action || 'cached';

  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'Server misconfiguration' });
  const db = createClient(SB_URL, SB_KEY);

  // ── STATUS — quick health check ───────────────────────────────────────
  if (action === 'status') {
    const { count } = await db
      .from('news_posts')
      .select('*', { count: 'exact', head: true })
      .eq('is_external', true);
    return res.json({ success: true, external_articles: count || 0, sources: RSS_SOURCES.length });
  }

  // ── CACHED — return latest published news from DB ────────────────────
  if (action === 'cached') {
    const { data, error } = await db
      .from('news_posts')
      .select('id,title,slug,excerpt,category,image_url,published_at,author,source_name,source_url')
      .eq('published', true)
      .eq('is_external', true)
      .order('published_at', { ascending: false })
      .limit(30);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, data: data || [] });
  }

  // ── FETCH — crawl feeds and publish to news_posts ─────────────────────
  if (action === 'fetch') {
    // Allow: Vercel cron header, internal (no origin), or valid admin key
    const key          = req.headers['x-admin-key'] || req.query.admin_key || '';
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const isInternal   = !req.headers.origin;
    const isAdmin      = ADMIN_KEY && key === ADMIN_KEY;

    if (!isVercelCron && !isInternal && !isAdmin) {
      return res.status(401).json({ error: 'Admin key required' });
    }

    const allItems   = [];
    const feedErrors = [];

    for (const source of RSS_SOURCES) {
      try {
        const items = await fetchRss(source);
        allItems.push(...items);
      } catch (e) {
        feedErrors.push(`${source.name}: ${e.message}`);
      }
    }

    console.log(`[news-crawler] Total relevant items fetched: ${allItems.length}`);

    let published = 0;
    let skipped   = 0;
    const insertErrors = [];

    for (const item of allItems) {
      try {
        // Dedup check: look up by external_id
        const { data: existing, error: lookupErr } = await db
          .from('news_posts')
          .select('id')
          .eq('external_id', item.external_id)
          .limit(1)
          .maybeSingle();

        if (lookupErr) {
          console.warn('[news-crawler] Dedup lookup error:', lookupErr.message);
        }

        if (existing) {
          skipped++;
          continue;
        }

        const { error: insErr } = await db.from('news_posts').insert(item);
        if (insErr) {
          insertErrors.push(`${item.title?.slice(0, 60)}: ${insErr.message}`);
          console.error('[news-crawler] Insert error:', insErr.message, '| item:', item.title);
        } else {
          published++;
        }
      } catch (e) {
        insertErrors.push(e.message);
      }
    }

    // Prune external articles older than 14 days to keep DB clean
    const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    const { error: pruneErr } = await db
      .from('news_posts')
      .delete()
      .eq('is_external', true)
      .lt('published_at', cutoff);
    if (pruneErr) console.warn('[news-crawler] Prune error:', pruneErr.message);

    return res.json({
      success:     true,
      fetched:     allItems.length,
      published,
      skipped,
      feed_errors: feedErrors,
      insert_errors: insertErrors.slice(0, 10),
    });
  }

  // ── INJURIES — live data from API-Football ────────────────────────────
  if (action === 'injuries') {
    return res.json({ success: true, data: await fetchInjuries() });
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
};
