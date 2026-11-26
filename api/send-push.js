// api/send-push.js — Fantasy PSL — Web Push sender
// ─────────────────────────────────────────────────────────────────────────
// Sends a push notification to every user who has opted in (profiles rows
// with a non-null push_subscription). Trigger it from the admin panel, a cron,
// or the news/quiz flow.
//
// AUTH:   admin key (?admin_key= or x-admin-key header) OR Vercel cron.
// ENV:    SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_SECRET,
//         VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (optional)
//
// BODY/QUERY: title, body, url, tag
//   GET  /api/send-push?admin_key=KEY&title=Hello&body=World&url=/%23news
//   POST /api/send-push  { "title":"GW11 deadline", "body":"...", "url":"/" }
// ─────────────────────────────────────────────────────────────────────────

'use strict';

const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const SB_URL        = process.env.SUPABASE_URL;
const SB_KEY        = process.env.SUPABASE_SERVICE_KEY;
const ADMIN         = process.env.ADMIN_SECRET;
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@fantasypsl.co.za';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', 'https://www.fantasypsl.co.za');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isCron = req.headers['x-vercel-cron'] === '1';
  const key = req.headers['x-admin-key'] || (req.query && (req.query.admin_key || req.query.secret)) || '';
  if (!isCron && (!ADMIN || key !== ADMIN)) return res.status(401).json({ error: 'Unauthorized' });

  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'Supabase env vars missing' });
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return res.status(500).json({ error: 'VAPID keys not set — add VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Vercel env vars' });
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  const b = req.body || {};
  const q = req.query || {};
  const title = b.title || q.title || 'Fantasy PSL';
  const message = b.body || q.body || 'Open the app for the latest.';
  const url = b.url || q.url || '/';
  const tag = b.tag || q.tag || 'fpsl-news';

  const db = createClient(SB_URL, SB_KEY);
  const { data, error } = await db
    .from('profiles')
    .select('id, push_subscription')
    .not('push_subscription', 'is', null);

  if (error) return res.status(500).json({ error: error.message });

  const payload = JSON.stringify({
    title: title,
    body: message,
    url: url,
    tag: tag,
    icon: '/icon-192.png',
    badge: '/icon-96.png',
  });

  let sent = 0, failed = 0, removed = 0;
  for (const row of (data || [])) {
    let sub;
    try { sub = JSON.parse(row.push_subscription); } catch (_) { continue; }
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (e) {
      failed++;
      // 404 / 410 = the subscription is dead (user uninstalled / revoked) → clear it.
      if (e.statusCode === 404 || e.statusCode === 410) {
        try { await db.from('profiles').update({ push_subscription: null }).eq('id', row.id); } catch (_) {}
        removed++;
      }
    }
  }

  return res.json({ success: true, recipients: (data || []).length, sent, failed, removed_expired: removed });
};
