// api/add-player.js — Fantasy PSL — Admin: Add Missing Players
// ─────────────────────────────────────────────────────────────────────────
// PURPOSE:
//   Insert a player who is missing from the players table.
//   You supply their API-Football ID and details — the player becomes
//   immediately available for selection and stats will auto-link on
//   next apifootball-sync run.
//
// USAGE (via curl or your admin panel):
//   POST /api/add-player
//   Headers: x-admin-key: YOUR_ADMIN_SECRET
//   Body (JSON):
//     {
//       "display_name": "Bongani Zungu",
//       "team": "Mamelodi Sundowns",
//       "position": "MID",           // GK | DEF | MID | FWD
//       "apifootball_id": 89123,     // from API-Football player search
//       "price": 7.5,                // in Rand millions
//       "is_available": true
//     }
//
// BULK INSERT — pass an array as "players":
//   { "players": [ { ...player1 }, { ...player2 } ] }
// ─────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN  = process.env.ADMIN_SECRET;

const VALID_POSITIONS = ['GK', 'DEF', 'MID', 'FWD'];

function defaultPrice(pos) {
  return pos === 'GK' ? 5.0 : pos === 'DEF' ? 5.5 : pos === 'MID' ? 6.5 : 7.0;
}

function normalisePosition(raw) {
  if (!raw) return 'MID';
  const r = raw.toUpperCase().trim();
  if (r === 'GK' || r.includes('GOAL')) return 'GK';
  if (r === 'DEF' || r.includes('DEF') || r.includes('BACK')) return 'DEF';
  if (r === 'MID' || r.includes('MID')) return 'MID';
  if (r === 'FWD' || r.includes('ATT') || r.includes('FOR') || r.includes('STRIKE')) return 'FWD';
  return 'MID';
}

function buildPlayerRow(p) {
  const pos = normalisePosition(p.position);
  return {
    display_name:    (p.display_name || p.name || '').trim(),
    team:            (p.team || p.club || '').trim(),
    position:        pos,
    apifootball_id:  p.apifootball_id ? parseInt(p.apifootball_id, 10) : null,
    price:           parseFloat(p.price) || defaultPrice(pos),
    is_available:    p.is_available !== false,
    goals:           0,
    assists:         0,
    yellow_cards:    0,
    red_cards:       0,
    clean_sheets:    0,
    apps:            0,
    total_points:    0,
    updated_at:      new Date().toISOString(),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const adminKey = req.headers && req.headers['x-admin-key'];
  if (!ADMIN || adminKey !== ADMIN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};
  const db   = createClient(SB_URL, SB_KEY);

  try {
    // ── Bulk insert mode ──────────────────────────────────────────────────
    if (Array.isArray(body.players)) {
      const rows   = body.players.map(buildPlayerRow);
      const errors = rows.filter(r => !r.display_name || !r.team);
      if (errors.length) {
        return res.status(400).json({ error: 'Each player needs display_name and team', invalid: errors });
      }

      const { data, error } = await db
        .from('players')
        .insert(rows)
        .select('id, display_name, team, position, apifootball_id');

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, inserted: data.length, players: data });
    }

    // ── Single insert mode ────────────────────────────────────────────────
    if (!body.display_name && !body.name) {
      return res.status(400).json({
        error: 'display_name is required',
        example: {
          display_name: 'Bongani Zungu',
          team: 'Mamelodi Sundowns',
          position: 'MID',
          apifootball_id: 89123,
          price: 7.5
        }
      });
    }
    if (!body.team && !body.club) {
      return res.status(400).json({ error: 'team is required' });
    }

    const row = buildPlayerRow(body);

    // Check for duplicate by apifootball_id (if supplied)
    if (row.apifootball_id) {
      const { data: existing } = await db
        .from('players')
        .select('id, display_name, team')
        .eq('apifootball_id', row.apifootball_id)
        .limit(1);

      if (existing && existing.length > 0) {
        return res.status(409).json({
          error: 'Player with this apifootball_id already exists',
          existing: existing[0]
        });
      }
    }

    const { data, error } = await db
      .from('players')
      .insert(row)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    return res.json({
      success: true,
      message: `${data.display_name} (${data.position}, ${data.team}) added successfully`,
      player:  data
    });

  } catch (err) {
    console.error('[add-player]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
