// api/force-sync.js — FIXED: full season sync with pagination
const { createClient } = require('@supabase/supabase-js');

const TOKEN = process.env.SPORTMONKS_TOKEN;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN = process.env.ADMIN_SECRET || 'fpsl-admin-2026';

const BASE = 'https://api.sportmonks.com/v3/football';
const PSL = 806;

module.exports = async (req, res) => {
  if (req.query.admin_key !== ADMIN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = createClient(SB_URL, SB_KEY);

  try {
    // Get current season
    const leagueRes = await fetch(`${BASE}/leagues/${PSL}?include=currentSeason&api_token=${TOKEN}`);
    const leagueData = await leagueRes.json();
    let seasonId = leagueData.data?.currentSeason?.id || leagueData.data?.current_season?.id;

    if (!seasonId) {
      const seasonsRes = await fetch(`${BASE}/seasons?filters=seasonLeagues:${PSL}&api_token=${TOKEN}`);
      const seasonsData = await seasonsRes.json();
      seasonId = seasonsData.data?.[0]?.id;
    }
    if (!seasonId) return res.status(500).json({ error: "No season found" });

    let updated = 0;
    let page = 1;
    const perPage = 100;

    while (true) {
      const fixturesRes = await fetch(
        `${BASE}/fixtures?filters=fixtureSeasons:${seasonId}&include=participants;scores;state&per_page=${perPage}&page=${page}&api_token=${TOKEN}`
      );
      const data = await fixturesRes.json();
      const fixtures = data.data || [];

      if (!fixtures.length) break;

      for (const f of fixtures) {
        const home = f.participants?.find(p => p.meta?.location === "home");
        const away = f.participants?.find(p => p.meta?.location === "away");

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
          status: (f.state?.short_name || f.state?.name || "NS").toUpperCase(),
          kickoff_at: f.starting_at
        });

        updated++;
      }

      if (fixtures.length < perPage) break;
      page++;
    }

    return res.json({ 
      success: true, 
      season_id: seasonId, 
      fixtures_updated: updated,
      message: "All fixtures synced — including yesterday's matches"
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
