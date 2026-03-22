// api/force-sync.js — Full fixture + standings sync  (Sportmonks v3)
const { createClient } = require('@supabase/supabase-js');
const { getSeasonId }  = require('./season-helper');

const TOKEN = process.env.SPORTMONKS_TOKEN;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY;
const ADMIN   = process.env.ADMIN_SECRET || 'fpsl-admin-2026';
const BASE    = 'https://api.sportmonks.com/v3/football';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if ((req.query && req.query.admin_key) !== ADMIN) return res.status(401).json({ error:'Unauthorized' });
  if (!TOKEN)          return res.status(500).json({ error:'SPORTMONKS_TOKEN missing' });
  if (!SB_URL||!SB_KEY) return res.status(500).json({ error:'Supabase env vars missing' });

  var db  = createClient(SB_URL, SB_KEY);
  var log = [];

  try {
    // ── Season ID ─────────────────────────────────────────────────────────
    // If you set SPORTMONKS_SEASON_ID in Vercel env vars, we use that directly
    // Otherwise auto-detect via /seasons list (no filters needed)
    var seasonId = process.env.SPORTMONKS_SEASON_ID
      ? parseInt(process.env.SPORTMONKS_SEASON_ID, 10)
      : await getSeasonId(db, TOKEN);
    log.push('Season ID: ' + seasonId);

    // ── Upcoming fixtures ─────────────────────────────────────────────────
    // Uses /fixtures?filters=fixtureSeasons:{id};fixtureStates:1 (state 1 = Not Started)
    var upCount = 0;
    try {
      var page = 1;
      while (page <= 5) {
        var upData = await smGet('/fixtures?filters=fixtureSeasons:' + seasonId + ';fixtureStates:1' +
          '&include=participants;round&per_page=50&page=' + page);
        var upcoming = upData.data || [];
        if (!upcoming.length) break;
        for (var i = 0; i < upcoming.length; i++) {
          var f = upcoming[i];
          await upsertFixture(db, f, 'NS', null, null);
          upCount++;
        }
        var umeta = upData.meta && upData.meta.pagination;
        if (!umeta || !umeta.has_next_page) break;
        page++;
      }
      log.push('Upcoming synced: ' + upCount);
    } catch(e) { log.push('Upcoming error: ' + e.message); }

    // ── Past results ──────────────────────────────────────────────────────
    // Uses /fixtures?filters=fixtureSeasons:{id};fixtureStates:5 (state 5 = Finished/FT)
    var pastCount = 0;
    try {
      var ppage = 1;
      while (ppage <= 10) {
        var pastData = await smGet('/fixtures?filters=fixtureSeasons:' + seasonId + ';fixtureStates:5' +
          '&include=participants;scores&per_page=50&page=' + ppage);
        var past = pastData.data || [];
        if (!past.length) break;
        for (var pi = 0; pi < past.length; pi++) {
          var pf = past[pi];
          var scores = extractScores(pf.scores || []);
          await upsertFixture(db, pf, 'FT', scores.home, scores.away);
          pastCount++;
        }
        var pmeta = pastData.meta && pastData.meta.pagination;
        if (!pmeta || !pmeta.has_next_page) break;
        ppage++;
      }
      log.push('Past results synced: ' + pastCount);
    } catch(e) { log.push('Past results error: ' + e.message); }

    // ── Standings ─────────────────────────────────────────────────────────
    var standCount = 0;
    try {
      var standData = await smGet('/standings/seasons/' + seasonId);
      var rows = flattenStandings(standData.data || []);
      if (rows.length) {
        await db.from('standings').upsert(rows, { onConflict:'id' });
        standCount = rows.length;
      }
      log.push('Standings synced: ' + standCount + ' teams');
    } catch(e) { log.push('Standings error: ' + e.message); }

    return res.json({
      success: true, season_id: seasonId,
      upcoming_synced: upCount,
      past_synced: pastCount,
      standings_synced: standCount,
      log,
      message: 'Sync complete — run /api/points-cron?admin_key=' + ADMIN + ' next to score players'
    });

  } catch(err) {
    console.error('[force-sync]', err.message);
    return res.status(500).json({ error: err.message, log });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────
async function upsertFixture(db, f, status, homeScore, awayScore) {
  var parts = f.participants || [];
  await db.from('fixtures').upsert({
    id:           f.id,
    sportmonks_id:f.id,
    home_team:    getParticipant(parts,'home','name')     || 'TBD',
    away_team:    getParticipant(parts,'away','name')     || 'TBD',
    home_logo:    getParticipant(parts,'home','image_path') || null,
    away_logo:    getParticipant(parts,'away','image_path') || null,
    home_score:   homeScore,
    away_score:   awayScore,
    status:       status,
    kickoff_at:   f.starting_at,
    round:        (f.round && f.round.name) || null,
    updated_at:   new Date().toISOString()
  }, { onConflict:'id' });
}

function getParticipant(parts, loc, field) {
  var p = parts.find(function(x){ return x.meta && x.meta.location === loc; });
  return p ? p[field] : null;
}

function extractScores(scores) {
  var home = null, away = null;
  scores.forEach(function(s) {
    var desc = (s.description || '').toUpperCase();
    if (['CURRENT','FT','FULLTIME','2ND_HALF'].indexOf(desc) > -1) {
      if (s.score && s.score.participant === 'home') home = s.score.goals;
      if (s.score && s.score.participant === 'away') away = s.score.goals;
    }
  });
  return { home, away };
}

function flattenStandings(data) {
  var rows = [];
  data.forEach(function(g) {
    var items = (g.standings && Array.isArray(g.standings)) ? g.standings : (g.position ? [g] : []);
    items.forEach(function(s, idx) {
      var det  = s.details || [];
      var part = s.participant || {};
      function dv(tid) { var d=det.find(function(x){return x.type_id===tid;}); return d?(d.value||0):0; }
      rows.push({
        id:            s.participant_id || part.id || (rows.length + 1),
        team_name:     part.name || s.team_name || 'Unknown',
        team_logo:     part.image_path || null,
        position:      s.position || rows.length + 1,
        played:        dv(129) || s.games_played || 0,
        won:           dv(130) || s.won   || 0,
        drawn:         dv(131) || s.draw  || 0,
        lost:          dv(132) || s.lost  || 0,
        goals_for:     dv(133) || s.goals_scored   || 0,
        goals_against: dv(134) || s.goals_conceded || 0,
        goal_diff:     dv(135) || s.goal_difference || 0,
        points:        s.points || 0,
        form:          Array.isArray(s.form) ? s.form.slice(-5).join(',') : (s.form || ''),
        updated_at:    new Date().toISOString()
      });
    });
  });
  return rows;
}

async function smGet(path) {
  var sep = path.indexOf('?') > -1 ? '&' : '?';
  var url = BASE + path + sep + 'api_token=' + TOKEN;
  console.log('[SM GET]', path.split('?')[0]);
  var r = await fetch(url, { headers:{ Accept:'application/json' } });
  if (!r.ok) { var b=await r.text().catch(function(){return'';}); throw new Error('Sportmonks '+r.status+': '+b.substring(0,300)); }
  var json = await r.json();
  if (json.errors) throw new Error('Sportmonks errors: '+JSON.stringify(json.errors).substring(0,300));
  return json;
}
