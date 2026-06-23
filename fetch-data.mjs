// fetch-data.mjs
// Runs in GitHub Actions (server-side). Uses ANTHROPIC_API_KEY from repo secrets.
// Writes ./data.json and ./<team>-squad.json / <team>-lineup.json (all in repo root)

import fs from "fs";
import path from "path";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY environment variable.");
  process.exit(1);
}

const DATA_DIR = process.cwd();
const TEAMS_DIR = process.cwd();
fs.mkdirSync(TEAMS_DIR, { recursive: true });

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function extractJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{");
  const e = clean.lastIndexOf("}");
  return JSON.parse(clean.slice(s, e + 1));
}

async function callClaude(prompt, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return extractJSON(text);
}

async function fetchWCData() {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `You are a World Cup 2026 data assistant. Today is ${today}.

Return ONLY a valid JSON object (no markdown, no explanation) with this exact structure:

{
  "updatedAt": "Jun 23, 2026",
  "matches": [
    {
      "status": "live|final|upcoming",
      "group": "Group X",
      "team1": { "name": "France", "flag": "🇫🇷", "score": "2" },
      "team2": { "name": "Iraq", "flag": "🇮🇶", "score": "0" },
      "venue": "Philadelphia",
      "time": "Jun 22, 11pm CEST",
      "minute": "67'"
    }
  ],
  "topScorers": [
    { "rank": 1, "name": "Lionel Messi", "country": "Argentina", "flag": "🇦🇷", "goals": 3 }
  ],
  "groups": [
    {
      "name": "Group A",
      "teams": [
        { "flag": "🇲🇽", "name": "Mexico", "p": 2, "w": 2, "d": 0, "l": 0, "pts": 6, "qualify": true }
      ]
    }
  ]
}

Use real World Cup 2026 data. Include 10-14 matches (mix of final/live/upcoming sorted so live first, then upcoming, then recent finals). Include top 6-8 scorers sorted by goals desc. Include all 12 groups A through L with 4 teams each sorted by pts desc, top 2 qualify:true. minute field only present if status is live, otherwise omit it.`;

  return callClaude(prompt, 4000);
}

async function fetchTeamSquad(teamName) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Give me the full World Cup 2026 squad (26 players) for ${teamName}. Today is ${today}.
Return ONLY valid JSON (no markdown):
{
  "coach": "Didier Deschamps",
  "squad": [
    {"number":1,"name":"Mike Maignan","position":"GK","club":"AC Milan","caps":30},
    {"number":10,"name":"Kylian Mbappe","position":"FW","club":"Real Madrid","caps":85}
  ]
}
Include real players. Positions: GK, DF, MF, FW.`;
  return callClaude(prompt, 2000);
}

async function fetchTeamLineup(teamName) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Give me the expected or confirmed starting lineup for ${teamName} at the FIFA World Cup 2026. Today is ${today}.
Return ONLY valid JSON (no markdown):
{
  "formation": "4-3-3",
  "available": true,
  "note": "optional short note like 'Confirmed XI vs Iraq'",
  "lineup": {
    "gk": [{"number":1,"name":"Lloris","club":"LA Galaxy"}],
    "def": [{"number":5,"name":"Kounde","club":"Barcelona"},{"number":3,"name":"Theo","club":"AC Milan"},{"number":4,"name":"Upamecano","club":"Bayern Munich"},{"number":2,"name":"Pavard","club":"Inter Milan"}],
    "mid": [{"number":8,"name":"Tchouameni","club":"Real Madrid"},{"number":13,"name":"Camavinga","club":"Real Madrid"},{"number":10,"name":"Rabiot","club":"Juventus"}],
    "fwd": [{"number":7,"name":"Griezmann","club":"Atletico Madrid"},{"number":9,"name":"Giroud","club":"LA Galaxy"},{"number":11,"name":"Dembele","club":"PSG"}]
  }
}
If no lineup available yet set available:false and lineup to null.`;
  return callClaude(prompt, 2000);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("Fetching World Cup data…");
  const wcData = await fetchWCData();
  fs.writeFileSync(path.join(DATA_DIR, "data.json"), JSON.stringify(wcData, null, 2));
  console.log("Wrote data.json");

  // Collect unique team names from groups (only fetch squad/lineup for teams
  // actually in the groups table, to keep API usage bounded).
  const teamNames = new Set();
  (wcData.groups || []).forEach((g) => (g.teams || []).forEach((t) => teamNames.add(t.name)));

  console.log(`Fetching squad/lineup for ${teamNames.size} teams…`);
  for (const name of teamNames) {
    const fileSlug = slug(name);
    try {
      const squad = await fetchTeamSquad(name);
      fs.writeFileSync(path.join(TEAMS_DIR, `${fileSlug}-squad.json`), JSON.stringify(squad, null, 2));
      console.log(`  ✓ ${name} squad`);
    } catch (e) {
      console.error(`  ✗ ${name} squad failed: ${e.message}`);
    }
    await sleep(300); // small pause between calls

    try {
      const lineup = await fetchTeamLineup(name);
      fs.writeFileSync(path.join(TEAMS_DIR, `${fileSlug}-lineup.json`), JSON.stringify(lineup, null, 2));
      console.log(`  ✓ ${name} lineup`);
    } catch (e) {
      console.error(`  ✗ ${name} lineup failed: ${e.message}`);
    }
    await sleep(300);
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
