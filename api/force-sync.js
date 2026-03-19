// api/force-sync.js

const { createClient } = require('@supabase/supabase-js');

const TOKEN    = process.env.SPORTMONKS_TOKEN;
const SB_URL   = process.env.SUPABASE_URL;
const SB_KEY   = process.env.SUPABASE_SERVICE_KEY;
const ADMIN    = process.env.ADMIN_SECRET || 'fpsl-admin-2026';

const BASE = 'https://api.sportmonks.com/v3/football';
const PSL  = 806;

module.exports = async (req, res) => {

  const key = req.query.admin_key;

  if (key !== ADMIN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!TOKEN) {
    return res.status(500).json({ error: 'SPORTMONKS_TOKEN missing' });
  }

  const db = createClient(SB_URL, SB_KEY);

  try {

    // 🔥 STEP 1: GET CURRENT SEASON
    const seasonRes = await fetch(
      `${BASE}/leagues/${PSL}?include=seasons&api_token=${TOKEN}`
    );

    const seasonData = await seasonRes.json();

    const seasons = seasonData.data?.seasons;

    if (!seasons || seasons.length === 0) {
      return res.status(500).json({
        error: "No seasons found",
        received: seasonData
      });
    }

    // 👉 get latest season
    const seasonId = seasons[0].id;

    // 🔥 STEP 2: GET FIXTURES USING SEASON
    const fixturesRes = await fetch(
      `${BASE}/fixtures?filters=season_id:${seasonId}&include=participants;scores&api_token=${TOKEN}`
    );

    const fixturesData = await fixturesRes.json();

    if (!fixturesData || !Array.isArray(fixturesData.data)) {
      return res.status(500).json({
        error: "Invalid fixtures response",
        received: fixturesData
      });
    }

    let updated = 0;

    for (const f of fixturesData.data) {

      const home = f.participants?.find(p => p.meta?.location === "home");
      const away = f.participants?.find(p => p.meta?.location === "away");

      const scoreObj = f.scores?.find(s => s.description === "CURRENT");

      const homeScore = scoreObj?.score?.goals_home ?? null;
      const awayScore = scoreObj?.score?.goals_away ?? null;

      await db.from("fixtures").upsert({
        id: f.id,
        home_team: home?.name || "TBD",
        away_team: away?.name || "TBD",
        home_score: homeScore,
        away_score: awayScore,
        status: f.state?.name || "NS",
        kickoff_at: f.starting_at
      });

      updated++;
    }

    return res.json({
      success: true,
      season_id: seasonId,
      fixtures_updated: updated
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
};
