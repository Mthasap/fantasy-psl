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

    // 🔁 STEP 1: FETCH FINISHED FIXTURES
    const fixturesRes = await fetch(
      `${BASE}/fixtures?filters=fixtureSeasons:${seasonId};fixtureStates:5&per_page=50&api_token=${TOKEN}`
    );

    const fixturesJson = await fixturesRes.json();
    const fixtures = fixturesJson.data || [];

    let statsInserted = 0;

    // 🔁 STEP 2: BUILD PLAYER MATCH STATS
    for (const f of fixtures) {
      const statsRes = await fetch(
        `${BASE}/fixtures/${f.id}?include=events&api_token=${TOKEN}`
      );

      const statsJson = await statsRes.json();
      if (!statsJson || !statsJson.data) continue;

      const events = statsJson.data.events || [];

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

      // 💾 SAVE MATCH STATS
      for (const pid in playerMap) {
        await db.from('player_match_stats').upsert({
          fixture_id: f.id,
          player_id: parseInt(pid),
          goals: playerMap[pid].goals,
          assists: playerMap[pid].assists,
          minutes: 90,
          saves: 0,
          goalsConceded: 0,
          updated_at: new Date()
        }, {
          onConflict: 'fixture_id,player_id'
        });

        statsInserted++;
      }
    }

    log.push("Stats inserted: " + statsInserted);

    // 🔁 STEP 3: CALCULATE POINTS (SIMPLE + RELIABLE)
    const { data: stats } = await db.from('player_match_stats').select('*');

    let playersMap = {};

    for (const s of stats || []) {
      let points = 0;

      // ✅ ALWAYS give appearance points
      points += 2;

      // ✅ Goals
      if (s.goals) {
        points += s.goals * 5;
      }

      // ✅ Assists
      if (s.assists) {
        points += s.assists * 3;
      }

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

    return res.json({
      success: true,
      statsInserted,
      playersScored,
      log
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
