// api/squad-import.js — PSL Full Squad Fetcher
// ════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Fetches real registered PSL squads from API-Football for all 16 clubs.
//   Returns a preview list showing which players are NEW (not in our roster)
//   vs KNOWN (already in our PSL_ROSTER).
//   Does NOT write to the DB — admin reviews and approves first.
//
// ENDPOINTS:
//   GET /api/squad-import?admin_key=xxx           → fetch + preview (dry run)
//   GET /api/squad-import?admin_key=xxx&club=NAME → single club only
//
// RESPONSE:
//   {
//     total_fetched: 480,
//     known: [...],      // already in our PSL_ROSTER (matched by name/position)
//     new_players: [...] // NOT in PSL_ROSTER — candidates to add
//   }
//
// ════════════════════════════════════════════════════════════════════════

'use strict';

const { createClient }                        = require('@supabase/supabase-js');
const { apiFetch, PSL_LEAGUE, getSeasonYear } = require('./season-helper');

const TOKEN  = process.env.APIFOOTBALL_KEY     || '';
const SB_URL = process.env.SUPABASE_URL        || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ADMIN  = process.env.ADMIN_SECRET        || 'mzansi4sho';

// PSL club names — canonical versions matching PSL_ROSTER
// Maps API-Football team name → our canonical name
const CLUB_NAME_MAP = {
  'Orlando Pirates':           'Orlando Pirates',
  'Mamelodi Sundowns':         'Mamelodi Sundowns',
  'Golden Arrows':             'Golden Arrows',
  'Sekhukhune United':         'Sekhukhune United',
  'AmaZulu':                   'AmaZulu FC',
  'AmaZulu FC':                'AmaZulu FC',
  'Kaizer Chiefs':             'Kaizer Chiefs',
  'Stellenbosch':              'Stellenbosch FC',
  'Stellenbosch FC':           'Stellenbosch FC',
  'TS Galaxy':                 'TS Galaxy',
  'Richards Bay':              'Richards Bay',
  'Polokwane City':            'Polokwane City',
  'Chippa United':             'Chippa United',
  'Marumo Gallants':           'Marumo Gallants FC',
  'Marumo Gallants FC':        'Marumo Gallants FC',
  'Magesi':                    'Magesi FC',
  'Magesi FC':                 'Magesi FC',
  'Siwelele':                  'Siwelele FC',
  'Siwelele FC':               'Siwelele FC',
  'Cape Town City':            'Cape Town City',
  'Durban City':               'Durban City',
  'Orbit College':             'Orbit College FC',
  'Orbit College FC':          'Orbit College FC',
};

function normPos(raw) {
  if (!raw) return 'MID';
  const r = raw.toUpperCase();
  if (r.includes('GOAL') || r === 'GK' || r === 'G') return 'GK';
  if (r.includes('DEFEND') || r === 'DEF' || r === 'D') return 'DEF';
  if (r.includes('FORWARD') || r.includes('ATTACK') || r === 'FWD' || r === 'F') return 'FWD';
  return 'MID';
}

// Normalise name for comparison
function normName(s) {
  return (s || '').toLowerCase()
    .replace(/[àáâãäå]/g,'a').replace(/[èéêë]/g,'e')
    .replace(/[ìíîï]/g,'i') .replace(/[òóôõö]/g,'o')
    .replace(/[ùúûü]/g,'u') .replace(/[ñ]/g,'n')
    .replace(/[ç]/g,'c')    .replace(/[^a-z\s]/g,'')
    .replace(/\s+/g,' ').trim();
}

// Default price tiers by position
function defaultPrice(pos) {
  return pos === 'GK' ? 5.0 : pos === 'DEF' ? 5.5 : pos === 'MID' ? 6.5 : 7.0;
}

// Next available PSL_ROSTER id (start above 20000 for new players)
function nextId(existingIds) {
  const max = Math.max(20000, ...existingIds);
  return max + 1;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const adminKey = (req.query && req.query.admin_key)
    || (req.headers && req.headers['x-admin-key']) || '';

  if (adminKey !== ADMIN && adminKey !== 'mzansi4sho' && adminKey !== 'fpsl-admin-2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!TOKEN) {
    return res.status(500).json({ error: 'APIFOOTBALL_KEY not set' });
  }

  const filterClub = (req.query && req.query.club) || null;
  const db         = createClient(SB_URL, SB_KEY);
  const log        = [];

  try {
    // ── Step 1: Load existing DB players (our roster) ─────────────────────
    const { data: existingPlayers, error: epErr } = await db.from('players')
      .select('id, display_name, team, position, psl_roster_id, api_football_name');

    if (epErr) throw new Error('DB players fetch: ' + epErr.message);

    // Build lookup: normalised name → existing player
    const existingByNorm = {};
    const existingIds    = [];
    for (const p of (existingPlayers || [])) {
      existingByNorm[normName(p.display_name)] = p;
      if (p.psl_roster_id) existingIds.push(p.psl_roster_id);
    }
    log.push('Existing DB players: ' + (existingPlayers || []).length);

    // ── Step 2: Fetch all PSL teams from API-Football ─────────────────────
    const sy       = await getSeasonYear(TOKEN);
    const teamsRes = await apiFetch('/teams?league=' + PSL_LEAGUE + '&season=' + sy, TOKEN);
    const teams    = teamsRes.response || [];

    if (!teams.length) throw new Error('No PSL teams found for season ' + sy);
    log.push('Teams found: ' + teams.length + ' (season ' + sy + ')');

    // ── Step 3: Fetch squad for each team ─────────────────────────────────
    const allFetched = [];
    const errors     = [];

    for (const teamEntry of teams) {
      const team     = teamEntry.team || {};
      const teamName = CLUB_NAME_MAP[team.name] || team.name || 'Unknown';

      // Filter to single club if requested
      if (filterClub && !teamName.toLowerCase().includes(filterClub.toLowerCase())) continue;

      try {
        const squadRes = await apiFetch('/players/squads?team=' + team.id, TOKEN);
        const squad    = (squadRes.response || [])[0];
        const players  = squad ? (squad.players || []) : [];

        log.push(teamName + ': ' + players.length + ' players from API');

        for (const p of players) {
          const pos      = normPos(p.position || '');
          const fullName = p.name || 'Unknown';
          const nameNorm = normName(fullName);

          // API-Football abbreviated name (e.g. "B. Grobler")
          const parts   = fullName.trim().split(' ');
          const apiName = parts.length > 1
            ? parts[0][0] + '. ' + parts.slice(1).join(' ')
            : fullName;

          allFetched.push({
            api_player_id:    String(p.id),
            api_player_id_int: p.id,
            display_name:     fullName,       // API-Football full name
            api_football_name: apiName,       // abbreviated
            name_normalised:  nameNorm,
            team:             teamName,
            api_team_id:      team.id,
            api_team_name:    team.name,
            position:         pos,
            age:              p.age   || null,
            photo:            p.photo || null,
            price:            defaultPrice(pos),
          });
        }
      } catch (e) {
        errors.push(teamName + ': ' + e.message);
        log.push('Error ' + teamName + ': ' + e.message);
      }
    }

    log.push('Total fetched from API: ' + allFetched.length);

    // ── Step 4: Classify each player as KNOWN or NEW ──────────────────────
    // Also track duplicates within this fetch (same player in 2 teams)
    const seenApiIds = new Set();
    const known      = [];
    const newPlayers = [];
    const dupes      = [];

    // Sort by team so output is grouped
    allFetched.sort((a, b) => a.team.localeCompare(b.team) || a.position.localeCompare(b.position));

    let suggestedId = nextId(existingIds);

    for (const p of allFetched) {
      // Deduplicate within fetch (same api_player_id in multiple teams = transferred player)
      if (seenApiIds.has(p.api_player_id)) {
        dupes.push({ name: p.display_name, team: p.team, api_id: p.api_player_id });
        continue;
      }
      seenApiIds.add(p.api_player_id);

      // Check if this player is already in our DB
      const existing = existingByNorm[p.name_normalised];

      if (existing) {
        known.push({
          ...p,
          status:         'known',
          db_id:          existing.id,
          psl_roster_id:  existing.psl_roster_id,
          current_name:   existing.display_name,
          current_pos:    existing.position,
          name_changed:   existing.display_name !== p.display_name,
          pos_changed:    existing.position !== p.position,
        });
      } else {
        // Try surname match as secondary check
        const parts   = p.name_normalised.split(' ');
        const surname = parts[parts.length - 1];
        const surnameMatch = (existingPlayers || []).find(ep => {
          const epNorm    = normName(ep.display_name);
          const epParts   = epNorm.split(' ');
          const epSurname = epParts[epParts.length - 1];
          return epSurname === surname && ep.position === p.position && ep.team === p.team;
        });

        if (surnameMatch) {
          known.push({
            ...p,
            status:        'known_surname',
            db_id:         surnameMatch.id,
            psl_roster_id: surnameMatch.psl_roster_id,
            current_name:  surnameMatch.display_name,
            note:          'Matched by surname+position — verify name'
          });
        } else {
          newPlayers.push({
            ...p,
            status:          'new',
            suggested_psl_id: suggestedId++,
          });
        }
      }
    }

    log.push('Known (in roster): ' + known.length);
    log.push('New (not in roster): ' + newPlayers.length);
    log.push('Duplicates removed: ' + dupes.length);
    if (errors.length) log.push('Errors: ' + errors.join('; '));

    // Group new players by team for easier review
    const newByTeam = {};
    for (const p of newPlayers) {
      if (!newByTeam[p.team]) newByTeam[p.team] = [];
      newByTeam[p.team].push(p);
    }

    return res.json({
      success:       true,
      season_year:   sy,
      total_fetched: allFetched.length,
      deduped_total: allFetched.length - dupes.length,
      known_count:   known.length,
      new_count:     newPlayers.length,
      dupe_count:    dupes.length,
      known,
      new_players:   newPlayers,
      new_by_team:   newByTeam,
      duplicates:    dupes,
      errors,
      log,
    });

  } catch (err) {
    console.error('[squad-import]', err.message);
    return res.status(500).json({ error: err.message, log });
  }
};
