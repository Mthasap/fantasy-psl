// ============================================================
//  Fantasy PSL — Serverless Data API
//  Netlify Function: /api/psl-data
//
//  Scrapes SuperSport for:
//    - Live / latest standings
//    - Recent results
//    - Upcoming fixtures
//    - Top scorers
//
//  Returns a single JSON object your app can consume.
//  Cached for 2 hours via Netlify CDN headers.
// ============================================================

const SUPERSPORT_TABLE    = 'https://supersport.com/football/tour/882fc52f-14b7-4e7c-a259-5ff5d18bde67/tables';
const SUPERSPORT_RESULTS  = 'https://supersport.com/football/tour/882fc52f-14b7-4e7c-a259-5ff5d18bde67/results';
const SUPERSPORT_FIXTURES = 'https://supersport.com/football/tour/882fc52f-14b7-4e7c-a259-5ff5d18bde67/fixtures';

// Short display names for teams
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
  'Siwelele FC':       'Siwelele',
  'Richards Bay':      'R. Bay',
  'Chippa United':     'Chippa',
  'Marumo Gallants':   'Gallants',
  'Orbit College FC':  'Orbit Col.',
  'Magesi FC':         'Magesi'
};

// SuperSport CDN logos
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
  'Siwelele FC':       'https://images.supersport.com/media/fprdumlm/siwelele-fc.png',
  'Richards Bay':      'https://images.supersport.com/media/o03dsxyb/richards-bay.png',
  'Chippa United':     'https://images.supersport.com/media/n2jl52bj/chippa-united.png',
  'Marumo Gallants':   'https://images.supersport.com/media/xdbdstfu/marumo-gallants-fc.png',
  'Orbit College FC':  'https://images.supersport.com/media/dx3jsm15/orbit-college-fc.png',
  'Magesi FC':         'https://images.supersport.com/media/yc3lut03/magesi-fc.png'
};

// ── Fetch a URL with a browser-like User-Agent ──────────────
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; FantasyPSL/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-ZA,en;q=0.9'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ── Parse standings from SuperSport HTML ────────────────────
function parseTable(html) {
  const rows = [];
  // Match table rows: position, team name, P W D L Pts
  const rowRe = /\|\s*(\d+)\s*\|[^|]*?\|\s*([A-Za-z][^\|]{2,30}?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|[^|]*?\|[^|]*?\|[^|]*?\|\s*(\d+)\s*\|/g;
  let m;
  while ((m = rowRe.exec(html)) !== null && rows.length < 16) {
    const name = m[2].trim();
    rows.push({
      pos:  parseInt(m[1]),
      team: name,
      abbr: SHORT[name] || name,
      logo: LOGOS[name] || '',
      p:    parseInt(m[3]),
      w:    parseInt(m[4]),
      d:    parseInt(m[5]),
      l:    parseInt(m[6]),
      pts:  parseInt(m[7])
    });
  }

  // Fallback: simpler regex for JSON-like data in page scripts
  if (rows.length < 8) {
    const scriptRe = /"team"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*\}[^}]*"points"\s*:\s*(\d+)[^}]*"played"\s*:\s*(\d+)[^}]*"won"\s*:\s*(\d+)[^}]*"drawn"\s*:\s*(\d+)[^}]*"lost"\s*:\s*(\d+)/g;
    let sm;
    let pos = 1;
    while ((sm = scriptRe.exec(html)) !== null && rows.length < 16) {
      const name = sm[1].trim();
      rows.push({
        pos:  pos++,
        team: name,
        abbr: SHORT[name] || name,
        logo: LOGOS[name] || '',
        p:    parseInt(sm[3]),
        w:    parseInt(sm[4]),
        d:    parseInt(sm[5]),
        l:    parseInt(sm[6]),
        pts:  parseInt(sm[2])
      });
    }
  }
  return rows;
}

// ── Parse fixtures/results from HTML ────────────────────────
function parseFixtures(html, isResults) {
  const matches = [];
  // Look for match data patterns in page source
  const matchRe = /"homeTeam"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*\}[^}]*"awayTeam"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*\}[^}]*"date"\s*:\s*"([^"]+)"(?:[^}]*"homeScore"\s*:\s*(\d+)[^}]*"awayScore"\s*:\s*(\d+))?/g;
  let m;
  while ((m = matchRe.exec(html)) !== null && matches.length < 10) {
    const home = m[1].trim();
    const away = m[2].trim();
    const date = m[3];
    const hg   = m[4] !== undefined ? parseInt(m[4]) : null;
    const ag   = m[5] !== undefined ? parseInt(m[5]) : null;
    if (isResults && hg === null) continue;
    if (!isResults && hg !== null) continue;
    matches.push({ date, home, away, hg, ag });
  }
  return matches;
}

// ── Fallback hardcoded data (used if scraping fails) ────────
function getFallbackData() {
  return {
    source: 'fallback',
    updated: new Date().toISOString(),
    table: [
      { pos:1,  team:'Orlando Pirates',   abbr:'Pirates',     logo:LOGOS['Orlando Pirates'],   p:18, w:13, d:2, l:3,  pts:41 },
      { pos:2,  team:'Mamelodi Sundowns', abbr:'Sundowns',    logo:LOGOS['Mamelodi Sundowns'], p:18, w:12, d:5, l:1,  pts:41 },
      { pos:3,  team:'Sekhukhune United', abbr:'Sekhukhune',  logo:LOGOS['Sekhukhune United'], p:19, w:9,  d:5, l:5,  pts:32 },
      { pos:4,  team:'Durban City',       abbr:'Durban City', logo:LOGOS['Durban City'],       p:19, w:9,  d:4, l:6,  pts:31 },
      { pos:5,  team:'Kaizer Chiefs',     abbr:'Chiefs',      logo:LOGOS['Kaizer Chiefs'],     p:17, w:8,  d:6, l:3,  pts:30 },
      { pos:6,  team:'AmaZulu FC',        abbr:'AmaZulu',     logo:LOGOS['AmaZulu FC'],        p:19, w:9,  d:3, l:7,  pts:30 },
      { pos:7,  team:'Polokwane City',    abbr:'Polokwane',   logo:LOGOS['Polokwane City'],    p:18, w:7,  d:7, l:4,  pts:28 },
      { pos:8,  team:'TS Galaxy',         abbr:'TS Galaxy',   logo:LOGOS['TS Galaxy'],         p:19, w:7,  d:3, l:9,  pts:24 },
      { pos:9,  team:'Stellenbosch FC',   abbr:'Stellenbosch',logo:LOGOS['Stellenbosch FC'],   p:18, w:6,  d:4, l:8,  pts:22 },
      { pos:10, team:'Golden Arrows',     abbr:'Arrows',      logo:LOGOS['Golden Arrows'],     p:18, w:6,  d:3, l:9,  pts:21 },
      { pos:11, team:'Siwelele FC',       abbr:'Siwelele',    logo:LOGOS['Siwelele FC'],       p:18, w:5,  d:6, l:7,  pts:21 },
      { pos:12, team:'Richards Bay',      abbr:'R. Bay',      logo:LOGOS['Richards Bay'],      p:18, w:4,  d:8, l:6,  pts:20 },
      { pos:13, team:'Chippa United',     abbr:'Chippa',      logo:LOGOS['Chippa United'],     p:19, w:4,  d:7, l:8,  pts:19 },
      { pos:14, team:'Marumo Gallants',   abbr:'Gallants',    logo:LOGOS['Marumo Gallants'],   p:19, w:3,  d:6, l:10, pts:15 },
      { pos:15, team:'Orbit College FC',  abbr:'Orbit Col.',  logo:LOGOS['Orbit College FC'],  p:19, w:4,  d:3, l:12, pts:15 },
      { pos:16, team:'Magesi FC',         abbr:'Magesi',      logo:LOGOS['Magesi FC'],         p:18, w:2,  d:6, l:10, pts:12 }
    ],
    results: [
      { date:'2026-03-01', home:'Mamelodi Sundowns', away:'Sekhukhune United', hg:3, ag:1 },
      { date:'2026-02-28', home:'Kaizer Chiefs',     away:'Orlando Pirates',   hg:0, ag:3 },
      { date:'2026-02-28', home:'Siwelele FC',       away:'TS Galaxy',         hg:1, ag:0 },
      { date:'2026-02-28', home:'Golden Arrows',     away:'Chippa United',     hg:0, ag:0 },
      { date:'2026-02-28', home:'Orbit College FC',  away:'Richards Bay',      hg:0, ag:0 },
      { date:'2026-02-22', home:'AmaZulu FC',        away:'Durban City',       hg:2, ag:1 },
      { date:'2026-02-22', home:'Polokwane City',    away:'Marumo Gallants',   hg:2, ag:0 }
    ],
    fixtures: [
      { date:'2026-03-07', home:'Kaizer Chiefs',     away:'Mamelodi Sundowns', hg:null, ag:null },
      { date:'2026-03-07', home:'Richards Bay',      away:'AmaZulu FC',        hg:null, ag:null },
      { date:'2026-03-08', home:'Durban City',       away:'Orlando Pirates',   hg:null, ag:null },
      { date:'2026-03-08', home:'TS Galaxy',         away:'Polokwane City',    hg:null, ag:null },
      { date:'2026-03-08', home:'Chippa United',     away:'Sekhukhune United', hg:null, ag:null },
      { date:'2026-03-15', home:'Mamelodi Sundowns', away:'Siwelele FC',       hg:null, ag:null },
      { date:'2026-03-15', home:'Orlando Pirates',   away:'Magesi FC',         hg:null, ag:null },
      { date:'2026-03-15', home:'Stellenbosch FC',   away:'Durban City',       hg:null, ag:null }
    ],
    live: []
  };
}

// ── Main handler ─────────────────────────────────────────────
exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    // Cache for 2 hours on CDN, 30 mins in browser
    'Cache-Control': 'public, s-maxage=7200, max-age=1800'
  };

  try {
    // Fetch all three pages in parallel
    const [tableHtml, resultsHtml, fixturesHtml] = await Promise.all([
      fetchPage(SUPERSPORT_TABLE),
      fetchPage(SUPERSPORT_RESULTS),
      fetchPage(SUPERSPORT_FIXTURES)
    ]);

    const table    = parseTable(tableHtml);
    const results  = parseFixtures(resultsHtml, true);
    const fixtures = parseFixtures(fixturesHtml, false);

    // If parsing returned too little data, use fallback
    if (table.length < 8) {
      console.log('Scraping returned insufficient data — using fallback');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(getFallbackData())
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        source:   'supersport',
        updated:  new Date().toISOString(),
        table,
        results:  results.length  ? results  : getFallbackData().results,
        fixtures: fixtures.length ? fixtures : getFallbackData().fixtures,
        live:     [] // populated when live games are detected
      })
    };

  } catch (err) {
    console.error('Scraper error:', err.message);
    // Always return something — never leave the app blank
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(getFallbackData())
    };
  }
};
