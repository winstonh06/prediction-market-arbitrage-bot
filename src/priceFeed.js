// ==============================================================
//  priceFeed.js — Multi-asset price feeds
//  BTC: Coinbase + Kraken + CoinGecko (averaged)
//  SPX: Yahoo Finance SPY ETF as proxy for S&P 500
// ==============================================================

import fetch from "node-fetch";

// ── BTC ──────────────────────────────────────────────────────
let btcPrice = 0;
let btcUpdate = 0;
let btcSources = 0;

export function getBTCPrice() {
  return { price: btcPrice, updated: btcUpdate };
}

async function fetchCoinbase() {
  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
    if (res.ok) {
      const data = await res.json();
      return parseFloat(data.data.amount);
    }
  } catch (e) {}
  return null;
}

async function fetchKraken() {
  try {
    const res = await fetch("https://api.kraken.com/0/public/Ticker?pair=XBTUSD");
    if (res.ok) {
      const data = await res.json();
      const ticker = data.result && data.result.XXBTZUSD;
      if (ticker && ticker.c && ticker.c[0]) {
        return parseFloat(ticker.c[0]);
      }
    }
  } catch (e) {}
  return null;
}

async function fetchCoinGecko() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
    if (res.ok) {
      const data = await res.json();
      return data.bitcoin.usd;
    }
  } catch (e) {}
  return null;
}

async function fetchBTC() {
  const [coinbase, kraken, coingecko] = await Promise.all([
    fetchCoinbase(), fetchKraken(), fetchCoinGecko(),
  ]);

  const prices = [];
  if (coinbase) prices.push(coinbase);
  if (kraken) prices.push(kraken);
  if (coingecko) prices.push(coingecko);

  if (prices.length === 0) return;

  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const filtered = prices.filter(p => Math.abs(p - avg) / avg < 0.01);

  btcPrice = filtered.length > 0
    ? filtered.reduce((a, b) => a + b, 0) / filtered.length
    : avg;
  btcSources = prices.length;
  btcUpdate = Date.now();
}

// ── SPX (S&P 500 via SPY ETF) ────────────────────────────────
let spxPrice = 0;
let spxUpdate = 0;

export function getSPXPrice() {
  return { price: spxPrice, updated: spxUpdate };
}

async function fetchSPX() {
  // Method 1: Yahoo Finance quote endpoint
  try {
    const res = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1m&range=1d",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (res.ok) {
      const data = await res.json();
      const meta = data.chart?.result?.[0]?.meta;
      if (meta && meta.regularMarketPrice) {
        // SPY tracks SPX at roughly 1/10 scale, multiply by 10
        spxPrice = meta.regularMarketPrice * 10;
        spxUpdate = Date.now();
        return;
      }
    }
  } catch (e) {}

  // Method 2: Direct SPX index from Yahoo
  try {
    const res = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1m&range=1d",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (res.ok) {
      const data = await res.json();
      const meta = data.chart?.result?.[0]?.meta;
      if (meta && meta.regularMarketPrice) {
        spxPrice = meta.regularMarketPrice;
        spxUpdate = Date.now();
        return;
      }
    }
  } catch (e) {}
}

// ── START FEEDS ──────────────────────────────────────────────
export async function startBTCFeed() {
  console.log("  Connecting to price feeds...");

  await fetchBTC();
  await fetchSPX();

  if (btcPrice > 0) {
    console.log("  BTC feed connected: $" + btcPrice.toFixed(2) + " (" + btcSources + " sources)");
  } else {
    console.log("  [!] BTC feed failed");
  }

  if (spxPrice > 0) {
    console.log("  SPX feed connected: " + spxPrice.toFixed(2));
  } else {
    console.log("  [WARN] SPX feed unavailable (market may be closed)");
  }

  // BTC updates every 2 seconds
  setInterval(fetchBTC, 2000);
  // SPX updates every 10 seconds (less volatile, save API calls)
  setInterval(fetchSPX, 10000);

  return btcPrice > 0;
}
