// api/season-helper.js
// Robust PSL season ID discovery — works on all Sportmonks plan tiers
// Priority: env var → Supabase cache → /leagues/{id} direct field → /seasons list

async function getSeasonId(db, TOKEN) {
  var BASE = 'https://api.sportmonks.com/v3/football';
  var PSL  = 806;

  // 0. Hard env var override (fastest — set SPORTMONKS_SEASON_ID=26173 in Vercel)
  if (process.env.SPORTMONKS_SEASON_ID) {
    return parseInt(process.env.SPORTMONKS_SEASON_ID, 10);
  }

  // 1. Supabase cache (avoids API calls on repeat runs)
  try {
    var cacheRes = await db.from('api_cache')
      .select('value,updated_at').eq('key','psl_current_season_id').single();
    if (cacheRes.data && cacheRes.data.value) {
      var age = Date.now() - new Date(cacheRes.data.updated_at).getTime();
      if (age < 24*60*60*1000) {
        return parseInt(cacheRes.data.value, 10);
      }
    }
  } catch(_) {}

  var found = null;

  // 2. /leagues/806 basic call — current_season_id is a top-level field
  //    (no include= needed, works on all plans)
  try {
    var r = await fetch(BASE + '/leagues/' + PSL + '?api_token=' + TOKEN, {
      headers: { Accept: 'application/json' }
    });
    if (r.ok) {
      var ld = await r.json();
      var ldata = ld.data || {};
      // current_season_id is returned directly on the league object
      var sid = ldata.current_season_id || ldata.currentSeasonId || null;
      if (sid) { found = sid; }
    }
  } catch(_) {}

  // 3. /seasons list — no filters, find PSL league_id:806, pick is_current or latest
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

  // 4. Known fallback — PSL 2024/25 season confirmed by user
  if (!found) {
    found = 26173;
    console.warn('[season-helper] Could not auto-detect season ID — using known fallback 26173');
  }

  // Cache it for 24h
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
