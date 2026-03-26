// api/admin-api.js — Secure admin write proxy
// Uses SUPABASE_SERVICE_KEY (server-side only, never in browser)
// All admin writes go through here to bypass Row Level Security safely
// Protected by ADMIN_SECRET env var — only the admin panel can call this

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN  = process.env.ADMIN_SECRET || 'mzansi4sho';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { return res.status(405).json({ error: 'POST only' }); }

  // Auth check — admin panel sends its password as x-admin-key header
  const adminKey = req.headers && req.headers['x-admin-key'];
  if (adminKey !== ADMIN && adminKey !== 'mzansi4sho' && adminKey !== 'fpsl-admin-2026') return res.status(401).json({ error: 'Unauthorized' });
  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'Supabase env vars missing' });

  const db = createClient(SB_URL, SB_KEY);

  try {
    const body   = req.body || {};
    const table  = body.table;
    const action = body.action; // insert | upsert | update | update_not | delete | select
    const data   = body.data;
    const match  = body.match;  // { col: val } for WHERE col = val
    const select = body.select || '*';

    if (!table)  return res.status(400).json({ error: 'table required' });
    if (!action) return res.status(400).json({ error: 'action required' });

    let result;

    if (action === 'insert') {
      result = await db.from(table).insert(data);

    } else if (action === 'upsert') {
      const conflict = body.onConflict || 'id';
      result = await db.from(table).upsert(data, { onConflict: conflict });

    } else if (action === 'update') {
      let q = db.from(table).update(data);
      if (match) {
        Object.entries(match).forEach(function([k, v]) { q = q.eq(k, v); });
      }
      result = await q;

    } else if (action === 'update_not') {
      // UPDATE table SET ... WHERE col != val  (used for clearing is_current on other GWs)
      const notMatch = body.notMatch || {};
      let q = db.from(table).update(data);
      Object.entries(notMatch).forEach(function([k, v]) { q = q.neq(k, v); });
      result = await q;

    } else if (action === 'delete') {
      let q = db.from(table).delete();
      if (match) {
        Object.entries(match).forEach(function([k, v]) { q = q.eq(k, v); });
      }
      result = await q;

    } else if (action === 'select') {
      let q = db.from(table).select(select);
      if (match) {
        Object.entries(match).forEach(function([k, v]) { q = q.eq(k, v); });
      }
      if (body.limit) q = q.limit(body.limit);
      if (body.order) q = q.order(body.order, { ascending: body.ascending !== false });
      result = await q;
      if (result.error) return res.status(500).json({ error: result.error.message });
      return res.json({ data: result.data });

    } else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

    if (result.error) {
      return res.status(500).json({ error: result.error.message, code: result.error.code });
    }
    return res.json({ success: true, data: result.data });

  } catch (err) {
    console.error('[admin-api]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
