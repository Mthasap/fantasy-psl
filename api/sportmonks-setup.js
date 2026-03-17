// ══════════════════════════════════════════════════════════════════════════
// api/sportmonks-setup.js  —  Fantasy PSL  —  Sportmonks Diagnostic Tool
// ══════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Test your Sportmonks API token, discover the correct PSL season ID,
//          and verify all endpoints needed by Fantasy PSL work correctly.
//
// USAGE (admin panel or direct browser):
//   GET /api/sportmonks-setup?admin_key=fpsl-admin-2026
//   GET /api/sportmonks-setup?admin_key=fpsl-admin-2026&action=fixtures
//   GET /api/sportmonks-setup?admin_key=fpsl-admin-2026&action=players&season_id=23614
//   GET /api/sportmonks-setup?admin_key=fpsl-admin-2026&action=import_players
//
// ENV VARS REQUIRED:
//   SPORTMONKS_TOKEN      — your Sportmonks API token
//   SUPABASE_URL          — your Supabase project URL
//   SUPABASE_SERVICE_KEY  — your Supabase service role key
//   ADMIN_SECRET          — must match admin_key param (fpsl-admin-2026)
// ══════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

const TOKEN        = process.env.SPORTMONKS_TOKEN     || '';
const SUPABASE_URL = process.env.SUPABASE_URL          || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY  || '';
const BASE        = 'https://api.sportmonks.com/v3/football';
const PSL_LEAGUE  = 806; // Betway Premiership

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Auth check
  const adminKey = req.query.admin_key || req.headers['x-admin-key'] || '';
  const expected = process.env.ADMIN_SECRET || 'fpsl-admin-2026';
  if (adminKey !== expected) return res.status(401).json({ error: 'Unauthorized — add ?admin_key=fpsl-admin-2026' });

  if (!TOKEN) return res.status(500).json({ error: 'SPORTMONKS_TOKEN env var not set in Vercel' });

  const action = req.query.action || 'diagnose';
  const report = { action, token_set: true, token_preview: TOKEN.substring(0,8)+'…', results: {}, errors: [] };

  try {

    if (action === 'diagnose') {
      // ── Full diagnosis: test all needed endpoints ──────────────────────
      report.description = 'Testing all Sportmonks endpoints needed by Fantasy PSL';

      // 1. Check subscription / ping
      try {
        const d = await smGet('/leagues/' + PSL_LEAGUE);
        report.results.league = { ok: true, name: d.data && d.data.name, id: d.data && d.data.id };
      } catch(e) { report.results.league = { ok: false, error: e.message }; report.errors.push('league: ' + e.message); }

      // 2. Get current season
      let seasonId = null;
      try {
        const d = await smGet('/leagues/' + PSL_LEAGUE + '?include=currentSeason');
        const s = (d.data && d.data.currentSeason) || (d.data && d.data.current_season);
        if (s && s.id) { seasonId = s.id; report.results.current_season = { ok: true, id: s.id, name: s.name }; }
        else {
          // fallback: list seasons
          const d2 = await smGet('/seasons?filters=leagueId:' + PSL_LEAGUE);
          const list = (d2.data || []).sort((a,b) => b.id - a.id);
          if (list.length) { seasonId = list[0].id; report.results.current_season = { ok: true, id: list[0].id, name: list[0].name, note: 'via season list fallback' }; }
          else { report.results.current_season = { ok: false, error: 'No seasons found' }; report.errors.push('No season found for PSL league'); }
        }
      } catch(e) { report.results.current_season = { ok: false, error: e.message }; report.errors.push('season: ' + e.message); }

      if (seasonId) {
        report.results.season_id_to_use = seasonId;
        report.instructions = ['Set SPORTMONKS_SEASON_ID=' + seasonId + ' in Vercel env vars (optional — cron auto-detects it)'];

        // 3. Test upcoming fixtures
        try {
          const d = await smGet('/fixtures/upcoming/season/' + seasonId + '?include=participants;round&per_page=5');
          const count = (d.data || []).length;
          report.results.upcoming_fixtures = { ok: true, count_returned: count, sample: (d.data || []).slice(0, 2).map(f => ({ id: f.id, starting_at: f.starting_at })) };
        } catch(e) { report.results.upcoming_fixtures = { ok: false, error: e.message }; report.errors.push('upcoming fixtures: ' + e.message); }

        // 4. Test past fixtures (results)
        try {
          const d = await smGet('/fixtures/past/season/' + seasonId + '?include=participants;scores&per_page=5');
          const count = (d.data || []).length;
          const sample = (d.data || []).slice(0, 2).map(f => ({ id: f.id, starting_at: f.starting_at }));
          report.results.past_fixtures = { ok: true, count_returned: count, sample };
        } catch(e) { report.results.past_fixtures = { ok: false, error: e.message }; report.errors.push('past fixtures: ' + e.message); }

        // 5. Test squad/players
        try {
          const d = await smGet('/squads/seasons/' + seasonId + '?include=player;position&per_page=10');
          const count = (d.data || []).length;
          report.results.squads = { ok: true, count_returned: count, note: 'Use action=players&season_id=' + seasonId + ' to see full list' };
        } catch(e) {
          // try team squads approach
          try {
            const d2 = await smGet('/teams/season/' + seasonId + '?per_page=5');
            const count2 = (d2.data || []).length;
            report.results.squads = { ok: true, via: 'team list', count_returned: count2, note: 'Use action=players&season_id=' + seasonId };
          } catch(e2) { report.results.squads = { ok: false, error: e.message + ' | ' + e2.message }; report.errors.push('squads: ' + e.message); }
        }

        // 6. Test player stats for a recent fixture (if we have one)
        if (report.results.past_fixtures && report.results.past_fixtures.sample && report.results.past_fixtures.sample.length) {
          const testFixId = report.results.past_fixtures.sample[0].id;
          try {
            const d = await smGet('/fixtures/' + testFixId + '?include=participants;scores;events.type;lineups.player;lineups.position;statistics.type');
            const lineupCount = (d.data && d.data.lineups && d.data.lineups.length) || 0;
            report.results.fixture_detail_stats = { ok: true, fixture_id: testFixId, lineups_found: lineupCount };
          } catch(e) { report.results.fixture_detail_stats = { ok: false, fixture_id: testFixId, error: e.message }; report.errors.push('fixture detail: ' + e.message); }
        }
      }

      report.summary = report.errors.length === 0
        ? '✅ All endpoints working! Your cron job should run correctly.'
        : '⚠️ ' + report.errors.length + ' issue(s) found. Check results above.';

    } else if (action === 'topscorer_types') {
      // ── Discover what type IDs Sportmonks uses for this season ──
      const sid = req.query.season_id || 26173;

      // Try 1: default endpoint (no filter)
      const d1 = await smGet('/topscorers/seasons/' + sid + '?include=participant;player;type&per_page=100');
      const types1 = {};
      (d1.data || []).forEach(r => {
        const t = r.type || {};
        const tid = t.id || r.type_id || '?';
        types1[tid] = { id: tid, developer_name: t.developer_name || t.name || '?' };
      });

      // Try 2: explicit goals filter type 208
      let goals208 = null;
      try {
        const d2 = await smGet('/topscorers/seasons/' + sid + '?include=participant;player;type&filters=seasontopscorerTypes:208&per_page=5');
        goals208 = { count: (d2.data||[]).length, sample: (d2.data||[]).slice(0,3).map(r=>({player:(r.player||{}).name,total:r.total,type_id:(r.type||{}).id})) };
      } catch(e) { goals208 = { error: e.message }; }

      // Try 3: season statistics include (alternative way to get player stats)
      let seasonStats = null;
      try {
        const d3 = await smGet('/seasons/' + sid + '?include=players.statistics.type&per_page=5');
        seasonStats = { keys: Object.keys(d3.data || {}).slice(0,10) };
      } catch(e) { seasonStats = { error: e.message }; }

      // Try 4: fixture player statistics for a recent result
      const { data: recentFix } = await smGet('/fixtures?filters=fixtureSeasons:' + sid + ';fixtureStates:5&per_page=1&sortBy=starting_at&order=desc');
      let fixStats = null;
      if (recentFix && recentFix.length) {
        const fid = recentFix[0].id;
        try {
          const d4 = await smGet('/fixtures/' + fid + '?include=statistics.type&per_page=3');
          const stats = (d4.data && d4.data.statistics || []).slice(0,5);
          fixStats = { fixture_id: fid, fixture_name: recentFix[0].name, stat_types: stats.map(s=>({ type_id:(s.type||{}).id, type_name:(s.type||{}).developer_name, player_id:s.player_id, value:s.data })) };
        } catch(e) { fixStats = { error: e.message }; }
      }

      report.results.topscorer_types = {
        unique_types_returned: Object.values(types1),
        total_rows: (d1.data||[]).length,
        goals_type_208_test: goals208,
        season_stats_test: seasonStats,
        fixture_stats_sample: fixStats,
        conclusion: Object.keys(types1).length <= 2 ? 'ONLY CARDS AVAILABLE — goals/assists not in topscorers for PSL. Use fixture statistics instead.' : 'Multiple types found'
      };

    } else if (action === 'fixtures') {
      // ── List upcoming + recent fixtures ───────────────────────────────
      const sid = req.query.season_id || await autoGetSeasonId();
      const [upcoming, past] = await Promise.all([
        smGet('/fixtures/upcoming/season/' + sid + '?include=participants;round&per_page=20'),
        smGet('/fixtures/past/season/' + sid + '?include=participants;scores&per_page=20')
      ]);
      report.results = {
        season_id: sid,
        upcoming: (upcoming.data || []).map(f => formatFixture(f)),
        past: (past.data || []).map(f => formatFixture(f))
      };

    } else if (action === 'players') {
      // ── List all players in the PSL this season ───────────────────────
      const sid = req.query.season_id || await autoGetSeasonId();
      report.results.season_id = sid;
      // Try squads endpoint first
      try {
        const d = await smGet('/squads/seasons/' + sid + '?include=player.position&per_page=200');
        report.results.players = (d.data || []).map(function(entry) {
          const p = entry.player || {};
          return { id: p.id, name: p.display_name || p.name, position: p.position && (p.position.developer_name || p.position.name) };
        });
        report.results.count = report.results.players.length;
      } catch(e) {
        // Fallback: get teams then squad per team
        report.errors.push('squads endpoint: ' + e.message + ' — trying team-by-team approach');
        const teamsData = await smGet('/teams/season/' + sid + '?per_page=25');
        const teams = teamsData.data || [];
        const allPlayers = [];
        for (const team of teams) {
          try {
            const sd = await smGet('/squads/teams/' + team.id + '?include=player.position');
            (sd.data || []).forEach(function(entry) {
              const p = entry.player || {};
              allPlayers.push({ id: p.id, name: p.display_name || p.name, team: team.name, position: p.position && (p.position.developer_name || p.position.name) });
            });
          } catch(_) {}
        }
        report.results.players = allPlayers;
        report.results.count = allPlayers.length;
      }

    } else if (action === 'import_players') {
      // ── Import players from Sportmonks into Supabase ──────────────────
      if (!SUPABASE_URL) return res.status(500).json({ error: 'SUPABASE_URL not set' });
      const db = createClient(SUPABASE_URL, SUPABASE_KEY);
      const sid = req.query.season_id || await autoGetSeasonId();
      report.results.season_id = sid;

      const allPlayers = [];
      const teamsData = await smGet('/teams/season/' + sid + '?per_page=25');
      const teams = teamsData.data || [];
      report.results.teams_found = teams.length;

      for (const team of teams) {
        try {
          const sd = await smGet('/squads/teams/' + team.id + '?include=player.position');
          (sd.data || []).forEach(function(entry) {
            const p = entry.player || {};
            if (!p.id || !p.name) return;
            const rawPos = p.position && (p.position.developer_name || p.position.name) || 'MID';
            const pos = normalisePosition(rawPos);
            const price = pos === 'GK' ? 4.5 : pos === 'DEF' ? 5.0 : pos === 'MID' ? 6.0 : 6.5;
            allPlayers.push({
              api_player_id: String(p.id),
              display_name: p.display_name || p.name,
              team: team.name,
              position: pos,
              photo: p.image_path || null,
              price: price,
              is_available: true,
              updated_at: new Date().toISOString()
            });
          });
        } catch(e) { report.errors.push('team ' + team.name + ': ' + e.message); }
      }

      if (!allPlayers.length) { return res.json({ ...report, error: 'No players found to import' }); }

      // Upsert into Supabase players table
      const chunkSize = 50;
      let imported = 0;
      for (let i = 0; i < allPlayers.length; i += chunkSize) {
        const chunk = allPlayers.slice(i, i + chunkSize);
        const { error } = await db.from('players').upsert(chunk, { onConflict: 'api_player_id', ignoreDuplicates: false });
        if (error) { report.errors.push('upsert chunk ' + i + ': ' + error.message); }
        else imported += chunk.length;
      }
      report.results.players_imported = imported;
      report.results.total_found = allPlayers.length;
      report.summary = imported > 0 ? '✅ Imported ' + imported + ' players into Supabase' : '❌ Import failed';

    } else {
      return res.status(400).json({ error: 'Unknown action. Use: diagnose, fixtures, players, import_players' });
    }

  } catch(err) {
    report.fatal_error = err.message;
    report.errors.push('fatal: ' + err.message);
  }

  return res.json(report);
};

// ── Helpers ───────────────────────────────────────────────────────────────
async function smGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = BASE + path + sep + 'api_token=' + TOKEN;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) { const b = await r.text().catch(() => ''); throw new Error('HTTP ' + r.status + ': ' + b.substring(0, 300)); }
  const json = await r.json();
  if (json.errors) throw new Error('Sportmonks error: ' + JSON.stringify(json.errors).substring(0, 300));
  return json;
}

async function autoGetSeasonId() {
  try {
    const d = await smGet('/leagues/' + PSL_LEAGUE + '?include=currentSeason');
    const s = (d.data && d.data.currentSeason) || (d.data && d.data.current_season);
    if (s && s.id) return s.id;
  } catch(_) {}
  const d = await smGet('/seasons?filters=leagueId:' + PSL_LEAGUE);
  const list = (d.data || []).sort((a,b) => b.id - a.id);
  if (list.length) return list[0].id;
  throw new Error('Could not determine PSL season ID');
}

function formatFixture(f) {
  const parts = f.participants || [];
  const home = (parts.find(p => p.meta && p.meta.location === 'home') || parts[0] || {}).name || '?';
  const away = (parts.find(p => p.meta && p.meta.location === 'away') || parts[1] || {}).name || '?';
  let hg = null, ag = null;
  (f.scores || []).forEach(s => {
    if (!s.score) return;
    const desc = (s.description || '').toUpperCase();
    if (desc === 'FT' || desc === 'FULLTIME') {
      if (s.score.participant === 'home') hg = s.score.goals;
      if (s.score.participant === 'away') ag = s.score.goals;
    }
  });
  const round = f.round && f.round.name ? f.round.name : null;
  return { id: f.id, home, away, starting_at: f.starting_at, round, score: hg !== null ? hg + '-' + ag : null };
}

function normalisePosition(raw) {
  if (!raw) return 'MID';
  const r = raw.toUpperCase();
  if (r.includes('GOAL') || r === 'GK' || r === 'G') return 'GK';
  if (r.includes('DEFEND') || r === 'DEF' || r === 'D' || r === 'CB' || r === 'LB' || r === 'RB' || r === 'WB') return 'DEF';
  if (r.includes('FORWARD') || r.includes('STRIKER') || r === 'FWD' || r === 'F' || r === 'ST' || r === 'CF' || r === 'LW' || r === 'RW' || r === 'ATT') return 'FWD';
  return 'MID';
}
