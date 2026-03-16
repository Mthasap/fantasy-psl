// ══════════════════════════════════════════════════════════════════════════
// api/points-cron.js  —  Fantasy PSL  —  Sportmonks Edition
// ══════════════════════════════════════════════════════════════════════════
//
// All API-Football references removed. Data source: Sportmonks only.
//
// ENVIRONMENT VARIABLES (Vercel Dashboard → Settings → Env Vars):
//   SPORTMONKS_TOKEN      — your Sportmonks API token
//   SUPABASE_URL          — your Supabase project URL
//   SUPABASE_SERVICE_KEY  — your Supabase service role key
//   ADMIN_SECRET          — for manual admin panel trigger
//   CRON_SECRET           — Vercel cron auth (optional)
//
// PSL League ID on Sportmonks: 806
// ══════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const { calculateFantasyPoints, normalisePosition } = require('./football.js');

const TOKEN        = process.env.SPORTMONKS_TOKEN    || '';
const SUPABASE_URL = process.env.SUPABASE_URL         || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const PSL_ID       = 806;
const BASE_URL     = 'https://api.sportmonks.com/v3/football';

let PSL_SEASON_ID = null;

const TEAM_MAP = {
  'Mamelodi Sundowns':'Mamelodi Sundowns','Orlando Pirates':'Orlando Pirates',
  'Kaizer Chiefs':'Kaizer Chiefs','Stellenbosch':'Stellenbosch FC',
  'Stellenbosch FC':'Stellenbosch FC','AmaZulu':'AmaZulu FC','AmaZulu FC':'AmaZulu FC',
  'Chippa United':'Chippa United','Golden Arrows':'Golden Arrows',
  'Lamontville Golden Arrows':'Golden Arrows','Sekhukhune United':'Sekhukhune United',
  'TS Galaxy':'TS Galaxy','Polokwane City':'Polokwane City','Marumo Gallants':'Marumo Gallants',
  'Richards Bay':'Richards Bay','Richards Bay FC':'Richards Bay',
  'Magesi':'Magesi FC','Magesi FC':'Magesi FC',
  'Durban City':'Durban City','Durban City FC':'Durban City',
  'Orbit College':'Orbit College FC','Orbit College FC':'Orbit College FC',
  'Siwelele':'Siwelele FC','Siwelele FC':'Siwelele FC',
};
function mapTeam(n) { return TEAM_MAP[n] || n; }

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const authHeader = req.headers['authorization'] || '';
  const cronSecret = process.env.CRON_SECRET      || '';
  const adminKey   = req.headers['x-admin-key']   || req.query.admin_key || '';
  const isAdmin    = adminKey && adminKey === (process.env.ADMIN_SECRET || '');
  const isCron     = cronSecret && authHeader === 'Bearer ' + cronSecret;

  if (!isAdmin && !isCron && cronSecret) return res.status(401).json({ error: 'Unauthorized' });
  if (!TOKEN)        return res.status(500).json({ error: 'SPORTMONKS_TOKEN not set' });
  if (!SUPABASE_URL) return res.status(500).json({ error: 'SUPABASE_URL not set' });
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not set' });

  const db  = createClient(SUPABASE_URL, SUPABASE_KEY);
  const log = [];
  const report = {
    started_at:'', triggered_by: isAdmin ? 'admin_panel' : 'cron',
    provider:'Sportmonks', steps_completed:[],
    fixtures_synced:0, results_updated:0, fixtures_scored:0,
    users_updated:0, gw_action:null, prices_updated:0, api_calls_used:0,
    errors:[], log
  };
  report.started_at = new Date().toISOString();

  try {

    // ─── STEP 1: Sync upcoming fixtures ──────────────────────────────
    log.push('━━ STEP 1: Sync upcoming fixtures ━━');
    try {
      const sid = await getSeasonId();
      const d   = await smGet('/fixtures/upcoming/season/'+sid+'?filters=leagueId:'+PSL_ID+'&include=participants;round&per_page=40');
      report.api_calls_used++;
      const currentGW = await getCurrentGameweek(db);
      const rows = [];
      for (const f of (d.data||[])) {
        const parts = f.participants||[];
        const home  = mapTeam(((parts.find(p=>p.meta&&p.meta.location==='home')||parts[0]||{}).name)||'');
        const away  = mapTeam(((parts.find(p=>p.meta&&p.meta.location==='away')||parts[1]||{}).name)||'');
        if (!home||!away||!f.starting_at) continue;
        let gw = currentGW;
        if (f.round&&f.round.name) { const m=(f.round.name+'').match(/(\d+)/); if(m) gw=parseInt(m[1]); }
        rows.push({ gameweek:gw, home_team:home, away_team:away, status:'NS', kickoff_at:f.starting_at, api_fixture_id:f.id||null });
      }
      log.push('  Found '+rows.length+' upcoming fixtures');
      for (const row of rows) {
        const {error} = await db.from('fixtures').upsert(row,{onConflict:'gameweek,home_team,away_team',ignoreDuplicates:true});
        if (!error) report.fixtures_synced++;
      }
      log.push('  Upserted '+report.fixtures_synced);
      report.steps_completed.push('sync_fixtures ✓');
    } catch(e) { log.push('  WARN: '+e.message); report.errors.push('sync_fixtures: '+e.message); report.steps_completed.push('sync_fixtures ✗'); }

    // ─── STEP 2: Sync completed results ──────────────────────────────
    log.push('━━ STEP 2: Sync results ━━');
    let recentFixtures = [];
    try {
      const sid = await getSeasonId();
      const d   = await smGet('/fixtures/past/season/'+sid+'?filters=leagueId:'+PSL_ID+'&include=participants;scores&per_page=15');
      report.api_calls_used++;
      recentFixtures = d.data||[];
      log.push('  Found '+recentFixtures.length+' completed matches');
      for (const f of recentFixtures) {
        const parts = f.participants||[];
        const home  = mapTeam(((parts.find(p=>p.meta&&p.meta.location==='home')||parts[0]||{}).name)||'');
        const away  = mapTeam(((parts.find(p=>p.meta&&p.meta.location==='away')||parts[1]||{}).name)||'');
        if (!home||!away) continue;
        let hg=null, ag=null;
        (f.scores||[]).forEach(s=>{
          if (!s.score) return;
          const desc=(s.description||'').toUpperCase();
          if (desc==='FT'||desc==='CURRENT'||desc==='FULLTIME') {
            if (s.score.participant==='home') hg=s.score.goals;
            if (s.score.participant==='away') ag=s.score.goals;
          }
        });
        if (hg===null||ag===null) continue;
        const {data:ex} = await db.from('fixtures').select('id,status').eq('home_team',home).eq('away_team',away).neq('status','FT').limit(1);
        if (ex&&ex.length>0) {
          const {error} = await db.from('fixtures').update({home_score:hg,away_score:ag,status:'FT',api_fixture_id:f.id||null}).eq('id',ex[0].id);
          if (!error) { report.results_updated++; log.push('  ✓ '+home+' '+hg+'-'+ag+' '+away); }
        }
      }
      log.push('  Updated '+report.results_updated+' results');
      report.steps_completed.push('sync_results ✓');
    } catch(e) { log.push('  WARN: '+e.message); report.errors.push('sync_results: '+e.message); report.steps_completed.push('sync_results ✗'); }

    // ─── STEP 3: Calculate fantasy points ────────────────────────────
    log.push('━━ STEP 3: Calculate points ━━');
    try {
      const alreadyProcessed = await getProcessedFixtureIds(db);
      const currentGW        = await getCurrentGameweek(db);
      const toProcess        = recentFixtures.filter(f=>f.id&&!alreadyProcessed.has(f.id));
      log.push('  '+alreadyProcessed.size+' done, '+toProcess.length+' new');

      for (const f of toProcess) {
        const parts = f.participants||[];
        const home  = mapTeam(((parts.find(p=>p.meta&&p.meta.location==='home')||parts[0]||{}).name)||'');
        const away  = mapTeam(((parts.find(p=>p.meta&&p.meta.location==='away')||parts[1]||{}).name)||'');
        let hg=null,ag=null;
        (f.scores||[]).forEach(s=>{
          if (!s.score) return;
          const desc=(s.description||'').toUpperCase();
          if (desc==='FT'||desc==='CURRENT'||desc==='FULLTIME') {
            if (s.score.participant==='home') hg=s.score.goals;
            if (s.score.participant==='away') ag=s.score.goals;
          }
        });
        const fixtureObj = {fixture_id:f.id,date:f.starting_at,home,away,hg,ag};
        log.push('  Processing: '+home+' '+hg+'-'+ag+' '+away+' (ID:'+f.id+')');
        try {
          const statsData = await smGet('/fixtures/'+f.id+'?include=participants;scores;events.type;lineups.player;lineups.position;statistics.type');
          report.api_calls_used++;
          const playerStats = extractPlayerStats(statsData.data||{});
          log.push('  '+playerStats.length+' players');
          if (!playerStats.length) { log.push('  No stats yet — retry tomorrow'); continue; }
          await storePlayerStats(db, playerStats, fixtureObj, currentGW);
          const statsByName = {};
          playerStats.forEach(p=>{ statsByName[normaliseName(p.player_name)]=p; });
          const users = await getAllUsersWithSquads(db);
          const gwScoreRows = [];
          for (const user of users) {
            let squad; try { squad=user.squad_data?JSON.parse(user.squad_data):[]; } catch(e){continue;}
            if (!squad||!squad.length) continue;
            const {gwPts,playerBreakdown} = scoreUserForFixture(squad,statsByName);
            if (gwPts===0&&!playerBreakdown.length) continue;
            gwScoreRows.push({user_id:user.id,gameweek:currentGW,points:gwPts,breakdown:{fixture_id:f.id,home,away},player_scores:playerBreakdown});
          }
          if (gwScoreRows.length) { await writeGWScores(db,gwScoreRows); await incrementTotalPoints(db,gwScoreRows); report.users_updated+=gwScoreRows.length; log.push('  Scored '+gwScoreRows.length+' users'); }
          await markFixtureProcessed(db,fixtureObj,currentGW,gwScoreRows.length,report.api_calls_used);
          report.fixtures_scored++;
          log.push('  ✓ Marked processed');
        } catch(e) { log.push('  ERROR fixture_'+f.id+': '+e.message); report.errors.push('fixture_'+f.id+': '+e.message); }
      }
      report.steps_completed.push('calc_points ✓');
    } catch(e) { log.push('  WARN: '+e.message); report.errors.push('calc_points: '+e.message); report.steps_completed.push('calc_points ✗'); }

    // ─── STEP 4: Gameweek management ─────────────────────────────────
    log.push('━━ STEP 4: Gameweek management ━━');
    try {
      const currentGW = await getCurrentGameweek(db);
      const {data:gwFix} = await db.from('fixtures').select('status').eq('gameweek',currentGW);
      const total    = (gwFix||[]).length;
      const finished = (gwFix||[]).filter(f=>f.status==='FT'||f.status==='AET').length;
      log.push('  GW'+currentGW+': '+finished+'/'+total+' done');
      if (total>0&&finished===total) {
        await db.from('gameweeks').update({is_current:false,is_finished:true}).eq('number',currentGW);
        const nextGW = currentGW+1;
        const {data:nextExists} = await db.from('gameweeks').select('number').eq('number',nextGW).maybeSingle();
        if (nextExists) { await db.from('gameweeks').update({is_current:true}).eq('number',nextGW); }
        else { await db.from('gameweeks').insert({number:nextGW,name:'Gameweek '+nextGW,is_current:true,is_finished:false}); log.push('  Created GW'+nextGW); }
        const {data:allUsers} = await db.from('profiles').select('id,free_transfers,transfers_this_gw');
        let rolled=0;
        for (const u of (allUsers||[])) {
          const unused=Math.max(0,(u.free_transfers||1)-(u.transfers_this_gw||0));
          await db.from('profiles').update({free_transfers:Math.min(5,1+unused),transfers_this_gw:0}).eq('id',u.id);
          rolled++;
        }
        report.gw_action='Closed GW'+currentGW+' → Opened GW'+nextGW+' | Rolled transfers for '+rolled+' users';
        log.push('  ✓ '+report.gw_action);
      } else { report.gw_action='GW'+currentGW+' in progress: '+finished+'/'+total; log.push('  '+report.gw_action); }
      report.steps_completed.push('manage_gameweeks ✓');
    } catch(e) { log.push('  WARN: '+e.message); report.errors.push('manage_gameweeks: '+e.message); report.steps_completed.push('manage_gameweeks ✗'); }

    // ─── STEP 5: Update player prices ────────────────────────────────
    log.push('━━ STEP 5: Update prices ━━');
    try {
      const currentGW = await getCurrentGameweek(db);
      const {data:recentStats} = await db.from('player_gw_stats').select('player_id,fantasy_points,gameweek').gte('gameweek',currentGW-3).not('player_id','is',null);
      if (!recentStats||recentStats.length<10) { log.push('  Not enough data'); report.steps_completed.push('update_prices — skipped'); }
      else {
        const pp={};
        recentStats.forEach(s=>{ if (!pp[s.player_id]) pp[s.player_id]=[]; pp[s.player_id].push(s.fantasy_points||0); });
        const {data:players} = await db.from('players').select('id,price,position');
        const bench={GK:4,DEF:5,MID:6,FWD:6};
        for (const p of (players||[])) {
          const pts=pp[p.id]; if (!pts||pts.length<2) continue;
          const avg=pts.reduce((a,b)=>a+b,0)/pts.length;
          const b=bench[p.position]||5;
          let np=p.price;
          if (avg>=b*1.5) np=Math.min(15.0,+(p.price+0.1).toFixed(1));
          else if (avg<=b*0.4) np=Math.max(4.0,+(p.price-0.1).toFixed(1));
          if (np!==p.price) { const {error}=await db.from('players').update({price:np,price_updated_at:new Date().toISOString()}).eq('id',p.id); if (!error) report.prices_updated++; }
        }
        log.push('  Updated '+report.prices_updated+' player prices');
        report.steps_completed.push('update_prices ✓');
      }
    } catch(e) { log.push('  WARN: '+e.message); report.errors.push('update_prices: '+e.message); report.steps_completed.push('update_prices ✗'); }

    report.finished_at = new Date().toISOString();
    report.duration_ms = new Date(report.finished_at)-new Date(report.started_at);
    log.push('COMPLETE in '+report.duration_ms+'ms | API calls: '+report.api_calls_used);
    return res.json(report);

  } catch(err) {
    report.fatal_error=err.message; report.finished_at=new Date().toISOString();
    console.error('[points-cron] Fatal:',err);
    return res.status(500).json(report);
  }
};

// ── Sportmonks HTTP client ────────────────────────────────────────────────
async function getSeasonId() {
  if (PSL_SEASON_ID) return PSL_SEASON_ID;
  try {
    const d=await smGet('/leagues/'+PSL_ID+'?include=currentSeason');
    const s=(d.data&&d.data.currentSeason)||(d.data&&d.data.current_season);
    if (s&&s.id) { PSL_SEASON_ID=s.id; return PSL_SEASON_ID; }
  } catch(_) {}
  const d=await smGet('/seasons?filters=leagueId:'+PSL_ID);
  const list=(d.data||[]).sort((a,b)=>b.id-a.id);
  if (list.length) { PSL_SEASON_ID=list[0].id; return PSL_SEASON_ID; }
  throw new Error('Could not determine PSL season ID');
}

async function smGet(path) {
  const sep=path.includes('?')?'&':'?';
  const url=BASE_URL+path+sep+'api_token='+TOKEN;
  const r=await fetch(url,{method:'GET',headers:{Accept:'application/json'}});
  if (!r.ok) { const b=await r.text().catch(()=>''); throw new Error('Sportmonks HTTP '+r.status+': '+b.substring(0,200)); }
  const json=await r.json();
  if (json.errors) throw new Error('Sportmonks error: '+JSON.stringify(json.errors).substring(0,300));
  return json;
}

// ── Player stats extraction ───────────────────────────────────────────────
function extractPlayerStats(fix) {
  const participants=fix.participants||[], events=fix.events||[], lineups=fix.lineups||[];
  const statistics=fix.statistics||[], scores=fix.scores||[];
  const finalScore={};
  scores.forEach(s=>{
    if (!s.score) return;
    const desc=(s.description||'').toUpperCase();
    if (desc==='FT'||desc==='CURRENT'||desc==='FULLTIME') finalScore[s.participant_id]=s.score.goals||0;
  });
  const ev={};
  function getEv(pid) { if (!ev[pid]) ev[pid]={goals:0,assists:0,yellowCards:0,redCards:0,penSaved:0,penMissed:0}; return ev[pid]; }
  events.forEach(e=>{
    const pid=e.player_id; if (!pid) return;
    const type=e.type?(e.type.developer_name||e.type.name||'').toUpperCase():String(e.type_id||'');
    if (type.includes('GOAL')&&!type.includes('ASSIST')&&!type.includes('OWN')&&!type.includes('MISS')&&!type.includes('SAVE')) getEv(pid).goals++;
    if (type.includes('OWN_GOAL')||type==='17') getEv(pid).goals=Math.max(0,getEv(pid).goals-1);
    if (type.includes('ASSIST')||type==='19') getEv(pid).assists++;
    if (type.includes('YELLOWCARD')||type==='83') getEv(pid).yellowCards++;
    if (type.includes('REDCARD')||type==='84') getEv(pid).redCards++;
    if (type.includes('MISSED_PENALTY')||type==='50') getEv(pid).penMissed++;
    if (type.includes('SAVED_PENALTY')||type==='51') getEv(pid).penSaved++;
  });
  const saves={};
  statistics.forEach(s=>{ const tn=s.type&&(s.type.developer_name||s.type.name)||''; if (tn.toUpperCase().includes('SAVE')&&s.player_id) saves[s.player_id]=parseInt(s.data&&s.data.value,10)||0; });
  return lineups.map(entry=>{
    const player=entry.player||{}, posObj=entry.position||{}, pid=player.id;
    const teamId=entry.team_id||entry.participant_id;
    let myConceded=0;
    Object.keys(finalScore).forEach(tid=>{ if (String(tid)!==String(teamId)) myConceded=finalScore[tid]||0; });
    const pos=normalisePosition(posObj.name||posObj.developer_name||'');
    const minutes=entry.minutes_played||0, pev=ev[pid]||{};
    const team=participants.find(p=>String(p.id)===String(teamId));
    const pts=calculateFantasyPoints({pos,minutes,goals:pev.goals||0,assists:pev.assists||0,saves:saves[pid]||0,goalsConceded:myConceded,yellowCards:pev.yellowCards||0,redCards:pev.redCards||0,penSaved:pev.penSaved||0,penMissed:pev.penMissed||0});
    return { api_player_id:pid||null, player_name:player.display_name||player.name||'Unknown', team:mapTeam(team?(team.name||''):''), position:pos, minutes, goals:pev.goals||0, assists:pev.assists||0, yellow_cards:pev.yellowCards||0, red_cards:pev.redCards||0, saves:saves[pid]||0, goals_conceded:myConceded, penalties_saved:pev.penSaved||0, penalties_missed:pev.penMissed||0, fantasy_points:pts.total, points_breakdown:pts.breakdown };
  });
}

// ── Scoring ───────────────────────────────────────────────────────────────
function scoreUserForFixture(squad, statsByName) {
  let gwPts=0; const playerBreakdown=[];
  const captain=squad.find(p=>p.isCaptain);
  const capKey=captain?normaliseName(captain.name||captain.display_name||''):'';
  const capStats=capKey?(statsByName[capKey]||null):null;
  const capPlayed=capStats&&capStats.minutes>0;
  squad.forEach(sp=>{
    if (sp.onBench) return;
    const key=normaliseName(sp.name||sp.display_name||'');
    const stats=statsByName[key]; if (!stats) return;
    let pts=stats.fantasy_points||0;
    if (sp.isCaptain) pts*=2; else if (sp.isVC&&!capPlayed) pts*=2;
    gwPts+=pts;
    playerBreakdown.push({name:sp.name||sp.display_name,position:sp.position,minutes:stats.minutes,goals:stats.goals,assists:stats.assists,base_pts:stats.fantasy_points,final_pts:pts,is_captain:sp.isCaptain||false,is_vc:sp.isVC||false,breakdown:stats.points_breakdown});
  });
  return {gwPts,playerBreakdown};
}

// ── DB helpers ────────────────────────────────────────────────────────────
async function getCurrentGameweek(db) {
  const {data,error}=await db.from('gameweeks').select('number').eq('is_current',true).single();
  if (error||!data) { console.warn('[cron] defaulting GW to 1'); return 1; }
  return data.number;
}
async function getProcessedFixtureIds(db) {
  const {data}=await db.from('processed_fixtures').select('fixture_id');
  const ids=new Set(); (data||[]).forEach(r=>ids.add(r.fixture_id)); return ids;
}
async function getAllUsersWithSquads(db) {
  const {data,error}=await db.from('profiles').select('id,squad_data,total_points,gw_points').not('squad_data','is',null);
  if (error) throw new Error('Could not load squads: '+error.message); return data||[];
}
async function storePlayerStats(db,playerStats,fixture,gameweek) {
  const rows=playerStats.map(p=>({api_player_id:p.api_player_id,player_name:p.player_name,team:p.team,fixture_id:fixture.fixture_id,gameweek,minutes:p.minutes,goals:p.goals,assists:p.assists,yellow_cards:p.yellow_cards,red_cards:p.red_cards,saves:p.saves,goals_conceded:p.goals_conceded,penalties_saved:p.penalties_saved,penalties_missed:p.penalties_missed,fantasy_points:p.fantasy_points,points_breakdown:p.points_breakdown}));
  const {error}=await db.from('player_gw_stats').upsert(rows,{onConflict:'api_player_id,fixture_id',ignoreDuplicates:false});
  if (error) throw new Error('storePlayerStats: '+error.message);
}
async function writeGWScores(db,rows) {
  for (const row of rows) {
    const {data:ex}=await db.from('gw_scores').select('id,points,player_scores').eq('user_id',row.user_id).eq('gameweek',row.gameweek).maybeSingle();
    if (ex) { await db.from('gw_scores').update({points:(ex.points||0)+row.points,player_scores:(ex.player_scores||[]).concat(row.player_scores||[]),calculated_at:new Date().toISOString()}).eq('id',ex.id); }
    else    { await db.from('gw_scores').insert({user_id:row.user_id,gameweek:row.gameweek,points:row.points,breakdown:row.breakdown,player_scores:row.player_scores}); }
  }
}
async function incrementTotalPoints(db,rows) {
  for (const row of rows) {
    const {data:p}=await db.from('profiles').select('total_points').eq('id',row.user_id).maybeSingle();
    const cur=(p&&p.total_points)||0;
    await db.from('profiles').update({gw_points:row.points,total_points:cur+row.points,last_gw_scored:row.gameweek,updated_at:new Date().toISOString()}).eq('id',row.user_id);
  }
}
async function markFixtureProcessed(db,fixture,gameweek,usersScored,apiCallsUsed) {
  const {error}=await db.from('processed_fixtures').upsert({fixture_id:fixture.fixture_id,gameweek,home_team:fixture.home,away_team:fixture.away,home_score:fixture.hg,away_score:fixture.ag,match_date:fixture.date,processed_at:new Date().toISOString(),users_scored:usersScored,api_calls_used:apiCallsUsed},{onConflict:'fixture_id'});
  if (error) throw new Error('markFixtureProcessed: '+error.message);
}
function normaliseName(n) { if (!n) return ''; return n.toLowerCase().replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim(); }
