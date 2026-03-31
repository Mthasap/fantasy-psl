module.exports = async (req, res) => {
  res.json({
    has_sync_secret: !!process.env.SYNC_SECRET,
    has_apifootball_key: !!process.env.APIFOOTBALL_KEY,
    has_supabase_url: !!process.env.SUPABASE_URL,
    has_supabase_service: !!process.env.SUPABASE_SERVICE_KEY,
    sync_secret_length: process.env.SYNC_SECRET?.length ?? 0,
    query_secret_match: req.query.secret === process.env.SYNC_SECRET,
    query_secret_received: req.query.secret
  });
};
