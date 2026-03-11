// ==============================================================
//  index.js — Kalshi Sports +EV Bot
//  Finds +EV bets by comparing Kalshi prices vs sharp lines
//  Auto-bets on Kalshi, Telegram alerts for everything
// ==============================================================

import dotenv from "dotenv";
dotenv.config();

import { getBalance, getSportsMarkets, submitOrder } from "./kalshi.js";
import { getSharpLines, getSharpProb, getSoftPrice, probToAmerican } from "./odds.js";
import https from "https";

// ==============================================================
//  CONFIG
// ==============================================================

const DRY_RUN = true;               // SET TO false FOR LIVE TRADING
const BANKROLL_START = 100;
const SCAN_INTERVAL = 120000;        // 2 minutes — conserve API quota
const MIN_EV_PCT = 5;               // Minimum +EV percentage to trigger
const MIN_EDGE_CENTS = 5;           // Minimum edge in cents on Kalshi
const MAX_BET_PCT = 0.08;           // Max 8% of bankroll per bet
const DEDUP_MINUTES = 30;           // Don't re-bet same market for 30 min

let bankroll = BANKROLL_START;
let scanCount = 0;
let totalBets = 0;
let wins = 0;
let losses = 0;
const recentBets = {};  // ticker -> timestamp

// Kalshi sports series tickers to scan
const KALSHI_SPORTS = [
  "KXNBA", "KXNFL", "KXMLB", "KXNHL",
  "KXNBAPLAYOFFS", "KXNFLPLAYOFFS",
];

// ==============================================================
//  TELEGRAM
// ==============================================================

function sendTelegram(msg) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    const text = encodeURIComponent(msg);
    const url = "https://api.telegram.org/bot" + token + "/sendMessage?chat_id=" + chatId + "&text=" + text;
    https.get(url, () => {}).on("error", () => {});
  } catch (e) {}
}

function notify(msg) {
  const ts = new Date().toLocaleTimeString();
  const line = "[" + ts + "] " + msg;
  console.log("\n  >>>>> " + line + "\n");
  sendTelegram(line);
}

// ==============================================================
//  EV CALCULATION
// ==============================================================

function calculateEV(sharpProb, kalshiPrice, side) {
  // sharpProb = true probability (0-1)
  // kalshiPrice = price in cents (0-100)
  // Returns EV as percentage

  const pWin = side === "YES" ? sharpProb : 1 - sharpProb;
  const cost = kalshiPrice / 100;  // Convert cents to dollars
  const payout = 1.0;              // Kalshi pays $1 on win

  const ev = (pWin * payout) - cost;
  const evPct = (ev / cost) * 100;

  return {
    ev: parseFloat(ev.toFixed(4)),
    evPct: parseFloat(evPct.toFixed(1)),
    pWin: parseFloat((pWin * 100).toFixed(1)),
    cost: cost,
  };
}

function kellySize(pWin, price, bankrollNow) {
  const p = pWin;
  const q = 1 - p;
  const b = (100 - price) / price;  // Odds
  const kelly = (p * b - q) / b;
  const halfKelly = kelly / 2;
  const fraction = Math.max(0, Math.min(halfKelly, MAX_BET_PCT));
  const bet = bankrollNow * fraction;
  return parseFloat(Math.max(1, Math.min(bet, bankrollNow * MAX_BET_PCT)).toFixed(2));
}

// ==============================================================
//  MATCH KALSHI MARKETS TO ODDS API GAMES
// ==============================================================

function normalizeTeam(name) {
  // Normalize team names for fuzzy matching
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fuzzyMatch(kalshiTitle, game) {
  const title = normalizeTeam(kalshiTitle);
  const home = normalizeTeam(game.homeTeam);
  const away = normalizeTeam(game.awayTeam);

  // Check if both teams appear in the Kalshi market title
  const homeWords = home.split(" ");
  const awayWords = away.split(" ");

  const homeMatch = homeWords.some(w => w.length > 3 && title.includes(w));
  const awayMatch = awayWords.some(w => w.length > 3 && title.includes(w));

  return homeMatch && awayMatch;
}

// ==============================================================
//  MAIN SCAN
// ==============================================================

async function runScan() {
  scanCount++;
  console.log("\n[" + new Date().toLocaleTimeString() + "] Scan #" + scanCount);

  // Sync bankroll
  if (!DRY_RUN) {
    const bal = await getBalance();
    if (bal !== null) bankroll = bal;
  }
  console.log("  Bank: $" + bankroll.toFixed(2));

  // 1. Fetch sharp lines from Odds API
  console.log("  Fetching sharp lines...");
  const sharpGames = await getSharpLines();
  if (sharpGames.length === 0) {
    console.log("  No games found from Odds API");
    return;
  }
  console.log("  Found " + sharpGames.length + " games across all sports");

  // 2. Fetch Kalshi sports markets
  console.log("  Fetching Kalshi sports markets...");
  const kalshiMarkets = [];
  for (const series of KALSHI_SPORTS) {
    const markets = await getSportsMarkets(series);
    kalshiMarkets.push(...markets);
  }
  console.log("  Found " + kalshiMarkets.length + " Kalshi sports markets");

  if (kalshiMarkets.length === 0) return;

  // 3. Match Kalshi markets to Odds API games and find +EV
  let opportunitiesFound = 0;

  for (const kalshiMkt of kalshiMarkets) {
    const title = kalshiMkt.title || "";
    const ticker = kalshiMkt.ticker || "";

    // Skip if recently bet
    if (recentBets[ticker] && Date.now() - recentBets[ticker] < DEDUP_MINUTES * 60000) continue;

    // Try to match to an Odds API game
    const matched = sharpGames.find(g => fuzzyMatch(title, g));
    if (!matched) continue;

    // Get sharp probability for the home team (h2h / moneyline)
    const sharpHome = getSharpProb(matched, "h2h", matched.homeTeam);
    const sharpAway = getSharpProb(matched, "h2h", matched.awayTeam);
    if (!sharpHome || !sharpAway) continue;

    // Check Kalshi YES price (home team wins)
    const kalshiYesPrice = kalshiMkt.yes_ask || 0;
    const kalshiNoPrice = kalshiMkt.no_ask || 0;

    if (kalshiYesPrice > 5 && kalshiYesPrice < 95) {
      const evYes = calculateEV(sharpHome.prob, kalshiYesPrice, "YES");
      if (evYes.evPct >= MIN_EV_PCT && evYes.ev * 100 >= MIN_EDGE_CENTS) {
        opportunitiesFound++;
        const bet = kellySize(evYes.pWin / 100, kalshiYesPrice, bankroll);
        const contracts = Math.floor(bet / (kalshiYesPrice / 100));

        notify(
          "+EV FOUND [" + matched.sportClean + "] " +
          matched.awayTeam + " @ " + matched.homeTeam +
          " | YES (home) at " + kalshiYesPrice + "c" +
          " | Sharp: " + (sharpHome.prob * 100).toFixed(0) + "% (" + sharpHome.book + ")" +
          " | EV: +" + evYes.evPct + "%" +
          " | Bet: $" + bet + " (" + contracts + "x)" +
          " | " + ticker
        );

        // Also check sportsbook prices for alert
        const softPrices = getSoftPrice(matched, "h2h", matched.homeTeam);
        for (const sp of softPrices) {
          const softEV = calculateEV(sharpHome.prob, sp.prob * 100, "YES");
          if (softEV.evPct >= MIN_EV_PCT) {
            notify(
              "SPORTSBOOK +EV: " + sp.book.toUpperCase() +
              " " + matched.homeTeam + " ML " + (sp.odds > 0 ? "+" : "") + sp.odds +
              " | Sharp: " + (sharpHome.prob * 100).toFixed(0) + "%" +
              " | EV: +" + softEV.evPct + "%"
            );
          }
        }

        // Auto-bet on Kalshi
        if (!DRY_RUN && contracts > 0) {
          const res = await submitOrder(ticker, "YES", kalshiYesPrice, contracts);
          if (res && res.order) {
            notify("KALSHI BET PLACED: " + contracts + "x YES on " + ticker + " at " + kalshiYesPrice + "c");
            totalBets++;
            recentBets[ticker] = Date.now();
          }
        } else {
          recentBets[ticker] = Date.now();
        }
      }
    }

    // Check NO side (away team wins)
    if (kalshiNoPrice > 5 && kalshiNoPrice < 95) {
      const evNo = calculateEV(sharpAway.prob, kalshiNoPrice, "NO");
      if (evNo.evPct >= MIN_EV_PCT && evNo.ev * 100 >= MIN_EDGE_CENTS) {
        opportunitiesFound++;
        const bet = kellySize(evNo.pWin / 100, kalshiNoPrice, bankroll);
        const contracts = Math.floor(bet / (kalshiNoPrice / 100));

        notify(
          "+EV FOUND [" + matched.sportClean + "] " +
          matched.awayTeam + " @ " + matched.homeTeam +
          " | NO (away wins) at " + kalshiNoPrice + "c" +
          " | Sharp: " + (sharpAway.prob * 100).toFixed(0) + "% (" + sharpAway.book + ")" +
          " | EV: +" + evNo.evPct + "%" +
          " | Bet: $" + bet + " (" + contracts + "x)" +
          " | " + ticker
        );

        // Sportsbook alert
        const softPrices = getSoftPrice(matched, "h2h", matched.awayTeam);
        for (const sp of softPrices) {
          const softEV = calculateEV(sharpAway.prob, sp.prob * 100, "NO");
          if (softEV.evPct >= MIN_EV_PCT) {
            notify(
              "SPORTSBOOK +EV: " + sp.book.toUpperCase() +
              " " + matched.awayTeam + " ML " + (sp.odds > 0 ? "+" : "") + sp.odds +
              " | Sharp: " + (sharpAway.prob * 100).toFixed(0) + "%" +
              " | EV: +" + softEV.evPct + "%"
            );
          }
        }

        if (!DRY_RUN && contracts > 0) {
          const res = await submitOrder(ticker, "NO", kalshiNoPrice, contracts);
          if (res && res.order) {
            notify("KALSHI BET PLACED: " + contracts + "x NO on " + ticker + " at " + kalshiNoPrice + "c");
            totalBets++;
            recentBets[ticker] = Date.now();
          }
        } else {
          recentBets[ticker] = Date.now();
        }
      }
    }
  }

  console.log("  +EV opportunities: " + opportunitiesFound);
  console.log("  Total bets placed: " + totalBets);
}

// ==============================================================
//  MAIN
// ==============================================================

async function main() {
  console.log("");
  console.log("==================================================");
  console.log("  KALSHI SPORTS +EV BOT v1.0");
  console.log("  Mode: " + (DRY_RUN ? "PAPER" : "LIVE"));
  console.log("==================================================");
  console.log("  Min EV:      " + MIN_EV_PCT + "%");
  console.log("  Min edge:    " + MIN_EDGE_CENTS + "c");
  console.log("  Max bet:     " + (MAX_BET_PCT * 100) + "% of bankroll");
  console.log("  Scan every:  " + (SCAN_INTERVAL / 1000) + "s");
  console.log("  Sports:      NFL, NBA, MLB, NHL");
  console.log("  Sharp books: Pinnacle, BetOnline, Bovada");
  console.log("  Auto-bet:    Kalshi");
  console.log("  Alerts:      FanDuel, Caesars");
  console.log("==================================================");
  console.log("");

  // Validate env
  if (!process.env.KALSHI_API_KEY || !process.env.KALSHI_PRIVATE_KEY) {
    console.error("  [!] Missing Kalshi credentials");
    process.exit(1);
  }
  if (!process.env.ODDS_API_KEY) {
    console.error("  [!] Missing ODDS_API_KEY");
    process.exit(1);
  }

  // Sync balance
  if (!DRY_RUN) {
    const bal = await getBalance();
    if (bal !== null) {
      bankroll = bal;
      console.log("  Kalshi balance: $" + bankroll.toFixed(2));
    }
  }

  console.log("  Running first scan...\n");
  await runScan();

  setInterval(async () => {
    try {
      await runScan();
    } catch (e) {
      console.error("  Scan error:", e.message);
    }
  }, SCAN_INTERVAL);
}

main();
