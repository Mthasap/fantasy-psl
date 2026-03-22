// api/sportmonks.js — generic Sportmonks proxy (for admin/debug use)
const TOKEN = process.env.SPORTMONKS_TOKEN;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (!TOKEN) return res.status(500).json({ error: 'SPORTMONKS_TOKEN not set' });

  var endpoint = req.query && req.query.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint query param required' });

  // Safety: only allow football endpoints
  if (endpoint.includes('..') || !endpoint.match(/^[a-zA-Z0-9\/_\-?&=:,]+$/)) {
    return res.status(400).json({ error: 'Invalid endpoint' });
  }

  try {
    var sep = endpoint.includes('?') ? '&' : '?';
    var url = 'https://api.sportmonks.com/v3/football/' + endpoint + sep + 'api_token=' + TOKEN;
    var r    = await fetch(url, { headers: { Accept: 'application/json' } });
    var data = await r.json();
    return res.status(r.status).json(data);
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
};
