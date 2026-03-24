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

    // ✅ STEP 1: GET FINISHED FIXTURES
    const fixturesRes = await fetch(
      `${BASE}/fixtures?filters=fixtureSeasons:${seasonId};fixtureStates:5&include=participants;scores&per_page=50&api_token=${TOKEN}`
    );
    const fixturesData = await fixturesRes.json();

    let statsInserted = 0;

    // ✅ STEP 2: LOOP FIXTURES → FETCH PLAYER STATS
    for (const f of fixturesData.data || []) {
      const statsRes = await fetch(
        `${BASE}/fixtures/${f.id}?include=players.statistics&api_token=${TOKEN}`
      );
      const statsJson = await statsRes.json();

      const players = statsJson.data.players || [];

      for (const p of players) {
        const s = p.statistics || {};

        const row = {
          fixture_id: f.id,
          player_id: p.id,
          minutes: s.minutes || 0,
          goals: s.goals || 0,
          assists: s.assists || 0,
          saves: s.saves || 0,
          goalsConceded: s.goals_conceded || 0,
          updated_at: new Date()
        };

        await db.from('player_match_stats').upsert(row, {
          onConflict: 'fixture_id,player_id'
        });

        statsInserted++;
      }
    }

    log.push("Stats inserted: " + statsInserted);

    // ✅ STEP 3: CALCULATE POINTS
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
