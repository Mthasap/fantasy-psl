const { createClient } = require('@supabase/supabase-js');

const TOKEN = process.env.SPORTMONKS_TOKEN;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN = process.env.ADMIN_SECRET || 'fpsl-admin-2026';

const BASE = 'https://api.sportmonks.com/v3/football';
const PSL = 806;

module.exports = async (req, res) => {
  if (req.query.admin_key !== ADMIN) return res.status(401).json({ error: 'Unauthorized' });

  const db = createClient(SB_URL, SB_KEY);

  try {
    const leagueRes = await fetch(`${BASE}/leagues/${PSL}?include=seasons&api_token=${TOKEN}`);
    const leagueData = await leagueRes.json();
    const seasonId = leagueData.data?.seasons?.[0]?.id;
    if (!seasonId) return res.status(500).json({ error: "No season found" });

    const seasonRes = await fetch(
      `${BASE}/seasons/${seasonId}?include=fixtures.participants;fixtures.scores;fixtures.state&api_token=${TOKEN}`
    );
    const seasonData = await seasonRes.json();
    const fixtures = seasonData.data?.fixtures || [];

    let updated = 0;

    for (const f of fixtures) {
      const home = f.participants?.find(p => p.meta?.location === "home");
      const away = f.participants?.find(p => p.meta?.location === "away");

      // Improved score extraction
      let homeScore = null, awayScore = null;
      (f.scores || []).forEach(s => {
        const desc = (s.description || '').toUpperCase();
        if (desc === 'FT' || desc === 'FULLTIME' || desc === 'CURRENT') {
          if (s.score?.participant === 'home') homeScore = s.score.goals;
          if (s.score?.participant === 'away') awayScore = s.score.goals;
        }
      });

      await db.from("fixtures").upsert({
        id: f.id,
        home_team: home?.name || "TBD",
        away_team: away?.name || "TBD",
        home_score: homeScore,
        away_score: awayScore,
        status: f.state?.name || f.state?.short_name || "NS",
        kickoff_at: f.starting_at
      });
      updated++;
    }

    return res.json({ success: true, season_id: seasonId, fixtures_updated: updated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
