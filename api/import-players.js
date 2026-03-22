// api/import-players.js — Sportmonks v3 player import
// Imports all PSL squad players into the Supabase players table
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  const TOKEN  = process.env.SPORTMONKS_TOKEN;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ADMIN  = process.env.ADMIN_SECRET || 'fpsl-admin-2026';

  // Admin-only endpoint
  if ((req.query && req.query.admin_key) !== ADMIN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!TOKEN || !SB_URL || !SB_KEY) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  const supabase = createClient(SB_URL, SB_KEY);
  const BASE     = 'https://api.sportmonks.com/v3/football';
  const PSL      = 806;

  function normalisePosition(raw) {
    if (!raw) return 'MID';
    var r = raw.toUpperCase().trim();
    if (r.includes('GOAL') || r === 'GK')                      return 'GK';
    if (r.includes('DEFEND') || r === 'DEF' || r === 'D')      return 'DEF';
    if (r.includes('ATTACK') || r.includes('FORWARD') || r === 'FWD') return 'FWD';
    return 'MID';
  }

  function defaultPrice(pos) {
    if (pos === 'GK')  return 4.5;
    if (pos === 'DEF') return 5.0;
    if (pos === 'MID') return 6.0;
    return 6.5; // FWD
  }

  try {
    // 1. Detect current season
    var seasonId;
    var leagueRes  = await fetch(BASE + '/leagues/' + PSL + '?include=currentSeason&api_token=' + TOKEN);
    var leagueData = await leagueRes.json();
    var cs = leagueData.data && (leagueData.data.currentSeason || leagueData.data.current_season);
    seasonId = cs && cs.id;

    if (!seasonId) {
      var seasonsRes  = await fetch(BASE + '/seasons?filters=leagueId:' + PSL + '&api_token=' + TOKEN);
      var seasonsData = await seasonsRes.json();
      var sorted = (seasonsData.data || []).sort(function(a,b){ return new Date(b.starting_at)-new Date(a.starting_at); });
      seasonId = sorted[0] && sorted[0].id;
    }
    if (!seasonId) throw new Error('Could not find current PSL season');

    // 2. Get all teams in season
    var teamsRes = await fetch(BASE + '/teams/seasons/' + seasonId + '?api_token=' + TOKEN);
    var teamsData = await teamsRes.json();
    var teams = teamsData.data || [];

    var allPlayers = [];
    var errors     = [];

    // 3. Get squad per team
    for (var i = 0; i < teams.length; i++) {
      var team = teams[i];
      try {
        var squadRes  = await fetch(BASE + '/squads/teams/' + team.id + '?include=player.position&api_token=' + TOKEN);
        var squadData = await squadRes.json();
        var squad     = squadData.data || [];

        squad.forEach(function(entry) {
          var p   = entry.player || {};
          var pos = normalisePosition(entry.position && (entry.position.name || entry.position.developer_name));

          allPlayers.push({
            api_player_id: String(p.id),
            display_name:  p.display_name || p.name || 'Unknown',
            team:          team.name,
            team_id:       String(team.id),
            position:      pos,
            photo:         p.image_path || null,
            price:         defaultPrice(pos),
            is_available:  true,
            goals:         0,
            assists:       0,
            yellow_cards:  0,
            red_cards:     0,
            clean_sheets:  0,
            apps:          0,
            total_points:  0,
            updated_at:    new Date().toISOString()
          });
        });
      } catch(e) {
        errors.push('Team ' + team.name + ': ' + e.message);
      }
    }

    if (!allPlayers.length) throw new Error('No players found. Check your Sportmonks plan includes squad data.');

    // 4. Upsert into players table
    var { error } = await supabase.from('players')
      .upsert(allPlayers, { onConflict: 'api_player_id' });
    if (error) throw error;

    return res.json({
      success:          true,
      players_imported: allPlayers.length,
      teams_processed:  teams.length,
      season_id:        seasonId,
      errors:           errors
    });

  } catch(err) {
    console.error('[import-players]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
