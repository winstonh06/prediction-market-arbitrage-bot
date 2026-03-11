// ==============================================================
//  btcFeed.js — Multi-source BTC price feed
//  Averages Coinbase + Kraken + CoinGecko to approximate
//  CF Benchmarks (what Kalshi actually settles on)
// ==============================================================

import fetch from "node-fetch";

let currentPrice = 0;
let lastUpdate = 0;
let running = false;
let sourceCount = 0;

export function getBTCPrice() {
  return { price: currentPrice, updated: lastUpdate };
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

async function fetchPrice() {
  // Fetch from all sources in parallel
  const [coinbase, kraken, coingecko] = await Promise.all([
    fetchCoinbase(),
    fetchKraken(),
    fetchCoinGecko(),
  ]);

  const prices = [];
  if (coinbase) prices.push(coinbase);
  if (kraken) prices.push(kraken);
  if (coingecko) prices.push(coingecko);

  if (prices.length === 0) {
    console.error("  [!] All price feeds failed");
    return;
  }

  // Average all available prices — closer to CF Benchmarks
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

  // Sanity check — if any source differs by more than 1% from average, drop it
  const filtered = prices.filter(p => Math.abs(p - avg) / avg < 0.01);
  
  if (filtered.length > 0) {
    currentPrice = filtered.reduce((a, b) => a + b, 0) / filtered.length;
  } else {
    currentPrice = avg;
  }

  sourceCount = prices.length;
  lastUpdate = Date.now();
}

export async function startBTCFeed() {
  console.log("  Connecting to BTC price feeds...");
  await fetchPrice();
  if (currentPrice > 0) {
    console.log("  BTC feed connected: $" + currentPrice.toFixed(2) + " (" + sourceCount + " sources)");
    running = true;
    setInterval(fetchPrice, 2000);  // Fetch every 2 seconds for faster data
    return true;
  }
  console.log("  Failed to get BTC price");
  return false;
}
