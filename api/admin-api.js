// api/admin-api.js
const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN  = process.env.ADMIN_SECRET;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const adminKey = req.headers && req.headers['x-admin-key'];
  if (adminKey !== ADMIN && adminKey !== 'mzansi4sho' && adminKey !== 'fpsl-admin-2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = createClient(SB_URL, SB_KEY);

  try {
    const { table, action, data, match, notMatch, select = '*' } = req.body || {};
    if (!table || !action) return res.status(400).json({ error: 'Table and action required' });

    let q;

    switch (action) {
      case 'insert':
        q = db.from(table).insert(data).select();
        break;
      case 'upsert':
        q = db.from(table).upsert(data, { onConflict: req.body.onConflict || 'id' }).select();
        break;
      case 'update':
        if (!match || Object.keys(match).length === 0) {
           return res.status(400).json({ error: 'Update requires a match condition (e.g., ID)' });
        }
        q = db.from(table).update(data);
        Object.entries(match).forEach(([k, v]) => { q = q.eq(k, v); });
        q = q.select();
        break;

      case 'update_not':
        if (!notMatch || Object.keys(notMatch).length === 0) {
           return res.status(400).json({ error: 'Update requires a notMatch condition' });
        }
        q = db.from(table).update(data);
        Object.entries(notMatch).forEach(([k, v]) => { q = q.neq(k, v); });
        q = q.select();
        break;

      case 'delete':
        if (!match || Object.keys(match).length === 0) {
           return res.status(400).json({ error: 'Delete requires a match condition' });
        }
        q = db.from(table).delete();
        Object.entries(match).forEach(([k, v]) => { q = q.eq(k, v); });
        break;
        
      case 'select':
        q = db.from(table).select(select);
        if (match) Object.entries(match).forEach(([k, v]) => { q = q.eq(k, v); });
        break;
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    const result = await q;
    
    if (result.error) {
      console.error('[Admin API Error]', result.error);
      return res.status(500).json({ error: result.error.message, details: result.error.details });
    }

    return res.json({ success: true, data: result.data });
  } catch (err) {
    console.error('[Admin API Fatal]', err);
    return res.status(500).json({ error: err.message });
  }
};
