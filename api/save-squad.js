// api/save-squad.js
const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // 1. Verify the user's JWT token
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const db = createClient(SB_URL, SB_KEY);
  const { data: { user }, error: authErr } = await db.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  try {
    // 2. Check the Gameweek Deadline securely on the backend
    const { data: gw } = await db.from('gameweeks')
      .select('deadline_at, is_current')
      .eq('is_current', true)
      .eq('season', 2025)
      .limit(1)
      .single();

    if (gw && gw.deadline_at) {
      const deadline = new Date(gw.deadline_at);
      if (new Date() >= deadline) {
        return res.status(403).json({ error: 'Deadline passed. Squad locked.' });
      }
    }

    const payload = req.body;

    // ─── 3. STRICT 15-PLAYER ENFORCEMENT ──────────────────────────────
    // Safely extract the players array depending on how your frontend formats it
    const squadData = payload.squad_data;
    const squadArr = Array.isArray(squadData) ? squadData : (squadData?.players || []);
    
    // Filter out empty slots to count only actual selected players
    const validPlayers = squadArr.filter(p => p && (p.id || p.psl_roster_id || p.apifootball_id));

    if (validPlayers.length !== 15) {
      return res.status(400).json({ 
        error: `Incomplete squad! You must select exactly 15 players to save and earn points. You currently have ${validPlayers.length}.` 
      });
    }
    // ──────────────────────────────────────────────────────────────────

    // 4. Deadline is safe and squad is full, proceed to save
    // Enforce that a user can only update their own profile ID
    payload.id = user.id;
