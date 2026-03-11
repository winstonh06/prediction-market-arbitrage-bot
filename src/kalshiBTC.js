// ==============================================================
//  kalshiMarkets.js — Fetch active markets from Kalshi
//  BTC: hourly above/below + 15-minute up/down
//  SPX: hourly above/below + daily above/below
// ==============================================================

import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

export async function getActiveBTCMarkets() {
  try {
    const headers = {};
    if (process.env.KALSHI_API_KEY) {
      headers["Authorization"] = "Bearer " + process.env.KALSHI_API_KEY;
    }

    const seriesList = [
      // BTC
      "KXBTC", "KXCBBTC", "KXBTCD",
      "KXBTC15M",
      // S&P 500
      "KXINXU",    // S&P 500 above/below (hourly/daily)
      "KXINX",     // S&P 500 range (we'll filter to above/below only)
    ];

    const allMarkets = [];

    for (const series of seriesList) {
      try {
        const res = await fetch(
          "https://api.elections.kalshi.com/trade-api/v2/markets?limit=200&status=open&series_ticker=" +
            series,
          { headers }
        );
        if (res.ok) {
          const data = await res.json();
          allMarkets.push(...(data.markets || []));
        }
      } catch (e) {
        continue;
      }
    }

    const now = Date.now();
    const formatted = [];

    for (const m of allMarkets) {
      try {
        const ticker = m.ticker || "";
        const title = (m.title || "").toLowerCase();
        const exp =
          m.close_time || m.expiration_time || m.expected_expiration_time || "";
        const minutesLeft = (new Date(exp).getTime() - now) / 60000;

        if (minutesLeft < 0 || minutesLeft > 1200) continue;
        if (m.yes_ask <= 1 && m.yes_bid <= 0) continue;

        let strike = 0;
        let marketType = "";
        let asset = "BTC";
        const is15M = ticker.startsWith("KXBTC15M");

        // Determine asset
        if (ticker.startsWith("KXINX")) {
          asset = "SPX";
        }

        if (is15M) {
          // BTC 15-min markets
          strike = m.floor_strike || 0;
          if (strike <= 0) continue;
          marketType = "above";
        } else if (asset === "SPX") {
          // S&P 500 markets — look for "above" in title or T prefix
          const tMatch = ticker.match(/T(\d+\.?\d*)/);
          if (tMatch) {
            strike = parseFloat(tMatch[1]);
            marketType = "above";
          } else if (title.includes("above") || title.includes("below")) {
            // Try to extract strike from title
            const numMatch = title.match(/(\d{4,5}\.?\d*)/);
            if (numMatch) {
              strike = parseFloat(numMatch[1]);
              marketType = "above";
            } else {
              continue;
            }
          } else {
            // Skip range markets
            continue;
          }
        } else {
          // BTC hourly — only above/below (T prefix)
          const tMatch = ticker.match(/T(\d+\.?\d*)/);
          if (tMatch) {
            strike = parseFloat(tMatch[1]);
            marketType = "above";
          } else {
            // Skip range markets (B prefix)
            continue;
          }
        }

        if (strike <= 0) continue;

        formatted.push({
          title: m.title || "",
          ticker: ticker,
          marketType: marketType,
          is15M: is15M,
          asset: asset,
          strike: strike,
          strikeLow: strike,
          strikeHigh: strike,
          yesAsk: m.yes_ask || 0,
          yesBid: m.yes_bid || 0,
          noAsk: m.no_ask || 0,
          noBid: m.no_bid || 0,
          volume: m.volume || 0,
          minutesLeft: parseFloat(minutesLeft.toFixed(1)),
          expiration: exp,
        });
      } catch (e) {
        continue;
      }
    }

    formatted.sort(function (a, b) {
      return a.minutesLeft - b.minutesLeft;
    });
    return formatted;
  } catch (err) {
    console.error("  Markets error: " + err.message);
    return [];
  }
}
