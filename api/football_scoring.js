// ══════════════════════════════════════════════════════════════════════════
// api/football_scoring.js  —  Fantasy PSL  —  Points Engine
// ══════════════════════════════════════════════════════════════════════════
// Single source of truth for all fantasy points calculations.
// Used by both points-cron.js and football.js
// ══════════════════════════════════════════════════════════════════════════

function calculateFantasyPoints(s) {
  var breakdown = {}, total = 0;
  function add(key, val) { if (val !== 0) { breakdown[key] = val; total += val; } }

  if (s.minutes === 0) return { total: 0, breakdown: { appearance: 0 } };

  add('appearance', s.minutes >= 60 ? 2 : 1);

  if (s.goals > 0) {
    var gPts = (s.pos === 'GK' || s.pos === 'DEF') ? 6 : s.pos === 'MID' ? 5 : 4;
    add('goals', s.goals * gPts);
  }
  if (s.assists > 0)      add('assists',        s.assists      * 3);
  if (s.minutes >= 60 && s.goalsConceded === 0) {
    if (s.pos === 'GK' || s.pos === 'DEF') add('clean_sheet', 4);
    else if (s.pos === 'MID')              add('clean_sheet', 1);
  }
  if ((s.pos === 'GK' || s.pos === 'DEF') && s.goalsConceded >= 2)
    add('goals_conceded', -Math.floor(s.goalsConceded / 2));
  if (s.pos === 'GK' && s.saves >= 3)
    add('saves_bonus', Math.floor(s.saves / 3));
  if (s.penSaved  > 0) add('penalty_saved',  s.penSaved  *  5);
  if (s.penMissed > 0) add('penalty_missed', s.penMissed * -2);
  if (s.yellowCards > 0) add('yellow_card', s.yellowCards * -1);
  if (s.redCards    > 0) add('red_card',    s.redCards    * -3);

  return { total, breakdown };
}

function normalisePosition(raw) {
  if (!raw) return 'MID';
  var r = raw.toUpperCase().trim();
  if (r === 'GK' || r === 'G' || r.includes('GOAL')) return 'GK';
  if (r === 'DEF' || r === 'D' || r.includes('DEF')) return 'DEF';
  if (r === 'MID' || r === 'M' || r.includes('MID')) return 'MID';
  if (r === 'FWD' || r === 'F' || r.includes('ATT') || r.includes('FOR')) return 'FWD';
  return 'MID';
}

module.exports = { calculateFantasyPoints, normalisePosition };
