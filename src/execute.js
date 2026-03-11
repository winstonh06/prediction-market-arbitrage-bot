// ==============================================================
//  execute.js — Kalshi order execution with RSA-PSS signing
//  + getBalance() to sync real bankroll from Kalshi
// ==============================================================

import axios from "axios";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";

const KALSHI_API_BASE = "https://api.elections.kalshi.com/trade-api/v2";

function signKalshiRequest(method, path) {
  const timestamp = Date.now().toString();
  const pathWithoutQuery = path.split("?")[0];
  const fullPath = "/trade-api/v2" + pathWithoutQuery;
  const msgString = timestamp + method + fullPath;

  let privateKey = process.env.KALSHI_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("KALSHI_PRIVATE_KEY is not set in environment");
  }

  privateKey = privateKey.replace(/\\n/g, "\n");
  if (!privateKey.includes("BEGIN")) {
    privateKey =
      "-----BEGIN PRIVATE KEY-----\n" +
      privateKey +
      "\n-----END PRIVATE KEY-----";
  }

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(msgString);
  sign.end();

  const signature = sign.sign({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return {
    "KALSHI-ACCESS-KEY": process.env.KALSHI_API_KEY,
    "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "Content-Type": "application/json",
  };
}

// ── Get real account balance from Kalshi ─────────────────────
export async function getBalance() {
  try {
    const path = "/portfolio/balance";
    const method = "GET";
    const headers = signKalshiRequest(method, path);

    const response = await axios.get(KALSHI_API_BASE + path, { headers });

    // Kalshi returns balance in cents (integer)
    const balanceCents = response.data.balance || 0;
    const balanceDollars = balanceCents / 100;

    return balanceDollars;
  } catch (error) {
    const errData = error.response?.data || error.message;
    const errStatus = error.response?.status || "N/A";
    console.error(
      "  [!] BALANCE CHECK ERROR (HTTP " + errStatus + "):",
      JSON.stringify(errData)
    );
    return null;
  }
}

// ── Get open positions from Kalshi ───────────────────────────
export async function getPositions() {
  try {
    const path = "/portfolio/positions";
    const method = "GET";
    const headers = signKalshiRequest(method, path);

    const response = await axios.get(KALSHI_API_BASE + path, { headers });
    return response.data;
  } catch (error) {
    const errData = error.response?.data || error.message;
    const errStatus = error.response?.status || "N/A";
    console.error(
      "  [!] POSITIONS CHECK ERROR (HTTP " + errStatus + "):",
      JSON.stringify(errData)
    );
    return null;
  }
}
// ── Get settlements from Kalshi ──────────────────────────────
export async function getSettlements() {
  try {
    const path = "/portfolio/settlements?limit=100";
    const method = "GET";
    const headers = signKalshiRequest(method, path);

    const response = await axios.get(KALSHI_API_BASE + path, { headers });
    return response.data.settlements || [];
  } catch (error) {
    const errData = error.response?.data || error.message;
    const errStatus = error.response?.status || "N/A";
    console.error(
      "  [!] SETTLEMENTS ERROR (HTTP " + errStatus + "):",
      JSON.stringify(errData)
    );
    return [];
  }
}

// ── Submit order to Kalshi ──────────────────────────────────
export async function submitOrder(ticker, side, price, contracts) {
  try {
    const path = "/portfolio/orders";
    const method = "POST";
    const headers = signKalshiRequest(method, path);

    const sideValue = side.toLowerCase();

    const body = {
      action: "buy",
      client_order_id: uuidv4(),
      count: Math.floor(contracts),
      side: sideValue,
      ticker: ticker,
      type: "limit",
      yes_price: sideValue === "yes" ? price : 100 - price,
    };

    console.log("  [ORDER] Submitting:", JSON.stringify(body));

    const response = await axios.post(KALSHI_API_BASE + path, body, {
      headers,
    });

    console.log("  [ORDER] Response:", JSON.stringify(response.data));
    return response.data;
  } catch (error) {
    const errData = error.response?.data || error.message;
    const errStatus = error.response?.status || "N/A";
    console.error(
      "  [!] KALSHI ORDER ERROR (HTTP " + errStatus + "):",
      JSON.stringify(errData)
    );
    return null;
  }
}
