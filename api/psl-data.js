// ============================================================
//  Fantasy PSL — Netlify Serverless Data Function
//  File: api/psl-data.js  (copy to your /api/ folder)
//
//  Powered by API-Football (RapidAPI) — League 288, Season 2024
//  Returns: standings, fixtures, live scores, top scorers,
//           assists, yellow/red cards, player details
//
//  Cache: 60s live | 5min normal | 1h player stats
// ============================================================

const API_KEY  = 'efd40a28aa4d2ed1758174bd319553d1';
const API_HOST = 'api-football-v1.p.rapidapi.com';
const BASE_URL = `https://${API_HOST}/v3`;
const LEAGUE   = 288;
const SEASON   = 2024;

const HEADERS = {
  'x-rapidapi-key':  API_KEY,
  'x-rapidapi-host': API_HOST,
};

// ── Club name normalisation (API → our names) ─────────────────
const TEAM_MAP = {
  'AmaZulu':'AmaZulu FC','Stellenbosch':'Stellenbosch FC',
  'Magesi':'Magesi FC','Orbit College':'Orbit College FC',
  'Cape Town City':'Siwelele FC','Siwelele':'Siwelele FC',
};
function norm(n) { return TEAM_MAP[n] || n; }

const SHORT = {
  'Orlando Pirates':'Pirates','Mamelodi Sundowns':'Sundowns',
  'Kaizer Chiefs':'Chiefs','AmaZulu FC':'AmaZulu',
  'Sekhukhune United':'Sekhukhune','Polokwane City':'Polokwane',
  'TS Galaxy':'TS Galaxy','Stellenbosch FC':'Stellenbosch',
  'Golden Arrows':'Arrows','Siwelele FC':'Siwelele',
  'Richards Bay':'R. Bay','Chippa United':'Chippa',
  'Marumo Gallants':'Gallants','Magesi FC':'Magesi',
  'Orbit College FC':'Orbit','Durban City':'Durban City',
};

const LOGOS = {
  'Orlando Pirates':'https://images.supersport.com/media/wkfgti45/orlando-pirates.png',
  'Mamelodi Sundowns':'https://images.supersport.com/media/hiklyiw5/mamelodi_sundowns_fc_logo_200x200.png',
  'Sekhukhune United':'https://images.supersport.com/media/ysvjj3ep/sekhuk-united.png',
  'Durban City':'https://images.supersport.com/media/yi4mugcg/durban_city_logo_200x200.png',
  'Kaizer Chiefs':'https://images.supersport.com/media/0cjpgz45/kaizer-chiefs-200x200.png',
  'AmaZulu FC':'https://images.supersport.com/media/nxwh0ird/amazulu-200x200.png',
  'Polokwane City':'https://images.supersport.com/media/pxwprbde/polokwane-city-200x200.png',
  'TS Galaxy':'https://images.supersport.com/media/2ywrqgn5/ts-galaxy-200x200.png',
  'Stellenbosch FC':'https://images.supersport.com/media/ekujfp53/stellenbosch-200x200.png',
  'Golden Arrows':'https://images.supersport.com/media/e3bpewop/golden-arrows-200x200.png',
  'Siwelele FC':'https://images.supersport.com/media/x5r1hxf0/siwelele-200x200.png',
  'Richards Bay':'https://images.supersport.com/media/o4cgxmhn/richards-bay-200x200.png',
  'Chippa United':'https://images.supersport.com/media/2qgjw143/chippa-united-200x200.png',
  'Marumo Gallants':'https://images.supersport.com/media/bqoh2uda/marumo-gallants-200x200.png',
  'Orbit College FC':'https://images.supersport.com/media/lvwavkax/orbit-college-200x200.png',
  'Magesi FC':'https://images.supersport.com/media/fgiqx3ai/magesi-200x200.png',
};

// ── Memory cache ──────────────────────────────────────────────
const CACHE = {};
function getCache(k) { const c=CACHE[k]; return c&&Date.now()<c.exp?c.data:null; }
function setCache(k,d,ms) { CACHE[k]={data:d,exp:Date.now()+ms}; }

// ── Fetch helper ──────────────────────────────────────────────
async function apiFetch(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${path}`);
  return res.json();
}

// ── Parsers ───────────────────────────────────────────────────
function parseStanding(e) {
  const tn = norm(e.team.name);
  const s  = e.all;
  return {
    team:tn, abbr:SHORT[tn]||tn, logo:LOGOS[tn]||e.team.logo||'',
    p:s.played, w:s.win, d:s.draw, l:s.lose,
    gf:s.goals.for, ga:s.goals.against, gd:e.goalsDiff,
    pts:e.points, pos:e.rank,
    form:(e.form||'').replace(/[^WDL]/g,'').slice(-5),
  };
}

function parseFixture(f) {
  const h=norm(f.teams.home.name), a=norm(f.teams.away.name);
  return {
    id:f.fixture.id,
    date:f.fixture.date?f.fixture.date.slice(0,10):null,
    time:f.fixture.date?f.fixture.date.slice(11,16):null,
    status:f.fixture.status.short,
    elapsed:f.fixture.status.elapsed,
    home:h, away:a,
    hLogo:LOGOS[h]||f.teams.home.logo,
    aLogo:LOGOS[a]||f.teams.away.logo,
    hg:f.goals.home, ag:f.goals.away,
    venue:f.fixture.venue?f.fixture.venue.name:null,
  };
}

function parsePlayer(r) {
  const pl=r.player, st=r.statistics?.[0]||{};
  const club=norm(st.team?.name||'');
  const g=st.goals||{}, c=st.cards||{}, gm=st.games||{},
        sh=st.shots||{}, ps=st.passes||{}, tk=st.tackles||{},
        dr=st.dribbles||{}, fo=st.fouls||{}, pe=st.penalty||{};
  return {
    id:pl.id, name:pl.name, photo:pl.photo,
    nationality:pl.nationality, age:pl.age,
    club, clubLogo:LOGOS[club]||st.team?.logo||'',
    position:gm.position||null,
    apps:gm.appearences||0, starts:gm.lineups||0, minutes:gm.minutes||0,
    rating:parseFloat(gm.rating||0),
    goals:g.total||0, assists:g.assists||0,
    xg:parseFloat(g.expected||0),
    shots:sh.total||0, shotsOn:sh.on||0,
    passes:ps.total||0, keyPasses:ps.key||0, passAcc:ps.accuracy||0,
    dribbles:dr.success||0, tackles:tk.total||0,
    interceptions:tk.interceptions||0, blocks:tk.blocks||0,
    yellowCards:c.yellow||0, redCards:c.red||0, yellowRed:c.yellowred||0,
    fouls:fo.committed||0, foulsDrawn:fo.drawn||0,
    saves:g.saves||0, penScored:pe.scored||0, penMissed:pe.missed||0,
  };
}

// ── Response builder ──────────────────────────────────────────
function ok(data, isLive=false) {
  const ttl = isLive ? 60 : 300;
  return {
    statusCode:200,
    headers:{
      'Content-Type':'application/json',
      'Cache-Control':`public,max-age=${ttl},s-maxage=${ttl}`,
      'Access-Control-Allow-Origin':'*',
    },
    body: JSON.stringify(data),
  };
}
function fail(msg,status=500) {
  return {
    statusCode:status,
    headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},
    body:JSON.stringify({error:msg}),
  };
}

// ════════════════════════════════════════════════════════════
//  HANDLER
// ════════════════════════════════════════════════════════════
exports.handler = async function(event) {
  if (event.httpMethod==='OPTIONS')
    return {statusCode:200,headers:{'Access-Control-Allow-Origin':'*'},body:''};

  const qs    = event.queryStringParameters||{};
  const type  = qs.type||'full';

  // ── LIVE only ────────────────────────────────────────────────
  if (type==='live') {
    const c=getCache('live'); if(c) return ok(c,true);
    try {
      const d=await apiFetch(`/fixtures?league=${LEAGUE}&live=all`);
      const live=(d.response||[]).map(parseFixture);
      const out={source:'api',updated:new Date().toISOString(),live};
      setCache('live',out,60_000);
      return ok(out,live.length>0);
    } catch(e){ return fail(e.message); }
  }

  // ── PLAYER STATS ─────────────────────────────────────────────
  if (type==='players') {
    const c=getCache('players'); if(c) return ok(c,false);
    try {
      const [sc,as,yw,rd]=await Promise.all([
        apiFetch(`/players/topscorers?league=${LEAGUE}&season=${SEASON}`),
        apiFetch(`/players/topassists?league=${LEAGUE}&season=${SEASON}`),
        apiFetch(`/players/topyellowcards?league=${LEAGUE}&season=${SEASON}`),
        apiFetch(`/players/topredcards?league=${LEAGUE}&season=${SEASON}`),
      ]);
      const out={
        source:'api', updated:new Date().toISOString(),
        topScorers:(sc.response||[]).slice(0,20).map(parsePlayer),
        topAssists:(as.response||[]).slice(0,20).map(parsePlayer),
        topYellow:(yw.response||[]).slice(0,20).map(parsePlayer),
        topRed:(rd.response||[]).filter(r=>r.statistics?.[0]?.cards?.red>0).slice(0,20).map(parsePlayer),
      };
      setCache('players',out,3_600_000);
      return ok(out,false);
    } catch(e){ return fail(e.message); }
  }

  // ── FULL BUNDLE (default) ─────────────────────────────────────
  const c=getCache('full');
  if(c) return ok(c,c.isLive);

  try {
    const [st,rs,fx,lv,sc,as,yw,rd]=await Promise.all([
      apiFetch(`/standings?league=${LEAGUE}&season=${SEASON}`),
      apiFetch(`/fixtures?league=${LEAGUE}&season=${SEASON}&last=10`),
      apiFetch(`/fixtures?league=${LEAGUE}&season=${SEASON}&next=10`),
      apiFetch(`/fixtures?league=${LEAGUE}&live=all`),
      apiFetch(`/players/topscorers?league=${LEAGUE}&season=${SEASON}`),
      apiFetch(`/players/topassists?league=${LEAGUE}&season=${SEASON}`),
      apiFetch(`/players/topyellowcards?league=${LEAGUE}&season=${SEASON}`),
      apiFetch(`/players/topredcards?league=${LEAGUE}&season=${SEASON}`),
    ]);

    const table   = (st.response?.[0]?.league?.standings?.[0]||[]).map(parseStanding);
    const results = (rs.response||[]).map(parseFixture);
    const fixtures= (fx.response||[]).map(parseFixture);
    const live    = (lv.response||[]).map(parseFixture);

    const topScorers=(sc.response||[]).slice(0,20).map(parsePlayer);
    const topAssists=(as.response||[]).slice(0,20).map(parsePlayer);
    const topYellow =(yw.response||[]).slice(0,20).map(parsePlayer);
    const topRed    =(rd.response||[]).filter(r=>r.statistics?.[0]?.cards?.red>0).slice(0,20).map(parsePlayer);

    const isLive=live.length>0;
    const out={
      source:'api-football', updated:new Date().toISOString(),
      isLive, table, results, fixtures, live,
      topScorers, topAssists, topYellow, topRed,
    };
    setCache('full',out,isLive?60_000:300_000);
    return ok(out,isLive);

  } catch(e) {
    console.error('PSL fetch error:',e.message);
    // Return fallback empty shell — frontend uses hardcoded REAL_TABLE
    return ok({
      source:'error', updated:new Date().toISOString(),
      error:e.message, isLive:false,
      table:[], results:[], fixtures:[], live:[],
      topScorers:[], topAssists:[], topYellow:[], topRed:[],
    }, false);
  }
};
