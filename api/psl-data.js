// ============================================================
//  Fantasy PSL — Serverless Data API
//  Netlify Function: /api/psl-data
//
//  Powered by API-Football (api-football-v1.p.rapidapi.com)
//  PSL League ID: 288 | Season: 2024
//
//  Endpoints:
//    - /standings        → Live league table
//    - /fixtures?live=all → Live scores (during matches)
//    - /fixtures?last=10  → Recent results
//    - /fixtures?next=10  → Upcoming fixtures
//
//  Cache: 60s during live matches, 5min otherwise
// ============================================================

const API_KEY  = 'efd40a28aa4d2ed1758174bd319553d1';
const API_HOST = 'api-football-v1.p.rapidapi.com';
const LEAGUE   = 288;
const SEASON   = 2024;

const API_HEADERS = {
  'x-rapidapi-key':  API_KEY,
  'x-rapidapi-host': API_HOST
};

const SHORT = {
  'Orlando Pirates':   'Pirates',
  'Mamelodi Sundowns': 'Sundowns',
  'Sekhukhune United': 'Sekhukhune',
  'Durban City':       'Durban City',
  'Kaizer Chiefs':     'Chiefs',
  'AmaZulu FC':        'AmaZulu',
  'Polokwane City':    'Polokwane',
  'TS Galaxy':         'TS Galaxy',
  'Stellenbosch FC':   'Stellenbosch',
  'Golden Arrows':     'Arrows',
  'Siwelele':          'Siwelele',
  'Richards Bay':      'R. Bay',
  'Chippa United':     'Chippa',
  'Marumo Gallants':   'Gallants',
  'Orbit College':     'Orbit Col.',
  'Magesi':            'Magesi'
};

const LOGOS = {
  'Orlando Pirates':   'https://images.supersport.com/media/wkfgti45/orlando-pirates.png',
  'Mamelodi Sundowns': 'https://images.supersport.com/media/hiklyiw5/mamelodi_sundowns_fc_logo_200x200.png',
  'Sekhukhune United': 'https://images.supersport.com/media/ysvjj3ep/sekhuk-united.png',
  'Durban City':       'https://images.supersport.com/media/yi4mugcg/durban_city_logo_200x200.png',
  'Kaizer Chiefs':     'https://images.supersport.com/media/snyn3ar5/kaizerchiefs_new-logo_200x200.png',
  'AmaZulu FC':        'https://images.supersport.com/media/lkll0gep/amazulufc_-2025_logo_rgb_124.png',
  'Polokwane City':    'https://images.supersport.com/media/sw2l3sct/polokwane_city_fc_logo_160x160.png',
  'TS Galaxy':         'https://images.supersport.com/media/p4adysnj/tsgalaxy.png',
  'Stellenbosch FC':   'https://images.supersport.com/media/qjfnk22o/stellenbosch-fc.png',
  'Golden Arrows':     'https://images.supersport.com/media/ou1p0ums/lamontville-golden-arrows.png',
  'Siwelele':          'https://images.supersport.com/media/fprdumlm/siwelele-fc.png',
  'Richards Bay':      'https://images.supersport.com/media/o03dsxyb/richards-bay.png',
  'Chippa United':     'https://images.supersport.com/media/n2jl52bj/chippa-united.png',
  'Marumo Gallants':   'https://images.supersport.com/media/xdbdstfu/marumo-gallants-fc.png',
  'Orbit College':     'https://images.supersport.com/media/dx3jsm15/orbit-college-fc.png',
  'Magesi':            'https://images.supersport.com/media/yc3lut03/magesi-fc.png'
};

async function apiFetch(path) {
  const url = `https://${API_HOST}/v3${path}`;
  const res = await fetch(url, { headers: API_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

function getShort(name) {
  if (SHORT[name]) return SHORT[name];
  for (const key of Object.keys(SHORT)) {
    if (name.includes(key) || key.includes(name)) return SHORT[key];
  }
  return name.length > 12 ? name.slice(0, 11) + '.' : name;
}

function getLogo(name, apiLogo) {
  if (LOGOS[name]) return LOGOS[name];
  for (const key of Object.keys(LOGOS)) {
    if (name.includes(key) || key.includes(name)) return LOGOS[key];
  }
  return apiLogo || '';
}

function parseStandings(data) {
  try {
    const rows = data.response[0][0].league.standings[0];
    return rows.map(s => ({
      pos:  s.rank,
      team: s.team.name,
      abbr: getShort(s.team.name),
      logo: getLogo(s.team.name, s.team.logo),
      p:    s.all.played,
      w:    s.all.win,
      d:    s.all.draw,
      l:    s.all.lose,
      gf:   s.all.goals.for,
      ga:   s.all.goals.against,
      gd:   s.goalsDiff,
      pts:  s.points,
      form: s.form || ''
    }));
  } catch (e) { return []; }
}

function parseFixture(f) {
  const status  = f.fixture.status.short;
  const isLive  = ['1H','HT','2H','ET','BT','PEN','LIVE'].includes(status);
  const isDone  = ['FT','AET','PEN'].includes(status);
  const elapsed = f.fixture.status.elapsed;
  return {
    id:       f.fixture.id,
    date:     f.fixture.date,
    home:     f.teams.home.name,
    homeAbbr: getShort(f.teams.home.name),
    homeLogo: getLogo(f.teams.home.name, f.teams.home.logo),
    away:     f.teams.away.name,
    awayAbbr: getShort(f.teams.away.name),
    awayLogo: getLogo(f.teams.away.name, f.teams.away.logo),
    hg:       (isDone || isLive) ? f.goals.home : null,
    ag:       (isDone || isLive) ? f.goals.away : null,
    status,
    isLive,
    isDone,
    elapsed:  isLive ? elapsed : null,
    venue:    f.fixture.venue?.name || ''
  };
}

function getFallbackData() {
  return {
    source: 'fallback', updated: new Date().toISOString(), isLive: false,
    table: [
      { pos:1,  team:'Orlando Pirates',   abbr:'Pirates',      logo:LOGOS['Orlando Pirates'],   p:20, w:14, d:2, l:4,  gf:38, ga:18, gd:20,  pts:44, form:'WWWDW' },
      { pos:2,  team:'Mamelodi Sundowns', abbr:'Sundowns',     logo:LOGOS['Mamelodi Sundowns'], p:20, w:13, d:5, l:2,  gf:35, ga:15, gd:20,  pts:44, form:'WWWWW' },
      { pos:3,  team:'Sekhukhune United', abbr:'Sekhukhune',   logo:LOGOS['Sekhukhune United'], p:20, w:9,  d:5, l:6,  gf:28, ga:22, gd:6,   pts:32, form:'DWWLD' },
      { pos:4,  team:'Durban City',       abbr:'Durban City',  logo:LOGOS['Durban City'],       p:20, w:10, d:4, l:6,  gf:30, ga:23, gd:7,   pts:34, form:'WWDLW' },
      { pos:5,  team:'AmaZulu FC',        abbr:'AmaZulu',      logo:LOGOS['AmaZulu FC'],        p:19, w:9,  d:3, l:7,  gf:27, ga:24, gd:3,   pts:30, form:'LWWWL' },
      { pos:6,  team:'Kaizer Chiefs',     abbr:'Chiefs',       logo:LOGOS['Kaizer Chiefs'],     p:19, w:8,  d:6, l:5,  gf:26, ga:22, gd:4,   pts:30, form:'DLWDW' },
      { pos:7,  team:'Polokwane City',    abbr:'Polokwane',    logo:LOGOS['Polokwane City'],    p:20, w:7,  d:7, l:6,  gf:24, ga:23, gd:1,   pts:28, form:'DDLLD' },
      { pos:8,  team:'TS Galaxy',         abbr:'TS Galaxy',    logo:LOGOS['TS Galaxy'],         p:21, w:7,  d:3, l:11, gf:22, ga:30, gd:-8,  pts:24, form:'LWLWL' },
      { pos:9,  team:'Richards Bay',      abbr:'R. Bay',       logo:LOGOS['Richards Bay'],      p:20, w:5,  d:8, l:7,  gf:20, ga:25, gd:-5,  pts:23, form:'DWDWD' },
      { pos:10, team:'Stellenbosch FC',   abbr:'Stellenbosch', logo:LOGOS['Stellenbosch FC'],   p:20, w:6,  d:5, l:9,  gf:21, ga:27, gd:-6,  pts:23, form:'LLDWL' },
      { pos:11, team:'Siwelele',          abbr:'Siwelele',     logo:LOGOS['Siwelele'],          p:20, w:5,  d:7, l:8,  gf:18, ga:24, gd:-6,  pts:22, form:'DLDWD' },
      { pos:12, team:'Golden Arrows',     abbr:'Arrows',       logo:LOGOS['Golden Arrows'],     p:20, w:6,  d:3, l:11, gf:19, ga:29, gd:-10, pts:21, form:'LWLLL' },
      { pos:13, team:'Chippa United',     abbr:'Chippa',       logo:LOGOS['Chippa United'],     p:19, w:4,  d:7, l:8,  gf:17, ga:25, gd:-8,  pts:19, form:'DLDLD' },
      { pos:14, team:'Orbit College',     abbr:'Orbit Col.',   logo:LOGOS['Orbit College'],     p:21, w:5,  d:3, l:13, gf:18, ga:35, gd:-17, pts:18, form:'LWLLL' },
      { pos:15, team:'Marumo Gallants',   abbr:'Gallants',     logo:LOGOS['Marumo Gallants'],   p:21, w:3,  d:6, l:12, gf:15, ga:32, gd:-17, pts:15, form:'LLDLL' },
      { pos:16, team:'Magesi',            abbr:'Magesi',       logo:LOGOS['Magesi'],            p:18, w:2,  d:6, l:10, gf:14, ga:28, gd:-14, pts:12, form:'DLLLD' }
    ],
    results: [
      { id:1, date:'2026-03-04T15:00:00+02:00', home:'Polokwane City',    homeAbbr:'Polokwane',  homeLogo:LOGOS['Polokwane City'],    away:'Orlando Pirates',   awayAbbr:'Pirates',     awayLogo:LOGOS['Orlando Pirates'],   hg:1, ag:2, status:'FT', isLive:false, isDone:true,  elapsed:null, venue:'Peter Mokaba Stadium' },
      { id:2, date:'2026-03-04T17:30:00+02:00', home:'Mamelodi Sundowns', homeAbbr:'Sundowns',   homeLogo:LOGOS['Mamelodi Sundowns'], away:'Golden Arrows',     awayAbbr:'Arrows',      awayLogo:LOGOS['Golden Arrows'],     hg:2, ag:1, status:'FT', isLive:false, isDone:true,  elapsed:null, venue:'Loftus Versfeld' },
      { id:3, date:'2026-03-04T15:00:00+02:00', home:'Orbit College',     homeAbbr:'Orbit Col.', homeLogo:LOGOS['Orbit College'],     away:'TS Galaxy',         awayAbbr:'TS Galaxy',   awayLogo:LOGOS['TS Galaxy'],         hg:2, ag:1, status:'FT', isLive:false, isDone:true,  elapsed:null, venue:'' },
      { id:4, date:'2026-03-04T17:30:00+02:00', home:'Durban City',       homeAbbr:'Durban City',homeLogo:LOGOS['Durban City'],       away:'Marumo Gallants',   awayAbbr:'Gallants',    awayLogo:LOGOS['Marumo Gallants'],   hg:1, ag:0, status:'FT', isLive:false, isDone:true,  elapsed:null, venue:'' },
      { id:5, date:'2026-03-03T15:00:00+02:00', home:'Richards Bay',      homeAbbr:'R. Bay',     homeLogo:LOGOS['Richards Bay'],      away:'Kaizer Chiefs',     awayAbbr:'Chiefs',      awayLogo:LOGOS['Kaizer Chiefs'],     hg:1, ag:0, status:'FT', isLive:false, isDone:true,  elapsed:null, venue:'' },
      { id:6, date:'2026-03-03T17:30:00+02:00', home:'Siwelele',          homeAbbr:'Siwelele',   homeLogo:LOGOS['Siwelele'],          away:'Stellenbosch FC',   awayAbbr:'Stellenbosch',awayLogo:LOGOS['Stellenbosch FC'],   hg:0, ag:0, status:'FT', isLive:false, isDone:true,  elapsed:null, venue:'' }
    ],
    fixtures: [
      { id:10, date:'2026-03-07T19:30:00+02:00', home:'Kaizer Chiefs',     homeAbbr:'Chiefs',       homeLogo:LOGOS['Kaizer Chiefs'],     away:'Mamelodi Sundowns', awayAbbr:'Sundowns',    awayLogo:LOGOS['Mamelodi Sundowns'], hg:null, ag:null, status:'NS', isLive:false, isDone:false, elapsed:null, venue:'FNB Stadium' },
      { id:11, date:'2026-03-07T19:30:00+02:00', home:'Richards Bay',      homeAbbr:'R. Bay',       homeLogo:LOGOS['Richards Bay'],      away:'AmaZulu FC',        awayAbbr:'AmaZulu',     awayLogo:LOGOS['AmaZulu FC'],        hg:null, ag:null, status:'NS', isLive:false, isDone:false, elapsed:null, venue:'' },
      { id:12, date:'2026-03-08T15:00:00+02:00', home:'Durban City',       homeAbbr:'Durban City',  homeLogo:LOGOS['Durban City'],       away:'Orlando Pirates',   awayAbbr:'Pirates',     awayLogo:LOGOS['Orlando Pirates'],   hg:null, ag:null, status:'NS', isLive:false, isDone:false, elapsed:null, venue:'' },
      { id:13, date:'2026-03-08T17:30:00+02:00', home:'TS Galaxy',         homeAbbr:'TS Galaxy',    homeLogo:LOGOS['TS Galaxy'],         away:'Polokwane City',    awayAbbr:'Polokwane',   awayLogo:LOGOS['Polokwane City'],    hg:null, ag:null, status:'NS', isLive:false, isDone:false, elapsed:null, venue:'' },
      { id:14, date:'2026-03-08T17:30:00+02:00', home:'Chippa United',     homeAbbr:'Chippa',       homeLogo:LOGOS['Chippa United'],     away:'Sekhukhune United', awayAbbr:'Sekhukhune',  awayLogo:LOGOS['Sekhukhune United'], hg:null, ag:null, status:'NS', isLive:false, isDone:false, elapsed:null, venue:'' },
      { id:15, date:'2026-03-15T15:00:00+02:00', home:'Mamelodi Sundowns', homeAbbr:'Sundowns',     homeLogo:LOGOS['Mamelodi Sundowns'], away:'Siwelele',          awayAbbr:'Siwelele',    awayLogo:LOGOS['Siwelele'],          hg:null, ag:null, status:'NS', isLive:false, isDone:false, elapsed:null, venue:'' },
      { id:16, date:'2026-03-15T17:30:00+02:00', home:'Orlando Pirates',   homeAbbr:'Pirates',      homeLogo:LOGOS['Orlando Pirates'],   away:'Magesi',            awayAbbr:'Magesi',      awayLogo:LOGOS['Magesi'],            hg:null, ag:null, status:'NS', isLive:false, isDone:false, elapsed:null, venue:'' }
    ],
    live: []
  };
}

exports.handler = async function(event, context) {
  try {
    const [standingsData, resultsData, fixturesData, liveData] = await Promise.all([
      apiFetch(`/standings?league=${LEAGUE}&season=${SEASON}`),
      apiFetch(`/fixtures?league=${LEAGUE}&season=${SEASON}&last=10`),
      apiFetch(`/fixtures?league=${LEAGUE}&season=${SEASON}&next=10`),
      apiFetch(`/fixtures?league=${LEAGUE}&live=all`)
    ]);

    const table    = parseStandings(standingsData);
    const results  = (resultsData.response  || []).map(parseFixture).filter(f => f.isDone);
    const fixtures = (fixturesData.response || []).map(parseFixture).filter(f => !f.isDone && !f.isLive);
    const live     = (liveData.response     || []).map(parseFixture);

    if (table.length < 8) {
      console.log('API returned insufficient data — using fallback');
      return respond(getFallbackData(), false);
    }

    const isLiveNow = live.length > 0;
    return respond({
      source:  'api-football',
      updated: new Date().toISOString(),
      isLive:  isLiveNow,
      table:   table.length   ? table    : getFallbackData().table,
      results: results.length ? results  : getFallbackData().results,
      fixtures:fixtures.length? fixtures : getFallbackData().fixtures,
      live
    }, isLiveNow);

  } catch (err) {
    console.error('API-Football error:', err.message);
    return respond(getFallbackData(), false);
  }
};

function respond(body, isLiveNow) {
  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
      // 60s cache during live games, 5min otherwise (CDN 1hr when idle)
      'Cache-Control': isLiveNow
        ? 'public, s-maxage=60, max-age=60'
        : 'public, s-maxage=3600, max-age=300'
    },
    body: JSON.stringify(body)
  };
}
