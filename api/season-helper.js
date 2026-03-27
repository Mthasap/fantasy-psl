// api/season-helper.js — API-Football edition
// Gets the current PSL season year (e.g. 2025 for the 2025/26 season)
// API-Football uses league_id=288, season=YYYY format
//
// ENV VAR: APIFOOTBALL_KEY  — your API-Football key
//          APIFOOTBALL_SEASON — optional hard override e.g. 2025

const PSL_LEAGUE = 288; // Betway Premiership on API-Football
const BASE       = 'https://v3.football.api-sports.io';

async function getSeasonYear(TOKEN) {
  // 0. Hard env var override
  if (process.env.APIFOOTBALL_SEASON) {
    return parseInt(process.env.APIFOOTBALL_SEASON, 10);
  }

  // 1. Ask API-Football which season is current for PSL
  try {
    var r = await apiFetch('/leagues?id=' + PSL_LEAGUE + '&current=true', TOKEN);
    var league = (r.response || [])[0];
    if (league && league.seasons) {
      var current = league.seasons.find(function(s) { return s.current === true; });
      if (current) return current.year;
    }
  } catch(e) {
    console.warn('[season-helper] API-Football call failed:', e.message);
  }

  // 2. Fallback
  console.warn('[season-helper] Using fallback season year 2025');
  return 2025;
}

async function apiFetch(path, TOKEN) {
  var url = BASE + path;
  var r = await fetch(url, {
    headers: {
      'x-apisports-key': TOKEN,
      'Accept': 'application/json'
    }
  });
  if (!r.ok) {
    var body = await r.text().catch(function(){ return ''; });
    throw new Error('API-Football HTTP ' + r.status + ': ' + body.substring(0, 200));
  }
  var json = await r.json();
  if (json.errors && Object.keys(json.errors).length) {
    var errs = JSON.stringify(json.errors);
    if (!errs.includes('{}')) throw new Error('API-Football error: ' + errs.substring(0, 200));
  }
  return json;
}

module.exports = { getSeasonYear, apiFetch, PSL_LEAGUE, BASE };
