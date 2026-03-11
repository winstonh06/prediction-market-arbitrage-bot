// ==============================================================
//  odds.js — The Odds API: fetch sharp lines for comparison
// ==============================================================

import dotenv from "dotenv";
dotenv.config();
import fetch from "node-fetch";

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

const SPORTS = [
  "americanfootball_nfl",
  "basketball_nba",
  "baseball_mlb",
  "icehockey_nhl",
];

const SHARP_BOOKS = ["pinnacle", "betonlineag", "bovada"];

export async function getSharpLines() {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error("  [!] ODDS_API_KEY not set");
    return [];
  }

  const allGames = [];

  for (const sport of SPORTS) {
    try {
      const url =
        ODDS_API_BASE +
        "/sports/" + sport + "/odds" +
        "?apiKey=" + apiKey +
        "&regions=us,us2,eu" +
        "&markets=h2h,spreads,totals" +
        "&oddsFormat=american" +
        "&bookmakers=pinnacle,fanduel,draftkings,caesars,betonlineag,bovada";

      const res = await fetch(url);
      if (!res.ok) {
        const errText = await res.text();
        console.error("  [!] Odds API error (" + sport + "):", res.status, errText);
        continue;
      }

      const data = await res.json();

      // Check remaining quota
      const remaining = res.headers.get("x-requests-remaining");
      if (remaining) {
        console.log("  [ODDS API] " + sport + ": " + data.length + " games | Quota left: " + remaining);
      }

      for (const game of data) {
        allGames.push({
          id: game.id,
          sport: sport,
          sportClean: sport.replace("americanfootball_", "").replace("basketball_", "").replace("baseball_", "").replace("icehockey_", "").toUpperCase(),
          homeTeam: game.home_team,
          awayTeam: game.away_team,
          commence: game.commence_time,
          bookmakers: game.bookmakers || [],
        });
      }
    } catch (e) {
      console.error("  [!] Odds fetch error (" + sport + "):", e.message);
    }
  }

  return allGames;
}

// Extract the "true" probability from sharp books
export function getSharpProb(game, market, outcome) {
  // Find Pinnacle first, then other sharp books
  for (const sharpBook of SHARP_BOOKS) {
    const bk = game.bookmakers.find(b => b.key === sharpBook);
    if (!bk) continue;

    const mkt = bk.markets.find(m => m.key === market);
    if (!mkt) continue;

    const out = mkt.outcomes.find(o => o.name === outcome);
    if (!out) continue;

    // Convert American odds to implied probability
    const prob = americanToProb(out.price);
    return { prob, odds: out.price, book: sharpBook };
  }

  return null;
}

// Get FanDuel/Caesars price for comparison
export function getSoftPrice(game, market, outcome) {
  const softBooks = ["fanduel", "caesars"];
  const results = [];

  for (const softBook of softBooks) {
    const bk = game.bookmakers.find(b => b.key === softBook);
    if (!bk) continue;

    const mkt = bk.markets.find(m => m.key === market);
    if (!mkt) continue;

    const out = mkt.outcomes.find(o => o.name === outcome);
    if (!out) continue;

    results.push({
      book: softBook,
      odds: out.price,
      prob: americanToProb(out.price),
    });
  }

  return results;
}

function americanToProb(odds) {
  if (odds > 0) {
    return 100 / (odds + 100);
  } else {
    return Math.abs(odds) / (Math.abs(odds) + 100);
  }
}

export function probToAmerican(prob) {
  if (prob >= 0.5) {
    return Math.round(-100 * prob / (1 - prob));
  } else {
    return Math.round(100 * (1 - prob) / prob);
  }
}
