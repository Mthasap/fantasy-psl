export default async function handler(req, res) {

  const API_KEY = process.env.API_FOOTBALL_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const headers = {
    "x-apisports-key": API_KEY
  };

  try {

    const teamsRes = await fetch(
      "https://v3.football.api-sports.io/teams?league=288&season=2024",
      { headers }
    );

    const teamsData = await teamsRes.json();

    let players = [];

    for (const team of teamsData.response) {

      const squadRes = await fetch(
        `https://v3.football.api-sports.io/players/squads?team=${team.team.id}`,
        { headers }
      );

      const squad = await squadRes.json();

      squad.response[0].players.forEach(p => {

        players.push({
          api_player_id: p.id,
          display_name: p.name,
          team: team.team.name,
          position: p.position,
          photo: p.photo,
          price: 6.0,
          is_available: true
        });

      });

    }

    await fetch(`${SUPABASE_URL}/rest/v1/players`,{
      method:"POST",
      headers:{
        "apikey": SUPABASE_KEY,
        "Authorization":`Bearer ${SUPABASE_KEY}`,
        "Content-Type":"application/json",
        "Prefer":"resolution=merge-duplicates"
      },
      body: JSON.stringify(players)
    });

    res.json({
      imported: players.length
    });

  } catch(err){

    res.status(500).json({
      error: err.message
    });

  }

}
