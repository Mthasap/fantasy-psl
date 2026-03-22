// api/sync-player-stats.js — redirect to import-players (kept for backward compat)
module.exports = async (req, res) => {
  return res.status(301).json({ message: 'Use /api/import-players instead', redirect: '/api/import-players' });
};
