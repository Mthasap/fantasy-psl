// api/force-sync.js — Enhanced: better includes, fallback status, full pagination
const { createClient } = require('@supabase/supabase-js');

const TOKEN = process.env.SPORTMONKS_TOKEN;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN = process.env.ADMIN_SECRET || 'fpsl-admin-2026';

const BASE = 'https://api.sportmonks.com/v3/football';
const PSL = 806;

module.exports = async (req, res) => {
  if (req.query.admin_key !== ADMIN) return res.status(401).json({ error: 'Unauthorized' });

  if (!TOKEN) return res.status(500).json({ error: 'SPORTMONKS_TOKEN missing' });

  const db = createClient(SB_URL, SB_KEY);

  try {
    // Get current season reliably
    const leagueRes = await fetch(`${BASE}/leagues/${PSL}?include=currentSeason&api_token=${TOKEN}`);
    const leagueData = await leagueRes.json();
    let seasonId = leagueData.data?.currentSeason?.id;
    if (!seasonId) {
      const seasonsRes = await fetch(`${BASE}/seasons?filters=leagueId:${PSL}&api_token=${TOKEN}`);
      const seasons = (await seasonsRes.json()).data || [];
      seasonId = seasons.sort((a,b) => new Date(b.starting_at) - new Date(a.starting_at))[0]?.id;
    }
    if (!seasonId) throw new Error('No season ID found');

    let updated = 0;
    let page = 1;
    const perPage = 50; // smaller to avoid rate limits

    while (true) {
      const url = `${BASE}/fixtures?filters=seasonId:${seasonId}&include=participants;scores;state;venue&per_page=${perPage}&page=${page}&api_token=${TOKEN}`;
      const resFix = await fetch(url);
      if (!resFix.ok) throw new Error(`Fixtures page ${page} failed: ${resFix.status}`);

      const data = await resFix.json();
      const fixtures = data.data || [];

      if (!fixtures.length) break;

      for (const f of fixtures) {
        const home = f.participants?.find(p => p.meta?.location === 'home')?.name || 'TBD';
        const away = f.participants?.find(p => p.meta?.location === 'away')?.name || 'TBD';

        let homeScore = null;
        let awayScore = null;
        (f.scores || []).forEach(s => {
          const desc = (s.description || '').toUpperCase();
          if (['CURRENT', 'FT', 'FULLTIME', '2ND_HALF'].includes(desc)) {
            if (s.score?.participant === 'home') homeScore = s.score.goals;
            if (s.score?.participant === 'away') awayScore = s.score.goals;
          }
        });

        // Fallback status logic – more robust
        let status = (f.state?.short_name || f.state?.name || 'NS').toUpperCase();
        if (homeScore !== null && awayScore !== null) status = 'FT'; // scores present → assume finished
        else if (new Date(f.starting_at) < new Date()) status = 'LIVE'; // past kickoff but no score → live/in play

        await db.from('fixtures').upsert({
          id: f.id,
          home_team: home,
          away_team: away,
          home_score: homeScore,
          away_score: awayScore,
          status: status,
          kickoff_at: f.starting_at
        }, { onConflict: 'id' });

        updated++;
      }

      if (data.meta?.pagination?.has_next_page !== true) break;
      page++;
    }

    return res.json({
      success: true,
      season_id: seasonId,
      fixtures_updated: updated,
      message: 'Fixtures refreshed – run points-cron next for scoring'
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
