const { createClient } = require('@supabase/supabase-js');
const { getSeasonId } = require('./season-helper');

const TOKEN  = process.env.SPORTMONKS_TOKEN;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

const BASE = 'https://api.sportmonks.com/v3/football';

module.exports = async (req, res) => {
  const db = createClient(SB_URL, SB_KEY);
  const log = [];

  try {
    const seasonId = await getSeasonId(db, TOKEN);
    log.push("Season ID: " + seasonId);

    const fixturesRes = await fetch(
      `${BASE}/fixtures?filters=fixtureSeasons:${seasonId};fixtureStates:5&per_page=50&api_token=${TOKEN}`
    );

    const fixturesJson = await fixturesRes.json();
    const fixtures = fixturesJson.data || [];

    let statsInserted = 0;

    // ✅ BUILD MATCH STATS
    for (const f of fixtures) {
      const statsRes = await fetch(
        `${BASE}/fixtures/${f.id}?include=events&api_token=${TOKEN}`
      );

      const statsJson = await statsRes.json();
      const events = (statsJson.data && statsJson.data.events) || [];

      let playerMap = {};

      for (const e of events) {
        if (!e.player_id) continue;

        const pid = e.player_id;

        if (!playerMap[pid]) {
          playerMap[pid] = { goals: 0, assists: 0 };
        }

        const type = (e.type || '').toLowerCase();

        if (type.includes('goal')) {
          playerMap[pid].goals += 1;
        }

        if (e.assist_id) {
          playerMap[pid].assists += 1;
        }
      }

      if (Object.keys(playerMap).length === 0) continue;

      for (const pid in playerMap) {
        await db.from('player_match_stats').upsert({
          fixture_id: f.id,
          player_id: parseInt(pid),
          goals: playerMap[pid].goals,
          assists: playerMap[pid].assists,
          minutes: 90,
          updated_at: new Date()
        }, {
          onConflict: 'fixture_id,player_id'
        });

        statsInserted++;
      }
    }

    log.push("Stats inserted: " + statsInserted);

    // ✅ REAL SCORING (NO MORE RANDOM)
    const { data: stats } = await db.from('player_match_stats').select('*');

    let playersMap = {};

    for (const s of stats || []) {
      let points = 2; // appearance

      if (s.goals) points += s.goals * 5;
      if (s.assists) points += s.assists * 3;

      if (!playersMap[s.player_id]) {
        playersMap[s.player_id] = 0;
      }

      playersMap[s.player_id] += points;
    }

    let playersScored = 0;

    for (const pid in playersMap) {
      await db.from('player_season_stats').upsert({
        player_id: parseInt(pid),
        total_points: playersMap[pid]
      }, { onConflict: 'player_id' });

      playersScored++;
    }

    log.push("Players scored: " + playersScored);

    // ✅ FIX SQUAD POINTS
    const { data: squads } = await db.from('squads').select('*');

    let squadsUpdated = 0;

    for (const squad of squads || []) {
      if (!squad.player_id) continue;

      const { data: ps } = await db
        .from('player_season_stats')
        .select('total_points')
        .eq('player_id', squad.player_id)
        .single();

      if (!ps) continue;

      await db.from('squads')
        .update({ points: ps.total_points || 0 })
        .eq('id', squad.id);

      squadsUpdated++;
    }

    log.push("Squads updated: " + squadsUpdated);

    return res.json({
      success: true,
      statsInserted,
      playersScored,
      squadsUpdated,
      log
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
