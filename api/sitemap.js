// api/sitemap.js — Dynamic XML sitemap for Fantasy PSL
// Reads published news articles from Supabase and generates a proper sitemap
// Google indexes this at https://www.fantasypsl.co.za/sitemap.xml
//
// STATIC PAGES always included:
//   / (home), /news, /confirm
// DYNAMIC PAGES pulled from Supabase:
//   /news/{slug} for each published news article

const BASE_URL = 'https://www.fantasypsl.co.za';
const SB_URL   = process.env.SUPABASE_URL        || '';
const SB_KEY   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');

  // Static pages
  var staticPages = [
    { url: '/',        priority: '1.0', changefreq: 'daily'   },
    { url: '/news',    priority: '0.9', changefreq: 'daily'   },
    { url: '/confirm', priority: '0.3', changefreq: 'yearly'  },
  ];

  // Dynamic news article pages
  var articles = [];
  try {
    if (SB_URL && SB_KEY) {
      var r = await fetch(
        SB_URL + '/rest/v1/news_posts?published=eq.true&select=slug,title,published_at,updated_at&order=published_at.desc&limit=200',
        { headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Accept': 'application/json' } }
      );
      if (r.ok) {
        var posts = await r.json();
        articles = (posts || []).map(function(post) {
          // Use slug if set, otherwise generate from title
          var slug = post.slug || (post.title || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
          var lastmod = (post.updated_at || post.published_at || '').split('T')[0];
          return { url: '/news/' + slug, priority: '0.8', changefreq: 'weekly', lastmod: lastmod };
        });
      }
    }
  } catch(e) {
    console.error('[sitemap] Supabase error:', e.message);
  }

  var now = new Date().toISOString().split('T')[0];

  var urlEntries = staticPages.concat(articles).map(function(page) {
    return [
      '  <url>',
      '    <loc>' + BASE_URL + page.url + '</loc>',
      page.lastmod
        ? '    <lastmod>' + page.lastmod + '</lastmod>'
        : '    <lastmod>' + now + '</lastmod>',
      '    <changefreq>' + page.changefreq + '</changefreq>',
      '    <priority>' + page.priority + '</priority>',
      '  </url>'
    ].join('\n');
  }).join('\n');

  var xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">',
    urlEntries,
    '</urlset>'
  ].join('\n');

  res.status(200).send(xml);
};
