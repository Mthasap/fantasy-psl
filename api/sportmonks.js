export default async function handler(req,res){

const token = process.env.SPORTMONKS_TOKEN

try{

const endpoint = req.query.endpoint

const url = `https://api.sportmonks.com/v3/football/${endpoint}?api_token=${token}`

const r = await fetch(url)

const data = await r.json()

res.status(200).json(data)

}catch(err){

res.status(500).json({error:err.message})

}

}
