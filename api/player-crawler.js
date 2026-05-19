// api/player-crawler.js — Fantasy PSL — Active Player Crawler
// ═══════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Fetches ALL active PSL players from API-Football Pro (/players/squads)
//   for every PSL team, then upserts them into the players table.
//   Designed to be run once per week or before each season to keep the
//   player roster complete and accurate.
//
// USAGE:
//   GET /api/player-crawler?admin_key=XXX            → dry run (preview only)
//   GET /api/player-crawler?admin_key=XXX&apply=1    → apply to DB
//   GET /api/player-crawler?admin_key=XXX&apply=1&team_id=496 → single team
//
// WHAT IT DOES:
//   1. Fetches all PSL teams from API-Football
//   2. For each team, calls /players/squads?team=ID (Pro tier endpoint)
//   3. For each player returned:
//      - If they already exist (by apifootball_id) → update name/position/photo/team
//      - If they are NEW → insert with a generated psl_roster_id
//   4. Marks players NOT in the API response as is_active=false (retired/left)
//   5. Returns a full report of added/updated/deactivated players
//
// ENV VARS REQUIRED:
//   APIFOOTBALL_KEY       — your API-Football Pro key
//   SUPABASE_URL          — Supabase project URL
//   SUPABASE_SERVICE_KEY  — Supabase service role key
//   ADMIN_SECRET          — admin authentication key
//
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const { createClient } = require('@supabase/supabase-js');

const API_KEY    = process.env.APIFOOTBALL_KEY      || '';
const API_BASE   = 'https://v3.football.api-sports.io';
const PSL_LEAGUE = 288;
const PSL_SEASON = parseInt(process.env.APIFOOTBALL_SEASON || '2025', 10);
const SB_URL     = process.env.SUPABASE_URL          || '';
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY  || '';
const ADMIN      = process.env.ADMIN_SECRET          || '';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function apiFetch(path) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'x-rapidapi-key': API_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' },
  });
  if (!res.ok) throw new Error(`API-Football ${res.status} on ${path}`);
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length) {
    const errStr = JSON.stringify(data.errors);
    if (!errStr.includes('{}')) throw new Error(`API-Football error: ${errStr}`);
  }
  return data;
}

function normPos(raw) {
  if (!raw) return 'MID';
  const r = raw.toUpperCase();
  if (r.includes('GOAL') || r === 'G' || r === 'GK') return 'GK';
  if (r.includes('DEFEND') || r === 'D' || r === 'DEF') return 'DEF';
  if (r.includes('FORWARD') || r.includes('ATTACK') || r === 'F' || r === 'FWD') return 'FWD';
  return 'MID';
}

function normName(s) {
  return (s || '').toLowerCase()
    .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u').replace(/[ñ]/g, 'n').replace(/[ç]/g, 'c')
    .replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

function defaultPrice(pos) {
  return pos === 'GK' ? 5.0 : pos === 'DEF' ? 5.5 : pos === 'MID' ? 6.5 : 7.0;
}

function makeSlug(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// PSL team name normalisation map — API-Football → our canonical name
const TEAM_NAME_MAP = {
  'Orlando Pirates':    'Orlando Pirates',
  'Mamelodi Sundowns':  'Mamelodi Sundowns',
  'Golden Arrows':      'Golden Arrows',
  'Sekhukhune United':  'Sekhukhune United',
  'AmaZulu':            'AmaZulu FC',
  'AmaZulu FC':         'AmaZulu FC',
  'Kaizer Chiefs':      'Kaizer Chiefs',
  'Stellenbosch':       'Stellenbosch FC',
  'Stellenbosch FC':    'Stellenbosch FC',
  'TS Galaxy':          'TS Galaxy',
  'Richards Bay':       'Richards Bay',
  'Polokwane City':     'Polokwane City',
  'Chippa United':      'Chippa United',
  'Marumo Gallants':    'Marumo Gallants FC',
  'Magesi':             'Magesi FC',
  'Magesi FC':          'Magesi FC',
  'Siwelele':           'Siwelele FC',
  'Siwelele FC':        'Siwelele FC',
  'Cape Town City':     'Cape Town City',
  'Durban City':        'Durban City',
  'Orbit College':      'Orbit College FC',
  'Orbit College FC':   'Orbit College FC',
};

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // Auth
  const adminKey = (req.query && req.query.admin_key)
    || (req.headers && req.headers['x-admin-key']) || '';
  if (!ADMIN || adminKey !== ADMIN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!API_KEY)  return res.status(500).json({ error: 'APIFOOTBALL_KEY not set' });
  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'Supabase env vars not set' });

  const apply        = req.query.apply    === '1';
  const teamIdFilter = req.query.team_id  ? parseInt(req.query.team_id, 10) : null;
  const db           = createClient(SB_URL, SB_KEY);
  const log          = [];

  try {
    // ── Step 1: Load existing players from DB ────────────────────────────────
    log.push('Step 1: Loading existing players from DB...');
    const { data: existingPlayers, error: epErr } = await db
      .from('players')
      .select('id, display_name, team, position, apifootball_id, psl_roster_id, photo, is_active');
    if (epErr) throw new Error('DB load failed: ' + epErr.message);

    const byApiId    = {};  // apifootball_id → player row
    const byNormName = {};  // normalised name → player row
    const allRosterIds = new Set();

    for (const p of (existingPlayers || [])) {
      if (p.apifootball_id) byApiId[p.apifootball_id] = p;
      byNormName[normName(p.display_name)] = p;
      if (p.psl_roster_id) allRosterIds.add(p.psl_roster_id);
    }

    // Next available roster ID — start above 20000 to avoid collisions with manual IDs
    let nextRosterId = Math.max(20000, ...(Array.from(allRosterIds))) + 1;

    log.push(`  Existing players in DB: ${(existingPlayers || []).length}`);

    // ── Step 2: Fetch all PSL teams ──────────────────────────────────────────
    log.push('Step 2: Fetching PSL teams from API-Football...');
    const teamsData = await apiFetch(`/teams?league=${PSL_LEAGUE}&season=${PSL_SEASON}`);
    const teams     = teamsData.response || [];
    log.push(`  Teams found: ${teams.length} (season ${PSL_SEASON})`);

    if (!teams.length) throw new Error(`No PSL teams returned for season ${PSL_SEASON}. Check APIFOOTBALL_SEASON env var.`);

    // ── Step 3: Fetch squad for each team ────────────────────────────────────
    log.push('Step 3: Fetching squads for each team...');

    const allApiPlayers = [];
    const fetchErrors   = [];

    for (const entry of teams) {
      const team     = entry.team || {};
      const teamId   = team.id;
      const teamName = TEAM_NAME_MAP[team.name] || team.name || 'Unknown';

      if (teamIdFilter && teamId !== teamIdFilter) continue;

      try {
        const squadData = await apiFetch(`/players/squads?team=${teamId}`);
        const squad     = (squadData.response || [])[0];
        const players   = squad ? (squad.players || []) : [];

        log.push(`  ${teamName}: ${players.length} players`);

        for (const p of players) {
          allApiPlayers.push({
            apifootball_id: p.id,
            display_name:   p.name || 'Unknown',
            team:           teamName,
            api_team_id:    teamId,
            position:       normPos(p.position || ''),
            age:            p.age  || null,
            photo:          p.photo || null,
            norm_name:      normName(p.name || ''),
          });
        }

        // Rate-limit friendly delay
        await new Promise(r => setTimeout(r, 150));

      } catch (e) {
        fetchErrors.push(`${teamName}: ${e.message}`);
        log.push(`  ⚠️  ${teamName}: ${e.message}`);
      }
    }

    log.push(`Total players fetched from API: ${allApiPlayers.length}`);

    // Deduplicate by apifootball_id (player transferred mid-season)
    const seenIds      = new Set();
    const dedupPlayers = [];
    for (const p of allApiPlayers) {
      if (seenIds.has(p.apifootball_id)) continue;
      seenIds.add(p.apifootball_id);
      dedupPlayers.push(p);
    }
    log.push(`After dedup: ${dedupPlayers.length} unique players`);

    // ── Step 4: Classify each API player ─────────────────────────────────────
    const toInsert = [];
    const toUpdate = [];

    for (const ap of dedupPlayers) {
      const existing = byApiId[ap.apifootball_id] || byNormName[ap.norm_name];

      if (existing) {
        // Player already in DB — update photo, position, team if changed
        toUpdate.push({
          id:           existing.id,
          display_name: ap.display_name,
          team:         ap.team,
          position:     ap.position,
          photo:        ap.photo || existing.photo || null,
          age:          ap.age   || existing.age   || null,
          apifootball_id: ap.apifootball_id,  // ensure API id is linked
          is_active:    true,
          updated_at:   new Date().toISOString(),
        });
      } else {
        // Brand new player — insert
        toInsert.push({
          display_name:   ap.display_name,
          team:           ap.team,
          position:       ap.position,
          apifootball_id: ap.apifootball_id,
          photo:          ap.photo || null,
          age:            ap.age   || null,
          price:          defaultPrice(ap.position),
          psl_roster_id:  nextRosterId++,
          slug:           makeSlug(ap.display_name),
          is_available:   true,
          is_active:      true,
          goals:          0,
          assists:        0,
          clean_sheets:   0,
          yellow_cards:   0,
          red_cards:      0,
          saves:          0,
          apps:           0,
          total_points:   0,
          created_at:     new Date().toISOString(),
          updated_at:     new Date().toISOString(),
        });
      }
    }

    // Players in DB but NOT returned by API → mark inactive
    const activeApiIds = new Set(dedupPlayers.map(p => p.apifootball_id));
    const toDeactivate = (existingPlayers || []).filter(p =>
      p.apifootball_id && !activeApiIds.has(p.apifootball_id) && p.is_active !== false
    );

    log.push(`Summary: ${toInsert.length} new | ${toUpdate.length} updates | ${toDeactivate.length} to deactivate`);

    // ── Step 5: Apply changes ─────────────────────────────────────────────────
    let inserted    = 0;
    let updated     = 0;
    let deactivated = 0;
    let errors      = 0;

    if (apply) {
      log.push('Applying changes to DB...');

      // Insert new players in batches of 25
      for (let i = 0; i < toInsert.length; i += 25) {
        const batch = toInsert.slice(i, i + 25);
        const { error } = await db.from('players').insert(batch);
        if (error) {
          // Handle slug duplicates gracefully
          if (error.message.includes('duplicate') || error.message.includes('unique')) {
            // Try one by one
            for (const row of batch) {
              row.slug = row.slug + '-' + row.apifootball_id;
              const { error: e2 } = await db.from('players').insert(row);
              if (!e2) inserted++; else { errors++; log.push(`  Insert error ${row.display_name}: ${e2.message}`); }
            }
          } else {
            errors++;
            log.push(`  Insert batch error: ${error.message}`);
          }
        } else {
          inserted += batch.length;
        }
      }

      // Update existing players in batches of 25
      for (let i = 0; i < toUpdate.length; i += 25) {
        const batch = toUpdate.slice(i, i + 25);
        for (const row of batch) {
          const { id, ...fields } = row;
          const { error } = await db.from('players').update(fields).eq('id', id);
          if (!error) updated++; else { errors++; log.push(`  Update error id ${id}: ${error.message}`); }
        }
      }

      // Deactivate players no longer in PSL squad lists
      for (let i = 0; i < toDeactivate.length; i += 50) {
        const batch = toDeactivate.slice(i, i + 50).map(p => p.id);
        const { error } = await db
          .from('players')
          .update({ is_active: false, is_available: false, updated_at: new Date().toISOString() })
          .in('id', batch);
        if (!error) deactivated += batch.length;
      }

      log.push(`✅ Done: ${inserted} inserted | ${updated} updated | ${deactivated} deactivated | ${errors} errors`);
    } else {
      log.push('DRY RUN — pass ?apply=1 to write changes');
    }

    return res.json({
      success:      true,
      dry_run:      !apply,
      season:       PSL_SEASON,
      api_total:    dedupPlayers.length,
      new_count:    toInsert.length,
      update_count: toUpdate.length,
      deactivate_count: toDeactivate.length,
      inserted,
      updated,
      deactivated,
      errors,
      fetch_errors: fetchErrors,
      log,
      // Preview: first 20 new players for review
      new_players_preview: toInsert.slice(0, 20).map(p => ({
        name: p.display_name, team: p.team, pos: p.position, api_id: p.apifootball_id
      })),
      updated_players_preview: toUpdate.slice(0, 10).map(p => ({
        id: p.id, name: p.display_name, team: p.team
      })),
      deactivated_preview: toDeactivate.slice(0, 10).map(p => ({
        id: p.id, name: p.display_name, team: p.team
      })),
    });

  } catch (err) {
    console.error('[player-crawler]', err.message);
    return res.status(500).json({ error: err.message, log });
  }
};
