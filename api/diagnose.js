/**
 * API-Football PSL Diagnostic Script
 * ------------------------------------
 * Run this ONCE locally or as a Vercel serverless function.
 * It tests every endpoint we need and logs exact response structure.
 *
 * Run locally:
 *   node apifootball-psl-diagnostic.js
 *
 * Or deploy temporarily as /api/diagnose.js on Vercel and hit:
 *   https://yourapp.vercel.app/api/diagnose?secret=psldiag2025
 */

const API_KEY = process.env.APIFOOTBALL_KEY || '11b629e49f40de368f94e19e06f22fdc';
const BASE_URL = 'https://v3.football.api-sports.io';
const PSL_LEAGUE = 288;
const PSL_SEASON = 2024; // Use 2024 for 2024/25 season
const AMAZULU_TEAM_ID = 2669; // From your CSV

// ─── HTTP helper ────────────────────────────────────────────────────────────
async function api(endpoint) {
  const url = `${BASE_URL}${endpoint}`;
  console.log(`\n→ GET ${url}`);
  const res = await fetch(url, {
    headers: {
      'x-rapidapi-key': API_KEY,
      'x-rapidapi-host': 'v3.football.api-sports.io',
    },
  });
  const data = await res.json();
  // Log rate limit info
  console.log(`  Status: ${res.status} | Remaining calls today: ${res.headers.get('x-ratelimit-requests-remaining') ?? 'unknown'}`);
  return data;
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function section(title) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function preview(obj, depth = 3) {
  console.log(JSON.stringify(obj, null, 2).split('\n').slice(0, 80).join('\n'));
}

// ─── Main diagnostic ────────────────────────────────────────────────────────
async function runDiagnostic() {
  console.log('API-Football PSL Diagnostic');
  console.log('============================');
  console.log(`League: ${PSL_LEAGUE} | Season: ${PSL_SEASON} | Team: ${AMAZULU_TEAM_ID}`);

  // ── 1. Standings ──────────────────────────────────────────────────────────
  section('1. STANDINGS');
  const standings = await api(`/standings?league=${PSL_LEAGUE}&season=${PSL_SEASON}`);
  console.log('Response count:', standings.response?.length);
  console.log('Errors:', standings.errors);
  if (standings.response?.[0]?.league?.standings?.[0]?.[0]) {
    console.log('\nSample standing row:');
    preview(standings.response[0].league.standings[0][0]);
  } else {
    console.log('RAW:', JSON.stringify(standings).slice(0, 500));
  }

  // ── 2. Fixtures ───────────────────────────────────────────────────────────
  section('2. FIXTURES (completed)');
  const fixtures = await api(`/fixtures?league=${PSL_LEAGUE}&season=${PSL_SEASON}&status=FT`);
  console.log('Total completed fixtures:', fixtures.response?.length);
  console.log('Errors:', fixtures.errors);
  
  let sampleFixtureId = null;
  if (fixtures.response?.length > 0) {
    const sample = fixtures.response[0];
    sampleFixtureId = sample.fixture?.id;
    console.log('\nSample fixture:');
    preview(sample);
    console.log('\nAll rounds/GWs found:');
    const rounds = [...new Set(fixtures.response.map(f => f.league?.round))];
    console.log(rounds.join(', '));
  } else {
    console.log('RAW:', JSON.stringify(fixtures).slice(0, 500));
  }

  // ── 3. Upcoming Fixtures ──────────────────────────────────────────────────
  section('3. UPCOMING FIXTURES');
  const upcoming = await api(`/fixtures?league=${PSL_LEAGUE}&season=${PSL_SEASON}&status=NS`);
  console.log('Total upcoming fixtures:', upcoming.response?.length);
  if (upcoming.response?.length > 0) {
    console.log('\nNext 3 fixtures:');
    preview(upcoming.response.slice(0, 3));
  }

  // ── 4. Fixture Events (goals, cards, subs) ────────────────────────────────
  if (sampleFixtureId) {
    section(`4. FIXTURE EVENTS (fixture ${sampleFixtureId})`);
    const events = await api(`/fixtures/events?fixture=${sampleFixtureId}`);
    console.log('Total events:', events.response?.length);
    console.log('Errors:', events.errors);
    if (events.response?.length > 0) {
      console.log('\nSample events (first 3):');
      preview(events.response.slice(0, 3));
    } else {
      console.log('RAW:', JSON.stringify(events).slice(0, 500));
    }

    // ── 5. Fixture Lineups ─────────────────────────────────────────────────
    section(`5. FIXTURE LINEUPS (fixture ${sampleFixtureId})`);
    const lineups = await api(`/fixtures/lineups?fixture=${sampleFixtureId}`);
    console.log('Teams returned:', lineups.response?.length);
    console.log('Errors:', lineups.errors);
    if (lineups.response?.length > 0) {
      console.log('\nSample lineup (team 1):');
      preview(lineups.response[0]);
    } else {
      console.log('RAW:', JSON.stringify(lineups).slice(0, 500));
    }

    // ── 6. CRITICAL: Fixture Player Stats ─────────────────────────────────
    section(`6. *** FIXTURE PLAYER STATS *** (fixture ${sampleFixtureId})`);
    console.log('This is the most important test — checks if deep per-player stats exist for PSL');
    const playerStats = await api(`/fixtures/players?fixture=${sampleFixtureId}`);
    console.log('Teams returned:', playerStats.response?.length);
    console.log('Errors:', playerStats.errors);
    if (playerStats.response?.length > 0) {
      const team1 = playerStats.response[0];
      console.log('\nTeam:', team1.team?.name);
      console.log('Players count:', team1.players?.length);
      if (team1.players?.length > 0) {
        console.log('\nSample player stats (first player):');
        preview(team1.players[0]);
        console.log('\n✅ ALL STAT FIELDS AVAILABLE:');
        const statKeys = Object.keys(team1.players[0]?.statistics?.[0] || {});
        statKeys.forEach(k => {
          const val = team1.players[0]?.statistics?.[0]?.[k];
          console.log(`  ${k}:`, JSON.stringify(val));
        });
      }
    } else {
      console.log('⚠️  NO PLAYER STATS RETURNED — PSL may not have deep coverage for this fixture');
      console.log('RAW:', JSON.stringify(playerStats).slice(0, 500));
    }
  }

  // ── 7. Season Player Stats (AmaZulu) ──────────────────────────────────────
  section(`7. SEASON PLAYER STATS — AmaZulu (team ${AMAZULU_TEAM_ID})`);
  const seasonStats = await api(`/players?team=${AMAZULU_TEAM_ID}&season=${PSL_SEASON}&league=${PSL_LEAGUE}`);
  console.log('Players returned (page 1):', seasonStats.response?.length);
  console.log('Total pages:', seasonStats.paging?.total);
  console.log('Errors:', seasonStats.errors);
  if (seasonStats.response?.length > 0) {
    console.log('\nSample player season stats:');
    preview(seasonStats.response[0]);
    console.log('\n✅ ALL STAT FIELDS FOR FIRST PLAYER:');
    const stats = seasonStats.response[0]?.statistics?.[0];
    if (stats) {
      Object.entries(stats).forEach(([category, values]) => {
        console.log(`\n  [${category}]`);
        if (typeof values === 'object' && values !== null) {
          Object.entries(values).forEach(([k, v]) => console.log(`    ${k}: ${v}`));
        }
      });
    }
  } else {
    console.log('RAW:', JSON.stringify(seasonStats).slice(0, 500));
  }

  // ── 8. Top Scorers ─────────────────────────────────────────────────────────
  section('8. TOP SCORERS');
  const topScorers = await api(`/players/topscorers?league=${PSL_LEAGUE}&season=${PSL_SEASON}`);
  console.log('Top scorers returned:', topScorers.response?.length);
  console.log('Errors:', topScorers.errors);
  if (topScorers.response?.length > 0) {
    console.log('\nTop 3:');
    topScorers.response.slice(0, 3).forEach((p, i) => {
      console.log(`  ${i+1}. ${p.player?.name} (${p.statistics?.[0]?.team?.name}) — ${p.statistics?.[0]?.goals?.total} goals`);
    });
  }

  // ── 9. Squad (AmaZulu) ────────────────────────────────────────────────────
  section(`9. SQUAD — AmaZulu (team ${AMAZULU_TEAM_ID})`);
  const squad = await api(`/players/squads?team=${AMAZULU_TEAM_ID}`);
  console.log('Errors:', squad.errors);
  if (squad.response?.length > 0) {
    const players = squad.response[0]?.players;
    console.log('Squad size:', players?.length);
    console.log('\nAll players:');
    players?.forEach(p => {
      console.log(`  ID:${p.id} | ${p.name} | Age:${p.age} | ${p.position} | #${p.number}`);
    });
  } else {
    console.log('RAW:', JSON.stringify(squad).slice(0, 500));
  }

  // ── 10. All PSL Teams ──────────────────────────────────────────────────────
  section('10. ALL PSL TEAMS');
  const teams = await api(`/teams?league=${PSL_LEAGUE}&season=${PSL_SEASON}`);
  console.log('Teams returned:', teams.response?.length);
  console.log('Errors:', teams.errors);
  if (teams.response?.length > 0) {
    console.log('\nAll teams with IDs:');
    teams.response.forEach(t => {
      console.log(`  ID:${t.team?.id} | ${t.team?.name} | ${t.venue?.name}`);
    });
  }

  // ── 11. Injuries ──────────────────────────────────────────────────────────
  section('11. INJURIES / SUSPENSIONS');
  const injuries = await api(`/injuries?league=${PSL_LEAGUE}&season=${PSL_SEASON}`);
  console.log('Injuries returned:', injuries.response?.length);
  console.log('Errors:', injuries.errors);
  if (injuries.response?.length > 0) {
    console.log('\nSample injury:');
    preview(injuries.response[0]);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  section('DIAGNOSTIC COMPLETE');
  console.log('Check the output above for:');
  console.log('  ✅ /standings          — table data');
  console.log('  ✅ /fixtures           — fixture IDs, dates, rounds');
  console.log('  ✅ /fixtures/events    — goals, cards, subs per match');
  console.log('  ✅ /fixtures/lineups   — starting XI per match');
  console.log('  ⚠️  /fixtures/players  — CRITICAL: deep per-player stats (check if populated)');
  console.log('  ✅ /players            — season totals per player');
  console.log('  ✅ /players/topscorers — goals ranking');
  console.log('  ✅ /players/squads     — current squad list');
  console.log('  ✅ /teams              — all team IDs');
  console.log('  ✅ /injuries           — injured/suspended players');
}

// ─── Entry point ─────────────────────────────────────────────────────────────
// Works both as a standalone Node script and as a Vercel serverless function

if (typeof module !== 'undefined' && require.main === module) {
  // Running as: node apifootball-psl-diagnostic.js
  runDiagnostic().catch(console.error);
} else {
  // Running as Vercel serverless function
  module.exports = async (req, res) => {
    if (req.query.secret !== 'psldiag2025') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // Capture console output
    const logs = [];
    const orig = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); orig(...args); };
    try {
      await runDiagnostic();
    } catch (e) {
      logs.push('ERROR: ' + e.message);
    }
    console.log = orig;
    res.setHeader('Content-Type', 'text/plain');
    res.send(logs.join('\n'));
  };
}
