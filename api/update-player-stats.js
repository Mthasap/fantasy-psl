export default async function handler(req,res){

  const API_KEY = process.env.API_FOOTBALL_KEY;
  const fixtureId = req.query.fixture;

  try{

    const response = await fetch(
      `https://v3.football.api-sports.io/fixtures/players?fixture=${fixtureId}`,
      {
        headers:{
          "x-apisports-key": API_KEY
        }
      }
    );

    const data = await response.json();

    const stats = [];

    data.response.forEach(team=>{

      team.players.forEach(p=>{

        stats.push({
          api_player_id: p.player.id,
          goals: p.statistics[0].goals.total || 0,
          assists: p.statistics[0].goals.assists || 0,
          yellow_cards: p.statistics[0].cards.yellow || 0,
          red_cards: p.statistics[0].cards.red || 0
        });

      });

    });

    res.json({
      players_updated: stats.length
    });

  }catch(err){

    res.status(500).json({
      error: err.message
    });

  }

}
