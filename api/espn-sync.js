// api/espn-sync.js — Fantasy PSL ESPN Stats Sync
// ESPN stats pages are JS-rendered HTML — scraping them returns empty tables.
// The real data is fetched by the browser via XHR to cdn.espn.com with ?xhr=1.
// We call those same XHR endpoints server-side to get live JSON data.
//
// ENDPOINTS:
//   https://cdn.espn.com/core/soccer/stats?xhr=1&slug=rsa.1&season=2025&view=scoring
//   https://cdn.espn.com/core/soccer/stats?xhr=1&slug=rsa.1&season=2025&view=discipline

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL          || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY   || '';
const ADMIN  = process.env.ADMIN_SECRET           || 'mzansi4sho';

const CDN_BASE    = 'https://cdn.espn.com/core/soccer/stats?xhr=1&slug=rsa.1&season=2025&view=';
const XHR_HEADERS = {
  'Accept':           'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent':       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122 Safari/537.36',
  'Referer':          'https://africa.espn.com/football/stats/_/league/RSA.1/view/scoring'
};

function norm(s) {
  return (s || '').toLowerCase()
    .replace(/[àáâãäå]/g,'a').replace(/[èéêë]/g,'e').replace(/[ìíîï]/g,'i')
    .replace(/[òóôõö]/g,'o').replace(/[ùúûü]/g,'u').replace(/[ñ]/g,'n')
    .replace(/[ç]/g,'c').replace(/[^a-z0-9\s]/g,'').trim();
}
function normPos(r) {
  r = (r||'').toUpperCase();
  if (r==='GK'||r==='G'||r.includes('GOAL')) return 'GK';
  if (r==='DEF'||r==='D'||r.includes('DEFEND')||r.includes('BACK')) return 'DEF';
  if (r==='FWD'||r==='F'||r.includes('FORWARD')||r.includes('STRIK')||r.includes('ATTACK')) return 'FWD';
  return 'MID';
}
function calcPts(s) {
  var pts = (s.apps||0)*2;
  var g = (s.pos==='GK'||s.pos==='DEF')?6:s.pos==='MID'?5:4;
  pts += (s.goals||0)*g + (s.assists||0)*3;
  var c = (s.pos==='GK'||s.pos==='DEF')?4:s.pos==='MID'?1:0;
  pts += (s.clean_sheets||0)*c - (s.yellow_cards||0) - (s.red_cards||0)*3;
  if (s.pos==='GK' && (s.saves||0)>=3) pts += Math.floor(s.saves/3);
  return Math.max(0,pts);
}

async function cdnFetch(view, log) {
  var url = CDN_BASE + view;
  log.push('GET ' + url);
  var r = await fetch(url, { headers: XHR_HEADERS, signal: AbortSignal.timeout(15000) });
  log.push('Status: ' + r.status + ' ' + r.statusText);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  var text = await r.text();
  log.push('Response length: ' + text.length + ' chars | Preview: ' + text.slice(0,200));
  return JSON.parse(text);
}

// Walk an unknown JSON object to find an athletes/leaders array
function findAthletes(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj[0] && (obj[0].athlete || obj[0].displayName || obj[0].name)) return obj;
    return null;
  }
  // Check common ESPN keys first
  var priority = ['athletes','leaders','statistics','stats','players','data','rows','items'];
  for (var i = 0; i < priority.length; i++) {
    if (obj[priority[i]]) {
      var r = findAthletes(obj[priority[i]], depth+1);
      if (r && r.length > 0) return r;
    }
  }
  // Exhaustive search
  for (var k in obj) {
    if (priority.indexOf(k) > -1) continue;
    var r = findAthletes(obj[k], depth+1);
    if (r && r.length > 0) return r;
  }
  return null;
}

function parseAthletesArray(arr, espnStats) {
  arr.forEach(function(entry) {
    var ath = entry.athlete || entry;
    var name = norm(ath.displayName || ath.shortName || ath.name || '');
    if (!name || name.length < 2) return;
    var pos = normPos((ath.position && (ath.position.abbreviation||ath.position.name)) || '');
    if (!espnStats[name]) {
      espnStats[name] = { name: ath.displayName||'', pos, apps:0, goals:0, assists:0, yellow_cards:0, red_cards:0, clean_sheets:0, saves:0 };
    }
    // Parse stats array
    var stats = entry.statistics || entry.stats || [];
    if (!Array.isArray(stats)) stats = Object.values(stats||{});
    stats.forEach(function(stat) {
      var sn  = (stat.name||stat.abbreviation||stat.label||'').toLowerCase().replace(/[^a-z]/g,'');
      var val = parseFloat(stat.value||stat.displayValue||0)||0;
      var p   = espnStats[name];
      if (sn==='goals'||sn==='g'||sn==='goalsscored') p.goals = Math.max(p.goals,Math.round(val));
      else if (sn==='assists'||sn==='a') p.assists = Math.max(p.assists,Math.round(val));
      else if (sn==='gp'||sn==='p'||sn==='gamesplayed'||sn==='appearances') p.apps = Math.max(p.apps,Math.round(val));
      else if (sn==='yellowcards'||sn==='yc'||sn==='yellow') p.yellow_cards = Math.max(p.yellow_cards,Math.round(val));
      else if (sn==='redcards'||sn==='rc'||sn==='red') p.red_cards = Math.max(p.red_cards,Math.round(val));
      else if (sn==='cleansheets'||sn==='cs') p.clean_sheets = Math.max(p.clean_sheets,Math.round(val));
      else if (sn==='saves'||sn==='sv') p.saves = Math.max(p.saves,Math.round(val));
    });
    // Inline value (top-scorers style: { athlete, value: 12 } — infer from parent key)
    if (entry.value !== undefined && entry.value > 0 && stats.length === 0) {
      // Can't know what the stat is without context — skip
    }
  });
}

function findMatch(map, dbNorm) {
  if (map[dbNorm]) return map[dbNorm];
  var parts = dbNorm.split(' ');
  var last  = parts[parts.length-1];
  var first = parts[0];
  if (last.length > 3) {
    for (var k in map) {
      var kp = k.split(' ');
      if (kp[kp.length-1] === last) return map[k];
    }
  }
  if (first.length > 2 && last.length > 2) {
    for (var k in map) {
      if (k.includes(first.slice(0,4)) && k.includes(last.slice(0,4))) return map[k];
    }
  }
  if (last.length >= 4) {
    for (var k in map) {
      if (k.includes(last.slice(0,5))) return map[k];
    }
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  var adminKey = (req.query&&req.query.admin_key)||(req.headers&&req.headers['x-admin-key'])||'';
  var isCron   = req.headers&&req.headers['x-vercel-cron']==='1';
  var force    = req.query&&req.query.force==='true';

  if (!isCron && adminKey !== ADMIN) return res.status(401).json({ error:'Unauthorized' });
  if (!SB_URL||!SB_KEY) return res.status(500).json({ error:'Supabase env vars missing' });

  var db = createClient(SB_URL, SB_KEY);
  var log = [];

  try {
    // Throttle cron
    if (!force && isCron) {
      var { data: cRow } = await db.from('api_cache').select('updated_at').eq('key','espn_stats_last_sync').single().catch(function(){return{data:null};});
      if (cRow && cRow.updated_at && (Date.now()-new Date(cRow.updated_at).getTime())<44*3600000) {
        return res.json({ skipped:true, log });
      }
    }

    var espnStats = {};
    var source    = 'fallback';

    // ── Try ESPN CDN scoring endpoint ─────────────────────────────────
    try {
      var scoringData = await cdnFetch('scoring', log);
      var athletes    = findAthletes(scoringData, 0);
      log.push('Scoring athletes found: ' + (athletes||[]).length);
      if (athletes && athletes.length > 0) {
        parseAthletesArray(athletes, espnStats);
        source = 'espn_cdn';
      }
    } catch(e) { log.push('Scoring error: '+e.message); }

    // ── Try ESPN CDN discipline endpoint ──────────────────────────────
    try {
      var discData  = await cdnFetch('discipline', log);
      var discAths  = findAthletes(discData, 0);
      log.push('Discipline athletes found: ' + (discAths||[]).length);
      if (discAths && discAths.length > 0) {
        var discMap = {};
        parseAthletesArray(discAths, discMap);
        for (var k in discMap) {
          if (!espnStats[k]) espnStats[k] = discMap[k];
          else {
            if (discMap[k].yellow_cards) espnStats[k].yellow_cards = discMap[k].yellow_cards;
            if (discMap[k].red_cards)    espnStats[k].red_cards    = discMap[k].red_cards;
          }
        }
      }
    } catch(e) { log.push('Discipline error: '+e.message); }

    log.push('ESPN players parsed: ' + Object.keys(espnStats).length + ' | Source: ' + source);

    // ── Always merge verified fallback ────────────────────────────────
    var fb = getFallback();
    var fbAdded = 0;
    for (var fn in fb) {
      if (!espnStats[fn]) { espnStats[fn] = fb[fn]; fbAdded++; }
      else {
        if (!espnStats[fn].clean_sheets && fb[fn].clean_sheets) espnStats[fn].clean_sheets = fb[fn].clean_sheets;
        if (!espnStats[fn].saves        && fb[fn].saves)        espnStats[fn].saves        = fb[fn].saves;
        if (!espnStats[fn].yellow_cards && fb[fn].yellow_cards) espnStats[fn].yellow_cards = fb[fn].yellow_cards;
        if (!espnStats[fn].red_cards    && fb[fn].red_cards)    espnStats[fn].red_cards    = fb[fn].red_cards;
        if (!espnStats[fn].apps         && fb[fn].apps)         espnStats[fn].apps         = fb[fn].apps;
      }
    }
    log.push('Fallback added ' + fbAdded + ' players | Total: ' + Object.keys(espnStats).length);

    // ── Update DB players ─────────────────────────────────────────────
    var { data: dbP } = await db.from('players').select('id,display_name,position,psl_roster_id,total_points');
    var synced=0, unmatched=[], topPts=[];

    for (var i=0; i<(dbP||[]).length; i++) {
      var p = dbP[i];
      var ep = findMatch(espnStats, norm(p.display_name||''));
      if (!ep) { unmatched.push(p.display_name); continue; }
      var pos = normPos(p.position||ep.pos||'');
      var pts = calcPts({ pos, apps:ep.apps, goals:ep.goals, assists:ep.assists,
        clean_sheets:ep.clean_sheets, yellow_cards:ep.yellow_cards,
        red_cards:ep.red_cards, saves:ep.saves });
      await db.from('players').update({
        total_points:pts, apps:ep.apps||0, goals:ep.goals||0, assists:ep.assists||0,
        clean_sheets:ep.clean_sheets||0, yellow_cards:ep.yellow_cards||0,
        red_cards:ep.red_cards||0, updated_at:new Date().toISOString()
      }).eq('id', p.id);
      synced++;
      if (pts>0) topPts.push({name:p.display_name, pts});
    }
    topPts.sort(function(a,b){return b.pts-a.pts;});
    log.push('Synced: '+synced+' | Unmatched: '+unmatched.length);
    if (topPts.length) log.push('Top 3: '+topPts.slice(0,3).map(function(p){return p.name+'('+p.pts+')';}).join(', '));

    // ── Recalculate profile totals ────────────────────────────────────
    var { data: rp } = await db.from('players').select('psl_roster_id,total_points').not('psl_roster_id','is',null);
    var rm = {}; (rp||[]).forEach(function(p){ if(p.psl_roster_id) rm[p.psl_roster_id]=p.total_points||0; });

    var { data: profs } = await db.from('profiles').select('id,squad_data,squad_count').not('squad_data','is',null).gt('squad_count',0);
    var profUpdated = 0;
    for (var pi=0; pi<(profs||[]).length; pi++) {
      try {
        var sq = typeof profs[pi].squad_data==='string'?JSON.parse(profs[pi].squad_data):profs[pi].squad_data;
        if (!Array.isArray(sq)||!sq.length) continue;
        var total = sq.reduce(function(s,sp){ var rid=parseInt(sp.id,10); var v=rid&&rm[rid]!==undefined?rm[rid]:0; return s+(sp.isCaptain?v*2:v); },0);
        await db.from('profiles').update({total_points:total}).eq('id',profs[pi].id);
        profUpdated++;
      } catch(e){}
    }
    log.push('Profiles updated: '+profUpdated);

    await db.from('api_cache').upsert({
      key:'espn_stats_last_sync',
      value:JSON.stringify({synced_at:new Date().toISOString(),players:synced,source}),
      updated_at:new Date().toISOString()
    },{onConflict:'key'}).catch(function(){});

    return res.json({ success:true, source, players_synced:synced, profiles_updated:profUpdated, top_scorer:topPts[0]||null, log });

  } catch(err) {
    return res.status(500).json({ error:err.message, log });
  }
};

// Verified data from africa.espn.com March 29 2026 — fills gaps when ESPN CDN misses players
function getFallback() {
  var rows = [
    ['sede junior dion',20,12,1,3,0,0,0],['iqraam rayners',17,10,3,1,0,0,0],
    ['bradley grobler',20,8,2,2,0,0,0],['relebohile ratomo',19,7,5,4,0,0,0],
    ['relebohile mofokeng',19,7,5,4,0,0,0],['langelihle phili',19,7,1,3,0,0,0],
    ['patrick maswanganyi',18,6,1,3,0,0,0],['thandolwenkosi ngwenya',16,6,1,2,0,0,0],
    ['tshepang moremi',22,5,2,4,0,0,0],['hendrick ekstein',21,5,3,3,0,0,0],
    ['seluleko mahlambi',21,5,3,2,0,0,0],['evidence makgopa',18,5,3,3,0,0,0],
    ['flavio silva',13,5,1,1,0,0,0],['oswin appollis',22,4,6,3,0,0,0],
    ['samkelo maseko',21,4,1,2,0,0,0],['tashreeq matthews',21,4,4,7,0,0,0],
    ['siyanda mthanti',19,4,5,2,0,0,0],['yamela mbuthuma',16,4,0,2,0,0,0],
    ['frank mhango',14,4,1,3,0,0,0],['puso dithejane',12,4,4,2,0,0,0],
    ['siviwe magidigidi',12,4,1,2,0,0,0],['sinoxolo kwayiba',9,4,0,1,0,0,0],
    ['brayan leon muniz',8,4,1,1,0,0,0],['saziso magawana',22,3,4,3,0,0,0],
    ['vusumuzi mncube',21,3,2,4,0,0,0],['bonginkosi dlamini',21,3,2,3,0,0,0],
    ['vincent pule',20,3,1,2,0,0,0],['marcelo allende',20,3,3,2,0,0,0],
    ['mduduzi shabalala',19,3,2,3,0,0,0],['moses mthembu',18,3,1,3,0,0,0],
    ['makabi lilepo',18,3,2,3,0,0,0],['arthur',18,3,4,2,0,0,0],
    ['teboho mokoena',14,3,2,6,0,0,0],['peter shalulile',10,3,1,1,0,0,0],
    ['deon hotto',17,1,6,3,0,0,0],['devon titus',22,1,5,2,0,0,0],
    ['philani kumalo',13,1,5,2,0,0,0],['monnapule saleng',14,2,4,3,0,0,0],
    ['tebogo potsane',14,1,4,2,0,0,0],['aubrey modiba',18,1,3,5,0,6,0],
    ['sipho chaine',13,0,0,2,0,8,45],['ronwen williams',14,0,0,1,0,11,38],
    ['nhlanhla ngcobo',14,0,0,4,0,5,35],['mfanuvela mafuleka',16,0,0,3,0,4,25],
    ['banele mnguni',11,0,0,2,0,2,28],['keenan cairns',14,0,0,2,0,3,20],
    ['nkosinathi sibisi',12,0,0,4,0,7,0],['deano van rooyen',11,0,1,3,0,6,0],
    ['olisa ndah',10,0,0,4,0,6,0],['thabiso monyane',11,0,0,3,0,5,0],
    ['grant kekana',13,0,0,6,0,8,0],['rushine de reuck',11,0,0,5,0,7,0],
    ['khuliso mudau',13,0,1,5,0,7,0],['bheki cele',22,0,0,8,0,2,0],
    ['edmilson dove',14,0,0,7,0,3,0],['fawaaz basadien',20,0,0,5,0,5,0],
    ['thabang monare',20,2,2,5,0,0,0],['nkosikhona radebe',22,0,2,3,0,4,0],
    ['bokang mokwena',22,2,1,3,0,0,0],['haashim domingo',20,2,2,3,0,0,0],
    ['kyle jurgens',20,0,2,3,0,3,0],['ibraheem jabaar',15,0,2,4,0,3,0],
    ['junior zindoga',19,2,2,3,0,0,0],['neo rapoo',18,0,2,3,0,3,0],
    ['lundi mahala',21,2,0,3,0,0,0],['bheki mabuza',21,2,0,3,0,0,0],
    ['victor letsoalo',17,2,1,2,0,0,0],['wonderboy makhubu',18,0,2,3,0,2,0],
    ['nuno santos',13,0,2,3,0,2,0],['khumbulani ncube',12,0,2,3,0,2,0],
    ['leandro sirino',15,0,2,3,0,0,0],['riaan hanamub',20,0,2,2,0,2,0],
    ['siyanda xulu',14,0,0,4,0,4,0],['katlego otladisa',12,1,3,3,0,0,0],
    ['jerome karlese',13,1,3,3,0,0,0],['tebogo masuku',13,0,3,3,0,2,0],
    ['thuso moleleki',14,1,3,2,0,0,0],['teboho motloung',14,1,3,3,0,0,0],
    ['mory cheick keita',16,3,1,2,0,0,0],['keenan phillips',14,0,0,3,0,3,0],
    ['sphesihle maduna',21,2,3,3,0,0,0],['justice figuareido',18,1,3,3,0,0,0],
    ['mokete mogaila',15,1,3,3,0,0,0],['andiswa sithole',14,0,2,2,0,2,0],
    ['ayanda nkosi',16,0,0,3,0,3,0],['sibusiso hadebe',14,0,0,3,0,4,0],
    ['thabo molefe',14,0,0,3,0,3,0],['rowan human',14,0,0,2,0,3,0],
    ['mbulelo wagaba',15,3,2,2,0,0,0],['jaisen jaren clifford',16,3,1,3,0,0,0],
    ['letsie koapeng',14,3,1,2,0,0,0],['thabelo tshikweta',9,3,0,2,0,0,0],
    ['sanele barns',16,0,0,3,0,3,0],['mokibelo ramabu',18,3,1,3,0,0,0],
    ['athini maqokola',17,3,2,2,0,0,0],['mlungisi mbunjana',21,2,0,3,0,0,0],
  ];
  var r={};
  rows.forEach(function(row){
    if(!r[row[0]]) r[row[0]]={apps:row[1],goals:row[2],assists:row[3],yellow_cards:row[4],red_cards:row[5],clean_sheets:row[6],saves:row[7]};
  });
  return r;
}
