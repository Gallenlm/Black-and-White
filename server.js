const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const APISPORTS_KEY = process.env.APISPORTS_KEY;

const ODDS_SPORT = process.env.ODDS_SPORT || "basketball_nba";
const ODDS_REGION = process.env.ODDS_REGION || "us";
const APISPORTS_BASE =
  process.env.APISPORTS_BASE || "https://v1.basketball.api-sports.io";

app.get("/", async (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Live Scores + Odds</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #222; }
    h1 { margin-bottom: 8px; }
    .note { color: #666; margin-bottom: 16px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background: #f5f5f5; }
    tr:nth-child(even) { background: #fafafa; }
    .muted { color: #777; }
  </style>
</head>
<body>
  <h1>Live Scores + Pre-Game Odds</h1>
  <div class="note">Auto-refreshes every 30 seconds.</div>
  <table>
    <thead>
      <tr>
        <th>Matchup</th>
        <th>Live Score</th>
        <th>Home Moneyline</th>
        <th>Away Moneyline</th>
      </tr>
    </thead>
    <tbody id="board">
      <tr><td colspan="4" class="muted">Loading...</td></tr>
    </tbody>
  </table>

  <script>
    async function loadBoard() {
      const tbody = document.getElementById('board');
      try {
        const res = await fetch('/api/board');
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" class="muted">No games found.</td></tr>';
          return;
        }
        tbody.innerHTML = data.map(game => {
          const matchup = game.homeTeam + ' vs ' + game.awayTeam;
          const score = game.liveScore || 'Pregame';
          const homeOdds = game.homeOdds ?? '—';
          const awayOdds = game.awayOdds ?? '—';
          return '<tr>' +
            '<td>' + matchup + '</td>' +
            '<td>' + score + '</td>' +
            '<td>' + homeOdds + '</td>' +
            '<td>' + awayOdds + '</td>' +
          '</tr>';
        }).join('');
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="4" class="muted">Error loading data.</td></tr>';
      }
    }

    loadBoard();
    setInterval(loadBoard, 30000);
  </script>
</body>
</html>`);
});

function normalizeTeam(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function teamKeySet(name) {
  const normalized = normalizeTeam(name);
  const tokens = normalized.split(" ").filter(Boolean);
  const nickname = tokens.length ? tokens[tokens.length - 1] : "";
  return new Set([normalized, nickname].filter(Boolean));
}

function extractScore(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object") {
    const keys = ["total", "points", "score", "runs", "goals"];
    for (const key of keys) {
      const candidate = extractScore(value[key]);
      if (candidate != null) {
        return candidate;
      }
    }
    for (const candidate of Object.values(value)) {
      const parsed = extractScore(candidate);
      if (parsed != null) {
        return parsed;
      }
    }
  }
  return null;
}

async function fetchOdds() {
  if (!ODDS_API_KEY) {
    return { error: "Missing ODDS_API_KEY", games: [] };
  }
  const url = new URL(`https://api.the-odds-api.com/v4/sports/${ODDS_SPORT}/odds/`);
  url.searchParams.set("regions", ODDS_REGION);
  url.searchParams.set("markets", "h2h");
  url.searchParams.set("oddsFormat", "american");
  url.searchParams.set("dateFormat", "iso");
  url.searchParams.set("apiKey", ODDS_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    return { error: `Odds API error: ${res.status}`, games: [] };
  }
  const data = await res.json();
  const games = data.map((game) => {
    const market = game.bookmakers?.[0]?.markets?.find((m) => m.key === "h2h");
    const outcomes = market?.outcomes || [];
    const homeOutcome = outcomes.find((o) => o.name === game.home_team);
    const awayOutcome = outcomes.find((o) => o.name === game.away_team);
    return {
      homeTeam: game.home_team,
      awayTeam: game.away_team,
      homeOdds: homeOutcome ? homeOutcome.price : null,
      awayOdds: awayOutcome ? awayOutcome.price : null,
    };
  });
  return { games };
}

async function fetchLiveScores() {
  if (!APISPORTS_KEY) {
    return { error: "Missing APISPORTS_KEY", games: [] };
  }
  const url = `${APISPORTS_BASE}/games?live=all`;
  const res = await fetch(url, {
    headers: {
      "x-apisports-key": APISPORTS_KEY,
    },
  });
  if (!res.ok) {
    return { error: `API-Sports error: ${res.status}`, games: [] };
  }
  const data = await res.json();
  const games = (data.response || []).map((game) => {
    const homeTeam = game.teams?.home?.name;
    const awayTeam = game.teams?.away?.name;
    const homeScore = extractScore(game.scores?.home);
    const awayScore = extractScore(game.scores?.away);
    const status = game.status?.short || game.status?.long || "";
    const isLive = Boolean(status);
    return {
      homeTeam,
      awayTeam,
      liveScore:
        isLive && homeScore != null && awayScore != null
          ? `${homeScore} - ${awayScore}`
          : null,
    };
  });
  return { games };
}

app.get("/api/board", async (req, res) => {
  try {
    const [oddsResult, liveResult] = await Promise.all([
      fetchOdds(),
      fetchLiveScores(),
    ]);

    const liveGames = liveResult.games || [];

    const merged = (oddsResult.games || []).map((oddsGame) => {
      const oddsHomeKeys = teamKeySet(oddsGame.homeTeam);
      const oddsAwayKeys = teamKeySet(oddsGame.awayTeam);
      const liveGame = liveGames.find((live) => {
        const liveHomeKeys = teamKeySet(live.homeTeam);
        const liveAwayKeys = teamKeySet(live.awayTeam);
        const homeMatch = [...oddsHomeKeys].some((key) => liveHomeKeys.has(key));
        const awayMatch = [...oddsAwayKeys].some((key) => liveAwayKeys.has(key));
        const swappedHomeMatch = [...oddsHomeKeys].some((key) =>
          liveAwayKeys.has(key)
        );
        const swappedAwayMatch = [...oddsAwayKeys].some((key) =>
          liveHomeKeys.has(key)
        );
        return (homeMatch && awayMatch) || (swappedHomeMatch && swappedAwayMatch);
      });

      return {
        homeTeam: oddsGame.homeTeam,
        awayTeam: oddsGame.awayTeam,
        homeOdds: oddsGame.homeOdds,
        awayOdds: oddsGame.awayOdds,
        liveScore: liveGame ? liveGame.liveScore : null,
      };
    });

    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
