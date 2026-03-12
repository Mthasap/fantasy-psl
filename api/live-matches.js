export default async function handler(req, res) {

  const API_KEY = process.env.API_FOOTBALL_KEY;

  try {

    const response = await fetch(
      "https://v3.football.api-sports.io/fixtures?live=all",
      {
        headers: {
          "x-apisports-key": API_KEY
        }
      }
    );

    const data = await response.json();

    const matches = (data.response || []).map(m => ({
      fixture_id: m.fixture.id,
      home: m.teams.home.name,
      away: m.teams.away.name,
      hg: m.goals.home,
      ag: m.goals.away,
      minute: m.fixture.status.elapsed
    }));

    res.json({
      live_matches: matches
    });

  } catch(err) {

    res.status(500).json({
      error: err.message
    });

  }

}
