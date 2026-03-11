// ==============================================================
//  trader.js v10.0 — KALSHI CRYPTO TRADER
//  15M (BTC/ETH/SOL) + HOURLY ABOVE/BELOW (BTC only)
//  NO RANGE MARKETS
// ==============================================================

import dotenv from "dotenv";
dotenv.config();

import { startBTCFeed, getBTCPrice, getSPXPrice } from "./priceFeed.js";
import { getActiveBTCMarkets } from "./kalshiBTC.js";
import { submitOrder, getBalance, getPositions, getSettlements } from "./execute.js";
import {
  fairProbAbove,
  fairProbRange,
  updateVolatility,
  getVolatility,
} from "./pricing.js";
import fs from "fs";
import https from "https";

// ==============================================================
//  CONFIG
// ==============================================================

const DRY_RUN = false;
const BANKROLL = 100;
const SCAN_INTERVAL = 2000;
const MIN_MINUTES = 2;
const MAX_MINUTES = 20;             // Shortened — wins cluster under 20 min
const MAX_OPEN_TRADES = 10;
const MAX_PER_EXPIRY_SINGLE = 2;
const MAX_PER_EXPIRY_BRACKET = 8;
const DEDUP_SECONDS = 300;          // 5 min dedup — prevents double orders
const MAX_STRIKE_DISTANCE = 750;
const SLIPPAGE = 1.5;
const KALSHI_FEE_PER_CONTRACT = 0.03;
const BRACKET_MAX_STRIKE_SPREAD = 750;
const MAX_DIRECTIONAL_RISK = 0.15;
const MAX_EXPIRY_DIRECTIONAL_RISK = 0.08;
const BALANCE_SYNC_INTERVAL = 60000;

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
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.log("  [WARN] Telegram not configured — console-only");
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
      console.log(
        "  [SYNC] Bankroll: $" + bankroll.toFixed(2) +
        " → $" + realBalance.toFixed(2)
      );
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
//  KELLY SIZING — tuned for above/below + 15M
// ==============================================================

function kellyBet(fairProb, price, bankrollNow, betType) {
  const pWin = fairProb / 100;
  const pLose = 1 - pWin;
  const odds = (100 - price) / price;
  const kellyFull = (pWin * odds - pLose) / odds;
  const kellyHalf = kellyFull / 2;  // Half Kelly — conservative

  // Drawdown scaling
  const drawdown = Math.max(0, (BANKROLL - bankrollNow) / BANKROLL);
  const drawdownMultiplier =
    drawdown > 0.20 ? 0.4 :
    drawdown > 0.15 ? 0.6 :
    drawdown > 0.10 ? 0.8 : 1.0;

  const edge = pWin * odds - pLose;
  let maxFraction;

  if (betType === "15m") {
    // 15M trades — higher conviction, tighter sizing
    if (edge > 0.30) maxFraction = 0.12;
    else if (edge > 0.20) maxFraction = 0.10;
    else if (edge > 0.15) maxFraction = 0.08;
    else maxFraction = 0.06;
  } else if (betType === "true_arb") {
    maxFraction = 0.15;
  } else if (betType === "near_arb") {
    maxFraction = 0.10;
  } else {
    // Hourly above/below
    if (edge > 0.25) maxFraction = 0.10;
    else if (edge > 0.15) maxFraction = 0.08;
    else if (edge > 0.10) maxFraction = 0.06;
    else maxFraction = 0.04;
  }

  const fraction = Math.max(0, Math.min(kellyHalf, maxFraction));
  const bet = bankrollNow * fraction * drawdownMultiplier;
  return parseFloat(
    Math.max(1, Math.min(bet, bankrollNow * maxFraction)).toFixed(2)
  );
}

// ==============================================================
//  EDGE THRESHOLDS
// ==============================================================

function getMinEdge(minutesLeft, volume) {
  let base = 30;
  if (minutesLeft <= 5) base = 8;
  else if (minutesLeft <= 8) base = 10;
  else if (minutesLeft <= 15) base = 15;
  else if (minutesLeft <= 30) base = 18;
  else if (minutesLeft <= 45) base = 22;

  if (volume >= 1000) base = base - 2;
  else if (volume >= 100) base = base - 1;
  else if (volume <= 2) base = base + 2;

  return Math.max(8, base);
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
  if (pctMove > 0.3) {
    console.log("  [SPIKE] " + pctMove.toFixed(2) + "% move — pausing");
    return true;
  }
  return false;
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
//  DIRECTIONAL EXPOSURE
// ==============================================================

function getDirectionalExposure(btcPrice) {
  let totalUp = 0;
  let totalDown = 0;
  const byExpiry = {};

  for (const pt of pendingTrades) {
    if (!byExpiry[pt.expiration]) {
      byExpiry[pt.expiration] = { up: 0, down: 0 };
    }

    if (pt.type === "above" && pt.side === "YES") {
      totalUp += pt.betAmount;
      byExpiry[pt.expiration].up += pt.betAmount;
    }
    if (pt.type === "above" && pt.side === "NO") {
      totalDown += pt.betAmount;
      byExpiry[pt.expiration].down += pt.betAmount;
    }
  }

  return { totalUp, totalDown, byExpiry };
}

function checkDirectionalLimits(opp, bet, btcPrice, exposure) {
  const isUpBet = opp.side === "YES";
  const isDownBet = opp.side === "NO";

  if (isUpBet && (exposure.totalUp + bet) > bankroll * MAX_DIRECTIONAL_RISK) return false;
  if (isDownBet && (exposure.totalDown + bet) > bankroll * MAX_DIRECTIONAL_RISK) return false;

  const expRisk = exposure.byExpiry[opp.expiration] || { up: 0, down: 0 };
  if (isUpBet && (expRisk.up + bet) > bankroll * MAX_EXPIRY_DIRECTIONAL_RISK) return false;
  if (isDownBet && (expRisk.down + bet) > bankroll * MAX_EXPIRY_DIRECTIONAL_RISK) return false;

  return true;
}

// ==============================================================
//  15-MINUTE EVALUATOR (BTC/ETH/SOL)
//  Late entry strategy — only trade when price has moved from strike
// ==============================================================

function evaluate15M(market, btcPrice, momentum) {
  if (!market.is15M) return [];

  const minutesLeft = market.minutesLeft;
  const strike = market.strike;

  // Entry window: 2-12 minutes left
  if (minutesLeft > 8 || minutesLeft < 1.5) return [];
  
  // In high vol, require bigger moves — model is less reliable
  const vol = get5MinVol();
  if (vol > 8) return [];  // Too volatile, skip 15M trades entirely

  // For 15M markets, use bid/ask to estimate current direction
  // if YES is trading high, asset is above strike
  // We use btcPrice for BTC markets, but for ETH/SOL we infer from market prices
  let distance;
  let absDist;

  if (market.asset === "BTC") {
    distance = btcPrice - strike;
    absDist = Math.abs(distance);
    const distancePct = (absDist / strike) * 100;
    if (distancePct < 0.05) return [];
  } else {
    // ETH/SOL — infer direction from market prices
    // YES ask > 55 means asset is likely above strike
    // NO ask > 55 means asset is likely below strike
    const yesMid = ((market.yesAsk || 50) + (market.yesBid || 50)) / 2;
    if (yesMid > 55) {
      distance = 1;   // above strike
      absDist = (yesMid - 50) * 2;  // rough distance proxy
    } else if (yesMid < 45) {
      distance = -1;  // below strike
      absDist = (50 - yesMid) * 2;
    } else {
      return [];  // too close to call
    }
  }

  // Volatility-adjusted move ratio
  const volPerMin = (vol / 100) / Math.sqrt(1440);
  const expectedMove = volPerMin * Math.sqrt(minutesLeft) * (market.asset === "BTC" ? btcPrice : strike);
  const moveRatio = market.asset === "BTC" ? absDist / expectedMove : absDist / 10;

  if (moveRatio < 0.7) return [];

  // Fair value based on move ratio
  let fairYes;
  if (moveRatio > 2.5) {
    fairYes = distance > 0 ? 92 : 8;
  } else if (moveRatio > 2.0) {
    fairYes = distance > 0 ? 85 : 15;
  } else if (moveRatio > 1.5) {
    fairYes = distance > 0 ? 78 : 22;
  } else if (moveRatio > 1.0) {
    fairYes = distance > 0 ? 70 : 30;
  } else {
    fairYes = distance > 0 ? 62 : 38;
  }

  // Momentum adjustment (BTC only — we don't have momentum for ETH/SOL)
  if (market.asset === "BTC") {
    if (distance > 0 && momentum === "up") {
      fairYes = Math.min(95, fairYes + 5);
    } else if (distance > 0 && momentum === "down") {
      fairYes = Math.max(50, fairYes - 8);
    } else if (distance < 0 && momentum === "down") {
      fairYes = Math.max(5, fairYes - 5);
    } else if (distance < 0 && momentum === "up") {
      fairYes = Math.min(50, fairYes + 8);
    }
  }

  // Time decay — less time = harder to reverse
  if (minutesLeft <= 3) {
    if (distance > 0) fairYes = Math.min(95, fairYes + 5);
    else fairYes = Math.max(5, fairYes - 5);
  }

const marketImplied15M = (market.yesAsk + (market.yesBid || market.yesAsk)) / 2;
  fairYes = fairYes * 0.7 + marketImplied15M * 0.3;
  // Lower edge threshold when move ratio is very high (strong signal)
  let MIN_EDGE_15M = 12;
  if (moveRatio > 2.0 && minutesLeft <= 5) MIN_EDGE_15M = 8;
  else if (moveRatio > 1.5) MIN_EDGE_15M = 10;
  const results = [];

  // YES side — asset above strike
  if (distance > 0 && market.yesAsk > 5 && market.yesAsk < 90) {
    const edge = fairYes - market.yesAsk - SLIPPAGE;
    if (edge >= MIN_EDGE_15M) {
      if (momentum === "down" && edge < 20) return results;
      results.push({
        side: "YES", price: market.yesAsk,
        fair: parseFloat(fairYes.toFixed(1)),
        edge: parseFloat(edge.toFixed(1)),
        title: market.title, ticker: market.ticker,
        mins: minutesLeft, strike: strike,
        type: "above", strikeLow: strike, strikeHigh: strike,
        expiration: market.expiration,
        volume: market.volume || 0,
        is15M: true, asset: market.asset,
      });
    }
  }

  // NO side — asset below strike
  if (distance < 0 && market.noAsk > 5 && market.noAsk < 90) {
    const fairNo = 100 - fairYes;
    const edge = fairNo - market.noAsk - SLIPPAGE;
    if (edge >= MIN_EDGE_15M) {
      if (momentum === "up" && edge < 20) return results;
      results.push({
        side: "NO", price: market.noAsk,
        fair: parseFloat(fairNo.toFixed(1)),
        edge: parseFloat(edge.toFixed(1)),
        title: market.title, ticker: market.ticker,
        mins: minutesLeft, strike: strike,
        type: "above", strikeLow: strike, strikeHigh: strike,
        expiration: market.expiration,
        volume: market.volume || 0,
        is15M: true, asset: market.asset,
      });
    }
  }

  return results;
}

// ==============================================================
//  HOURLY ABOVE/BELOW EVALUATOR (BTC only)
// ==============================================================

function evaluate(market, btcPrice, momentum) {
  if (market.is15M) return [];
  if (market.marketType !== "above") return [];

  const vol = get5MinVol();
  const rawFair = fairProbAbove(btcPrice, market.strike, market.minutesLeft, vol);
  const marketImplied = (market.yesAsk + (market.yesBid || market.yesAsk)) / 2;
  const fair = rawFair * 0.7 + marketImplied * 0.3;

  const distance = Math.abs(btcPrice - market.strike);
  if (distance > MAX_STRIKE_DISTANCE) return [];

  const minEdge = getMinEdge(market.minutesLeft, market.volume || 0);
  const results = [];

  if (market.yesAsk > 10 && market.yesAsk < 98) {
    const edgeVsAsk = fair - market.yesAsk - SLIPPAGE;
    if (edgeVsAsk >= minEdge) {
      if (momentum === "down" && edgeVsAsk < minEdge + 10) return results;
      results.push({
        side: "YES", price: market.yesAsk, fair: fair,
        edge: parseFloat(edgeVsAsk.toFixed(1)),
        title: market.title, ticker: market.ticker,
        mins: market.minutesLeft, strike: market.strike,
        type: market.marketType, strikeLow: market.strike,
        strikeHigh: market.strike, expiration: market.expiration,
        volume: market.volume || 0,
        is15M: false, asset: "BTC",
      });
    }
  }

  if (market.noAsk > 10 && market.noAsk < 98) {
    const fairNo = 100 - fair;
    const edgeVsAsk = fairNo - market.noAsk - SLIPPAGE;
    if (edgeVsAsk >= minEdge) {
      if (momentum === "up" && edgeVsAsk < minEdge + 10) return results;
      results.push({
        side: "NO", price: market.noAsk,
        fair: parseFloat(fairNo.toFixed(1)),
        edge: parseFloat(edgeVsAsk.toFixed(1)),
        title: market.title, ticker: market.ticker,
        mins: market.minutesLeft, strike: market.strike,
        type: market.marketType, strikeLow: market.strike,
        strikeHigh: market.strike, expiration: market.expiration,
        volume: market.volume || 0,
        is15M: false, asset: "BTC",
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
      if (data.trades) trades = data.trades;
      if (data.bankroll) bankroll = data.bankroll;
      if (data.paperPnL) paperPnL = data.paperPnL;
      if (data.wins) wins = data.wins;
      if (data.losses) losses = data.losses;
      if (data.dailyLoss) dailyLoss = data.dailyLoss;
      if (data.dailyLossDate === new Date().toDateString())
        dailyLossDate = data.dailyLossDate;
      totalEdges = trades.length;
      console.log("  Loaded " + trades.length + " prev | Bank:$" + bankroll.toFixed(2));
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
  fs.writeFileSync("dedup.json", JSON.stringify(alerted));
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
      if (pt.type === "above") {
        const isAbove = btcPrice >= pt.strike;
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

      const assetTag = pt.asset ? " [" + pt.asset + "]" : "";
      const typeTag = pt.is15M ? " [15M]" : " [1H]";

      notify(
        "RESOLVED: " + (won ? "WIN" : "LOSS") +
        " $" + pnlNum.toFixed(2) +
        " | " + pt.side + " $" + pt.strike + " " + pt.type +
        " | BTC:$" + btcPrice.toFixed(0) +
        " | Bank:$" + bankroll.toFixed(2) +
        " | W:" + wins + " L:" + losses +
        " (" + ((wins / Math.max(wins + losses, 1)) * 100).toFixed(0) + "%)" +
        assetTag + typeTag
      );

      console.log("  [CALIBRATION] Fair:" + (pt.fair || "?") + " Price:" + pt.price + " Side:" + pt.side + " Won:" + won + " Ticker:" + (pt.ticker || "?"));

      const tradeIndex = trades.findIndex((t) => t.id === pt.id);
      if (tradeIndex !== -1) {
        trades[tradeIndex].resolved = true;
        trades[tradeIndex].won = won;
        trades[tradeIndex].payout = won ? parseFloat((pt.betAmount + pnlNum).toFixed(2)) : 0;
      }
      toRemove.push(i);
    }
  }
  for (let i = toRemove.length - 1; i >= 0; i--) {
    pendingTrades.splice(toRemove[i], 1);
  }
  if (toRemove.length > 0) saveTrades();
}


function evaluateSPX(market, spxPrice, momentum) {
  if (market.asset !== "SPX") return [];
  if (market.marketType !== "above") return [];
  if (spxPrice <= 0) return [];

  const vol = 1.2;
  const rawFair = fairProbAbove(spxPrice, market.strike, market.minutesLeft, vol);
  const marketImplied = (market.yesAsk + (market.yesBid || market.yesAsk)) / 2;
  const fair = rawFair * 0.6 + marketImplied * 0.4;

  const distance = Math.abs(spxPrice - market.strike);
  if (distance > 200) return [];

  let minEdge = 15;
  if (market.minutesLeft <= 5) minEdge = 8;
  else if (market.minutesLeft <= 10) minEdge = 10;
  else if (market.minutesLeft <= 20) minEdge = 12;
  else if (market.minutesLeft <= 40) minEdge = 15;

  if (market.volume >= 1000) minEdge -= 2;
  else if (market.volume <= 10) minEdge += 3;

  const results = [];

  if (market.yesAsk > 10 && market.yesAsk < 95) {
    const edgeVsAsk = fair - market.yesAsk - SLIPPAGE;
    if (edgeVsAsk >= minEdge) {
      results.push({
        side: "YES", price: market.yesAsk, fair: fair,
        edge: parseFloat(edgeVsAsk.toFixed(1)),
        title: market.title, ticker: market.ticker,
        mins: market.minutesLeft, strike: market.strike,
        type: "above", strikeLow: market.strike,
        strikeHigh: market.strike, expiration: market.expiration,
        volume: market.volume || 0,
        is15M: false, asset: "SPX",
      });
    }
  }

  if (market.noAsk > 10 && market.noAsk < 95) {
    const fairNo = 100 - fair;
    const edgeVsAsk = fairNo - market.noAsk - SLIPPAGE;
    if (edgeVsAsk >= minEdge) {
      results.push({
        side: "NO", price: market.noAsk,
        fair: parseFloat(fairNo.toFixed(1)),
        edge: parseFloat(edgeVsAsk.toFixed(1)),
        title: market.title, ticker: market.ticker,
        mins: market.minutesLeft, strike: market.strike,
        type: "above", strikeLow: market.strike,
        strikeHigh: market.strike, expiration: market.expiration,
        volume: market.volume || 0,
        is15M: false, asset: "SPX",
      });
    }
  }

  return results;
}


//  PLACE TRADE

function placeTrade(o, btcPrice, vol, momentum) {
  totalEdges++;
  const bType = o.is15M ? "15m" : "single";
  let bet = kellyBet(o.fair, o.price, bankroll, bType);

  // 1.5x bet if edge is 30+ cents
  if (o.edge >= 30) {
    bet = Math.min(bet * 1.5, bankroll * 0.15);
    console.log("  [1.5x BET] Edge:" + o.edge + "c " + o.mins.toFixed(0) + "min → $" + bet.toFixed(2));
  }

  const contracts = parseFloat((bet / (o.price / 100)).toFixed(1));
  const feeCost = contracts * KALSHI_FEE_PER_CONTRACT;
  const effectivePrice = o.price + SLIPPAGE;
  const maxProfit = parseFloat(
    (((100 - effectivePrice) / 100) * contracts - feeCost).toFixed(2)
  );
  const kellyPct = ((bet / bankroll) * 100).toFixed(1);

  const assetTag = o.asset ? " [" + o.asset + "]" : "";
  const typeTag = o.is15M ? " [15M]" : " [1H]";

  trades.push({
    id: totalEdges, time: new Date().toISOString(),
    btcPrice: btcPrice, side: o.side, price: o.price,
    fair: o.fair, edge: o.edge, ticker: o.ticker,
    strike: o.strike, type: o.type, minutesLeft: o.mins,
    expiration: o.expiration, betSize: bet, contracts: contracts,
    maxProfit: maxProfit, maxLoss: bet, momentum: momentum,
    vol: vol, kellyPct: kellyPct, volume: o.volume,
    is15M: o.is15M || false, asset: o.asset || "BTC",
    resolved: false, won: null, payout: null,
  });

  pendingTrades.push({
    id: totalEdges,
    ticker: o.ticker,
    side: o.side,
    price: o.price,
    fair: o.fair,
    strike: o.strike,
    strikeLow: o.strikeLow,
    strikeHigh: o.strikeHigh,
    type: o.type,
    contracts: contracts,
    expiration: o.expiration,
    betAmount: bet,
    is15M: o.is15M || false,
    asset: o.asset || "BTC",
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
      " BTC:$" + btcPrice.toFixed(0) +
      " [" + pendingTrades.length + "/" + MAX_OPEN_TRADES + "]" +
      assetTag + typeTag
  );

  if (!DRY_RUN) {
    submitOrder(o.ticker, o.side, o.price, contracts).then((res) => {
      if (res && res.order) {
        notify("LIVE ORDER PLACED: " + contracts + "x " + o.side + " on " + o.ticker + " at " + o.price + "c" + assetTag + typeTag);
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
// Load dedup state from disk if empty (survives restarts)
  if (Object.keys(alerted).length === 0) {
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
  await syncBankroll();

  const btc = getBTCPrice();
  const spx = getSPXPrice();
  if (btc.price === 0) return;

  // Stale price check
  if (Date.now() - btc.updated > 15000) {
    console.log("  [STALE] Price " + ((Date.now() - btc.updated) / 1000).toFixed(0) + "s old — skipping");
    return;
  }

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

  const dynamicDailyLimit = 95;
  if (dailyLoss >= dynamicDailyLimit && !stopped) {
    stopped = true;
    notify("DAILY LIMIT: -$" + dailyLoss.toFixed(2));
  }

  resolvePendingTrades(btc.price);

  const allMarkets = await getActiveBTCMarkets();
  const markets = allMarkets.filter(function (m) {
    return m.minutesLeft >= MIN_MINUTES && m.minutesLeft <= MAX_MINUTES;
  });

  // Also include 15M markets up to 12 min (their own filter handles the rest)
  const markets15M = allMarkets.filter(function (m) {
    return m.is15M && m.minutesLeft >= 2 && m.minutesLeft <= 15;
  });

  const allTradeable = [...markets, ...markets15M];
  // Dedup by ticker
  const seen = {};
  const uniqueMarkets = [];
  for (const m of allTradeable) {
    if (!seen[m.ticker]) {
      seen[m.ticker] = true;
      uniqueMarkets.push(m);
    }
  }

  if (scanCount % 12 === 1) {
    const exposure = getDirectionalExposure(btc.price);
    const count15M = uniqueMarkets.filter(m => m.is15M).length;
    const count1H = uniqueMarkets.filter(m => !m.is15M).length;
    console.log("");
    console.log(
      "[" + new Date().toLocaleTimeString() + "] #" + scanCount +
        " BTC:$" + btc.price.toFixed(0) +
        " Vol:" + vol + "% Mom:" + momentum +
        " 15M:" + count15M + " 1H:" + count1H +
        " Open:" + pendingTrades.length + "/" + MAX_OPEN_TRADES +
        " Bank:$" + bankroll.toFixed(2) +
        " PnL:$" + paperPnL.toFixed(2) +
        " W:" + wins + " L:" + losses +
        " ↑$" + exposure.totalUp.toFixed(0) +
        " ↓$" + exposure.totalDown.toFixed(0)
    );
    if (stopped) console.log("  *** STOPPED ***");
  }

  if (stopped) return;
  if (pendingTrades.length >= MAX_OPEN_TRADES) return;
  if (uniqueMarkets.length === 0) return;

  // Spike detection
  if (detectSpike()) {
    notify("SPIKE DETECTED — skipping");
    return;
  }

  const exposure = getDirectionalExposure(btc.price);

  const expirySingleCount = {};
  for (const pt of pendingTrades) {
    expirySingleCount[pt.expiration] = (expirySingleCount[pt.expiration] || 0) + 1;
  }
  const openStrikes = {};
  for (const pt of pendingTrades) {
    openStrikes[pt.strike + "_" + pt.type + "_" + (pt.ticker || "")] = true;
  }

  // ── TRADE SCAN ──
  for (const mkt of uniqueMarkets) {
    if (pendingTrades.length >= MAX_OPEN_TRADES) break;
    if ((expirySingleCount[mkt.expiration] || 0) >= MAX_PER_EXPIRY_SINGLE) continue;

    const strikeKey = mkt.strike + "_" + mkt.marketType + "_" + mkt.ticker;
    if (openStrikes[strikeKey]) continue;

    // Route to correct evaluator
    let opps;
    if (mkt.is15M) {
    opps = evaluate15M(mkt, btc.price, momentum);
    } else if (mkt.asset === "SPX") {
      opps = evaluateSPX(mkt, spx.price, momentum);
    } else {
      opps = evaluate(mkt, btc.price, momentum);
    }

    for (const o of opps) {
      if (pendingTrades.length >= MAX_OPEN_TRADES) break;
      if ((expirySingleCount[mkt.expiration] || 0) >= MAX_PER_EXPIRY_SINGLE) break;

      const key = o.ticker + "_" + o.side;
      const now = Date.now();
      if (alerted[key] && now - alerted[key] < DEDUP_SECONDS * 1000) continue;
      alerted[key] = now;

      const bType = o.is15M ? "15m" : "single";
      const bet = kellyBet(o.fair, o.price, bankroll, bType);
      if (!checkDirectionalLimits(o, bet, btc.price, exposure)) continue;

      placeTrade(o, btc.price, vol, momentum);
      expirySingleCount[mkt.expiration] = (expirySingleCount[mkt.expiration] || 0) + 1;
      openStrikes[strikeKey] = true;
      saveTrades();
    }
  }

  // Periodic summary
  if (scanCount % 120 === 0) {
    console.log("");
    console.log("  ======= SUMMARY =======");
    console.log("  Bank:$" + bankroll.toFixed(2) + " PnL:$" + paperPnL.toFixed(2) + " (" + ((paperPnL / BANKROLL) * 100).toFixed(1) + "%)");
    console.log("  W:" + wins + " L:" + losses + " Rate:" + ((wins / Math.max(wins + losses, 1)) * 100).toFixed(1) + "%");
    const trades15M = pendingTrades.filter(pt => pt.is15M).length;
    const trades1H = pendingTrades.filter(pt => !pt.is15M).length;
    console.log("  Open: " + trades15M + " 15M | " + trades1H + " 1H");
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
  console.log("  KALSHI CRYPTO TRADER v10.0");
  console.log("  15M (BTC/ETH/SOL) + 1H ABOVE/BELOW");
  console.log("  Mode: " + (DRY_RUN ? "PAPER" : "LIVE"));
  console.log("==================================================");

  validateEnv();

  console.log("  Bankroll:        $" + BANKROLL);
  console.log("  Sizing:          Half-Kelly");
  console.log("  15M max:         12% per trade");
  console.log("  1H max:          10% per trade");
  console.log("  Slippage:        " + SLIPPAGE + "c");
  console.log("  Fees:            $" + KALSHI_FEE_PER_CONTRACT);
  console.log("  Edge:            Dynamic by time + volume");
  console.log("  Window:          " + MIN_MINUTES + "-" + MAX_MINUTES + "min");
  console.log("  15M window:      2-12min");
  console.log("  Max open:        " + MAX_OPEN_TRADES);
  console.log("  Directional cap: " + (MAX_DIRECTIONAL_RISK * 100) + "%");
  console.log("  Dedup:           " + DEDUP_SECONDS + "s");
  console.log("  Markets:         BTC/ETH/SOL 15M + BTC 1H above");
  console.log("  Range markets:   DISABLED");
  console.log("==================================================");
  console.log("");

  loadTrades();

  const ok = await startBTCFeed();
  if (!ok) {
    console.log("  Failed to start BTC feed. Exiting.");
    return;
  }

  console.log("  BTC: $" + getBTCPrice().price.toFixed(2));

  // Sync real balance on startup
  if (!DRY_RUN) {
    const realBalance = await getBalance();
    if (realBalance !== null) {
      console.log("  Kalshi balance: $" + realBalance.toFixed(2));
      bankroll = realBalance;
      paperPnL = realBalance - BANKROLL;
      wins = 0;
      losses = 0;
      trades = [];
      totalEdges = 0;
      dailyLoss = 0;
      console.log("  Real PnL: $" + paperPnL.toFixed(2));
      console.log("  Record reset — tracking fresh");
      lastBalanceSync = Date.now();
      saveTrades();
    }
  }

  console.log("  Running...");

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
