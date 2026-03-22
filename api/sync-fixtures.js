// api/sync-fixtures.js — redirect to force-sync (kept for backward compat)
module.exports = async (req, res) => {
  return res.status(301).json({ message: 'Use /api/force-sync instead', redirect: '/api/force-sync' });
};
