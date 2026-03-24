// ==============================================================
//  trader.js v11.0 — KALSHI BTC TRADER
//  DATA-DRIVEN: Based on analysis of 54 real trades
//  RULES:
//    - BTC ONLY (only asset with price data)
//    - YES bets only (67% WR vs NO 21% WR)
//    - Under 8 min only (80% WR under 5min)
//    - Fair < 90 sanity check (Fair>=90 was 36% WR)
//    - Max 25c gap between fair and market
//    - 3% max bet size
//    - 12c minimum edge always
//    - Above/below only, no ranges
// ==============================================================

import dotenv from "dotenv";
dotenv.config();

import { startBTCFeed, getBTCPrice, getSPXPrice } from "./priceFeed.js";
import { getActiveBTCMarkets } from "./kalshiBTC.js";
import { submitOrder, getBalance, getSettlements } from "./execute.js";
import {
  fairProbAbove,
  updateVolatility,
  getVolatility,
} from "./pricing.js";
import fs from "fs";
import https from "https";

// ==============================================================
//  CONFIG — v11 DATA-DRIVEN
// ==============================================================

const DRY_RUN = false;
const BANKROLL = 100;
const SCAN_INTERVAL = 2000;         // 2 seconds
const MAX_OPEN_TRADES = 5;          // Fewer concurrent = less risk
const DEDUP_SECONDS = 300;          // 5 min dedup
const MAX_STRIKE_DISTANCE = 500;    // Tighter than before
const SLIPPAGE = 1.5;
const KALSHI_FEE_PER_CONTRACT = 0.03;
const BALANCE_SYNC_INTERVAL = 60000;

// DATA-DRIVEN RULES
const MAX_BET_FRACTION = 0.03;      // 3% max per trade (was 6-12%)
const MIN_EDGE = 12;                // 12c minimum always
const MAX_MINUTES_1H = 10;           // Only trade under 8 min
const MAX_MINUTES_15M = 12;          // Same for 15M
const MIN_MINUTES = 1.5;            // Not too close to expiry
const MAX_FAIR_VALUE = 88;          // Skip if model says > 88% (Fair:92 bug)
const MAX_FAIR_GAP = 25;            // Skip if fair vs market > 25c apart
const YES_ONLY = true;              // Data says YES = 67% WR, NO = 21%

let scanCount = 0;
let totalEdges = 0;
let paperPnL = 0;
let bankroll = BANKROLL;
let lastBalanceSync = 0;
let dailyLoss = 0;
let dailyLossDate = new Date().toDateString();
let trades = [];
let wins = 0;
let losses = 0;
let stopped = false;
const alerted = {};
const pendingTrades = [];
const priceHistory = [];

// ==============================================================
//  STARTUP VALIDATION
// ==============================================================

function validateEnv() {
  const required = ["KALSHI_API_KEY", "KALSHI_PRIVATE_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error("  [!] Missing required env vars: " + missing.join(", "));
    process.exit(1);
  }
}

// ==============================================================
//  BANKROLL SYNC
// ==============================================================

async function syncBankroll() {
  if (DRY_RUN) return;
  const now = Date.now();
  if (now - lastBalanceSync < BALANCE_SYNC_INTERVAL) return;

  const realBalance = await getBalance();
  if (realBalance !== null) {
    const diff = Math.abs(realBalance - bankroll);
    if (diff > 0.50) {
      console.log("  [SYNC] Bankroll: $" + bankroll.toFixed(2) + " → $" + realBalance.toFixed(2));
    }
    bankroll = realBalance;
    paperPnL = realBalance - BANKROLL;
    lastBalanceSync = now;
  }

  await syncRecord();
}

async function syncRecord() {
  if (DRY_RUN) return;
  const settlements = await getSettlements();
  if (settlements.length === 0) return;

  let w = 0;
  let l = 0;

  for (const s of settlements) {
    const revenue = (s.revenue || 0) / 100;
    const yesCost = (s.yes_total_cost || 0) / 100;
    const noCost = (s.no_total_cost || 0) / 100;
    const cost = yesCost + noCost;
    if (revenue > cost) w++;
    else l++;
  }

  if (w !== wins || l !== losses) {
    console.log("  [RECORD] " + wins + "W/" + losses + "L → " + w + "W/" + l + "L");
    wins = w;
    losses = l;
  }
}

// ==============================================================
//  KELLY SIZING — CONSERVATIVE (3% max)
// ==============================================================

function kellyBet(fairProb, price, bankrollNow) {
  const pWin = fairProb / 100;
  const pLose = 1 - pWin;
  const odds = (100 - price) / price;
  const kellyFull = (pWin * odds - pLose) / odds;
  const kellyQuarter = kellyFull / 4;  // Quarter Kelly — very conservative

  // Drawdown scaling
  const drawdown = Math.max(0, (BANKROLL - bankrollNow) / BANKROLL);
  const drawdownMultiplier =
    drawdown > 0.30 ? 0.3 :
    drawdown > 0.20 ? 0.5 :
    drawdown > 0.10 ? 0.7 : 1.0;

  const fraction = Math.max(0, Math.min(kellyQuarter, MAX_BET_FRACTION));
  const bet = bankrollNow * fraction * drawdownMultiplier;
  return parseFloat(
    Math.max(1, Math.min(bet, bankrollNow * MAX_BET_FRACTION)).toFixed(2)
  );
}

// ==============================================================
//  MOMENTUM + VOLATILITY
// ==============================================================

function getMomentum() {
  if (priceHistory.length < 10) return "flat";
  const recent = priceHistory.slice(-15);
  const oldest = recent[0];
  const newest = recent[recent.length - 1];
  const pctChange = ((newest - oldest) / oldest) * 100;
  if (pctChange > 0.1) return "up";
  if (pctChange < -0.1) return "down";
  return "flat";
}

function detectSpike() {
  if (priceHistory.length < 5) return false;
  const recent = priceHistory.slice(-5);
  const oldest = recent[0];
  const newest = recent[recent.length - 1];
  const pctMove = Math.abs((newest - oldest) / oldest) * 100;
  return pctMove > 0.3;
}

function get5MinVol() {
  if (priceHistory.length < 30) return getVolatility();
  const recent = priceHistory.slice(-60);
  const returns = [];
  for (let i = 1; i < recent.length; i++) {
    returns.push(Math.log(recent[i] / recent[i - 1]));
  }
  let sum = 0;
  for (const r of returns) sum += r;
  const mean = sum / returns.length;
  let v = 0;
  for (const r of returns) v += (r - mean) * (r - mean);
  v /= returns.length;
  const daily = Math.sqrt(v) * Math.sqrt(17280) * 100;
  return parseFloat(Math.max(1.5, Math.min(20, daily)).toFixed(2));
}

// ==============================================================
//  BTC 15-MINUTE EVALUATOR — YES ONLY, UNDER 8 MIN
// ==============================================================

function evaluate15M(market, btcPrice, momentum) {
  if (!market.is15M) return [];
  if (market.asset !== "BTC") return [];  // BTC ONLY

  const minutesLeft = market.minutesLeft;
  const strike = market.strike;

  // Entry window: 1.5-8 minutes (data says under 8 is profitable)
  if (minutesLeft > MAX_MINUTES_15M || minutesLeft < MIN_MINUTES) return [];

  const distance = btcPrice - strike;
  const absDist = Math.abs(distance);
  const distancePct = (absDist / strike) * 100;
  if (distancePct < 0.05) return [];  // Too close to strike

  // YES ONLY — only trade when BTC is ABOVE the strike
  if (YES_ONLY && distance <= 0) return [];

  // Volatility-adjusted move ratio
  const vol = get5MinVol();
  const volPerMin = (vol / 100) / Math.sqrt(1440);
  const expectedMove = volPerMin * Math.sqrt(minutesLeft) * btcPrice;
  const moveRatio = absDist / expectedMove;

  if (moveRatio < 0.7) return [];

  // Fair value based on move ratio
  let fairYes;
  if (moveRatio > 2.5) fairYes = 88;     // Capped at 88 (was 92)
  else if (moveRatio > 2.0) fairYes = 83;
  else if (moveRatio > 1.5) fairYes = 76;
  else if (moveRatio > 1.0) fairYes = 68;
  else fairYes = 60;

  // Momentum adjustment
  if (distance > 0 && momentum === "up") {
    fairYes = Math.min(88, fairYes + 4);
  } else if (distance > 0 && momentum === "down") {
    fairYes = Math.max(50, fairYes - 8);
  }

  // Time decay — less time = harder to reverse
  if (minutesLeft <= 3) {
    fairYes = Math.min(88, fairYes + 4);
  }

  // SANITY CHECKS (from data analysis)
  if (fairYes > MAX_FAIR_VALUE) return [];  // Skip Fair:90+ (36% WR)

  const marketImplied = (market.yesAsk + (market.yesBid || market.yesAsk)) / 2;
  if (Math.abs(fairYes - marketImplied) > MAX_FAIR_GAP) return [];  // Model too far from market

  const results = [];

  if (market.yesAsk > 10 && market.yesAsk < 88) {
    const edge = fairYes - market.yesAsk - SLIPPAGE;
    if (edge >= MIN_EDGE) {
      // Skip if momentum is against us and edge isn't huge
      if (momentum === "down" && edge < 18) return results;

      results.push({
        side: "YES", price: market.yesAsk,
        fair: parseFloat(fairYes.toFixed(1)),
        edge: parseFloat(edge.toFixed(1)),
        title: market.title, ticker: market.ticker,
        mins: minutesLeft, strike: strike,
        type: "above", strikeLow: strike, strikeHigh: strike,
        expiration: market.expiration,
        volume: market.volume || 0,
        is15M: true, asset: "BTC",
      });
    }
  }

  return results;
}

// ==============================================================
//  BTC HOURLY ABOVE/BELOW — YES ONLY, UNDER 8 MIN
// ==============================================================

function evaluate1H(market, btcPrice, momentum) {
  if (market.is15M) return [];
  if (market.asset !== "BTC" && market.asset !== "SPX") return [];
  if (market.marketType !== "above") return [];

  const vol = market.asset === "SPX" ? 1.2 : get5MinVol();
  const price = market.asset === "SPX" ? getSPXPrice().price : btcPrice;

  if (price <= 0) return [];

  // Time filter: under 8 min only
  if (market.minutesLeft > MAX_MINUTES_1H || market.minutesLeft < MIN_MINUTES) return [];

  const fair = fairProbAbove(price, market.strike, market.minutesLeft, vol);

  const distance = Math.abs(price - market.strike);
  const maxDist = market.asset === "SPX" ? 100 : MAX_STRIKE_DISTANCE;
  if (distance > maxDist) return [];

  // SANITY CHECKS
  if (fair > MAX_FAIR_VALUE) return [];
  const marketImplied = (market.yesAsk + (market.yesBid || market.yesAsk)) / 2;
  if (Math.abs(fair - marketImplied) > MAX_FAIR_GAP) return [];

  const results = [];

  // YES side only (data says 67% WR vs NO 21%)
  if (market.yesAsk > 10 && market.yesAsk < 88) {
    const edgeVsAsk = fair - market.yesAsk - SLIPPAGE;
    if (edgeVsAsk >= MIN_EDGE) {
      if (momentum === "down" && edgeVsAsk < MIN_EDGE + 8) return results;
      results.push({
        side: "YES", price: market.yesAsk, fair: fair,
        edge: parseFloat(edgeVsAsk.toFixed(1)),
        title: market.title, ticker: market.ticker,
        mins: market.minutesLeft, strike: market.strike,
        type: "above", strikeLow: market.strike,
        strikeHigh: market.strike, expiration: market.expiration,
        volume: market.volume || 0,
        is15M: false, asset: market.asset || "BTC",
      });
    }
  }

  // NO side — only if YES_ONLY is disabled
  if (!YES_ONLY && market.noAsk > 10 && market.noAsk < 88) {
    const fairNo = 100 - fair;
    if (fairNo > MAX_FAIR_VALUE) return results;
    const edgeVsAsk = fairNo - market.noAsk - SLIPPAGE;
    if (edgeVsAsk >= MIN_EDGE) {
      if (momentum === "up" && edgeVsAsk < MIN_EDGE + 8) return results;
      results.push({
        side: "NO", price: market.noAsk,
        fair: parseFloat(fairNo.toFixed(1)),
        edge: parseFloat(edgeVsAsk.toFixed(1)),
        title: market.title, ticker: market.ticker,
        mins: market.minutesLeft, strike: market.strike,
        type: "above", strikeLow: market.strike,
        strikeHigh: market.strike, expiration: market.expiration,
        volume: market.volume || 0,
        is15M: false, asset: market.asset || "BTC",
      });
    }
  }

  return results;
}

// ==============================================================
//  FILE OPS
// ==============================================================

function loadTrades() {
  try {
    if (fs.existsSync("trades.json")) {
      const data = JSON.parse(fs.readFileSync("trades.json", "utf-8"));
      if (data.bankroll) bankroll = data.bankroll;
      if (data.paperPnL) paperPnL = data.paperPnL;
      if (data.wins) wins = data.wins;
      if (data.losses) losses = data.losses;
      if (data.dailyLoss) dailyLoss = data.dailyLoss;
      if (data.dailyLossDate === new Date().toDateString())
        dailyLossDate = data.dailyLossDate;
      console.log("  Loaded | Bank:$" + bankroll.toFixed(2));
    }
  } catch (e) {
    console.error("  [!] Failed to load trades.json:", e.message);
  }
}

function saveTrades() {
  const data = {
    lastUpdate: new Date().toISOString(),
    bankroll: parseFloat(bankroll.toFixed(2)),
    paperPnL: parseFloat(paperPnL.toFixed(2)),
    startingBankroll: BANKROLL,
    totalTrades: trades.length,
    wins: wins, losses: losses,
    winRate: parseFloat(((wins / Math.max(wins + losses, 1)) * 100).toFixed(1)),
    dailyLoss: parseFloat(dailyLoss.toFixed(2)),
    dailyLossDate: dailyLossDate,
    trades: trades,
  };
  fs.writeFileSync("trades.json", JSON.stringify(data, null, 2));

  // Save dedup state to disk
  try {
    fs.writeFileSync("dedup.json", JSON.stringify(alerted));
  } catch (e) {}
}

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
  console.log("");
  console.log("  >>>>> " + line);
  console.log("");
  sendTelegram(line);
  try {
    let log = "";
    if (fs.existsSync("notifications.log"))
      log = fs.readFileSync("notifications.log", "utf-8");
    log += line + "\n";
    fs.writeFileSync("notifications.log", log);
  } catch (e) {}
}

// ==============================================================
//  RESOLVE
// ==============================================================

function resolvePendingTrades(btcPrice) {
  const now = Date.now();
  const toRemove = [];
  for (let i = 0; i < pendingTrades.length; i++) {
    const pt = pendingTrades[i];
    const expTime = new Date(pt.expiration).getTime();
    if (now >= expTime) {
      let won = false;
      const settlePrice = pt.asset === "SPX" ? getSPXPrice().price : btcPrice;
      if (pt.type === "above") {
        const isAbove = settlePrice >= pt.strike;
        won = pt.side === "YES" ? isAbove : !isAbove;
      }
      const feeCost = pt.contracts * KALSHI_FEE_PER_CONTRACT;
      const dollarPnL = won
        ? parseFloat(((100 - pt.price) / 100) * pt.contracts - feeCost).toFixed(2)
        : parseFloat((-pt.betAmount).toFixed(2));
      const pnlNum = parseFloat(dollarPnL);
      paperPnL += pnlNum;
      bankroll += pnlNum;
      if (pnlNum < 0) dailyLoss += Math.abs(pnlNum);
      if (won) wins++; else losses++;

      const tag = " [" + (pt.asset || "BTC") + "] [" + (pt.is15M ? "15M" : "1H") + "]";

      notify(
        "RESOLVED: " + (won ? "WIN" : "LOSS") +
        " $" + pnlNum.toFixed(2) +
        " | " + pt.side + " $" + pt.strike + " " + pt.type +
        " | Price:$" + settlePrice.toFixed(0) +
        " | Bank:$" + bankroll.toFixed(2) +
        " | W:" + wins + " L:" + losses +
        " (" + ((wins / Math.max(wins + losses, 1)) * 100).toFixed(0) + "%)" +
        tag
      );

      console.log("  [CALIBRATION] Fair:" + (pt.fair || "?") + " Price:" + pt.price + " Side:" + pt.side + " Won:" + won + " Ticker:" + (pt.ticker || "?"));

      toRemove.push(i);
    }
  }
  for (let i = toRemove.length - 1; i >= 0; i--) {
    pendingTrades.splice(toRemove[i], 1);
  }
  if (toRemove.length > 0) saveTrades();
}

// ==============================================================
//  PLACE TRADE
// ==============================================================

function placeTrade(o, currentPrice, vol, momentum) {
  totalEdges++;
  let bet = kellyBet(o.fair, o.price, bankroll);
  const contracts = parseFloat((bet / (o.price / 100)).toFixed(1));
  const feeCost = contracts * KALSHI_FEE_PER_CONTRACT;
  const maxProfit = parseFloat(
    (((100 - o.price - SLIPPAGE) / 100) * contracts - feeCost).toFixed(2)
  );
  const kellyPct = ((bet / bankroll) * 100).toFixed(1);
  const tag = " [" + (o.asset || "BTC") + "] [" + (o.is15M ? "15M" : "1H") + "]";

  trades.push({
    id: totalEdges, time: new Date().toISOString(),
    price_at_entry: currentPrice, side: o.side, price: o.price,
    fair: o.fair, edge: o.edge, ticker: o.ticker,
    strike: o.strike, type: o.type, minutesLeft: o.mins,
    expiration: o.expiration, betSize: bet, contracts: contracts,
    maxProfit: maxProfit, maxLoss: bet, momentum: momentum,
    vol: vol, kellyPct: kellyPct, volume: o.volume,
    is15M: o.is15M || false, asset: o.asset || "BTC",
    resolved: false, won: null,
  });

  pendingTrades.push({
    id: totalEdges, ticker: o.ticker,
    side: o.side, price: o.price, fair: o.fair,
    strike: o.strike, strikeLow: o.strikeLow, strikeHigh: o.strikeHigh,
    type: o.type, contracts: contracts,
    expiration: o.expiration, betAmount: bet,
    is15M: o.is15M || false, asset: o.asset || "BTC",
  });

  notify(
    "#" + totalEdges + " " + o.side + " " + o.price + "c" +
    " Edge:" + o.edge + "c Fair:" + o.fair + "c" +
    " $" + o.strike + " " + o.type.toUpperCase() +
    " Kelly:" + kellyPct + "% $" + bet +
    " (" + contracts.toFixed(0) + "x)" +
    " +" + maxProfit + "/-" + bet +
    " " + o.mins.toFixed(0) + "min Mom:" + momentum +
    " Vol:" + o.volume +
    " " + (o.asset || "BTC") + ":$" + currentPrice.toFixed(0) +
    " [" + pendingTrades.length + "/" + MAX_OPEN_TRADES + "]" +
    tag
  );

  if (!DRY_RUN) {
    submitOrder(o.ticker, o.side, o.price, contracts).then((res) => {
      if (res && res.order) {
        notify("LIVE ORDER PLACED: " + contracts + "x " + o.side + " on " + o.ticker + " at " + o.price + "c" + tag);
      } else {
        notify("LIVE ORDER FAILED on " + o.ticker);
      }
    });
  }

  return bet;
}

// ==============================================================
//  MAIN SCAN
// ==============================================================

async function runScan() {
  scanCount++;

  await syncBankroll();

  const btc = getBTCPrice();
  if (btc.price === 0) return;

  // Stale price check
  if (Date.now() - btc.updated > 15000) return;

  updateVolatility(btc.price);
  priceHistory.push(btc.price);
  if (priceHistory.length > 500) priceHistory.splice(0, priceHistory.length - 500);
  const vol = get5MinVol();
  const momentum = getMomentum();

  // Daily reset
  const today = new Date().toDateString();
  if (today !== dailyLossDate) {
    dailyLoss = 0;
    dailyLossDate = today;
    stopped = false;
    notify("NEW DAY - Reset.");
  }

  if (dailyLoss >= 20 && !stopped) {
    stopped = true;
    notify("DAILY LIMIT: -$" + dailyLoss.toFixed(2));
  }

  resolvePendingTrades(btc.price);

  const allMarkets = await getActiveBTCMarkets();

  // Status log every ~30 seconds
  if (scanCount % 15 === 1) {
    const spx = getSPXPrice();
    const count15M = allMarkets.filter(m => m.is15M && m.minutesLeft >= MIN_MINUTES && m.minutesLeft <= MAX_MINUTES_15M).length;
    const count1H = allMarkets.filter(m => !m.is15M && m.minutesLeft >= MIN_MINUTES && m.minutesLeft <= MAX_MINUTES_1H).length;
    console.log(
      "[" + new Date().toLocaleTimeString() + "] #" + scanCount +
      " BTC:$" + btc.price.toFixed(0) +
      " SPX:" + spx.price.toFixed(0) +
      " Vol:" + vol + "% Mom:" + momentum +
      " 15M:" + count15M + " 1H:" + count1H +
      " Open:" + pendingTrades.length + "/" + MAX_OPEN_TRADES +
      " Bank:$" + bankroll.toFixed(2) +
      " PnL:$" + paperPnL.toFixed(2) +
      " W:" + wins + " L:" + losses
    );
  }

  if (stopped) return;
  if (pendingTrades.length >= MAX_OPEN_TRADES) return;

  // Spike detection
  if (detectSpike()) {
    if (scanCount % 15 === 0) notify("SPIKE DETECTED — skipping");
    return;
  }

  // Load dedup from disk on first scan
  if (scanCount === 1) {
    try {
      if (fs.existsSync("dedup.json")) {
        const dedupData = JSON.parse(fs.readFileSync("dedup.json", "utf-8"));
        const now = Date.now();
        for (const [key, ts] of Object.entries(dedupData)) {
          if (now - ts < DEDUP_SECONDS * 1000) alerted[key] = ts;
        }
      }
    } catch (e) {}
  }

  const openTickers = {};
  for (const pt of pendingTrades) {
    openTickers[pt.ticker] = true;
  }

  // TRADE SCAN
  for (const mkt of allMarkets) {
    if (pendingTrades.length >= MAX_OPEN_TRADES) break;
    if (openTickers[mkt.ticker]) continue;

    // Route to correct evaluator
    let opps;
    if (mkt.is15M) {
      opps = evaluate15M(mkt, btc.price, momentum);
    } else {
      opps = evaluate1H(mkt, btc.price, momentum);
    }

    for (const o of opps) {
      if (pendingTrades.length >= MAX_OPEN_TRADES) break;

      const key = o.ticker + "_" + o.side;
      const now = Date.now();
      if (alerted[key] && now - alerted[key] < DEDUP_SECONDS * 1000) continue;
      alerted[key] = now;

      const currentPrice = o.asset === "SPX" ? getSPXPrice().price : btc.price;
      placeTrade(o, currentPrice, vol, momentum);
      saveTrades();
    }
  }

  // Summary every ~10 minutes
  if (scanCount % 300 === 0) {
    console.log("");
    console.log("  ======= SUMMARY =======");
    console.log("  Bank:$" + bankroll.toFixed(2) + " PnL:$" + paperPnL.toFixed(2) + " (" + ((paperPnL / BANKROLL) * 100).toFixed(1) + "%)");
    console.log("  W:" + wins + " L:" + losses + " Rate:" + ((wins / Math.max(wins + losses, 1)) * 100).toFixed(1) + "%");
    console.log("  Open: " + pendingTrades.length);
    console.log("  Strategy: BTC YES only, <8min, Fair<88, Edge>12c, 3% max");
    console.log("  ======================");
    saveTrades();
  }
}

// ==============================================================
//  GRACEFUL SHUTDOWN
// ==============================================================

function shutdown(signal) {
  console.log("\n  [" + signal + "] Shutting down...");
  saveTrades();
  console.log("  Trades saved. Exiting.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ==============================================================
//  MAIN
// ==============================================================

async function main() {
  console.log("");
  console.log("==================================================");
  console.log("  KALSHI BTC TRADER v11.0 — DATA-DRIVEN");
  console.log("  Mode: " + (DRY_RUN ? "PAPER" : "LIVE"));
  console.log("==================================================");

  validateEnv();

  console.log("  STRATEGY (based on 54 trade analysis):");
  console.log("  Assets:      BTC only (57% WR, +$10 PnL)");
  console.log("  Side:        YES only (67% WR vs NO 21%)");
  console.log("  Time:        Under 8 min (80% WR under 5min)");
  console.log("  Edge min:    " + MIN_EDGE + "c always");
  console.log("  Fair cap:    " + MAX_FAIR_VALUE + " (skip Fair:90+ bug)");
  console.log("  Fair gap:    " + MAX_FAIR_GAP + "c max from market");
  console.log("  Bet size:    " + (MAX_BET_FRACTION * 100) + "% max (quarter Kelly)");
  console.log("  Max open:    " + MAX_OPEN_TRADES);
  console.log("  Dedup:       " + DEDUP_SECONDS + "s (persisted to disk)");
  console.log("  SPX:         Enabled (same rules)");
  console.log("==================================================");
  console.log("");

  loadTrades();

  const ok = await startBTCFeed();
  if (!ok) {
    console.log("  Failed to start price feeds. Exiting.");
    return;
  }

  const spx = getSPXPrice();
  console.log("  BTC: $" + getBTCPrice().price.toFixed(2));
  if (spx.price > 0) console.log("  SPX: " + spx.price.toFixed(2));

  // Sync real balance
  if (!DRY_RUN) {
    const realBalance = await getBalance();
    if (realBalance !== null) {
      console.log("  Kalshi balance: $" + realBalance.toFixed(2));
      bankroll = realBalance;
      paperPnL = realBalance - BANKROLL;
      lastBalanceSync = Date.now();
      saveTrades();
    }
  }

  console.log("  Running...\n");

  await runScan();
  setInterval(async function () {
    try {
      await runScan();
    } catch (e) {
      console.error("  Scan error: " + e.message);
    }
  }, SCAN_INTERVAL);
}

main();
