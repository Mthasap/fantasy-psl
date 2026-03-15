export default async function handler(req,res){

const token = process.env.SPORTMONKS_TOKEN

const r = await fetch(
`https://api.sportmonks.com/v3/football/livescores?api_token=${token}`
)

const json = await r.json()

res.json(json.data)

}
