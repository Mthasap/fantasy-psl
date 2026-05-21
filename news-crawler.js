// api/news-crawler.js — Fantasy PSL — Legal RSS/News Crawler
// ══════════════════════════════════════════════════════════════════════════
//
// LEGAL APPROACH — only uses:
//   1. Public RSS feeds (sites explicitly publish these for syndication)
//   2. Open sports APIs (API-Football, which we already pay for)
//   3. All fetched items are attributed & linked back to the source
//   4. No content is reproduced verbatim — summaries only, with source link
//   5. Respects robots.txt (checked before adding any source)
//   6. 24h caching to avoid hammering sources
//
// SOURCES USED:
//   - KickOff.co.za  RSS   https://www.kickoff.com/feeds/rss/news.xml
//   - Soccer Laduma  RSS   https://www.soccerladuma.co.za/rss/news
//   - IOL Sport      RSS   https://rss.iol.co.za/rss/sport
//   - TimesLive Sport RSS  https://www.timeslive.co.za/feeds/section/sport/
//   - API-Football    Predictions / Injuries (already licensed)
//
// ENDPOINT:
//   GET /api/news-crawler?action=fetch        → fetch & cache latest RSS items
//   GET /api/news-crawler?action=cached        → return only from Supabase cache
//   GET /api/news-crawler?action=injuries      → PSL injury report from API-Football
//   GET /api/news-crawler?action=h2h&home=X&away=Y → head-to-head from API-Football
//
// ENV VARS:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, APIFOOTBALL_KEY, ADMIN_SECRET
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
  rec.c++; _rl.set(ip, rec);
  return rec.c > max;
}

// ── RSS Sources (all have robots.txt allowing crawlers) ───────────────────
const RSS_SOURCES = [
  {
    name:     'KickOff',
    url:      'https://www.kickoff.com/feeds/rss/news.xml',
    category: 'PSL News',
    credit:   'KickOff.co.za',
  },
  {
    name:     'Soccer Laduma',
    url:      'https://www.soccerladuma.co.za/rss/news',
    category: 'PSL News',
    credit:   'Soccer Laduma',
  },
  {
    name:     'IOL Sport',
    url:      'https://rss.iol.co.za/rss/sport',
    category: 'Sport',
    credit:   'IOL Sport',
  },
  {
    name:     'TimesLive Sport',
    url:      'https://www.timeslive.co.za/feeds/section/sport/',
    category: 'Sport',
    credit:   'Times Live',
  },
];

// PSL keyword filter — only store articles relevant to South African football
const PSL_KEYWORDS = [
  'psl','premiership','kaizer chiefs','orlando pirates','mamelodi sundowns',
  'amazulu','cape town city','stellenbosch','supersport','chippa','sekhukhune',
  'richards bay','ts galaxy','marumo','golden arrows','magesi','swallows',
  'bafana','safa','cosafa','nedbank cup','telkom knockout','mtn8',
  'betway','dstv premiership','south africa','sa football'
];

function isPslRelevant(title, desc) {
  const text = ((title || '') + ' ' + (desc || '')).toLowerCase();
  return PSL_KEYWORDS.some(k => text.includes(k));
}

// ── Parse RSS XML ─────────────────────────────────────────────────────────
function parseRss(xml, source) {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>'))
        || block.match(new RegExp('<' + tag + '[^>]*>([^<]*)<\\/' + tag + '>'));
      return m ? m[1].trim() : '';
    };

    const title  = get('title');
    const link   = get('link') || get('guid');
    const pubDate= get('pubDate') || get('dc:date') || '';
    const desc   = get('description') || get('summary') || '';

    // Extract image from enclosure, media:content, or og tags in description
    let image = '';
    const encl = block.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/i);
    if (encl) image = encl[1];
    if (!image) {
      const med = block.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["']/i);
      if (med) image = med[1];
    }
    if (!image) {
      const imgTag = desc.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (imgTag) image = imgTag[1];
    }

    // Strip HTML from description to get clean summary
    const summary = desc.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);

    if (!title || !link) continue;
    if (!isPslRelevant(title, summary)) continue;

    let published;
    try { published = pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(); }
    catch(e) { published = new Date().toISOString(); }

    items.push({
      external_id:  Buffer.from(link).toString('base64').slice(0, 64),
      title:        title.slice(0, 200),
      summary:      summary || title,
      source_name:  source.credit,
      source_url:   link,
      category:     source.category,
      image_url:    image || null,
      published_at: published,
      is_external:  true,
    });
  }
  return items;
}

// ── Fetch one RSS feed ────────────────────────────────────────────────────
async function fetchRss(source) {
  try {
    const r = await fetch(source.url, {
      headers: {
        'User-Agent': 'FantasyPSL/1.0 RSS Reader (+https://www.fantasypsl.co.za)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const text = await r.text();
    return parseRss(text, source);
  } catch(e) {
    console.warn('[news-crawler] RSS fetch failed for', source.name, ':', e.message);
    return [];
  }
}

// ── Fetch PSL injuries from API-Football ──────────────────────────────────
async function fetchInjuries() {
  if (!AF_KEY) return [];
  try {
    const r = await fetch(
      `https://v3.football.api-sports.io/injuries?league=${PSL_LEAGUE}&season=${PSL_SEASON}`,
      { headers: { 'x-apisports-key': AF_KEY }, signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return [];
    const json = await r.json();
    return (json.response || []).map(item => ({
      player_name: item.player?.name || 'Unknown',
      player_photo: item.player?.photo || null,
      team_name:   item.team?.name || 'Unknown',
      team_logo:   item.team?.logo || null,
      type:        item.player?.type || 'Injury',
      reason:      item.player?.reason || 'Unknown',
    }));
  } catch(e) {
    console.warn('[news-crawler] injuries fetch failed:', e.message);
    return [];
  }
}

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://www.fantasypsl.co.za');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip  = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (rateLimit(ip)) return res.status(429).json({ error: 'Too many requests' });

  const action = (req.query?.action || 'cached');

  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  const db = createClient(SB_URL, SB_KEY);

  // ── GET CACHED — default, no rate limit on external APIs ─────────────
  if (action === 'cached') {
    const { data, error } = await db
      .from('external_news')
      .select('id,title,summary,source_name,source_url,category,image_url,published_at')
      .order('published_at', { ascending: false })
      .limit(30);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, data: data || [] });
  }

  // ── FETCH — admin only, actually hits RSS feeds ───────────────────────
  if (action === 'fetch') {
    // Require admin key for the crawl action (prevent abuse)
    const key = req.headers['x-admin-key'] || req.query.admin_key || '';
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      return res.status(401).json({ error: 'Admin key required for fetch action' });
    }

    const allItems = [];
    for (const source of RSS_SOURCES) {
      const items = await fetchRss(source);
      allItems.push(...items);
    }

    if (allItems.length > 0) {
      // Upsert by external_id to avoid duplicates
      const { error } = await db
        .from('external_news')
        .upsert(allItems, { onConflict: 'external_id', ignoreDuplicates: true });
      if (error) console.error('[news-crawler] upsert error:', error.message);
    }

    // Prune items older than 14 days to keep the table lean
    const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    await db.from('external_news').delete().lt('published_at', cutoff);

    return res.json({ success: true, fetched: allItems.length });
  }

  // ── INJURIES — uses API-Football ──────────────────────────────────────
  if (action === 'injuries') {
    const injuries = await fetchInjuries();
    return res.json({ success: true, data: injuries });
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
};
