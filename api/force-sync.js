// api/force-sync.js — Full fixture sync using correct Sportmonks v3 endpoints
const { createClient } = require('@supabase/supabase-js');

const TOKEN = process.env.SPORTMONKS_TOKEN;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN = process.env.ADMIN_SECRET || 'fpsl-admin-2026';
const BASE = 'https://api.sportmonks.com/v3/football';
const PSL = 806;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if ((req.query && req.query.admin_key) !== ADMIN) return res.status(401).json({ error: 'Unauthorized' });
  if (!TOKEN) return res.status(500).json({ error: 'SPORTMONKS_TOKEN missing' });
  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'Supabase env vars missing' });

  var db = createClient(SB_URL, SB_KEY);
  var log = [];

  try {
    // ── Step 1: Get season ID ─────────────────────────────────────────────
    var seasonId = null;

    // Check Supabase cache first
    var cacheRes = await db.from('api_cache').select('value').eq('key', 'psl_current_season_id').single();
    if (cacheRes.data && cacheRes.data.value) {
      seasonId = parseInt(cacheRes.data.value, 10);
      log.push('Season from cache: ' + seasonId);
    }

    if (!seasonId) {
      // Primary: league with currentSeason include
      var leagueRes = await smGet('/leagues/' + PSL + '?include=currentSeason');
      var cs = leagueRes.data && (leagueRes.data.currentSeason || leagueRes.data.current_season);
      seasonId = cs && cs.id;
      log.push('Season from league endpoint: ' + seasonId);
    }

    if (!seasonId) {
      // Fallback: seasons list filtered by league
      var seasonsRes = await smGet('/seasons?filters=leagueId:' + PSL + '&per_page=10');
      var list = (seasonsRes.data || []).sort(function(a, b) { return b.id - a.id; });
      seasonId = list[0] && list[0].id;
      log.push('Season from seasons list: ' + seasonId + (list[0] ? ' (' + list[0].name + ')' : ''));
    }

    if (!seasonId) {
      return res.status(500).json({
        error: 'No season ID found. Run /api/sportmonks-setup?admin_key=' + ADMIN + '&action=diagnose to debug.',
        log: log
      });
    }

    // Cache it
    await db.from('api_cache').upsert({
      key: 'psl_current_season_id',
      value: seasonId.toString(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'key' });

    // ── Step 2: Sync upcoming fixtures ────────────────────────────────────
    // Correct endpoint: /fixtures/upcoming/season/{id} — no filter params needed
    var upCount = 0;
    try {
      var page = 1;
      while (page <= 5) {
        var upData = await smGet('/fixtures/upcoming/season/' + seasonId + '?include=participants;round&per_page=50&page=' + page);
        var upcoming = upData.data || [];
        if (!upcoming.length) break;

        for (var i = 0; i < upcoming.length; i++) {
          var f = upcoming[i];
          var fp = f.participants || [];
          await db.from('fixtures').upsert({
            id:          f.id,
            sportmonks_id: f.id,
            home_team:   getName(fp, 'home'),
            away_team:   getName(fp, 'away'),
            home_logo:   getLogo(fp, 'home'),
            away_logo:   getLogo(fp, 'away'),
            home_score:  null,
            away_score:  null,
            status:      'NS',
            kickoff_at:  f.starting_at,
            round:       (f.round && f.round.name) || null,
            updated_at:  new Date().toISOString()
          }, { onConflict: 'id' });
          upCount++;
        }

        var meta = upData.meta && upData.meta.pagination;
        if (!meta || !meta.has_next_page) break;
        page++;
      }
      log.push('Upcoming fixtures synced: ' + upCount);
    } catch(e) {
      log.push('Upcoming fixtures error: ' + e.message);
    }

    // ── Step 3: Sync past results ─────────────────────────────────────────
    // Correct endpoint: /fixtures/past/season/{id}
    var pastCount = 0;
    try {
      var ppage = 1;
      while (ppage <= 10) {
        var pastData = await smGet('/fixtures/past/season/' + seasonId + '?include=participants;scores;state&per_page=50&page=' + ppage);
        var past = pastData.data || [];
        if (!past.length) break;

        for (var pi = 0; pi < past.length; pi++) {
          var pf = past[pi];
          var pp = pf.participants || [];
          var homeScore = null, awayScore = null;

          (pf.scores || []).forEach(function(s) {
            var desc = (s.description || '').toUpperCase();
            if (['CURRENT','FT','FULLTIME','2ND_HALF'].indexOf(desc) > -1) {
              if (s.score && s.score.participant === 'home') homeScore = s.score.goals;
              if (s.score && s.score.participant === 'away') awayScore = s.score.goals;
            }
          });

          await db.from('fixtures').upsert({
            id:          pf.id,
            sportmonks_id: pf.id,
            home_team:   getName(pp, 'home'),
            away_team:   getName(pp, 'away'),
            home_logo:   getLogo(pp, 'home'),
            away_logo:   getLogo(pp, 'away'),
            home_score:  homeScore,
            away_score:  awayScore,
            status:      'FT',
            kickoff_at:  pf.starting_at,
            round:       (pf.round && pf.round.name) || null,
            updated_at:  new Date().toISOString()
          }, { onConflict: 'id' });
          pastCount++;
        }

        var pmeta = pastData.meta && pastData.meta.pagination;
        if (!pmeta || !pmeta.has_next_page) break;
        ppage++;
      }
      log.push('Past fixtures synced: ' + pastCount);
    } catch(e) {
      log.push('Past fixtures error: ' + e.message);
    }

    // ── Step 4: Sync standings ────────────────────────────────────────────
    var standCount = 0;
    try {
      var standData = await smGet('/standings/seasons/' + seasonId);
      var groups = standData.data || [];
      var rows = [];
      groups.forEach(function(g) {
        if (g.standings && Array.isArray(g.standings)) rows = rows.concat(g.standings);
        else if (g.position) rows.push(g);
      });

      if (rows.length) {
        var upsertRows = rows.map(function(s, idx) {
          var det = s.details || [];
          function dv(tid) { var d = det.find(function(x){ return x.type_id===tid; }); return d ? (d.value||0) : 0; }
          var part = s.participant || {};
          return {
            id:            s.participant_id || part.id || (idx+1),
            team_name:     part.name || s.team_name || 'Unknown',
            team_logo:     part.image_path || null,
            position:      s.position || idx+1,
            played:        dv(129) || s.games_played || 0,
            won:           dv(130) || s.won   || 0,
            drawn:         dv(131) || s.draw  || 0,
            lost:          dv(132) || s.lost  || 0,
            goals_for:     dv(133) || s.goals_scored   || 0,
            goals_against: dv(134) || s.goals_conceded || 0,
            goal_diff:     dv(135) || s.goal_difference || 0,
            points:        s.points || 0,
            form:          Array.isArray(s.form) ? s.form.slice(-5).join(',') : (s.form||''),
            updated_at:    new Date().toISOString()
          };
        });
        await db.from('standings').upsert(upsertRows, { onConflict: 'id' });
        standCount = upsertRows.length;
        log.push('Standings synced: ' + standCount + ' teams');
      }
    } catch(e) {
      log.push('Standings error: ' + e.message);
    }

    return res.json({
      success:         true,
      season_id:       seasonId,
      upcoming_synced: upCount,
      past_synced:     pastCount,
      standings_synced: standCount,
      log:             log,
      message:         'Sync complete — run points-cron next to calculate player/user points'
    });

  } catch(err) {
    console.error('[force-sync]', err.message);
    return res.status(500).json({ error: err.message, log: log });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────
function getName(parts, loc) {
  var p = parts.find(function(x){ return x.meta && x.meta.location === loc; });
  return (p && p.name) || 'TBD';
}
function getLogo(parts, loc) {
  var p = parts.find(function(x){ return x.meta && x.meta.location === loc; });
  return (p && p.image_path) || null;
}
async function smGet(path) {
  var TOKEN = process.env.SPORTMONKS_TOKEN;
  var sep = path.indexOf('?') > -1 ? '&' : '?';
  var url = 'https://api.sportmonks.com/v3/football' + path + sep + 'api_token=' + TOKEN;
  console.log('[SM GET]', path.split('?')[0]);
  var r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) {
    var body = await r.text().catch(function(){ return ''; });
    throw new Error('Sportmonks ' + r.status + ': ' + body.substring(0, 300));
  }
  var json = await r.json();
  if (json.errors) throw new Error('Sportmonks errors: ' + JSON.stringify(json.errors).substring(0, 300));
  return json;
}
