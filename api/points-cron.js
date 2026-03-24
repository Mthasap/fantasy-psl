const { createClient } = require('@supabase/supabase-js');
const { calculateFantasyPoints } = require('./football_scoring');
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

    // ✅ GET FINISHED FIXTURES
    const fixturesRes = await fetch(
      `${BASE}/fixtures?filters=fixtureSeasons:${seasonId};fixtureStates:5&per_page=50&api_token=${TOKEN}`
    );
    const fixturesJson = await fixturesRes.json();
    const fixtures = fixturesJson.data || [];

    let statsInserted = 0;

    // ✅ LOOP FIXTURES
    for (const f of fixtures) {
      const statsRes = await fetch(
        `${BASE}/fixtures/${f.id}?include=participants;events;statistics&api_token=${TOKEN}`
      );

      const statsJson = await statsRes.json();

      if (!statsJson || !statsJson.data) continue;

      const events = statsJson.data.events || [];

      // ✅ EXTRACT FROM EVENTS (goals, assists)
      for (const e of events) {
        if (!e.player_id) continue;

        const row = {
          fixture_id: f.id,
          player_id: e.player_id,
          goals: e.type === 'goal' ? 1 : 0,
          assists: e.assist_id ? 1 : 0,
          minutes: 90,
          saves: 0,
          goalsConceded: 0,
          updated_at: new Date()
        };

        await db.from('player_match_stats').upsert(row, {
          onConflict: 'fixture_id,player_id'
        });

        statsInserted++;
      }
    }

    log.push("Stats inserted: " + statsInserted);

    // ✅ CALCULATE POINTS
    const { data: stats } = await db.from('player_match_stats').select('*');

    let playersScored = 0;

    for (const s of stats || []) {
      const result = calculateFantasyPoints({
        minutes: s.minutes,
        goals: s.goals,
        assists: s.assists,
        saves: s.saves,
        goalsConceded: s.goalsConceded,
        pos: 'MID'
      });

      await db.from('player_season_stats').upsert({
        player_id: s.player_id,
        total_points: result.total
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
