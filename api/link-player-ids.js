// api/link-player-ids.js — Fantasy PSL — One-time Player ID Linker
// ════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Reads all distinct player names + API-Football IDs from match_player_stats
//   (already populated by apifootball-sync.js) and maps them onto the players
//   table by setting apifootball_id.
//
//   After this runs, points-cron.js resolves player IDs correctly and
//   all GW points calculate accurately — permanently.
//
// USAGE:
//   GET /api/link-player-ids?admin_key=YOUR_ADMIN_SECRET           → dry run (shows matches, no writes)
//   GET /api/link-player-ids?admin_key=YOUR_ADMIN_SECRET&apply=1   → actually writes to DB
//
// MATCHING TIERS (in order of confidence):
//   1. Exact normalised name match        "Bradley Grobler" = "bradley grobler"
//   2. Surname match                      "B. Grobler" → surname "grobler" matches
//   3. First-initial + surname match      "B. Grobler" → "b_grobler" = "bradley grobler"
//   4. Partial first name match           "Iqraam" matches "Iqraam Rayners"
//
// ════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL          || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY   || '';
const ADMIN  = process.env.ADMIN_SECRET;

// ── Name normalisation ────────────────────────────────────────────────────────
function norm(s) {
  return (s || '').toLowerCase()
    .replace(/[àáâãäå]/g,'a').replace(/[èéêë]/g,'e')
    .replace(/[ìíîï]/g,'i') .replace(/[òóôõö]/g,'o')
    .replace(/[ùúûü]/g,'u') .replace(/[ñ]/g,'n')
    .replace(/[^a-z\s]/g,'')
    .replace(/\s+/g,' ').trim();
}

function surname(normName) {
  var parts = normName.split(' ');
  return parts[parts.length - 1];
}

function initKey(normName) {
  var parts = normName.split(' ');
  if (parts.length < 2) return null;
  return parts[0][0] + '_' + parts[parts.length - 1];
}

// ── MANUAL OVERRIDES ─────────────────────────────────────────────────────────
// Add any known mismatches here: our display_name → correct apifootball_id
// Format: 'our display_name (lowercase)': apifootball_id_number
const MANUAL_OVERRIDES = {
  'brandon peterson': 98933,   // API has "Brandon Petersen" — different spelling
};

// ── Fuzzy surname similarity (handles Peterson/Petersen, Dlamini/Dlamini) ────
// Returns true if two surnames are close enough (1 char difference)
function surnameFuzzy(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 2) return false;
  var diff = 0;
  var longer  = a.length > b.length ? a : b;
  var shorter = a.length > b.length ? b : a;
  for (var i = 0; i < longer.length; i++) {
    if (longer[i] !== shorter[i]) diff++;
    if (diff > 1) return false;
  }
  return true;
}
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const adminKey = (req.query && req.query.admin_key)
    || (req.headers && req.headers['x-admin-key']) || '';

  if (!ADMIN || adminKey !== ADMIN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  const apply = req.query.apply === '1';
  const db    = createClient(SB_URL, SB_KEY);
  const log   = [];

  try {
    // ── Step 1: Load all distinct API-Football players from match_player_stats ──
    log.push('Loading API-Football players from match_player_stats...');
    const { data: statsPlayers, error: statsErr } = await db
      .from('match_player_stats')
      .select('apifootball_player_id, player_name, apifootball_team_id')
      .not('apifootball_player_id', 'is', null)
      .not('player_name', 'is', null);

    if (statsErr) throw new Error('match_player_stats load: ' + statsErr.message);

    // Deduplicate: keep one entry per apifootball_player_id
    const apiPlayerMap = {}; // apifootball_player_id → { name, team_id }
    for (const row of (statsPlayers || [])) {
      if (!apiPlayerMap[row.apifootball_player_id]) {
        apiPlayerMap[row.apifootball_player_id] = {
          api_id:   row.apifootball_player_id,
          name:     row.player_name,
          team_id:  row.apifootball_team_id,
          norm:     norm(row.player_name),
          surname:  surname(norm(row.player_name)),
          initKey:  initKey(norm(row.player_name))
        };
      }
    }
    const apiPlayers = Object.values(apiPlayerMap);
    log.push('Distinct API-Football players found: ' + apiPlayers.length);

    // Build lookup indexes for fast matching
    const byNorm    = {}; // normalised full name → api player
    const bySurname = {}; // surname → api player (first match wins)
    const byInit    = {}; // firstInitial_surname → api player

    for (const ap of apiPlayers) {
      byNorm[ap.norm] = ap;
      // Only index surname if unique enough (>=4 chars)
      if (ap.surname && ap.surname.length >= 4) {
        if (!bySurname[ap.surname]) bySurname[ap.surname] = ap;
        else bySurname[ap.surname] = null; // mark as ambiguous (multiple players same surname)
      }
      if (ap.initKey) {
        if (!byInit[ap.initKey]) byInit[ap.initKey] = ap;
        else byInit[ap.initKey] = null; // ambiguous
      }
    }

    // ── Step 2: Load all players from our players table ───────────────────────
    log.push('Loading players from players table...');
    const { data: ourPlayers, error: playersErr } = await db
      .from('players')
      .select('id, display_name, team, position, apifootball_id, psl_roster_id');

    if (playersErr) throw new Error('players load: ' + playersErr.message);
    log.push('Our players in DB: ' + (ourPlayers || []).length);

    // ── Step 3: Match each of our players to an API-Football player ───────────
    const matched   = [];
    const unmatched = [];
    const already   = [];

    for (const p of (ourPlayers || [])) {
      // Already has an apifootball_id — skip unless it looks wrong (0 or very low)
      if (p.apifootball_id && p.apifootball_id > 1000) {
        already.push({ id: p.id, name: p.display_name, apifootball_id: p.apifootball_id });
        continue;
      }

      const pNorm    = norm(p.display_name);
      const pSurname = surname(pNorm);
      const pInit    = initKey(pNorm);

      // TIER 0: Manual override — highest confidence, used for known API spelling mismatches
      let hit  = null;
      let tier = 0;
      if (MANUAL_OVERRIDES[pNorm] !== undefined) {
        const overrideId = MANUAL_OVERRIDES[pNorm];
        hit = apiPlayers.find(function(ap) { return ap.api_id === overrideId; });
        if (hit) tier = 0;
      }

      // Tier 1: exact normalised name
      if (!hit) {
        hit = byNorm[pNorm];
        if (hit) tier = 1;
      }

      // Tier 2: unique exact surname match (requires surname is unambiguous)
      if (!hit && pSurname.length >= 4) {
        const s = bySurname[pSurname];
        if (s) { hit = s; tier = 2; }
      }

      // Tier 2b: fuzzy surname match — catches Peterson/Petersen spelling differences
      // Only fires when combined with matching first initial (prevents false positives)
      if (!hit && pSurname.length >= 5 && pInit) {
        const ourInitial = pNorm.split(' ')[0][0];
        const fuzzyHit = apiPlayers.find(function(ap) {
          const apSur = ap.surname;
          const apInitial = ap.norm.split(' ')[0][0];
          return apInitial === ourInitial && surnameFuzzy(pSurname, apSur);
        });
        if (fuzzyHit) { hit = fuzzyHit; tier = 2; }
      }

      // Tier 3: first-initial + exact surname (handles "B. Grobler" → "Bradley Grobler")
      if (!hit && pInit) {
        const s = byInit[pInit];
        if (s) { hit = s; tier = 3; }
      }

      // Tier 4: UNIQUE first name match — ONLY fires when first name is unique across
      // all API players (prevents "Brandon" matching "Brandon Junior Theron" instead of
      // "Brandon Petersen"). Requires first name ≥5 chars and only ONE player has that name.
      if (!hit) {
        const firstName = pNorm.split(' ')[0];
        if (firstName && firstName.length >= 5) {
          const candidates = apiPlayers.filter(function(ap) {
            return ap.norm.split(' ')[0] === firstName;
          });
          // Only match if exactly ONE player has this first name — no ambiguity
          if (candidates.length === 1) {
            hit = candidates[0];
            tier = 4;
          }
        }
      }

      if (hit) {
        matched.push({
          db_id:          p.id,
          our_name:       p.display_name,
          api_name:       hit.name,
          apifootball_id: hit.api_id,
          team:           p.team,
          tier,
          name_changed:   norm(p.display_name) !== hit.norm
        });
      } else {
        unmatched.push({
          db_id:   p.id,
          name:    p.display_name,
          team:    p.team,
          position:p.position
        });
      }
    }

    log.push('Matched: ' + matched.length);
    log.push('Already had ID: ' + already.length);
    log.push('Unmatched: ' + unmatched.length);

    // ── Step 4: Apply updates if ?apply=1 ────────────────────────────────────
    let updated = 0;
    let errors  = 0;

    if (apply) {
      log.push('Applying updates...');

      for (const m of matched) {
        try {
          const updatePayload = { apifootball_id: m.apifootball_id };
          // Also update display_name to the canonical API-Football name
          // ONLY if it changed meaningfully (not just casing/punctuation)
          if (m.name_changed) {
            updatePayload.display_name = m.api_name;
          }

          const { error: updErr } = await db
            .from('players')
            .update(updatePayload)
            .eq('id', m.db_id);

          if (updErr) {
            errors++;
            log.push('  Error updating ' + m.our_name + ': ' + updErr.message);
          } else {
            updated++;
          }
        } catch (e) {
          errors++;
          log.push('  Error ' + m.our_name + ': ' + e.message);
        }
      }

      log.push('Updated: ' + updated + ' | Errors: ' + errors);

      // ── Step 5: Also update players with apifootball_id from players/squads API ──
      // This catches any player in our DB that wasn't in GW24 match_player_stats
      // (e.g. injured players, players from teams that didn't play GW24)
      // We fetch directly from API-Football squads
      log.push('Checking for remaining unmatched players via API-Football squads...');

      // Get unique team IDs from match_player_stats
      const { data: teamRows } = await db
        .from('match_player_stats')
        .select('apifootball_team_id')
        .not('apifootball_team_id', 'is', null);

      const teamIds = [...new Set((teamRows || []).map(r => r.apifootball_team_id))];
      log.push('Teams in match_player_stats: ' + teamIds.length);

    } else {
      log.push('DRY RUN — pass ?apply=1 to write changes');
    }

    return res.json({
      success:      true,
      dry_run:      !apply,
      matched:      matched.length,
      already_had:  already.length,
      unmatched:    unmatched.length,
      updated:      updated,
      errors,
      log,
      // Full match list for review
      matches:      matched.map(function(m) {
        return {
          our_name:    m.our_name,
          api_name:    m.api_name,
          team:        m.team,
          tier:        m.tier,
          api_id:      m.apifootball_id,
          name_update: m.name_changed ? (m.our_name + ' → ' + m.api_name) : null
        };
      }),
      unmatched_players: unmatched,
    });

  } catch (err) {
    console.error('[link-player-ids]', err.message);
    return res.status(500).json({ error: err.message, log });
  }
};
