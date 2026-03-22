// api/live-matches.js — live PSL matches via Sportmonks
const TOKEN  = process.env.SPORTMONKS_TOKEN;
const PSL_ID = 806;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (!TOKEN) return res.status(500).json({ error: 'SPORTMONKS_TOKEN not set' });

  try {
    var r    = await fetch('https://api.sportmonks.com/v3/football/livescores/inplay?include=participants;scores;state&filters=fixtureLeagues:' + PSL_ID + '&api_token=' + TOKEN);
    var json = await r.json();
    var data = json.data || [];
    var matches = data.map(function(f) {
      var parts = f.participants||[];
      var home  = parts.find(function(p){return p.meta&&p.meta.location==='home';})||parts[0]||{};
      var away  = parts.find(function(p){return p.meta&&p.meta.location==='away';})||parts[1]||{};
      var hg=null,ag=null;
      (f.scores||[]).forEach(function(s){
        var d=(s.description||'').toUpperCase();
        if(['CURRENT','FT','2ND_HALF','FULLTIME'].indexOf(d)>-1){
          if(s.score&&s.score.participant==='home') hg=s.score.goals;
          if(s.score&&s.score.participant==='away') ag=s.score.goals;
        }
      });
      return { fixture_id:f.id, home:home.name||'', away:away.name||'',
               home_logo:home.image_path||'', away_logo:away.image_path||'',
               hg:hg, ag:ag, is_live:true, status:'LIVE',
               elapsed:f.minute||null, date:f.starting_at };
    });
    return res.json({ isLive: matches.length>0, matches: matches, count: matches.length });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
};
