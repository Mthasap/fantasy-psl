// api/season-helper.js
// Robust PSL season ID discovery — works on all Sportmonks plan tiers
// Priority: env var → /leagues/{id} live call → /seasons list → Supabase cache → hardcoded fallback
//
// IMPORTANT: The Supabase cache is now checked LAST, not first.
// This prevents a stale cached season ID (e.g. 2024/25 = 26173) from
// blocking discovery of the actual current season (2025/26).

async function getSeasonId(db, TOKEN) {
  var BASE = 'https://api.sportmonks.com/v3/football';
  var PSL  = 806;

  // 0. Hard env var override — set SPORTMONKS_SEASON_ID in Vercel env vars
  //    This is the most reliable option. Find your season ID by visiting:
  //    /api/sportmonks-setup?admin_key=fpsl-admin-2026&action=default
  //    Look for "current_season" in the output and note the ID.
  if (process.env.SPORTMONKS_SEASON_ID) {
    return parseInt(process.env.SPORTMONKS_SEASON_ID, 10);
  }

  var found = null;

  // 1. /leagues/806 live call — current_season_id is a top-level field
  try {
    var r = await fetch(BASE + '/leagues/' + PSL + '?api_token=' + TOKEN, {
      headers: { Accept: 'application/json' }
    });
    if (r.ok) {
      var ld = await r.json();
      var ldata = ld.data || {};
      var sid = ldata.current_season_id || ldata.currentSeasonId || null;
      if (sid) found = sid;
    }
  } catch(_) {}

  // 2. /seasons list — scan all pages, find PSL league_id:806
  //    Pick is_current first, then highest ID (most recent season)
  if (!found) {
    try {
      var page = 1;
      var done = false;
      while (page <= 8 && !done) {
        var sr = await fetch(BASE + '/seasons?per_page=100&page=' + page + '&api_token=' + TOKEN, {
          headers: { Accept: 'application/json' }
        });
        if (!sr.ok) break;
        var sj = await sr.json();
        var seasons = sj.data || [];
        if (!seasons.length) break;
        for (var i = 0; i < seasons.length; i++) {
          var s = seasons[i];
          if (s.league_id === PSL) {
            if (s.is_current) { found = s.id; done = true; break; }
            if (!found || s.id > found) found = s.id;
          }
        }
        var meta = sj.meta && sj.meta.pagination;
        if (!meta || !meta.has_next_page) break;
        page++;
      }
    } catch(_) {}
  }

  // 3. Supabase cache — only use if live calls failed
  if (!found) {
    try {
      var cacheRes = await db.from('api_cache')
        .select('value,updated_at').eq('key','psl_current_season_id').single();
      if (cacheRes.data && cacheRes.data.value) {
        found = parseInt(cacheRes.data.value, 10);
        console.warn('[season-helper] Using Supabase cached season ID:', found);
      }
    } catch(_) {}
  }

  // 4. Hardcoded fallback — PSL 2025/26 season
  //    If this is wrong, set SPORTMONKS_SEASON_ID in Vercel env vars instead.
  if (!found) {
    found = 26173;
    console.warn('[season-helper] All auto-detection failed — using hardcoded fallback 26173');
    console.warn('[season-helper] To fix: visit /api/sportmonks-setup?admin_key=fpsl-admin-2026 and set SPORTMONKS_SEASON_ID in Vercel');
  }

  // Always update Supabase cache with the found value
  try {
    await db.from('api_cache').upsert({
      key: 'psl_current_season_id',
      value: String(found),
      updated_at: new Date().toISOString()
    }, { onConflict: 'key' });
  } catch(_) {}

  return found;
}

module.exports = { getSeasonId };
