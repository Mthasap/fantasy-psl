// api/news-crawler.js — Fantasy Pro Soccer League — News Crawler v5
// ══════════════════════════════════════════════════════════════════════════
//
// ARCHITECTURE:
//   Vercel Hobby blocks direct RSS fetching from SA sports sites.
//   We use two free news APIs that work from Vercel IPs.
//
//   PRIMARY:   GNews API  (gnews.io — free 100 req/day)
//              - No country filter (broader results)
//              - 12-hour delay on free tier — articles from yesterday+
//              - Upgrade to €9/month removes delay entirely
//
//   SECONDARY: NewsAPI.org (newsapi.org — free 100 req/day)
//              - No delay on developer plan
//              - Good SA football coverage
//              - Requires NEWSAPI_KEY env var
//
// REQUIRED ENV VARS (add in Vercel → Settings → Environment Variables):
//   GNEWS_API_KEY   — from https://gnews.io (free, 2 min signup)
//   NEWSAPI_KEY     — from https://newsapi.org (free, 2 min signup) [optional]
//
// ══════════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL      = process.env.SUPABASE_URL         || '';
const SB_KEY      = process.env.SUPABASE_SERVICE_KEY || '';
const ADMIN_KEY   = process.env.ADMIN_SECRET         || '';
const GNEWS_KEY   = process.env.GNEWS_API_KEY        || '';
const NEWSAPI_KEY = process.env.NEWSAPI_KEY          || '';

// ── Helpers ───────────────────────────────────────────────────────────────
const _rl = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const rec = _rl.get(ip) || { c:0, r:now+60000 };
  if (now > rec.r) { rec.c=0; rec.r=now+60000; }
  rec.c++; _rl.set(ip, rec);
  return rec.c > 20;
}

function makeSlug(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s]/g,'').replace(/\s+/g,'-')
    .replace(/-+/g,'-').trim().slice(0,70)
    + '-' + Date.now().toString(36)
    + '-' + Math.random().toString(36).slice(2,5);
}

function makeExtId(source, url) {
  return Buffer.from((source + '||' + url).slice(0,180))
    .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'').slice(0,64);
}

function getCategory(title, desc) {
  const t = ((title||'')+(desc||'')).toLowerCase();
  if (t.includes('transfer')||t.includes('sign')||t.includes('join')) return 'Transfer News';
  if (t.includes('injur')||t.includes('miss')||t.includes('suspend')) return 'Injury';
  if (t.includes('bafana')||t.includes('national')) return 'Bafana';
  if (t.includes('mtn8')||t.includes('nedbank')||t.includes('cup')) return 'Cup';
  if (t.includes('result')||t.includes('score')||t.includes('defeat')||t.includes('win')) return 'Results';
  return 'PSL News';
}

// ── GNews API — primary source ────────────────────────────────────────────
// Searches broadly — no country filter so we get all English PSL content
async function fetchGNews() {
  if (!GNEWS_KEY) return { items:[], error:'GNEWS_API_KEY not set' };

  // Multiple targeted queries to maximise coverage
  const queries = [
    'Betway Premiership',
    'PSL soccer "South Africa"',
    '"Kaizer Chiefs" OR "Orlando Pirates" OR "Mamelodi Sundowns"',
    'Bafana Bafana',
  ];

  const seen  = new Set();
  const items = [];

  for (const q of queries) {
    try {
      const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=en&max=10&apikey=${GNEWS_KEY}&sortby=publishedAt&in=title,description`;
      const r   = await fetch(url, { signal: AbortSignal.timeout(12000) });

      if (!r.ok) {
        const body = await r.text().catch(()=>'');
        console.warn(`[gnews] HTTP ${r.status} for "${q}": ${body.slice(0,100)}`);
        continue;
      }

      const data = await r.json();
      const arts = data.articles || [];
      console.log(`[gnews] "${q}": ${arts.length} results`);

      for (const a of arts) {
        if (!a.url || !a.title) continue;
        if (seen.has(a.url)) continue;
        seen.add(a.url);

        items.push({
          title:        a.title.slice(0,250),
          slug:         makeSlug(a.title),
          summary:      (a.description||a.title).slice(0,300),
          excerpt:      (a.description||a.title).slice(0,300),
          content:      `<p>${(a.description||a.title).slice(0,800)}</p><p><a href="${a.url}" target="_blank" rel="noopener noreferrer">Read full article on ${a.source?.name||'source'} →</a></p>`,
          category:     getCategory(a.title, a.description),
          image_url:    a.image||null,
          published_at: a.publishedAt ? new Date(a.publishedAt).toISOString() : new Date().toISOString(),
          published:    true,
          author:       a.source?.name||'GNews',
          source_url:   a.url,
          source_name:  a.source?.name||'GNews',
          is_external:  true,
          external_id:  makeExtId('gnews', a.url),
        });
      }
    } catch (e) {
      console.warn(`[gnews] Query error "${q}": ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  return { items, error: null };
}

// ── NewsAPI.org — secondary source ────────────────────────────────────────
async function fetchNewsAPI() {
  if (!NEWSAPI_KEY) return { items:[], error:'NEWSAPI_KEY not set' };

  try {
    const url = `https://newsapi.org/v2/everything?q=betway+premiership+OR+%22PSL+soccer%22+OR+%22Kaizer+Chiefs%22+OR+%22Orlando+Pirates%22&language=en&sortBy=publishedAt&pageSize=20&apiKey=${NEWSAPI_KEY}`;
    const r   = await fetch(url, { signal: AbortSignal.timeout(12000) });

    if (!r.ok) {
      const body = await r.text().catch(()=>'');
      return { items:[], error:`HTTP ${r.status}: ${body.slice(0,100)}` };
    }

    const data  = await r.json();
    const arts  = data.articles || [];
    console.log(`[newsapi] ${arts.length} results`);

    const items = arts
      .filter(a => a.url && a.title && a.title !== '[Removed]')
      .map(a => ({
        title:        a.title.slice(0,250),
        slug:         makeSlug(a.title),
        summary:      (a.description||a.title).slice(0,300),
        excerpt:      (a.description||a.title).slice(0,300),
        content:      `<p>${(a.description||a.content||a.title).slice(0,800)}</p><p><a href="${a.url}" target="_blank" rel="noopener noreferrer">Read full article on ${a.source?.name||'source'} →</a></p>`,
        category:     getCategory(a.title, a.description),
        image_url:    a.urlToImage||null,
        published_at: a.publishedAt ? new Date(a.publishedAt).toISOString() : new Date().toISOString(),
        published:    true,
        author:       a.source?.name||a.author||'NewsAPI',
        source_url:   a.url,
        source_name:  a.source?.name||'NewsAPI',
        is_external:  true,
        external_id:  makeExtId('newsapi', a.url),
      }));

    return { items, error:null };
  } catch (e) {
    return { items:[], error:e.message };
  }
}

// ── Save articles to Supabase ──────────────────────────────────────────────
async function saveArticles(db, items) {
  let published=0, skipped=0;
  const errors=[];

  for (const item of items) {
    try {
      const { data:exists } = await db.from('news_posts')
        .select('id').eq('external_id', item.external_id).maybeSingle();
      if (exists) { skipped++; continue; }

      const { error:err } = await db.from('news_posts').insert(item);
      if (err) {
        if (err.message?.includes('slug') || err.message?.includes('unique')) {
          const { error:e2 } = await db.from('news_posts')
            .insert({...item, slug: item.slug+'-'+Math.random().toString(36).slice(2,6)});
          if (e2) errors.push(`${item.title.slice(0,50)}: ${e2.message}`);
          else published++;
        } else {
          errors.push(`${item.title.slice(0,50)}: ${err.message}`);
        }
      } else { published++; }
    } catch(e) { errors.push(e.message); }
  }
  return { published, skipped, errors };
}

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', 'https://www.fantasypsl.co.za');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!SB_URL || !SB_KEY) return res.status(500).json({ error:'Supabase env vars missing' });

  const ip = (req.headers['x-forwarded-for']||req.socket?.remoteAddress||'').split(',')[0].trim();
  if (rateLimit(ip)) return res.status(429).json({ error:'Rate limited' });

  const action = req.query.action || 'cached';
  const db     = createClient(SB_URL, SB_KEY);

  // ── STATUS ──────────────────────────────────────────────────────────────
  if (action === 'status') {
    try {
      const [{ count:total }, { count:ext }, { data:latest }] = await Promise.all([
        db.from('news_posts').select('*',{count:'exact',head:true}),
        db.from('news_posts').select('*',{count:'exact',head:true}).eq('is_external',true),
        db.from('news_posts').select('title,published_at,source_name').eq('is_external',true)
          .order('published_at',{ascending:false}).limit(3),
      ]);
      return res.json({
        success:              true,
        total_articles:       total  || 0,
        crawled_articles:     ext    || 0,
        latest_3:             latest || [],
        gnews_configured:     !!GNEWS_KEY,
        newsapi_configured:   !!NEWSAPI_KEY,
        note:                 'GNews free tier has a 12-hour delay. Upgrade to €9/month for real-time news.',
        setup_missing:        [
          !GNEWS_KEY   ? 'GNEWS_API_KEY — sign up free at gnews.io'   : null,
          !NEWSAPI_KEY ? 'NEWSAPI_KEY — sign up free at newsapi.org'  : null,
        ].filter(Boolean),
      });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  // ── CACHED ──────────────────────────────────────────────────────────────
  if (action === 'cached') {
    const { data, error } = await db.from('news_posts')
      .select('id,title,slug,excerpt,summary,category,image_url,published_at,author,source_name,source_url')
      .eq('published',true).order('published_at',{ascending:false}).limit(30);
    if (error) return res.status(500).json({ error:error.message });
    return res.json({ success:true, count:(data||[]).length, data:data||[] });
  }

  // ── FETCH ────────────────────────────────────────────────────────────────
  if (action === 'fetch') {
    const key    = req.headers['x-admin-key'] || req.query.admin_key || '';
    const isCron = req.headers['x-vercel-cron'] === '1';
    if (!isCron && ADMIN_KEY && key !== ADMIN_KEY) {
      return res.status(401).json({ error:'Admin key required' });
    }

    if (!GNEWS_KEY && !NEWSAPI_KEY) {
      return res.json({
        success: false,
        error:   'No news API keys configured',
        action_required: [
          '1. Go to https://gnews.io — sign up free, copy your API key',
          '2. Go to Vercel → fantasy-psl → Settings → Environment Variables',
          '3. Add: GNEWS_API_KEY = [your key]',
          '4. Redeploy, then trigger this endpoint again',
          '',
          'Optional second source:',
          '5. Go to https://newsapi.org — sign up free',
          '6. Add: NEWSAPI_KEY = [your key]',
        ],
      });
    }

    const t0      = Date.now();
    const allRaw  = [];
    const tierLog = [];

    // Run both sources
    const [gn, na] = await Promise.all([
      fetchGNews(),
      fetchNewsAPI(),
    ]);

    allRaw.push(...gn.items, ...na.items);
    tierLog.push({ tier:'GNews API',   found:gn.items.length, error:gn.error });
    tierLog.push({ tier:'NewsAPI.org', found:na.items.length, error:na.error });

    // Deduplicate across both sources
    const seen    = new Set();
    const deduped = allRaw.filter(item => {
      if (seen.has(item.external_id)) return false;
      seen.add(item.external_id); return true;
    });

    console.log(`[crawler] Total unique articles: ${deduped.length}`);
    const { published, skipped, errors } = await saveArticles(db, deduped);

    // Prune articles older than 21 days
    try {
      const cutoff = new Date(Date.now() - 21*86400000).toISOString();
      await db.from('news_posts').delete().eq('is_external',true).lt('published_at',cutoff);
    } catch(_) {}

    const duration = ((Date.now()-t0)/1000).toFixed(1);
    const message  = !GNEWS_KEY && !NEWSAPI_KEY
      ? '⚠ No API keys configured — see action_required'
      : published > 0
        ? `✅ ${published} new articles published — visible on site immediately`
        : deduped.length === 0
          ? '⚠ GNews free tier 12-hour delay — articles from yesterday and older will appear. Trigger again in 12 hours OR upgrade gnews.io to €9/month for real-time news.'
          : `ℹ ${skipped} articles already in database`;

    return res.json({
      success: true,
      duration:`${duration}s`,
      total_found: deduped.length,
      published,
      skipped,
      errors:  errors.slice(0,10),
      tiers:   tierLog,
      message,
    });
  }

  return res.status(400).json({ error:`Unknown action: ${action}`, valid:['fetch','status','cached'] });
};
