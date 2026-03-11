// psl-data.js — Vercel/Netlify Serverless Function
// Scrapes Goal.com for PSL fixtures, standings, top scorers, news
// Falls back to hardcoded data if scraping fails

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  const type = (req.query && req.query.type) || 'full';

  try {
    if (type === 'live') {
      const liveData = await fetchLiveScores();
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
      return res.json(liveData);
    }

    // Full bundle — fixtures + table + stats + news
    const [fixtureData, tableData, statsData, newsData] = await Promise.allSettled([
      fetchGoalFixtures(),
      fetchGoalTable(),
      fetchGoalStats(),
      fetchGoalNews()
    ]);

    const bundle = buildBundle(
      fixtureData.status === 'fulfilled' ? fixtureData.value : null,
      tableData.status  === 'fulfilled' ? tableData.value  : null,
      statsData.status  === 'fulfilled' ? statsData.value  : null,
      newsData.status   === 'fulfilled' ? newsData.value   : null
    );

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.json(bundle);

  } catch (err) {
    console.error('[psl-data] Error:', err.message);
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.json(getFallback());
  }
};

// ── FETCH HELPERS ─────────────────────────────────────────────────────────

const GOAL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-ZA,en;q=0.9',
  'Referer': 'https://www.google.co.za/'
};

async function goalFetch(url) {
  const r = await fetch(url, { headers: GOAL_HEADERS, redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  return r.text();
}

// ── FIXTURES & RESULTS ────────────────────────────────────────────────────

async function fetchGoalFixtures() {
  const html = await goalFetch('https://www.goal.com/en-za/psl/fixtures-results/yv73ms6v1995b5wny16jcfi3');
  return parseFixtures(html);
}

function parseFixtures(html) {
  const results = [];
  const upcoming = [];
  const live = [];

  // Game Week detection from page heading tabs
  const gwMatch = html.match(/Game Week (\d+)[^\d]/g) || [];
  // Detect current GW from the active tab
  const activeGW = (() => {
    const m = html.match(/class="[^"]*active[^"]*"[^>]*>Game Week (\d+)/);
    return m ? parseInt(m[1]) : null;
  })();

  // Parse date headings and match rows
  // Goal.com format: date heading then match rows with team names, badges, scores
  const dateBlocks = html.split(/(?=\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\d+\s+(?:January|February|March|April|May|June|July|August|September|October|November|December))/);

  dateBlocks.forEach(function(block) {
    const dateMatch = block.match(/^(\w+)\s+(\d+)\s+(\w+)/);
    if (!dateMatch) return;
    const dateStr = dateMatch[1] + ' ' + dateMatch[2] + ' ' + dateMatch[3] + ' 2026';
    const isoDate = parseGoalDate(dateStr);

    // Extract match rows - each has 2 team names, score or time
    // Pattern: team name — badge img — score/time — badge img — team name
    const matchPattern = /\/en-za\/match\/([^/]+)\/([\w-]+)/g;
    let matchLink;
    const matchSlugs = [];
    while ((matchLink = matchPattern.exec(block)) !== null) {
      matchSlugs.push({ slug: matchLink[1], id: matchLink[2] });
    }

    // Extract teams from badge alt text and team name spans
    const teamPattern = /([A-Z][^<]{2,40}?)\s*\n\s*([A-Z]{2,4})\s*\n[\s\S]{1,200}?([A-Z][^<]{2,40}?)\s*\n\s*([A-Z]{2,4})/g;

    // Simpler: extract all team crest + name combos
    const allTeamMatches = [...block.matchAll(/badge"[^>]*>\n\s*\n([^\n]+)\n\s*\n([A-Z]{2,4})/g)];

    // Time pattern: HH:MM
    const timeMatches = [...block.matchAll(/(\d{2}:\d{2})/g)];
    // Score pattern: digit-digit
    const scoreMatches = [...block.matchAll(/(\d+)-(\d+)/g)];

    // Best approach: split block by anchor links to /en-za/match/
    const matchBlocks = block.split('/en-za/match/').slice(1);

    matchBlocks.forEach(function(mb) {
      // Extract home/away from crest badge alt text
      const teamNames = [];
      const badgePattern = /badge"[^>]*?>\s*([A-Za-z][^<]{2,40}?)\s*badge/g;
      const abbrevs = [];
      const abbrevPat = /\n([A-Z]{2,4})\n/g;
      let am;
      while ((am = abbrevPat.exec(mb)) !== null && abbrevs.length < 2) {
        abbrevs.push(am[1]);
      }

      // Match lines with 3-4 word team names using newline separation
      const lines = mb.split('\n').map(s => s.trim()).filter(Boolean);
      const teamLineIdx = [];
      lines.forEach(function(line, i) {
        if (/^[A-Z][a-zA-Z ]{2,35}(FC|United|City|Bay|Stars|Galaxy|Arrows|Swallows|Gallants|College)$/.test(line.trim()) ||
            /^(Orlando Pirates|Kaizer Chiefs|Mamelodi Sundowns FC|AmaZulu FC|Chippa United|TS Galaxy|Siwelele|Stellenbosch FC|Richards Bay|Polokwane City|Sekhukhune United|Durban City|Marumo Gallants|Orbit College|Magesi FC|Lamontville Golden Arrows)$/.test(line.trim())) {
          teamLineIdx.push(i);
        }
      });

      if (teamLineIdx.length < 2) return;
      const home = lines[teamLineIdx[0]];
      const away = lines[teamLineIdx[1]];
      if (!home || !away || home === away) return;

      // Find score or time
      const scoreMatch = mb.match(/(\d+)\s*\n\s*(\d+)/);
      const timeMatch  = mb.match(/(\d{2}:\d{2})/);
      const isLive     = /LIVE|1H|2H|HT/.test(mb);

      const fixture = {
        date: isoDate,
        home: normaliseTeamName(home),
        away: normaliseTeamName(away),
        hg: scoreMatch ? parseInt(scoreMatch[1]) : null,
        ag: scoreMatch ? parseInt(scoreMatch[2]) : null,
        time: timeMatch ? timeMatch[1] : null,
        status: scoreMatch ? 'FT' : (isLive ? 'LIVE' : 'NS'),
        isLive: isLive
      };

      if (isLive) live.push(fixture);
      else if (fixture.hg !== null) results.push(fixture);
      else upcoming.push(fixture);
    });
  });

  return { FT: results, NS: upcoming, live, activeGW };
}

// ── STANDINGS TABLE ───────────────────────────────────────────────────────

async function fetchGoalTable() {
  const html = await goalFetch('https://www.goal.com/en-za/psl/table/yv73ms6v1995b5wny16jcfi3');
  return parseTable(html);
}

function parseTable(html) {
  const table = [];
  // Goal.com table rows: | Pos | Team name | crest | P | W | D | L | F | A | +/- | PTS | Form |
  const rowPattern = /\|(\s*\d+\s*)\|[\s\S]*?\[([^\]]+)\][^|]+\|[\s\S]*?\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([-+]?\d+)\s*\|\s*(\d+)\s*\|/g;
  let m;
  while ((m = rowPattern.exec(html)) !== null) {
    table.push({
      pos: parseInt(m[1]),
      team: normaliseTeamName(m[2].split(' crest')[0].trim()),
      p: parseInt(m[3]), w: parseInt(m[4]), d: parseInt(m[5]), l: parseInt(m[6]),
      gf: parseInt(m[7]), ga: parseInt(m[8]), gd: parseInt(m[9]), pts: parseInt(m[10])
    });
  }

  // Fallback: line-based parsing
  if (!table.length) {
    const lines = html.split('\n').map(s => s.trim()).filter(Boolean);
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
      const posMatch = lines[i].match(/^(\d+)$/);
      if (posMatch && parseInt(posMatch[1]) === pos + 1) {
        pos = parseInt(posMatch[1]);
        // Next few lines should be team name, then numbers
        const nums = [];
        for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
          if (/^\d+$/.test(lines[j])) nums.push(parseInt(lines[j]));
          if (nums.length === 8) break;
        }
        if (nums.length >= 8) {
          // Find team name line
          let teamName = '';
          for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
            if (/[A-Z][a-z]/.test(lines[j]) && lines[j].length > 3 && !/^\d/.test(lines[j]) && !/crest/.test(lines[j])) {
              teamName = lines[j].replace(/ crest.*$/, '').trim();
              break;
            }
          }
          if (teamName) {
            table.push({ pos, team: normaliseTeamName(teamName), p: nums[0], w: nums[1], d: nums[2], l: nums[3], gf: nums[4], ga: nums[5], gd: nums[6], pts: nums[7] });
          }
        }
      }
    }
  }
  return table;
}

// ── PLAYER STATS ──────────────────────────────────────────────────────────

async function fetchGoalStats() {
  const html = await goalFetch('https://www.goal.com/en-za/premier-soccer-league/top-players/yv73ms6v1995b5wny16jcfi3');
  return parseStats(html);
}

function parseStats(html) {
  const scorers  = [];
  const assisters = [];

  // Goal.com stats: ordered list items with player name and count
  // Pattern: "* [rank] [club crest] [Name] [count]"
  const statBlock = (section) => {
    const idx = html.indexOf(section);
    if (idx === -1) return [];
    const block = html.substring(idx, idx + 3000);
    const results = [];
    const lines = block.split('\n').map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      // Lines starting with * [num] have rank
      const rankMatch = lines[i].match(/^\*?\s*\[?(\d+)\]?$/);
      if (rankMatch) {
        let name = '', count = 0, club = '';
        // Skip img/badge lines, find the name line
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const line = lines[j];
          if (/\d+$/.test(line) && count === 0 && /^[A-Z]/.test(line)) {
            // "J. Dion\n\n10" style
            const parts = line.match(/^(.+?)\s+(\d+)$/);
            if (parts) { name = parts[1].trim(); count = parseInt(parts[2]); break; }
          }
          if (/^[A-Z][\. A-Za-z]+$/.test(line) && line.length > 3 && !line.includes('badge')) {
            name = line;
          }
          if (/^\d+$/.test(line) && name && count === 0) {
            count = parseInt(line);
            break;
          }
        }
        if (name && count > 0) results.push({ name, count });
      }
    }
    return results;
  };

  // Better parse: use the markdown-style output we confirmed above
  // "* [1\n  ![](crest.png)J. Dion\n\n  10]"
  const goalBlock = html.indexOf('### Top scorers');
  const assistBlock = html.indexOf('### Assists');

  const parseList = (startIdx, endIdx) => {
    const seg = html.substring(startIdx, endIdx > startIdx ? endIdx : startIdx + 4000);
    const items = [];
    // Match: "* [rank\n  ![](badge)Name\n  \n  Count]"
    const re = /\*\s*\[(\d+)\s*\n[\s\S]*?\)([A-Z][^\n]+?)\n[\s\S]*?\n\s*(\d+)\]/g;
    let m;
    while ((m = re.exec(seg)) !== null) {
      items.push({ rank: parseInt(m[1]), name: m[2].trim(), count: parseInt(m[3]) });
    }
    // Simpler fallback for plain text rendering
    if (!items.length) {
      const lines = seg.split('\n').map(s => s.trim());
      for (let i = 0; i < lines.length; i++) {
        if (/^\* \[/.test(lines[i]) || /^\d+$/.test(lines[i])) {
          let name = '', count = 0;
          const nameL = lines[i+2] || '';
          const countL = lines[i+3] || '';
          if (/^[A-Z]/.test(nameL)) name = nameL;
          if (/^\d+$/.test(countL)) count = parseInt(countL);
          if (!count && /\d+$/.test(nameL)) {
            const p = nameL.match(/^(.+?)\s+(\d+)$/);
            if (p) { name = p[1]; count = parseInt(p[2]); }
          }
          if (name && count > 0) items.push({ name, count });
        }
      }
    }
    return items;
  };

  // Parse top scorers and assists
  if (goalBlock > -1) {
    const goals = parseList(goalBlock, assistBlock > -1 ? assistBlock : goalBlock + 3000);
    goals.forEach(g => scorers.push(g));
  }
  if (assistBlock > -1) {
    const assists = parseList(assistBlock, assistBlock + 3000);
    assists.forEach(a => assisters.push(a));
  }

  return { scorers, assisters };
}

// ── NEWS ──────────────────────────────────────────────────────────────────

async function fetchGoalNews() {
  const html = await goalFetch('https://www.goal.com/en-za/premier-soccer-league/news/yv73ms6v1995b5wny16jcfi3');
  return parseNews(html);
}

function parseNews(html) {
  const news = [];
  // Match: [### Title](url) pattern with optional image
  const articlePattern = /\[###\s+([^\]]+?)\]\((\/en-za\/[^)]+)\)/g;
  const imgPattern     = /\[!\[[^\]]*\]\(([^)]+assets\.goal\.com[^)]+)\)\]\((\/en-za\/[^)]+)\)/g;

  // Extract articles with images first
  const imgArticles = {};
  let im;
  while ((im = imgPattern.exec(html)) !== null) {
    imgArticles[im[2]] = im[1]; // url -> img
  }

  let m;
  while ((m = articlePattern.exec(html)) !== null && news.length < 15) {
    const title = m[1].trim();
    const relUrl = m[2].trim();
    const url = 'https://www.goal.com' + relUrl;
    const img = imgArticles[relUrl] || null;

    // Find snippet after article title (next 2-3 lines)
    const titleIdx = html.indexOf('[### ' + title + ']');
    let snippet = '';
    if (titleIdx > -1) {
      const after = html.substring(titleIdx + title.length + 10, titleIdx + 600);
      const snippetMatch = after.match(/\n\n([A-Z][^\n]{20,200})/);
      if (snippetMatch) snippet = snippetMatch[1].substring(0, 120) + '…';
    }

    news.push({
      source: 'Goal.com',
      title,
      url,
      img,
      snippet,
      date: new Date().toISOString()
    });
  }

  return news;
}

// ── LIVE SCORES (60s poll) ────────────────────────────────────────────────

async function fetchLiveScores() {
  try {
    const html = await goalFetch('https://www.goal.com/en-za/psl/fixtures-results/yv73ms6v1995b5wny16jcfi3');
    const parsed = parseFixtures(html);
    return { live: parsed.live || [], isLive: (parsed.live || []).length > 0 };
  } catch (e) {
    return { live: [], isLive: false };
  }
}

// ── BUNDLE ASSEMBLER ──────────────────────────────────────────────────────

function buildBundle(fixtureData, tableData, statsData, newsData) {
  const now = new Date();
  // Determine current game week from fixtures
  const currentGW = (fixtureData && fixtureData.activeGW) ||
                    calculateCurrentGW(now);

  return {
    FT:          (fixtureData && fixtureData.FT)   || [],
    NS:          (fixtureData && fixtureData.NS)   || [],
    live:        (fixtureData && fixtureData.live) || [],
    isLive:      !!(fixtureData && fixtureData.live && fixtureData.live.length),
    table:       tableData || [],
    topScorers:  (statsData  && statsData.scorers)   || [],
    topAssists:  (statsData  && statsData.assisters) || [],
    news:        newsData || [],
    currentGW,
    lastUpdated: now.toISOString(),
    source:      'goal.com'
  };
}

function calculateCurrentGW(now) {
  // Season started August 2025, GW1 started ~10 Aug 2025
  // Each GW ~1 week
  const seasonStart = new Date('2025-08-10');
  const weeks = Math.floor((now - seasonStart) / (7 * 24 * 60 * 60 * 1000));
  return Math.max(1, Math.min(30, weeks + 1));
}

// ── UTILITY ───────────────────────────────────────────────────────────────

function normaliseTeamName(name) {
  const map = {
    'Lamontville Golden Arrows': 'Golden Arrows',
    'Mamelodi Sundowns FC': 'Mamelodi Sundowns',
    'Orlando Pirates': 'Orlando Pirates',
    'Kaizer Chiefs': 'Kaizer Chiefs',
    'Chippa United': 'Chippa United',
    'TS Galaxy': 'TS Galaxy',
    'Siwelele': 'Siwelele FC',
    'Stellenbosch FC': 'Stellenbosch FC',
    'Richards Bay': 'Richards Bay',
    'Polokwane City': 'Polokwane City',
    'Sekhukhune United': 'Sekhukhune United',
    'Durban City': 'Durban City',
    'Marumo Gallants': 'Marumo Gallants',
    'Orbit College': 'Orbit College FC',
    'Magesi FC': 'Magesi FC',
    'AmaZulu FC': 'AmaZulu FC',
  };
  return map[name] || name;
}

function parseGoalDate(str) {
  // "Thursday 12 March 2026" -> "2026-03-12"
  const months = { January:'01', February:'02', March:'03', April:'04', May:'05', June:'06',
                   July:'07', August:'08', September:'09', October:'10', November:'11', December:'12' };
  const m = str.match(/\d+\s+(\w+)\s+(\d{4})/);
  const d = str.match(/\b(\d+)\b/);
  if (!m || !d) return new Date().toISOString().split('T')[0];
  const day = d[0].padStart(2, '0');
  const mon = months[m[1]] || '01';
  return m[2] + '-' + mon + '-' + day;
}

// ── FALLBACK (hardcoded) ──────────────────────────────────────────────────

function getFallback() {
  return {
    FT: [], NS: [], live: [], isLive: false,
    table: FALLBACK_TABLE,
    topScorers: FALLBACK_SCORERS,
    topAssists: FALLBACK_ASSISTS,
    news: [],
    currentGW: 17,
    lastUpdated: new Date().toISOString(),
    source: 'fallback'
  };
}

const FALLBACK_TABLE = [
  { pos:1, team:'Orlando Pirates',     p:19, w:14, d:2, l:3,  gf:31, ga:8,  gd:23,  pts:44 },
  { pos:2, team:'Mamelodi Sundowns',   p:19, w:13, d:5, l:1,  gf:32, ga:10, gd:22,  pts:44 },
  { pos:3, team:'Sekhukhune United',   p:20, w:9,  d:6, l:5,  gf:21, ga:14, gd:7,   pts:33 },
  { pos:4, team:'Durban City',         p:20, w:9,  d:5, l:6,  gf:19, ga:14, gd:5,   pts:32 },
  { pos:5, team:'AmaZulu FC',          p:20, w:9,  d:4, l:7,  gf:19, ga:18, gd:1,   pts:31 },
  { pos:6, team:'Kaizer Chiefs',       p:18, w:8,  d:6, l:4,  gf:16, ga:12, gd:4,   pts:30 },
  { pos:7, team:'Polokwane City',      p:19, w:7,  d:7, l:5,  gf:16, ga:13, gd:3,   pts:28 },
  { pos:8, team:'TS Galaxy',           p:20, w:7,  d:3, l:10, gf:23, ga:22, gd:1,   pts:24 },
  { pos:9, team:'Richards Bay',        p:19, w:5,  d:8, l:6,  gf:15, ga:19, gd:-4,  pts:23 },
  { pos:10, team:'Stellenbosch FC',    p:19, w:6,  d:5, l:8,  gf:15, ga:20, gd:-5,  pts:23 },
  { pos:11, team:'Siwelele FC',        p:19, w:5,  d:7, l:7,  gf:10, ga:14, gd:-4,  pts:22 },
  { pos:12, team:'Golden Arrows',      p:19, w:6,  d:3, l:10, gf:24, ga:24, gd:0,   pts:21 },
  { pos:13, team:'Chippa United',      p:20, w:4,  d:7, l:9,  gf:14, ga:24, gd:-10, pts:19 },
  { pos:14, team:'Marumo Gallants',    p:20, w:4,  d:6, l:10, gf:15, ga:26, gd:-11, pts:18 },
  { pos:15, team:'Orbit College FC',   p:19, w:3,  d:4, l:12, gf:12, ga:32, gd:-20, pts:13 },
  { pos:16, team:'Magesi FC',          p:16, w:2,  d:6, l:8,  gf:10, ga:20, gd:-10, pts:12 }
];

const FALLBACK_SCORERS  = [
  { name:'J. Dion',         count:10 }, { name:'I. Rayners', count:9  },
  { name:'B. Grobler',      count:8  }, { name:'L. Phili',   count:7  },
  { name:'S. Mahlambi',     count:6  }, { name:'P. Maswanganyi', count:6 },
  { name:'F. Silva',        count:5  }
];
const FALLBACK_ASSISTS = [
  { name:'D. Hotto',        count:5  }, { name:'P. Khumalo',  count:5 },
  { name:'R. Mofokeng',     count:5  }, { name:'S. Ndlovu',   count:5 },
  { name:'O. Appollis',     count:4  }
];
