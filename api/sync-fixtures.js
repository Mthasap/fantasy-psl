import { createClient } from "@supabase/supabase-js"

export default async function handler(req,res){

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const TOKEN = process.env.SPORTMONKS_TOKEN

const supabase = createClient(SUPABASE_URL,SERVICE_KEY)

const league = 806

const r = await fetch(
`https://api.sportmonks.com/v3/football/fixtures/leagues/${league}?api_token=${TOKEN}`
)

const json = await r.json()

for(const fixture of json.data){

await supabase.from("fixtures").upsert({

id:fixture.id,
home_team:fixture.participants[0].name,
away_team:fixture.participants[1].name,
kickoff:fixture.starting_at,
status:fixture.state.name

})

}

res.json({
fixtures_synced:json.data.length
})

}
