// api/news-crawler.js — Fantasy PSL — RSS News Crawler + Auto-Publisher
// ══════════════════════════════════════════════════════════════════════════
// Fetches PSL-relevant RSS articles and publishes them to news_posts so
// they appear in the app news feed immediately — no admin action needed.
//
// LEGAL: only uses public RSS feeds (explicitly published for syndication).
// All items are attributed + linked. No verbatim reproduction.
//
// SCHEDULE: runs every 6 hours via Vercel cron (add to vercel.json)
// ENDPOINT: GET /api/news-crawler?action=fetch&admin_key=XXX
// ══════════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL    = process.env.SUPABASE_URL          || '';
const SB_KEY    = process.env.SUPABASE_SERVICE_KEY  || '';
const AF_KEY    = process.env.APIFOOTBALL_KEY        || '';
const ADMIN_KEY = process.env.ADMIN_SECRET           || '';
const PSL_LEAGUE = 288;
const PSL_SEASON = process.env.APIFOOTBALL_SEASON ? parseInt(process.env.APIFOOTBALL_SEASON) : 2025;

// Rate limiter
const _rl = new Map();
function rateLimit(ip, max = 30, ms = 60_000) {
  const now = Date.now(); const rec = _rl.get(ip) || { c: 0, r: now + ms };
  if (now > rec.r) { rec.c = 0; rec.r = now + ms; } rec.c++; _rl.set(ip, rec);
  return rec.c > max;
}

// RSS Sources — all have robots.txt allowing crawlers
const RSS_SOURCES = [
  { name: 'KickOff',        url: 'https://www.kickoff.com/feeds/rss/news.xml',        category: 'PSL News',  credit: 'KickOff.co.za' },
  { name: 'Soccer Laduma',  url: 'https://www.soccerladuma.co.za/rss/news',           category: 'PSL News',  credit: 'Soccer Laduma' },
  { name: 'IOL Sport',      url: 'https://rss.iol.co.za/rss/sport',                   category: 'Sport',     credit: 'IOL Sport' },
  { name: 'TimesLive Sport',url: 'https://www.timeslive.co.za/feeds/section/sport/',  category: 'Sport',     credit: 'Times Live' },
];

// Only store PSL-relevant articles
const PSL_KEYWORDS = [
  'psl','premiership','kaizer chiefs','orlando pirates','mamelodi sundowns',
  'amazulu','cape town city','stellenbosch','chippa','sekhukhune',
  'richards bay','ts galaxy','marumo','golden arrows','magesi','siwelele',
  'bafana','safa','nedbank cup','mtn8','betway','dstv',
  'south africa','sa football','fantasy psl'
];
function isPslRelevant(title, desc) {
  const text = ((title || '') + ' ' + (desc || '')).toLowerCase();
  return PSL_KEYWORDS.some(k => text.includes(k));
}

// Parse RSS XML → array of article objects
function parseRss(xml, source) {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = block.match(new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>'))
             || block.match(new RegExp('<' + tag + '[^>]*>([^<]*)<\\/' + tag + '>'));
      return r ? r[1].trim() : '';
    };
    const title   = get('title');
    const link    = get('link') || get('guid');
    const pubDate = get('pubDate') || get('dc:date') || '';
    const desc    = get('description') || get('summary') || '';

    let image = '';
    const encl = block.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/i);
    if (encl) image = encl[1];
    if (!image) { const med = block.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["']/i); if (med) image = med[1]; }
    if (!image) { const img = desc.match(/<img[^>]+src=["']([^"']+)["']/i); if (img) image = img[1]; }

    const summary = desc.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!title || !link) continue;
    if (!isPslRelevant(title, summary)) continue;

    let published;
    try { published = pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(); } catch(e) { published = new Date().toISOString(); }

    // Build a URL-friendly slug
    const slug = title.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
      .trim().slice(0, 80) + '-' + Date.now().toString(36);

    items.push({
      // Fields matching news_posts table schema
      title:        title.slice(0, 200),
      slug,
      excerpt:      summary || title,
      summary:      summary || title,
      content:      `<p>${summary}</p><p><a href="${link}" target="_blank" rel="noopener">Read full article on ${source.credit} →</a></p>`,
      category:     source.category,
      image_url:    image || null,
      cover_image:  image || null,
      published_at: published,
      published:    true,
      author:       source.credit,
      source_url:   link,
      source_name:  source.credit,
      is_external:  true,
      // Dedup key
      external_id:  Buffer.from(link).toString('base64').slice(0, 64),
    });
  }
  return items;
}

async function fetchRss(source) {
  try {
    const r = await fetch(source.url, {
      headers: { 'User-Agent': 'FantasyPSL/1.0 (+https://www.fantasypsl.co.za)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    return parseRss(await r.text(), source);
  } catch(e) {
    console.warn('[news-crawler] RSS failed:', source.name, e.message);
    return [];
  }
}

async function fetchInjuries() {
  if (!AF_KEY) return [];
  try {
    const r = await fetch(`https://v3.football.api-sports.io/injuries?league=${PSL_LEAGUE}&season=${PSL_SEASON}`,
      { headers: { 'x-apisports-key': AF_KEY }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return [];
    const json = await r.json();
    return (json.response || []).map(item => ({
      player_name:  item.player?.name || 'Unknown',
      player_photo: item.player?.photo || null,
      team_name:    item.team?.name || 'Unknown',
      team_logo:    item.team?.logo || null,
      type:         item.player?.type || 'Injury',
      reason:       item.player?.reason || 'Unknown',
    }));
  } catch(e) { return []; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://www.fantasypsl.co.za');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (rateLimit(ip)) return res.status(429).json({ error: 'Too many requests' });

  const action = req.query?.action || 'cached';

  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'Server misconfiguration' });
  const db = createClient(SB_URL, SB_KEY);

  // ── GET CACHED — return latest news from DB ───────────────────────────
  if (action === 'cached') {
    const { data, error } = await db.from('news_posts')
      .select('id,title,slug,excerpt,category,image_url,published_at,author,source_name,source_url')
      .eq('published', true).eq('is_external', true)
      .order('published_at', { ascending: false }).limit(30);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, data: data || [] });
  }

  // ── FETCH — hit RSS feeds and publish to news_posts ──────────────────
  if (action === 'fetch') {
    const key          = req.headers['x-admin-key'] || req.query.admin_key || '';
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const isInternal   = !req.headers.origin;
    if (!isVercelCron && !isInternal && (!ADMIN_KEY || key !== ADMIN_KEY)) {
      return res.status(401).json({ error: 'Admin key required' });
    }

    const allItems = [];
    for (const source of RSS_SOURCES) {
      const items = await fetchRss(source);
      allItems.push(...items);
    }

    let published = 0; let skipped = 0; const errors = [];

    for (const item of allItems) {
      try {
        // Check if already exists by external_id or slug
        const { data: existing } = await db.from('news_posts')
          .select('id').eq('external_id', item.external_id).limit(1).maybeSingle();
        if (existing) { skipped++; continue; }

        // Insert into news_posts so it shows in the main news feed
        const { error: insErr } = await db.from('news_posts').insert(item);
        if (insErr) { errors.push(item.title + ': ' + insErr.message); }
        else { published++; }
      } catch(e) { errors.push(e.message); }
    }

    // Prune external articles older than 14 days
    const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    await db.from('news_posts').delete().eq('is_external', true).lt('published_at', cutoff);

    return res.json({ success: true, fetched: allItems.length, published, skipped, errors: errors.slice(0,5) });
  }

  // ── INJURIES — from API-Football ──────────────────────────────────────
  if (action === 'injuries') {
    return res.json({ success: true, data: await fetchInjuries() });
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
};
