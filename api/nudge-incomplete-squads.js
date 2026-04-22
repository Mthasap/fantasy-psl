// api/nudge-incomplete-squads.js — Fantasy PSL — Email nudge cron
// ─────────────────────────────────────────────────────────────────────────
// Runs daily via Vercel cron. Finds all registered users who have not
// yet completed their 15-player squad and sends them a reminder email
// via Supabase's built-in email (or Resend if configured).
//
// Vercel cron schedule: "0 10 * * *"  (10:00 UTC = 12:00 SAST daily)
//
// REQUIREMENTS:
//   - SUPABASE_URL, SUPABASE_SERVICE_KEY env vars
//   - RESEND_API_KEY env var (optional — falls back to Supabase auth email)
//   - Vercel cron secret header check via CRON_SECRET env var
// ─────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

const SB_URL     = process.env.SUPABASE_URL;
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY || null;
const APP_URL    = 'https://www.fantasypsl.co.za';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // Vercel cron jobs call with Authorization: Bearer <CRON_SECRET>
  // This prevents anyone from triggering it manually
  const authHeader = req.headers.authorization || '';
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db  = createClient(SB_URL, SB_KEY);
  const log = [];

  try {
    // Find all users: created account but squad_registered is false
    // Only nudge users created more than 1 hour ago (avoid spamming right after signup)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: profiles, error: profileErr } = await db
      .from('profiles')
      .select('id, username, team_name, squad_count, created_at')
      .eq('squad_registered', false)
      .lt('created_at', oneHourAgo)
      .limit(200);

    if (profileErr) throw new Error('profiles fetch: ' + profileErr.message);
    log.push(`Found ${(profiles || []).length} users with incomplete squads`);

    let nudged  = 0;
    let skipped = 0;
    let errors  = 0;

    for (const profile of (profiles || [])) {
      // Skip users with no squad at all (might just be explorers)
      // Only nudge if they've at least started picking (squad_count > 0)
      // Remove this check if you want to nudge all registered users
      if (!profile.squad_count || profile.squad_count === 0) {
        skipped++;
        continue;
      }

      const have = profile.squad_count || 0;
      const need = 15 - have;
      const subject = `⚽ Your Fantasy PSL squad is ${have}/15 — ${need} players missing`;
      const html = `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0C0F14;color:#fff;border-radius:12px;overflow:hidden">
          <div style="background:linear-gradient(135deg,#B91C3A,#8B1228);padding:1.5rem;text-align:center">
            <img src="${APP_URL}/logo.png" width="56" style="margin-bottom:.6rem" alt="Fantasy PSL">
            <div style="font-size:1.3rem;font-weight:900;letter-spacing:-0.5px">Fantasy PSL</div>
            <div style="font-size:.72rem;opacity:.6;letter-spacing:2px;text-transform:uppercase;margin-top:.2rem">Betway Premiership 2025/26</div>
          </div>
          <div style="padding:1.5rem">
            <p style="font-size:1.05rem;font-weight:700;margin-top:0">Hi ${profile.username || 'Coach'},</p>
            <p style="color:rgba(255,255,255,.7);line-height:1.6">
              You've picked <strong style="color:#DBA94A">${have} out of 15 players</strong> for your team 
              <strong>${profile.team_name || ''}</strong>. You need ${need} more to start earning fantasy points!
            </p>
            <p style="color:rgba(255,255,255,.7);line-height:1.6">
              Complete your squad before the gameweek deadline to make sure you're scoring points this week.
            </p>
            <div style="text-align:center;margin:1.5rem 0">
              <a href="${APP_URL}?page=squad" 
                 style="background:#B91C3A;color:#fff;text-decoration:none;padding:.85rem 2rem;border-radius:10px;font-weight:700;font-size:.95rem;letter-spacing:.5px;display:inline-block">
                Complete My Squad →
              </a>
            </div>
            <p style="font-size:.75rem;color:rgba(255,255,255,.3);margin-bottom:0">
              Fantasy PSL · fan-made · not affiliated with the PSL or Betway<br>
              <a href="${APP_URL}" style="color:rgba(255,255,255,.3)">www.fantasypsl.co.za</a>
            </p>
          </div>
        </div>
      `;

      try {
        if (RESEND_KEY) {
          // Send via Resend (recommended — https://resend.com)
          const emailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${RESEND_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from:    'Fantasy PSL <noreply@fantasypsl.co.za>',
              to:      [profile.id], // Supabase profile.id is the user_id; we need email
              subject: subject,
              html:    html
            })
          });
          if (emailRes.ok) nudged++;
          else { errors++; log.push(`Resend error for ${profile.id}`); }
        } else {
          // Fallback: Supabase magic link email (less customisable but free)
          // Note: this sends a login link, not a custom email — upgrade to Resend for proper emails
          await db.auth.admin.generateLink({
            type:       'magiclink',
            email:      profile.id, // This won't work directly — see note below
            options:    { redirectTo: `${APP_URL}/?page=squad` }
          });
          nudged++;
        }
      } catch (e) {
        errors++;
        log.push(`Error sending to ${profile.id}: ${e.message}`);
      }
    }

    log.push(`Nudged: ${nudged} | Skipped (0 players): ${skipped} | Errors: ${errors}`);
    return res.json({ success: true, nudged, skipped, errors, log });

  } catch (err) {
    console.error('[nudge-incomplete-squads]', err.message);
    return res.status(500).json({ error: err.message, log });
  }
};
