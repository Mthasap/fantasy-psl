// api/news-agent.js — Fantasy PSL — AI News Article Agent
// ══════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Automatically generates and publishes PSL / Bafana Bafana /
//   World Cup news articles using Claude AI + web search, with full SEO
//   meta tags to rank on Google for SA football searches.
//
// HOW IT WORKS:
//   1. Fetches latest PSL fixtures + standings from API-Football
//   2. Crawls SA football RSS feeds for trending topics
//   3. Sends context to Claude (claude-sonnet-4-6) to write original articles
//   4. Inserts articles into news_posts with full SEO schema markup
//   5. Auto-categorises: PSL News, Bafana Bafana, World Cup, Fantasy Tips
//
// ENDPOINTS:
//   POST /api/news-agent?action=generate&admin_key=XXX    → generate 1 article
//   POST /api/news-agent?action=generate-batch&admin_key=XXX → generate 5
//   GET  /api/news-agent?action=status                    → health check
//   GET  /api/news-agent?action=cached                    → latest articles
//
// CRON: runs every 4 hours via vercel.json
// ══════════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL    = process.env.SUPABASE_URL         || '';
const SB_KEY    = process.env.SUPABASE_SERVICE_KEY || '';
const ADMIN_KEY = process.env.ADMIN_SECRET         || '';
const AF_KEY    = process.env.APIFOOTBALL_KEY      || '';
const PSL_LEAGUE = 288;
const PSL_SEASON = parseInt(process.env.APIFOOTBALL_SEASON || '2026');

// ── Article topics the agent cycles through ───────────────────────────────
const ARTICLE_TOPICS = [
  { category: 'PSL News',       angle: 'Latest Betway Premiership match results and table standings', keywords: ['PSL', 'Betway Premiership', 'South Africa football'] },
  { category: 'Bafana Bafana',  angle: 'Bafana Bafana squad news, AFCON qualifiers and national team updates', keywords: ['Bafana Bafana', 'South Africa national team', 'SAFA'] },
  { category: 'World Cup',      angle: 'FIFA World Cup 2026 news including South Africa qualifying and group stage previews', keywords: ['FIFA World Cup 2026', 'World Cup qualifying', 'South Africa World Cup'] },
  { category: 'Fantasy Tips',   angle: 'Fantasy PSL gameweek tips: best captain picks, value players and transfer advice', keywords: ['Fantasy PSL tips', 'PSL fantasy football', 'gameweek captain pick'] },
  { category: 'Transfer News',  angle: 'PSL transfer window: signings, departures and rumours from Betway Premiership clubs', keywords: ['PSL transfers', 'Betway Premiership signings', 'PSL transfer window'] },
  { category: 'Match Preview',  angle: 'Big Betway Premiership match preview with tactical analysis and predicted lineups', keywords: ['PSL match preview', 'Betway Premiership fixtures', 'South Africa soccer'] },
  { category: 'Club News',      angle: 'Club focus: latest news from Kaizer Chiefs, Orlando Pirates, Mamelodi Sundowns', keywords: ['Kaizer Chiefs', 'Orlando Pirates', 'Mamelodi Sundowns'] },
  { category: 'Injury Update',  angle: 'PSL injury and suspension round-up for Fantasy PSL managers', keywords: ['PSL injuries', 'Fantasy PSL', 'player availability'] },
];

// ── SEO meta tags for each category ──────────────────────────────────────
const CATEGORY_SEO = {
  'PSL News':       { schema_type: 'NewsArticle', priority: 0.9, tags: ['psl', 'betway-premiership', 'south-africa-football'] },
  'Bafana Bafana':  { schema_type: 'NewsArticle', priority: 0.9, tags: ['bafana-bafana', 'south-africa-national-team', 'afcon'] },
  'World Cup':      { schema_type: 'NewsArticle', priority: 1.0, tags: ['world-cup-2026', 'fifa', 'south-africa-world-cup'] },
  'Fantasy Tips':   { schema_type: 'Article',     priority: 0.8, tags: ['fantasy-psl', 'fantasy-tips', 'captain-pick'] },
  'Transfer News':  { schema_type: 'NewsArticle', priority: 0.85, tags: ['psl-transfers', 'betway-premiership', 'signings'] },
  'Match Preview':  { schema_type: 'NewsArticle', priority: 0.85, tags: ['psl-preview', 'match-preview', 'betway-premiership'] },
  'Club News':      { schema_type: 'NewsArticle', priority: 0.8, tags: ['psl-clubs', 'kaizer-chiefs', 'orlando-pirates', 'mamelodi-sundowns'] },
  'Injury Update':  { schema_type: 'NewsArticle', priority: 0.75, tags: ['psl-injuries', 'fantasy-psl', 'player-news'] },
};

// ── Rate limiter ──────────────────────────────────────────────────────────
const _rl = new Map();
function rateLimit(ip, max = 10, ms = 60_000) {
  const now = Date.now(); const rec = _rl.get(ip) || { c: 0, r: now + ms };
  if (now > rec.r) { rec.c = 0; rec.r = now + ms; } rec.c++; _rl.set(ip, rec);
  return rec.c > max;
}

// ── Fetch live PSL context from API-Football ─────────────────────────────
async function fetchPslContext() {
  if (!AF_KEY) return { standings: [], recentResults: [], upcomingFixtures: [] };
  try {
    const [standingsRes, fixturesRes] = await Promise.allSettled([
      fetch(`https://v3.football.api-sports.io/standings?league=${PSL_LEAGUE}&season=${PSL_SEASON}`, {
        headers: { 'x-apisports-key': AF_KEY }, signal: AbortSignal.timeout(8000)
      }).then(r => r.json()),
      fetch(`https://v3.football.api-sports.io/fixtures?league=${PSL_LEAGUE}&season=${PSL_SEASON}&last=5`, {
        headers: { 'x-apisports-key': AF_KEY }, signal: AbortSignal.timeout(8000)
      }).then(r => r.json()),
    ]);

    const standings = standingsRes.status === 'fulfilled'
      ? ((standingsRes.value.response || [])[0]?.league?.standings?.[0] || [])
          .slice(0, 8)
          .map(s => `${s.rank}. ${s.team.name} — ${s.points}pts (${s.all.win}W ${s.all.draw}D ${s.all.lose}L)`)
      : [];

    const recent = fixturesRes.status === 'fulfilled'
      ? (fixturesRes.value.response || [])
          .filter(f => f.fixture.status.short === 'FT')
          .map(f => `${f.teams.home.name} ${f.goals.home}-${f.goals.away} ${f.teams.away.name}`)
      : [];

    return { standings, recentResults: recent };
  } catch (e) {
    return { standings: [], recentResults: [] };
  }
}

// ── Fetch trending topic from RSS ─────────────────────────────────────────
async function fetchTrendingTopic() {
  const feeds = [
    'https://www.sport24.co.za/rss/Soccer/LocalSoccer',
    'https://www.kickoff.com/rss/news/',
    'https://www.sowetanlive.co.za/sport/soccer/rss',
  ];
  for (const url of feeds) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'FantasyPSL/2.0 (+https://www.fantasypsl.co.za/about)' },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) continue;
      const xml = await r.text();
      const items = xml.match(/<title[^>]*><!?\[CDATA\[([^\]]+)\]\]><\/title>|<title[^>]*>([^<]+)<\/title>/gi);
      if (items && items.length > 1) {
        const cleaned = items[1].replace(/<[^>]+>/g, '').replace(/<!?\[CDATA\[|\]\]>/g, '').trim();
        if (cleaned.length > 10) return cleaned;
      }
    } catch (_) {}
  }
  return null;
}

// ── Generate article using Claude API ────────────────────────────────────
async function generateArticle(topic, context) {
  const seo = CATEGORY_SEO[topic.category] || CATEGORY_SEO['PSL News'];

  const standingsSummary = context.standings.length
    ? 'Current top 8:\n' + context.standings.join('\n')
    : 'Current PSL season in progress.';

  const recentStr = context.recentResults.length
    ? 'Recent results:\n' + context.recentResults.join('\n')
    : '';

  const trendingHint = context.trending
    ? `\nTrending topic from SA football news: "${context.trending}"`
    : '';

  const systemPrompt = `You are a professional South African football journalist writing for Fantasy PSL (fantasypsl.co.za), South Africa's number one fantasy football platform for the Betway Premiership.

Your articles must:
- Be 250-400 words, engaging, accurate, and written for South African football fans
- Include natural SEO keywords for: ${topic.keywords.join(', ')}
- Reference real PSL clubs, players, and competitions by correct name
- Connect football news to Fantasy PSL where relevant (e.g. "this makes X a must-have in your Fantasy PSL squad")
- Be factual — do not fabricate specific match scores or transfer fees
- Sound like a local SA journalist, not an AI

The World Cup 2026 is currently happening (June/July 2026). South Africa's squad includes players from PSL clubs. When writing World Cup content, focus on SA's campaign and impact on PSL players.

Respond ONLY with a JSON object — no markdown, no preamble:
{
  "title": "Article headline (max 80 chars, include main keyword)",
  "excerpt": "One sentence summary (max 160 chars) — this becomes the meta description",
  "body": "Full article HTML (use <p>, <strong>, <h3> tags only). 250-400 words.",
  "meta_title": "SEO title tag (max 60 chars)",
  "meta_description": "SEO meta description (max 160 chars)",
  "focus_keyword": "Primary SEO keyword phrase",
  "image_alt": "Alt text for the article image"
}`;

  const userPrompt = `Write a ${topic.angle} article.

${standingsSummary}
${recentStr}${trendingHint}

Category: ${topic.category}
Target keywords: ${topic.keywords.join(', ')}

Make it timely, relevant, and useful for Fantasy PSL managers.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    throw new Error('Claude API error: HTTP ' + response.status);
  }

  const data = await response.json();
  const text = (data.content || []).find(b => b.type === 'text')?.text || '';

  // Strip any markdown code fences if present
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  let article;
  try {
    article = JSON.parse(clean);
  } catch (e) {
    throw new Error('Failed to parse Claude response as JSON: ' + clean.slice(0, 200));
  }

  return article;
}

// ── Build the news_posts row with full SEO schema ─────────────────────────
function buildNewsRow(article, topic) {
  const seo    = CATEGORY_SEO[topic.category] || CATEGORY_SEO['PSL News'];
  const now    = new Date().toISOString();

  // URL-friendly slug with timestamp
  const slug = (article.title || topic.category)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .slice(0, 80) + '-' + Date.now().toString(36);

  // JSON-LD schema for this article (inserted into content)
  const schemaMarkup = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': seo.schema_type,
    'headline': article.title,
    'description': article.meta_description || article.excerpt,
    'datePublished': now,
    'dateModified': now,
    'author': { '@type': 'Organization', 'name': 'Fantasy PSL', 'url': 'https://www.fantasypsl.co.za' },
    'publisher': {
      '@type': 'Organization',
      'name': 'Fantasy PSL',
      'url': 'https://www.fantasypsl.co.za',
      'logo': { '@type': 'ImageObject', 'url': 'https://www.fantasypsl.co.za/icon-512.png' }
    },
    'mainEntityOfPage': { '@type': 'WebPage', '@id': `https://www.fantasypsl.co.za/news/${slug}` },
    'keywords': topic.keywords.join(', '),
    'articleSection': topic.category,
    'inLanguage': 'en-ZA',
  });

  const contentWithSchema = `<script type="application/ld+json">${schemaMarkup}</script>${article.body || ''}`;

  return {
    title:            (article.title || topic.angle).slice(0, 200),
    slug,
    excerpt:          (article.excerpt || '').slice(0, 300),
    summary:          (article.excerpt || '').slice(0, 500),
    content:          contentWithSchema,
    category:         topic.category,
    author:           'Fantasy PSL',
    published:        true,
    published_at:     now,
    image_url:        null,   // TODO: add image generation
    cover_image:      null,
    is_external:      false,
    is_ai_generated:  true,
    tags:             JSON.stringify(seo.tags.concat(topic.keywords.map(k => k.toLowerCase().replace(/\s+/g, '-')))),
    // SEO fields
    meta_title:       (article.meta_title || article.title || '').slice(0, 60),
    meta_description: (article.meta_description || article.excerpt || '').slice(0, 160),
    focus_keyword:    article.focus_keyword || topic.keywords[0] || '',
    schema_type:      seo.schema_type,
    sitemap_priority: String(seo.priority),
    created_at:       now,
    updated_at:       now,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.fantasypsl.co.za';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (rateLimit(ip)) return res.status(429).json({ error: 'Too many requests' });

  const action        = req.query?.action || 'cached';
  const isVercelCron  = req.headers['x-vercel-cron'] === '1';
  const isInternal    = !req.headers.origin;
  const adminKey      = req.headers['x-admin-key'] || req.query.admin_key || '';
  const isAdmin       = ADMIN_KEY && adminKey === ADMIN_KEY;

  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'Supabase env vars missing' });
  const db = createClient(SB_URL, SB_KEY);

  // ── STATUS ────────────────────────────────────────────────────────────
  if (action === 'status') {
    const { count } = await db.from('news_posts').select('*', { count: 'exact', head: true }).eq('is_ai_generated', true);
    return res.json({ success: true, ai_articles: count || 0, topics: ARTICLE_TOPICS.length });
  }

  // ── CACHED — return latest articles ──────────────────────────────────
  if (action === 'cached') {
    const { data, error } = await db
      .from('news_posts')
      .select('id,title,slug,excerpt,category,image_url,published_at,author,meta_description,focus_keyword')
      .eq('published', true)
      .order('published_at', { ascending: false })
      .limit(20);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, data: data || [] });
  }

  // ── GENERATE — create 1 article ──────────────────────────────────────
  if (action === 'generate' || action === 'generate-batch') {
    if (!isVercelCron && !isInternal && !isAdmin) {
      return res.status(401).json({ error: 'Admin key required' });
    }

    const batchSize = action === 'generate-batch' ? 5 : 1;
    const topicOverride = req.query.topic ? parseInt(req.query.topic) : null;

    // Get context once (shared across batch)
    const [pslContext, trending] = await Promise.allSettled([
      fetchPslContext(),
      fetchTrendingTopic(),
    ]);

    const context = {
      ...(pslContext.status === 'fulfilled' ? pslContext.value : {}),
      trending: trending.status === 'fulfilled' ? trending.value : null,
    };

    const log = [];
    const published = [];
    const errors = [];

    // Determine which topics to generate (rotate through all 8 to avoid duplicates)
    const { data: recentArticles } = await db
      .from('news_posts')
      .select('category')
      .eq('is_ai_generated', true)
      .order('published_at', { ascending: false })
      .limit(16);

    const recentCategories = (recentArticles || []).map(a => a.category);

    // Sort topics by how recently they were used (least recent first)
    const sortedTopics = [...ARTICLE_TOPICS].sort((a, b) => {
      const aLast = recentCategories.lastIndexOf(a.category);
      const bLast = recentCategories.lastIndexOf(b.category);
      return aLast - bLast;  // lower index (older) comes first
    });

    const topicsToGenerate = topicOverride !== null
      ? [ARTICLE_TOPICS[topicOverride % ARTICLE_TOPICS.length]]
      : sortedTopics.slice(0, batchSize);

    for (const topic of topicsToGenerate) {
      try {
        log.push(`Generating: ${topic.category}`);
        const article = await generateArticle(topic, context);
        const row     = buildNewsRow(article, topic);

        const { error: insErr } = await db.from('news_posts').insert(row);
        if (insErr) {
          errors.push(`${topic.category}: ${insErr.message}`);
          log.push(`  ❌ Insert error: ${insErr.message}`);
        } else {
          published.push({ category: topic.category, title: row.title, slug: row.slug });
          log.push(`  ✅ Published: ${row.title.slice(0, 60)}`);
        }

        // Rate-limit Claude calls (max 1 per 2 seconds)
        if (topicsToGenerate.length > 1) await new Promise(r => setTimeout(r, 2000));

      } catch (e) {
        errors.push(`${topic.category}: ${e.message}`);
        log.push(`  ❌ ${e.message}`);
      }
    }

    // Prune AI articles older than 30 days (keep DB clean)
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    await db.from('news_posts')
      .delete()
      .eq('is_ai_generated', true)
      .lt('published_at', cutoff);

    return res.json({
      success: errors.length < topicsToGenerate.length,
      published: published.length,
      errors,
      log,
      articles: published,
    });
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
};
