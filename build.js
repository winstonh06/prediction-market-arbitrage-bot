import fs from 'fs';

const code = `import { startBTCFeed, getBTCPrice } from "./btcFeed.js";
import { getActiveBTCMarkets } from "./kalshiBTC.js";
import { fairProbAbove, fairProbBelow, fairProbRange, updateVolatility, getVolatility } from "./pricing.js";
import fs from "fs";

const DRY_RUN = true;
const BANKROLL = 1000;
const SCAN_INTERVAL = 5000;
const MIN_MINUTES = 3;
const MAX_MINUTES = 58;
const MAX_OPEN_TRADES = 5;
const MAX_PER_EXPIRY = 2;
const DAILY_LOSS_LIMIT = 100;
const DEDUP_SECONDS = 180;
const MAX_STRIKE_DISTANCE = 500;

let scanCount = 0;
let totalEdges = 0;
let paperPnL = 0;
let bankroll = BANKROLL;
let dailyLoss = 0;
let dailyLossDate = new Date().toDateString();
let trades = [];
let wins = 0;
let losses = 0;
let stopped = false;
const alerted = {};
const pendingTrades = [];
const priceHistory = [];

function kellyBet(fairProb, price, bankrollNow) {
  const pWin = fairProb / 100;
  const pLose = 1 - pWin;
  const odds = (100 - price) / price;
  const kellyFull = (pWin * odds - pLose) / odds;
  const kellyHalf = kellyFull / 2;
  const fraction = Math.max(0, Math.min(kellyHalf, 0.06));
  const bet = bankrollNow * fraction;
  return parseFloat(Math.max(10, Math.min(bet, bankrollNow * 0.06)).toFixed(2));
}

function getMinEdge(minutesLeft, volume) {
  let base = 14;
  if (minutesLeft <= 8) base = 8;
  else if (minutesLeft <= 15) base = 9;
  else if (minutesLeft <= 25) base = 10;
  else if (minutesLeft <= 40) base = 12;

  if (volume >= 100) base = base - 2;
  else if (volume >= 20) base = base - 1;
  else if (volume <= 2) base = base + 2;

  return Math.max(6, base);
}

function getMomentum() {
  if (priceHistory.length < 10) return "flat";
  const recent = priceHistory.slice(-15);
  const oldest = recent.at(0);
  const newest = recent.at(recent.length - 1);
  const pctChange = ((newest - oldest) / oldest) * 100;
  if (pctChange > 0.1) return "up";
  if (pctChange < -0.1) return "down";
  return "flat";
}

function get5MinVol() {
  if (priceHistory.length < 30) return getVolatility();
  const recent = priceHistory.slice(-60);
  const returns = [];
  for (let i = 1; i < recent.length; i++) {
    returns.push(Math.log(recent.at(i) / recent.at(i - 1)));
  }
  let sum = 0;
  for (const r of returns) sum += r;
  const mean = sum / returns.length;
  let v = 0;
  for (const r of returns) v += (r - mean) * (r - mean);
  v /= returns.length;
  const daily = Math.sqrt(v) * Math.sqrt(17280) * 100;
  return parseFloat(Math.max(1.5, Math.min(10, daily)).toFixed(2));
}

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
      if (data.dailyLossDate === new Date().toDateString()) dailyLossDate = data.dailyLossDate;
      totalEdges = trades.length;
      console.log("  Loaded " + trades.length + " prev | Bank:$" + bankroll.toFixed(2));
    }
  } catch(e) {}
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
    trades: trades
  };
  fs.writeFileSync("trades.json", JSON.stringify(data, null, 2));
}

function notify(msg) {
  const ts = new Date().toLocaleTimeString();
  const line = "[" + ts + "] " + msg;
  console.log("");
  console.log("  >>>>> " + line);
  console.log("");
  try {
    let log = "";
    if (fs.existsSync("notifications.log")) log = fs.readFileSync("notifications.log", "utf-8");
    log += line + "\\n";
    fs.writeFileSync("notifications.log", log);
  } catch(e) {}
}

function resolvePendingTrades(btcPrice) {
  const now = Date.now();
  const toRemove = [];
  for (let i = 0; i < pendingTrades.length; i++) {
    const pt = pendingTrades.at(i);
    const expTime = new Date(pt.expiration).getTime();
    if (now >= expTime) {
      let won = false;
      if (pt.type === "range") {
        const inRange = btcPrice >= pt.strikeLow && btcPrice < pt.strikeHigh;
        won = pt.side === "YES" ? inRange : !inRange;
      } else if (pt.type === "above") {
        const isAbove = btcPrice >= pt.strike;
        won = pt.side === "YES" ? isAbove : !isAbove;
      }
      const dollarPnL = won
        ? parseFloat(((100 - pt.price) / 100 * pt.contracts).toFixed(2))
        : parseFloat((-(pt.betAmount)).toFixed(2));
      paperPnL += dollarPnL;
      bankroll += dollarPnL;
      if (dollarPnL < 0) dailyLoss += Math.abs(dollarPnL);
      if (won) wins++; else losses++;
      notify("RESOLVED: " + (won ? "WIN" : "LOSS") + " $" + dollarPnL.toFixed(2) + " | " + pt.side + " $" + pt.strike + " " + pt.type + " | BTC:$" + btcPrice.toFixed(0) + " | Bank:$" + bankroll.toFixed(2) + " | W:" + wins + " L:" + losses + " (" + ((wins / Math.max(wins + losses, 1)) * 100).toFixed(0) + "%)");
      toRemove.push(i);
    }
  }
  for (let i = toRemove.length - 1; i >= 0; i--) {
    pendingTrades.splice(toRemove.at(i), 1);
  }
  if (toRemove.length > 0) saveTrades();
}

function evaluate(market, btcPrice, momentum) {
  const vol = get5MinVol();
  let fair = 0;
  let strikeLow = market.strikeLow;
  let strikeHigh = market.strikeLow + 250;

  if (market.marketType === "above") {
    fair = fairProbAbove(btcPrice, market.strike, market.minutesLeft, vol);
  } else if (market.marketType === "range") {
    fair = fairProbRange(btcPrice, strikeLow, strikeHigh, market.minutesLeft, vol);
  } else return [];

  const distance = Math.abs(btcPrice - market.strike);
  if (distance > MAX_STRIKE_DISTANCE) return [];

  const minEdge = getMinEdge(market.minutesLeft, market.volume || 0);
  const results = [];

  if (market.yesAsk > 2 && market.yesAsk < 90) {
    const edgeVsAsk = fair - market.yesAsk;
    if (edgeVsAsk >= minEdge) {
      if (market.marketType === "above" && momentum === "down") return results;
      results.push({ side:"YES", price:market.yesAsk, fair:fair, edge:parseFloat(edgeVsAsk.toFixed(1)), title:market.title, ticker:market.ticker, mins:market.minutesLeft, strike:market.strike, type:market.marketType, strikeLow:strikeLow, strikeHigh:strikeHigh, expiration:market.expiration, volume:market.volume || 0 });
    }
  }

  if (market.noAsk > 2 && market.noAsk < 90) {
    const fairNo = 100 - fair;
    const edgeVsAsk = fairNo - market.noAsk;
    if (edgeVsAsk >= minEdge) {
      if (market.marketType === "above" && momentum === "up") return results;
      results.push({ side:"NO", price:market.noAsk, fair:parseFloat(fairNo.toFixed(1)), edge:parseFloat(edgeVsAsk.toFixed(1)), title:market.title, ticker:market.ticker, mins:market.minutesLeft, strike:market.strike, type:market.marketType, strikeLow:strikeLow, strikeHigh:strikeHigh, expiration:market.expiration, volume:market.volume || 0 });
    }
  }

  return results;
}

async function runScan() {
  scanCount++;
  const btc = getBTCPrice();
  if (btc.price === 0) return;
  updateVolatility(btc.price);
  priceHistory.push(btc.price);
  if (priceHistory.length > 500) priceHistory.splice(0, priceHistory.length - 500);
  const vol = get5MinVol();
  const momentum = getMomentum();

  const today = new Date().toDateString();
  if (today !== dailyLossDate) {
    dailyLoss = 0;
    dailyLossDate = today;
    stopped = false;
    notify("NEW DAY - Reset.");
  }

  if (dailyLoss >= DAILY_LOSS_LIMIT && !stopped) {
    stopped = true;
    notify("DAILY LIMIT -$" + dailyLoss.toFixed(2));
  }

  resolvePendingTrades(btc.price);

  const allMarkets = await getActiveBTCMarkets();
  const markets = allMarkets.filter(function(m) {
    return m.minutesLeft >= MIN_MINUTES && m.minutesLeft <= MAX_MINUTES;
  });

  if (scanCount % 12 === 1) {
    console.log("");
    console.log("[" + new Date().toLocaleTimeString() + "] #" + scanCount + " BTC:$" + btc.price.toFixed(0) + " Vol:" + vol + "% Mom:" + momentum + " Mkts:" + markets.length + " Open:" + pendingTrades.length + "/" + MAX_OPEN_TRADES + " Bank:$" + bankroll.toFixed(2) + " PnL:$" + paperPnL.toFixed(2) + " W:" + wins + " L:" + losses);
    if (stopped) console.log("  *** STOPPED ***");
  }

  if (stopped) return;
  if (pendingTrades.length >= MAX_OPEN_TRADES) return;
  if (markets.length === 0) return;

  const expiryCount = {};
  for (const pt of pendingTrades) {
    expiryCount[pt.expiration] = (expiryCount[pt.expiration] || 0) + 1;
  }
  const openStrikes = {};
  for (const pt of pendingTrades) {
    openStrikes[pt.strike + "_" + pt.type] = true;
  }

  for (const mkt of markets) {
    if (pendingTrades.length >= MAX_OPEN_TRADES) break;
    if ((expiryCount[mkt.expiration] || 0) >= MAX_PER_EXPIRY) continue;
    if (openStrikes[mkt.strike + "_" + mkt.marketType]) continue;

    const opps = evaluate(mkt, btc.price, momentum);
    for (const o of opps) {
      if (pendingTrades.length >= MAX_OPEN_TRADES) break;
      if ((expiryCount[mkt.expiration] || 0) >= MAX_PER_EXPIRY) break;

      const key = o.ticker + "_" + o.side;
      const now = Date.now();
      if (alerted[key] && (now - alerted[key]) < DEDUP_SECONDS * 1000) continue;
      alerted[key] = now;

      totalEdges++;
      const bet = kellyBet(o.fair, o.price, bankroll);
      const contracts = parseFloat((bet / (o.price / 100)).toFixed(1));
      const maxProfit = parseFloat((((100 - o.price) / 100) * contracts).toFixed(2));
      const kellyPct = ((bet / bankroll) * 100).toFixed(1);

      trades.push({
        id: totalEdges, time: new Date().toISOString(),
        btcPrice: btc.price, side: o.side, price: o.price,
        fair: o.fair, edge: o.edge, ticker: o.ticker,
        strike: o.strike, type: o.type, minutesLeft: o.mins,
        expiration: o.expiration, betSize: bet, contracts: contracts,
        maxProfit: maxProfit, maxLoss: bet, momentum: momentum,
        vol: vol, kellyPct: kellyPct, volume: o.volume,
        resolved: false, won: null, payout: null
      });

      pendingTrades.push({
        side: o.side, price: o.price, strike: o.strike,
        strikeLow: o.strikeLow, strikeHigh: o.strikeHigh,
        type: o.type, contracts: contracts, expiration: o.expiration,
        betAmount: bet
      });

      expiryCount[mkt.expiration] = (expiryCount[mkt.expiration] || 0) + 1;
      openStrikes[o.strike + "_" + o.type] = true;

      notify(
        "#" + totalEdges + " " + o.side + " " + o.price + "c" +
        " Edge:" + o.edge + "c Fair:" + o.fair + "c" +
        " $" + o.strike + " " + o.type.toUpperCase() +
        " Kelly:" + kellyPct + "% $" + bet + " (" + contracts.toFixed(0) + "x)" +
        " +" + maxProfit + "/-" + bet +
        " " + o.mins.toFixed(0) + "min Mom:" + momentum +
        " Vol:" + o.volume +
        " BTC:$" + btc.price.toFixed(0) +
        " [" + pendingTrades.length + "/" + MAX_OPEN_TRADES + "]"
      );
      saveTrades();
    }
  }

  if (scanCount % 120 === 0) {
    console.log("");
    console.log("  ======= SUMMARY =======");
    console.log("  Bank:$" + bankroll.toFixed(2) + " PnL:$" + paperPnL.toFixed(2) + " (" + ((paperPnL / BANKROLL) * 100).toFixed(1) + "%)");
    console.log("  W:" + wins + " L:" + losses + " Rate:" + ((wins / Math.max(wins + losses, 1)) * 100).toFixed(1) + "%");
    console.log("  ======================");
    saveTrades();
  }
}

async function main() {
  console.log("");
  console.log("==================================================");
  console.log("  KALSHI BTC TRADER v6.0 (KELLY + VOLUME)");
  console.log("  Mode: " + (DRY_RUN ? "PAPER" : "LIVE"));
  console.log("==================================================");
  console.log("  Bankroll:      $" + BANKROLL);
  console.log("  Sizing:        Half-Kelly (max 6%)");
  console.log("  Edge:          Dynamic by time + volume");
  console.log("  Window:        " + MIN_MINUTES + "-" + MAX_MINUTES + "min");
  console.log("  Max open:      " + MAX_OPEN_TRADES + " (max " + MAX_PER_EXPIRY + "/expiry)");
  console.log("  Distance:      $" + MAX_STRIKE_DISTANCE);
  console.log("  Daily limit:   -$" + DAILY_LOSS_LIMIT);
  console.log("==================================================");
  console.log("");
  loadTrades();
  const ok = await startBTCFeed();
  if (!!ok) { console.log("  Failed"); return; }
  console.log("  BTC: $" + getBTCPrice().price.toFixed(2));
  console.log("  Running...");
  await runScan();
  setInterval(async function() {
    try { await runScan(); } catch(e) { console.log("  Err: " + e.message); }
  }, SCAN_INTERVAL);
}

main();`;

fs.writeFileSync('src/trader.js', code);
console.log('trader.js v6.0 written OK');
