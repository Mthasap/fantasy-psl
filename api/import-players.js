// api/import-players.js — Sportmonks v3 player import
const { createClient } = require('@supabase/supabase-js');
const { getSeasonId }  = require('./season-helper');

const TOKEN  = process.env.SPORTMONKS_TOKEN;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN  = process.env.ADMIN_SECRET || 'fpsl-admin-2026';
const BASE   = 'https://api.sportmonks.com/v3/football';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (!req.query || req.query.admin_key !== ADMIN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!TOKEN || !SB_URL || !SB_KEY) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  var db = createClient(SB_URL, SB_KEY);

  function normalisePosition(raw) {
    if (!raw) return 'MID';
    var r = raw.toUpperCase().trim();
    if (r.includes('GOAL') || r === 'GK' || r === 'G') return 'GK';
    if (r.includes('DEFEND') || r === 'DEF' || r === 'D') return 'DEF';
    if (r.includes('FORWARD') || r.includes('ATTACK') || r === 'FWD' || r === 'F' || r === 'ST') return 'FWD';
    return 'MID';
  }

  function defaultPrice(pos) {
    if (pos === 'GK')  return 4.5;
    if (pos === 'DEF') return 5.0;
    if (pos === 'MID') return 6.0;
    return 6.5;
  }

  try {
    // Season ID — uses season-helper (works on all plan tiers, known fallback 26173)
    var seasonId = await getSeasonId(db, TOKEN);

    // Get all teams in season
    var teamsRes  = await smGet('/teams/seasons/' + seasonId + '?per_page=25');
    var teams     = teamsRes.data || [];

    if (!teams.length) throw new Error('No teams found for season ' + seasonId);

    var allPlayers = [];
    var errors     = [];

    for (var i = 0; i < teams.length; i++) {
      var team = teams[i];
      try {
        var squadRes  = await smGet('/squads/teams/' + team.id + '?include=player.position');
        var squad     = squadRes.data || [];

        for (var j = 0; j < squad.length; j++) {
          var entry = squad[j];
          var p     = entry.player || {};
          if (!p.id) continue;

          var rawPos = (entry.position && (entry.position.name || entry.position.developer_name)) || '';
          var pos    = normalisePosition(rawPos);

          allPlayers.push({
            api_player_id: String(p.id),
            display_name:  p.display_name || p.name || 'Unknown',
            team:          team.name,
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
        }
      } catch(e) {
        errors.push('Team ' + team.name + ': ' + e.message);
      }
    }

    if (!allPlayers.length) {
      return res.status(500).json({ error: 'No players found. Check Sportmonks plan includes squad data.', errors });
    }

    // Upsert in chunks of 50
    var imported = 0;
    for (var ci = 0; ci < allPlayers.length; ci += 50) {
      var chunk = allPlayers.slice(ci, ci + 50);
      var upsertRes = await db.from('players').upsert(chunk, { onConflict: 'api_player_id' });
      if (upsertRes.error) {
        errors.push('Upsert chunk ' + ci + ': ' + upsertRes.error.message);
      } else {
        imported += chunk.length;
      }
    }

    return res.json({
      success:          true,
      players_imported: imported,
      teams_processed:  teams.length,
      season_id:        seasonId,
      errors:           errors
    });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
};

async function smGet(path) {
  var TOKEN = process.env.SPORTMONKS_TOKEN;
  var sep   = path.indexOf('?') > -1 ? '&' : '?';
  var url   = BASE + path + sep + 'api_token=' + TOKEN;
  var r     = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) {
    var b = await r.text().catch(function(){ return ''; });
    throw new Error('Sportmonks ' + r.status + ': ' + b.substring(0, 200));
  }
  var json = await r.json();
  if (json.errors) throw new Error('Sportmonks errors: ' + JSON.stringify(json.errors).substring(0, 200));
  return json;
}
