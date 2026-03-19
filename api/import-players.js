// api/import-players.js
// 100% Sportmonks — no more API-Football
// Imports full PSL squad with correct positions + realistic prices

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  const TOKEN = process.env.SPORTMONKS_TOKEN;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!TOKEN || !SB_URL || !SB_KEY) {
    return res.status(500).json({ error: "Missing SPORTMONKS_TOKEN or Supabase env vars" });
  }

  const supabase = createClient(SB_URL, SB_KEY);
  const BASE = "https://api.sportmonks.com/v3/football";
  const PSL = 806;

  try {
    // ── 1. Auto-detect current season ──
    let seasonId;
    const leagueRes = await fetch(`${BASE}/leagues/${PSL}?include=currentSeason&api_token=${TOKEN}`);
    const leagueData = await leagueRes.json();
    const cs = leagueData.data?.currentSeason || leagueData.data?.current_season;
    if (cs?.id) {
      seasonId = cs.id;
    } else {
      const seasonsRes = await fetch(`${BASE}/seasons?filters=seasonLeagues:${PSL}&api_token=${TOKEN}`);
      const seasonsData = await seasonsRes.json();
      seasonId = (seasonsData.data || []).find(s => s.is_current)?.id || seasonsData.data?.[0]?.id;
    }
    if (!seasonId) throw new Error("Could not detect current PSL season");

    // ── 2. Get all teams for the season ──
    const teamsRes = await fetch(`${BASE}/teams/season/${seasonId}?api_token=${TOKEN}`);
    const teamsData = await teamsRes.json();
    const teams = teamsData.data || [];

    let allPlayers = [];

    const normalisePosition = (raw) => {
      if (!raw) return "MID";
      const r = raw.toUpperCase().trim();
      if (r.includes("GOAL") || r === "GK" || r === "G") return "GK";
      if (r.includes("DEFEND") || r === "DEF" || r === "D" || r.includes("CB") || r.includes("LB") || r.includes("RB")) return "DEF";
      if (r.includes("FORWARD") || r.includes("STRIKER") || r === "FWD" || r === "F" || r.includes("ATT")) return "FWD";
      return "MID";
    };

    // ── 3. Fetch squad for every team ──
    for (const team of teams) {
      const squadRes = await fetch(`${BASE}/squads/teams/${team.id}?include=player.position&api_token=${TOKEN}`);
      const squadData = await squadRes.json();
      const squad = squadData.data || [];

      for (const entry of squad) {
        const p = entry.player || {};
        const posObj = entry.position || {};
        const rawPos = posObj.developer_name || posObj.name || "MID";
        const pos = normalisePosition(rawPos);

        const price = pos === "GK" ? 4.5 : pos === "DEF" ? 5.0 : pos === "MID" ? 6.0 : 6.5;

        allPlayers.push({
          api_player_id: String(p.id),
          display_name: p.display_name || p.name || "Unknown",
          team: team.name || "",
          position: pos,
          photo: p.image_path || null,
          price: price,
          is_available: true,
          updated_at: new Date().toISOString()
        });
      }
    }

    // ── 4. Upsert into Supabase (merge duplicates) ──
    const { error } = await supabase
      .from("players")
      .upsert(allPlayers, { onConflict: "api_player_id" });

    if (error) throw error;

    return res.json({
      success: true,
      season_id: seasonId,
      teams_processed: teams.length,
      players_imported: allPlayers.length
    });

  } catch (err) {
    console.error("[import-players]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
