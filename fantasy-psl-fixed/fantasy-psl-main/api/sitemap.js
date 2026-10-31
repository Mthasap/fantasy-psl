// api/sitemap.js — Fantasy PSL — Google News + Standard Sitemap (redeploy build)
// ══════════════════════════════════════════════════════════════════════════
// Endpoints (one function, switched by ?type=):
//   /sitemap.xml               → sitemap index (lists the two child sitemaps)
//   /sitemap.xml?type=news     → Google News sitemap (articles from last 2 days)
//   /sitemap.xml?type=pages    → static pages + all published news articles
//   /sitemap.xml?type=robots   → robots.txt (also served at /robots.txt via rewrite)
//
// Google Search Console: submit https://www.fantasypsl.co.za/sitemap.xml
//
// IMPORTANT (deployment): to serve /robots.txt from this function, add a rewrite
// in vercel.json, otherwise /robots.txt 404s and only ?type=robots works:
//   { "source": "/robots.txt", "destination": "/api/sitemap?type=robots" }
//   { "source": "/sitemap.xml", "destination": "/api/sitemap" }
// ══════════════════════════════════════════════════════════════════════════

const BASE_URL = 'https://www.fantasypsl.co.za';
const SB_URL   = process.env.SUPABASE_URL         || '';
const SB_KEY   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

async function fetchPosts(select, filter) {
  if (!SB_URL || !SB_KEY) return [];
  try {
    var url = SB_URL + '/rest/v1/news_posts?' + filter + '&select=' + select +
              '&order=published_at.desc&limit=200';
    var r = await fetch(url, {
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Accept': 'application/json' }
    });
    if (!r.ok) return [];
    return (await r.json()) || [];
  } catch (e) { return []; }
}

function makeSlug(post) {
  return post.slug || (post.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function xmlEscape(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                  .replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

module.exports = async (req, res) => {
  // Harden query access — some runtimes can leave req.query undefined.
  var query = (req && req.query) || {};
  var url   = (req && req.url) || '';
  var hdrs  = (req && req.headers) || {};
  var type  = query.type || 'index';

  // ── robots.txt ────────────────────────────────────────────────────────
  if (type === 'robots' || url === '/robots.txt' || hdrs['x-original-url'] === '/robots.txt') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=86400');
    return res.status(200).send([
      'User-agent: *',
      'Allow: /',
      '',
      '# Block admin panel and API from indexing',
      'Disallow: /admin',
      'Disallow: /api/',
      '',
      '# Sitemap location',
      'Sitemap: ' + BASE_URL + '/sitemap.xml',
    ].join('\n'));
  }

  var now = new Date().toISOString().split('T')[0];

  // ── Sitemap index (default) ─────────────────────────────────────────────
  if (type === 'index') {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    var idx = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      '  <sitemap>',
      '    <loc>' + BASE_URL + '/sitemap.xml?type=pages</loc>',
      '    <lastmod>' + now + '</lastmod>',
      '  </sitemap>',
      '  <sitemap>',
      '    <loc>' + BASE_URL + '/sitemap.xml?type=news</loc>',
      '    <lastmod>' + now + '</lastmod>',
      '  </sitemap>',
      '</sitemapindex>'
    ].join('\n');
    return res.status(200).send(idx);
  }

  // ── Google News sitemap (last 2 days only) ──────────────────────────────
  if (type === 'news') {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=120');

    var twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    var posts = await fetchPosts(
      'slug,title,published_at,updated_at,category,author',
      'published=eq.true&published_at=gte.' + twoDaysAgo
    );

    var entries = posts.map(function(post) {
      var slug    = makeSlug(post);
      var pubDate = (post.published_at || '').replace(' ', 'T');
      if (pubDate && !pubDate.endsWith('Z') && !pubDate.includes('+')) pubDate += 'Z';
      return [
        '  <url>',
        '    <loc>' + BASE_URL + '/news/' + xmlEscape(slug) + '</loc>',
        '    <lastmod>' + (post.updated_at || post.published_at || '').split('T')[0] + '</lastmod>',
        '    <news:news>',
        '      <news:publication>',
        '        <news:name>Fantasy PSL</news:name>',
        '        <news:language>en</news:language>',
        '      </news:publication>',
        '      <news:publication_date>' + pubDate + '</news:publication_date>',
        '      <news:title>' + xmlEscape(post.title || '') + '</news:title>',
        '      <news:keywords>PSL, Betway Premiership, Fantasy Football, Fantasy PSL' +
          (post.category ? ', ' + xmlEscape(post.category) : '') + '</news:keywords>',
        '    </news:news>',
        '  </url>'
      ].join('\n');
    }).join('\n');

    var newsXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
      '        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">',
      entries || '  <!-- No articles in last 2 days -->',
      '</urlset>'
    ].join('\n');
    return res.status(200).send(newsXml);
  }

  // ── Pages sitemap (static pages + all published articles) ───────────────
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');

  var staticPages = [
    { url: '/',        priority: '1.0', changefreq: 'daily',   lastmod: now },
    { url: '/news',    priority: '0.9', changefreq: 'hourly',  lastmod: now },
    { url: '/about',   priority: '0.8', changefreq: 'monthly', lastmod: now },
    { url: '/privacy', priority: '0.4', changefreq: 'yearly',  lastmod: now },
    { url: '/terms',   priority: '0.4', changefreq: 'yearly',  lastmod: now },
    { url: '/confirm', priority: '0.3', changefreq: 'yearly',  lastmod: now },
  ];

  var posts = await fetchPosts('slug,title,published_at,updated_at', 'published=eq.true');

  var articles = posts.map(function(post) {
    var slug    = makeSlug(post);
    var lastmod = (post.updated_at || post.published_at || '').split('T')[0];
    return {
      url:        '/news/' + slug,
      priority:   '0.85',
      changefreq: 'weekly',
      lastmod:    lastmod || now
    };
  });

  var urlEntries = staticPages.concat(articles).map(function(page) {
    return [
      '  <url>',
      '    <loc>' + BASE_URL + xmlEscape(page.url) + '</loc>',
      '    <lastmod>' + page.lastmod + '</lastmod>',
      '    <changefreq>' + page.changefreq + '</changefreq>',
      '    <priority>' + page.priority + '</priority>',
      '  </url>'
    ].join('\n');
  }).join('\n');

  var pagesXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urlEntries,
    '</urlset>'
  ].join('\n');

  return res.status(200).send(pagesXml);
};
