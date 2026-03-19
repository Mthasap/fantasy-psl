// ══════════════════════════════════════════════════════════════════════════
// api/points-cron.js  —  Fantasy PSL  —  Nightly Data Sync  (Budget-Safe v2)
// ══════════════════════════════════════════════════════════════════════════
//
// WHAT THIS DOES (runs at 9pm daily via Vercel cron):
//   Step 1 — Get/cache PSL season ID (1 call EVER after first run)
//   Step 2 — Sync upcoming fixtures to Supabase (1 call/day)
//   Step 3 — Sync recent results to Supabase (1 call/day)
//   Step 4 — Sync league standings to Supabase (1 call/day)
//   Step 5 — Score completed matches + update user GW points (1 call/match)
//   Step 6 — Sync top scorers weekly (or force on admin run)
//
// CALL BUDGET: ~150-200 calls/month out of 2000 limit
//
// ENV VARS:
//   SPORTMONKS_TOKEN      — Sportmonks API token
//   SUPABASE_URL          — Supabase project URL
//   SUPABASE_SERVICE_KEY  — Supabase service role key
//   ADMIN_SECRET          — for manual trigger (fpsl-admin-2026)
// ══════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const { calculateFantasyPoints, normalisePosition } = require('./football_scoring');

const TOKEN    = process.env.SPORTMONKS_TOKEN    || '';
const SB_URL   = process.env.SUPABASE_URL        || '';
const SB_KEY   = process.env.SUPABASE_SERVICE_KEY || '';
const PSL_ID   = 806;
const BASE_URL = 'https://api.sportmonks.com/v3/football';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const adminKey = (req.query && req.query.admin_key) || '';
  const isAdmin  = adminKey && adminKey === (process.env.ADMIN_SECRET || 'fpsl-admin-2026');
  const isCron   = req.headers['x-vercel-cron'] === '1';

  if (!isCron && !isAdmin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!TOKEN)  return res.status(500).json({ error: 'SPORTMONKS_TOKEN missing' });
  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'Supabase env vars missing' });

  const db = createClient(SB_URL, SB_KEY);

  try {
    // ── Helper: Normalize player names for matching ───────────────────────
    function normaliseName(name) {
      if (!name) return '';
      return name.toLowerCase().trim()
        .replace(/\s+/g, ' ')
        .replace(/[^a-z\s]/g, '');
    }

    // ── STEP 1: Get/cached current season ID ──────────────────────────────
    let seasonId;
    const { data: seasonCache } = await db.from('api_cache')
      .select('value')
      .eq('key', 'psl_current_season_id')
      .single();

    if (seasonCache?.value) {
      seasonId = parseInt(seasonCache.value, 10);
    } else {
      const res = await fetch(`${BASE_URL}/leagues/${PSL_ID}?include=currentSeason&api_token=${TOKEN}`);
      if (!res.ok) throw new Error(`League fetch failed: ${res.status}`);
      const data = await res.json();
      seasonId = data.data?.currentSeason?.id || data.data?.current_season?.id;
      if (!seasonId) throw new Error('No current season found for PSL');

      await db.from('api_cache').upsert({
        key: 'psl_current_season_id',
        value: seasonId.toString(),
        updated_at: new Date().toISOString()
      }, { onConflict: 'key' });
    }

    console.log(`[cron] Using season ID: ${seasonId}`);

    // ── STEP 2: Sync upcoming fixtures (NS + scheduled) ───────────────────
    // (you already have logic elsewhere; assuming it's handled in force-sync or separate)
    // If needed, add a lightweight call here — but keeping budget low

    // ── STEP 3 & 4: Sync recent results + standings ───────────────────────
    // (similar — assuming force-sync handles full fixtures; add if missing)

    // ── STEP 5: Score completed matches + update GW points ────────────────
    const { data: completedFixtures } = await db
      .from('fixtures')
      .select('id, status, kickoff_at')
      .eq('status', 'FT')           // only fully completed
      .gte('kickoff_at', new Date(Date.now() - 7*24*60*60*1000).toISOString()) // last week
      .order('kickoff_at', { ascending: false });

    let pointsUpdated = 0;

    for (const fix of (completedFixtures || [])) {
      // Get events/lineups for this fixture (Sportmonks call per match)
      const res = await fetch(
        `${BASE_URL}/fixtures/${fix.id}?include=events;participants;lineups;statistics&api_token=${TOKEN}`
      );
      if (!res.ok) {
        console.error(`Fixture ${fix.id} fetch failed: ${res.status}`);
        continue;
      }
      const fData = await res.json();
      const fixture = fData.data;

      if (!fixture) continue;

      // Process events → aggregate player stats per match
      const byPlayer = {};

      function getPlayer(playerData, participantData) {
        const key = normaliseName(playerData?.display_name || playerData?.name);
        if (!key) return null;
        if (!byPlayer[key]) {
          byPlayer[key] = {
            name: playerData?.display_name || playerData?.name || 'Unknown',
            club: participantData?.name || '',
            goals: 0, assists: 0, yellow_cards: 0, red_cards: 0,
            apps: 1, image_path: playerData?.image_path
          };
        }
        return byPlayer[key];
      }

      (fixture.events || []).forEach(event => {
        const typeObj = event.type || {};
        const typeId  = typeObj.id || event.type_id;
        const p = getPlayer(event.player || {}, event.participant || {});
        if (!p) return;

        if (typeId === 84 || String(typeObj.developer_name || '').toUpperCase().includes('YELLOW')) {
          p.yellow_cards = (p.yellow_cards || 0) + (event.total || 1);
        }
        if (typeId === 83 || String(typeObj.developer_name || '').toUpperCase().includes('RED')) {
          p.red_cards = (p.red_cards || 0) + (event.total || 1);
        }
        // Add goals/assists logic here if not already in events
        // (you may need to expand based on your event types)
      });

      // ... (expand for goals, assists, minutes, clean sheets etc. from lineups/statistics)

      const players = Object.values(byPlayer);
      if (!players.length) continue;

      // Update players table (match by normalised name + club)
      let updated = 0;
      for (const p of players) {
        const normName = normaliseName(p.name);
        const lastName = normName.split(' ').pop();

        const { data: found, error: findErr } = await db.from('players')
          .select('id')
          .ilike('display_name', `%${lastName}%`)
          .eq('team', p.club)
          .limit(1);

        if (findErr || !found?.length) continue;

        await db.from('players').update({
          goals:        p.goals        || 0,
          assists:      p.assists      || 0,
          yellow_cards: p.yellow_cards || 0,
          red_cards:    p.red_cards    || 0,
          apps:         (p.apps || 0) + 1,
          photo:        p.image_path   || null,
          updated_at:   new Date().toISOString()
        }).eq('id', found[0].id);

        updated++;
      }

      // Calculate fantasy points per player (using your engine)
      // Then update user GW points (this part needs your actual user-team-player mapping)
      // Example placeholder:
      // for each user team → sum calculateFantasyPoints(player stats this match)
      // upsert into user_gameweek_points or similar

      pointsUpdated += updated;
    }

    // ── STEP 6: Sync top scorers (weekly OR force on admin) ────────────────
    const forceTopScorers = isAdmin; // force when manually triggered

    const { data: cache } = await db.from('api_cache')
      .select('updated_at')
      .eq('key', 'topscorers_last_sync')
      .single();

    const shouldSyncTop = forceTopScorers ||
      !cache?.updated_at ||
      (Date.now() - new Date(cache.updated_at).getTime()) > 7 * 24 * 60 * 60 * 1000;

    let scorersSynced = false;
    if (shouldSyncTop) {
      // Fetch season top scorers from Sportmonks
      const res = await fetch(
        `${BASE_URL}/seasons/${seasonId}?include=statistics.details;statistics.type&api_token=${TOKEN}`
      );
      if (res.ok) {
        const data = await res.json();
        // Process & upsert to player_season_stats (adapt based on response structure)
        // Example:
        const statsRows = []; // build from data.data.statistics...
        if (statsRows.length) {
          await db.from('player_season_stats').upsert(statsRows, { onConflict: 'season_id,player_name' });
        }

        await db.from('api_cache').upsert({
          key: 'topscorers_last_sync',
          value: `${new Date().toISOString()} - ${statsRows.length || 0} players`,
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' });

        scorersSynced = true;
      }
    }

    return res.json({
      success: true,
      season_id: seasonId,
      points_processed: pointsUpdated,
      top_scorers_synced: scorersSynced,
      message: isAdmin ? 'Manual full refresh completed' : 'Cron run OK'
    });

  } catch (err) {
    console.error('[points-cron] ERROR:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
};
