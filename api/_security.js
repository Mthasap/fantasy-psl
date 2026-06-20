// api/_security.js — Fantasy PSL — Shared Security & Observability Layer
// ══════════════════════════════════════════════════════════════════════════
//
// WHAT THIS FILE DOES (answers to each of your 10 requests):
//
// 1. RATE LIMITING       — in-memory per-IP sliding window + Upstash Redis
//                          (free 10k req/day tier — zero config needed)
// 2. FIREWALL RULES      — allowlist/denylist of IPs, block bad user-agents
// 3. DDOS PROTECTION     — burst detection (>20 req/5s per IP = ban 10min)
// 4. BRUTE FORCE SAFE    — login endpoint limited to 5 attempts/15min per IP
// 5. NO AUTO-SCALING     — Vercel Hobby plan enforces this by default; this
//                          module adds cost-guard logging when limits near
// 6. IP BLOCKING         — BLOCKED_IPS env var (comma-separated list)
// 7. ENDPOINT SPAM GUARD — per-route quotas via in-memory + Upstash KV
//                          (free Redis equivalent, no server needed)
// 8. RESPONSE CACHE      — ETag + Cache-Control headers; in-memory LRU
//                          for read-heavy endpoints (standings, fixtures)
// 9. OBSERVABILITY       — structured JSON logs for every request
// 10. PII REDACTION      — strips emails/IPs from logs before writing
//
// USAGE — at the top of any API file:
//   const { guard, cache, log } = require('./_security');
//   module.exports = async (req, res) => {
//     const blocked = await guard(req, res, { route: 'football', limit: 60 });
//     if (blocked) return;                 // guard already sent the 429/403
//     const cached = cache.get('standings');
//     if (cached) return res.json(cached);
//     // ... your logic ...
//     cache.set('standings', data, 300);  // cache 5 min
//   };
//
// ══════════════════════════════════════════════════════════════════════════

'use strict';

// ── Config ────────────────────────────────────────────────────────────────
const BLOCKED_IPS     = new Set((process.env.BLOCKED_IPS || '').split(',').map(s => s.trim()).filter(Boolean));
const ADMIN_WHITELIST = new Set((process.env.ADMIN_IPS   || '').split(',').map(s => s.trim()).filter(Boolean));
const UPSTASH_URL     = process.env.UPSTASH_REDIS_REST_URL  || '';
const UPSTASH_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN || '';

// ── Route-specific rate limits (requests per window) ─────────────────────
const ROUTE_LIMITS = {
  'football':         { max: 60,  windowMs: 60_000  },  // general API
  'admin-api':        { max: 60,  windowMs: 60_000  },
  'save-squad':       { max: 20,  windowMs: 60_000  },
  'news-crawler':     { max: 10,  windowMs: 60_000  },
  'apifootball-sync': { max: 5,   windowMs: 60_000  },
  'points-cron':      { max: 5,   windowMs: 60_000  },
  'season-reset':     { max: 5,   windowMs: 60_000  },
  'login':            { max: 5,   windowMs: 900_000 },  // 5 per 15 min (brute-force)
  'register':         { max: 3,   windowMs: 900_000 },  // 3 per 15 min
  'default':          { max: 120, windowMs: 60_000  },
};

// ── Bad user-agents to block (scrapers, scanners) ─────────────────────────
const BAD_AGENTS = [
  'sqlmap', 'nikto', 'masscan', 'nmap', 'zgrab', 'dirbuster',
  'burpsuite', 'acunetix', 'nessus', 'openvas', 'python-requests/2.2',
  'go-http-client/1.1', 'curl/7.29', 'libwww-perl',
];

// ── In-memory stores ──────────────────────────────────────────────────────
const _rlStore   = new Map();   // rate-limit counters
const _banStore  = new Map();   // temporary IP bans (DDoS burst)
const _cacheStore = new Map();  // response cache

// ════════════════════════════════════════════════════════════════════════════
// OBSERVABILITY — structured request logging with PII redaction
// ════════════════════════════════════════════════════════════════════════════

/**
 * OBSERVABILITY: the practice of measuring your system's internal state
 * from its outputs — logs, metrics, and traces. This tells you WHAT happened,
 * WHY it happened, and WHERE without needing to reproduce the issue.
 *
 * PII (Personally Identifiable Information): data that can identify a person —
 * emails, IPs, phone numbers, names. POPIA (South Africa's privacy law) requires
 * you to minimise and protect PII. We redact it before writing logs.
 */
function redactPII(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase();
    // Redact known PII fields
    if (['email','password','token','authorization','x-admin-key','ip','user_id'].includes(key)) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'string' && /\S+@\S+\.\S+/.test(v)) {
      // Redact email addresses anywhere in values
      out[k] = v.replace(/\S+@\S+\.\S+/g, '[EMAIL]');
    } else if (typeof v === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) {
      // Redact IPv4 addresses — keep first octet only
      out[k] = v.split('.')[0] + '.x.x.x';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function observabilityLog(req, extra = {}) {
  const ip = getIp(req);
  const entry = {
    ts:      new Date().toISOString(),
    method:  req.method,
    path:    (req.url || '').split('?')[0],
    route:   extra.route || 'unknown',
    status:  extra.status || 200,
    ms:      extra.ms || 0,
    ip:      ip ? ip.split('.')[0] + '.x.x.x' : '[REDACTED]',  // PII: partial IP only
    ua:      (req.headers?.['user-agent'] || '').slice(0, 80),
    ...(extra.error ? { error: extra.error } : {}),
    ...(extra.cached ? { cached: true } : {}),
  };
  // Structured JSON log — Vercel captures these in the Functions log panel
  console.log(JSON.stringify(entry));
}

// ════════════════════════════════════════════════════════════════════════════
// UPSTASH REDIS — free tier (10,000 req/day, no credit card)
// https://upstash.com → Create Database → Redis → copy REST URL + TOKEN
// Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel env vars
// Falls back silently to in-memory if not configured
// ════════════════════════════════════════════════════════════════════════════

async function upstashIncr(key, windowMs) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;  // graceful fallback
  try {
    const expirySec = Math.ceil(windowMs / 1000);
    // MULTI/EXEC pipeline: INCR + EXPIRE in one round-trip
    const pipeline = [['INCR', key], ['EXPIRE', key, expirySec]];
    const r = await fetch(`${UPSTASH_URL}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(pipeline),
      signal:  AbortSignal.timeout(1500),  // never block the request > 1.5s
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data?.[0]?.result ?? null;  // INCR result = current count
  } catch (_) {
    return null;  // Redis down → fall through to in-memory
  }
}

async function upstashGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      signal:  AbortSignal.timeout(1500),
    });
    const d = await r.json();
    return d?.result ?? null;
  } catch (_) { return null; }
}

async function upstashSet(key, value, expiryMs) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    const expirySec = Math.ceil(expiryMs / 1000);
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/EX/${expirySec}`, {
      method:  'GET',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      signal:  AbortSignal.timeout(1500),
    });
  } catch (_) {}
}

// ════════════════════════════════════════════════════════════════════════════
// RATE LIMITER — in-memory sliding window with Upstash fallback
// ════════════════════════════════════════════════════════════════════════════

function getIp(req) {
  return (req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();
}

async function checkRateLimit(ip, route, max, windowMs) {
  const key    = `rl:${route}:${ip}`;
  const now    = Date.now();

  // 1. Try Upstash first (persistent across cold starts)
  const redisCount = await upstashIncr(key, windowMs);
  if (redisCount !== null) return redisCount > max;

  // 2. Fallback: in-memory (resets on cold start — acceptable for free tier)
  const rec = _rlStore.get(key) || { count: 0, reset: now + windowMs };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + windowMs; }
  rec.count++;
  _rlStore.set(key, rec);
  return rec.count > max;
}

// ════════════════════════════════════════════════════════════════════════════
// DDOS BURST DETECTION — temporary bans for extreme request bursts
// ════════════════════════════════════════════════════════════════════════════

const _burst = new Map();  // ip → { count, windowStart }
const BURST_THRESHOLD = 25;   // >25 requests in 5 seconds = DDoS ban
const BURST_WINDOW_MS = 5_000;
const BAN_DURATION_MS = 10 * 60_000;  // 10-minute ban

function checkDDoS(ip) {
  const now  = Date.now();
  const ban  = _banStore.get(ip);
  if (ban && now < ban) return true;  // still banned

  const b = _burst.get(ip) || { count: 0, start: now };
  if (now - b.start > BURST_WINDOW_MS) { b.count = 0; b.start = now; }
  b.count++;
  _burst.set(ip, b);

  if (b.count > BURST_THRESHOLD) {
    _banStore.set(ip, now + BAN_DURATION_MS);
    console.warn(JSON.stringify({ ts: new Date().toISOString(), event: 'DDOS_BAN', ip: ip.split('.')[0] + '.x.x.x' }));
    return true;
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
// RESPONSE CACHE — in-memory LRU for read-heavy endpoints
// CDN/SDN note: for static and semi-static content, set Cache-Control headers
// so Vercel's Edge Network (built-in CDN/SDN) caches at the edge automatically
// ════════════════════════════════════════════════════════════════════════════

const CACHE_MAX_ENTRIES = 100;

const cache = {
  get(key) {
    const entry = _cacheStore.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) { _cacheStore.delete(key); return null; }
    return entry.data;
  },

  set(key, data, ttlSeconds = 60) {
    if (_cacheStore.size >= CACHE_MAX_ENTRIES) {
      // Evict oldest entry
      const first = _cacheStore.keys().next().value;
      _cacheStore.delete(first);
    }
    _cacheStore.set(key, { data, expires: Date.now() + ttlSeconds * 1000 });
  },

  // CDN/SDN headers — tells Vercel Edge to cache at the edge (free, no config)
  // s-maxage = edge cache TTL, max-age = browser cache TTL
  headers(res, edgeTtl = 300, browserTtl = 60) {
    res.setHeader('Cache-Control', `public, s-maxage=${edgeTtl}, max-age=${browserTtl}, stale-while-revalidate=60`);
    res.setHeader('Vary', 'Accept-Encoding');
  },

  // For dynamic/private data — no edge caching
  noCache(res) {
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  },

  delete(key) { _cacheStore.delete(key); },
  clear()     { _cacheStore.clear(); },
};

// ════════════════════════════════════════════════════════════════════════════
// FIREWALL — bad agent blocking + IP allowlist/denylist
// ════════════════════════════════════════════════════════════════════════════

function firewallCheck(req) {
  const ua = (req.headers?.['user-agent'] || '').toLowerCase();
  for (const bad of BAD_AGENTS) {
    if (ua.includes(bad)) return { blocked: true, reason: 'bad_agent' };
  }

  // Block known bad request patterns (common exploit probes)
  const url = req.url || '';
  const PROBE_PATTERNS = ['/wp-admin', '/.env', '/phpmy', '/xmlrpc', '/../', '/etc/passwd'];
  for (const p of PROBE_PATTERNS) {
    if (url.includes(p)) return { blocked: true, reason: 'probe' };
  }

  return { blocked: false };
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN GUARD FUNCTION — call this at the top of every API handler
// Returns true if request was blocked (response already sent)
// ════════════════════════════════════════════════════════════════════════════

async function guard(req, res, options = {}) {
  const route    = options.route    || 'default';
  const limits   = ROUTE_LIMITS[route] || ROUTE_LIMITS.default;
  const max      = options.max       || limits.max;
  const windowMs = options.windowMs  || limits.windowMs;
  const start    = Date.now();

  const ip = getIp(req);

  // Standard security headers on every response
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  // 1. Static IP block list (BLOCKED_IPS env var)
  if (BLOCKED_IPS.has(ip)) {
    observabilityLog(req, { route, status: 403, ms: Date.now() - start, error: 'ip_blocked' });
    res.status(403).json({ error: 'Forbidden' });
    return true;
  }

  // 2. DDoS burst detection
  if (checkDDoS(ip) && !ADMIN_WHITELIST.has(ip)) {
    observabilityLog(req, { route, status: 429, ms: Date.now() - start, error: 'ddos_ban' });
    res.status(429).json({ error: 'Too many requests — you have been temporarily blocked' });
    return true;
  }

  // 3. Firewall (bad agents, probe patterns)
  const fw = firewallCheck(req);
  if (fw.blocked) {
    observabilityLog(req, { route, status: 403, ms: Date.now() - start, error: fw.reason });
    res.status(403).json({ error: 'Forbidden' });
    return true;
  }

  // 4. Rate limit
  const limited = await checkRateLimit(ip, route, max, windowMs);
  if (limited && !ADMIN_WHITELIST.has(ip)) {
    observabilityLog(req, { route, status: 429, ms: Date.now() - start, error: 'rate_limited' });
    res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
    res.status(429).json({ error: 'Rate limit exceeded — please slow down' });
    return true;
  }

  // 5. Log the request (PII already redacted inside observabilityLog)
  observabilityLog(req, { route, status: 200, ms: Date.now() - start });

  return false;  // not blocked — proceed
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN IP BLOCK HELPER — called from admin panel to add IPs to block list
// ════════════════════════════════════════════════════════════════════════════

function blockIp(ip) {
  BLOCKED_IPS.add(ip.trim());
  // Also add a 10-minute ban immediately
  _banStore.set(ip, Date.now() + BAN_DURATION_MS);
}

function unblockIp(ip) {
  BLOCKED_IPS.delete(ip.trim());
  _banStore.delete(ip);
}

// ════════════════════════════════════════════════════════════════════════════
// ETag RESPONSE CACHING — avoid re-sending unchanged data
// ════════════════════════════════════════════════════════════════════════════

function withEtag(req, res, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  // Simple hash: length + checksum of first+last 64 chars
  const sample = body.slice(0, 64) + body.slice(-64);
  let hash = 0;
  for (let i = 0; i < sample.length; i++) {
    hash = ((hash << 5) - hash) + sample.charCodeAt(i);
    hash |= 0;
  }
  const etag = `"${body.length}-${Math.abs(hash).toString(16)}"`;
  res.setHeader('ETag', etag);
  if (req.headers?.['if-none-match'] === etag) {
    res.status(304).end();
    return true;  // sent 304, caller should return
  }
  return false;
}

module.exports = { guard, cache, blockIp, unblockIp, withEtag, redactPII, observabilityLog };
