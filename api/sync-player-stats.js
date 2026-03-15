import { createClient } from "@supabase/supabase-js"

export default async function handler(req,res){

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const TOKEN = process.env.SPORTMONKS_TOKEN

const supabase = createClient(SUPABASE_URL,SERVICE_KEY)

const r = await fetch(
`https://api.sportmonks.com/v3/football/leagues/806/players?api_token=${TOKEN}`
)

const json = await r.json()

for(const player of json.data){

await supabase.from("players").upsert({

id:player.id,
name:player.name,
position:player.position.name,
team:player.team.name

})

}

res.json({
players_synced:json.data.length
})

}
