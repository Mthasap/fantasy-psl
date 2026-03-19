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

  const db = createClient(SB_URL, SB_KEY);

  try {

    // 1. Get fixtures (latest)
    const fixturesRes = await fetch(
      `${BASE}/fixtures/leagues/${PSL}?include=participants;scores&api_token=${TOKEN}`
    );

    const fixturesData = await fixturesRes.json();

    let updated = 0;

    for (const f of fixturesData.data) {

      const home = f.participants.find(p => p.meta.location === "home");
      const away = f.participants.find(p => p.meta.location === "away");

      const homeScore = f.scores?.find(s => s.description === "CURRENT")?.score?.goals_home ?? null;
      const awayScore = f.scores?.find(s => s.description === "CURRENT")?.score?.goals_away ?? null;

      await db.from("fixtures").upsert({
        id: f.id,
        home_team: home?.name,
        away_team: away?.name,
        home_score: homeScore,
        away_score: awayScore,
        status: f.state.name,
        kickoff_at: f.starting_at
      });

      updated++;
    }

    return res.json({
      success: true,
      fixtures_updated: updated
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
