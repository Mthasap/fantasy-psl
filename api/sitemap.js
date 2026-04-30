// api/sitemap.js — Fantasy PSL — Google News + Standard Sitemap
// ══════════════════════════════════════════════════════════════════
// Two sitemaps served from one endpoint:
//   /sitemap.xml        → index listing both sitemaps
//   /sitemap.xml?type=news  → Google News sitemap (last 2 days)
//   /sitemap.xml?type=pages → Static pages + all news articles
//
// Google Search Console: submit https://www.fantasypsl.co.za/sitemap.xml
// ══════════════════════════════════════════════════════════════════

const BASE_URL = 'https://www.fantasypsl.co.za';
const SB_URL   = process.env.SUPABASE_URL        || '';
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
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

module.exports = async (req, res) => {
  var type = (req.query && req.query.type) || 'index';
  var now  = new Date().toISOString().split('T')[0];

  // ── Sitemap Index (default) ──────────────────────────────────────────────
  if (type === 'index' || !req.query.type) {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    var xml = [
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
    return res.status(200).send(xml);
  }

  // ── Google News Sitemap (type=news) ─────────────────────────────────────
  // Only articles from the last 2 days (Google News requirement)
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
      if (!pubDate.endsWith('Z') && !pubDate.includes('+')) pubDate += 'Z';
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

    var xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
      '        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">',
      entries || '  <!-- No articles in last 2 days -->',
      '</urlset>'
    ].join('\n');
    return res.status(200).send(xml);
  }

  // ── Pages Sitemap (type=pages) ──────────────────────────────────────────
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');

  var staticPages = [
    { url: '/',        priority: '1.0', changefreq: 'daily',  lastmod: now },
    { url: '/news',    priority: '0.9', changefreq: 'hourly', lastmod: now },
    { url: '/confirm', priority: '0.3', changefreq: 'yearly', lastmod: now },
  ];

  var posts = await fetchPosts(
    'slug,title,published_at,updated_at',
    'published=eq.true'
  );

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
      '    <loc>' + BASE_URL + page.url + '</loc>',
      '    <lastmod>' + page.lastmod + '</lastmod>',
      '    <changefreq>' + page.changefreq + '</changefreq>',
      '    <priority>' + page.priority + '</priority>',
      '  </url>'
    ].join('\n');
  }).join('\n');

  var xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urlEntries,
    '</urlset>'
  ].join('\n');

  return res.status(200).send(xml);
};
