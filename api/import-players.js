export default async function handler(req, res) {

  const API_KEY = process.env.API_FOOTBALL_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const headers = {
    "x-apisports-key": API_KEY
  };

  try {

    // Step 1 — get PSL teams
    const teamsRes = await fetch(
      "https://v3.football.api-sports.io/teams?league=288&season=2024",
      { headers }
    );

    const teamsData = await teamsRes.json();
    const teams = teamsData.response || [];

    let allPlayers = [];

    // Step 2 — get players for each team
    for (const t of teams) {

      const teamId = t.team.id;
      const teamName = t.team.name;

      const playersRes = await fetch(
        `https://v3.football.api-sports.io/players?team=${teamId}&season=2025`,
        { headers }
      );

      const playersData = await playersRes.json();
      const players = playersData.response || [];

      players.forEach(p => {

        const player = p.player;

        allPlayers.push({
          api_player_id: player.id,
          display_name: player.name,
          team: teamName,
          position: p.statistics?.[0]?.games?.position || "MID",
          photo: player.photo,
          price: 6.0,
          is_available: true
        });

      });

    }

    if (allPlayers.length === 0) {
      return res.json({
        imported: 0,
        message: "No players returned from API"
      });
    }

    // Step 3 — insert into Supabase
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/players`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates"
      },
      body: JSON.stringify(allPlayers)
    });

    const result = await insertRes.text();

    res.json({
      imported: allPlayers.length,
      supabase_response: result
    });

  } catch(err) {

    res.status(500).json({
      error: err.message
    });

  }

}
