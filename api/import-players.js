// api/import-players.js — 100% Sportmonks (replaces the old API-Football version)
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  const TOKEN = process.env.SPORTMONKS_TOKEN;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!TOKEN || !SB_URL || !SB_KEY) {
    return res.status(500).json({ error: "Missing env vars" });
  }

  const supabase = createClient(SB_URL, SB_KEY);
  const BASE = "https://api.sportmonks.com/v3/football";
  const PSL = 806;

  try {
    // Auto-detect current season
    let seasonId;
    const leagueRes = await fetch(`${BASE}/leagues/${PSL}?include=currentSeason&api_token=${TOKEN}`);
    const leagueData = await leagueRes.json();
    seasonId = leagueData.data?.currentSeason?.id || leagueData.data?.current_season?.id;

    if (!seasonId) {
      const seasonsRes = await fetch(`${BASE}/seasons?filters=seasonLeagues:${PSL}&api_token=${TOKEN}`);
      const seasonsData = await seasonsRes.json();
      seasonId = seasonsData.data?.[0]?.id;
    }
    if (!seasonId) throw new Error("Could not find season");

    // Get teams
    const teamsRes = await fetch(`${BASE}/teams/season/${seasonId}?api_token=${TOKEN}`);
    const teams = (await teamsRes.json()).data || [];

    let allPlayers = [];
    const normalisePosition = (raw) => {
      if (!raw) return "MID";
      const r = raw.toUpperCase().trim();
      if (r.includes("GOAL") || r === "GK") return "GK";
      if (r.includes("DEF")) return "DEF";
      if (r.includes("FWD") || r.includes("ATT") || r.includes("FOR")) return "FWD";
      return "MID";
    };

    for (const team of teams) {
      const squadRes = await fetch(`${BASE}/squads/teams/${team.id}?include=player.position&api_token=${TOKEN}`);
      const squadData = await squadRes.json();
      const squad = squadData.data || [];

      for (const entry of squad) {
        const p = entry.player || {};
        const pos = normalisePosition(entry.position?.name || entry.position?.developer_name);
        const price = pos === "GK" ? 4.5 : pos === "DEF" ? 5.0 : pos === "MID" ? 6.0 : 6.5;

        allPlayers.push({
          api_player_id: String(p.id),
          display_name: p.display_name || p.name,
          team: team.name,
          position: pos,
          photo: p.image_path,
          price,
          is_available: true,
          updated_at: new Date().toISOString()
        });
      }
    }

    const { error } = await supabase.from("players").upsert(allPlayers, { onConflict: "api_player_id" });
    if (error) throw error;

    return res.json({ success: true, players_imported: allPlayers.length, season_id: seasonId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
