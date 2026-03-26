// api/robots.js — robots.txt for Fantasy PSL
// Tells search engines what to crawl and where the sitemap is

const BASE_URL = 'https://www.fantasypsl.co.za';

module.exports = (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=86400');

  var robots = [
    'User-agent: *',
    'Allow: /',
    '',
    '# Block admin panel from indexing',
    'Disallow: /admin',
    'Disallow: /api/',
    '',
    '# Sitemap location',
    'Sitemap: ' + BASE_URL + '/sitemap.xml',
  ].join('\n');

  res.status(200).send(robots);
};
