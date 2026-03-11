// ==============================================================
//  kalshi.js — Kalshi API: auth, orders, balance, sports markets
// ==============================================================

import dotenv from "dotenv";
dotenv.config();
import axios from "axios";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
const KALSHI_API_BASE = "https://api.elections.kalshi.com/trade-api/v2";

function signRequest(method, path) {
  const timestamp = Date.now().toString();
  const pathWithoutQuery = path.split("?")[0];
  const fullPath = "/trade-api/v2" + pathWithoutQuery;
  const msgString = timestamp + method + fullPath;

  let privateKey = process.env.KALSHI_PRIVATE_KEY;
  if (!privateKey) throw new Error("KALSHI_PRIVATE_KEY not set");

  privateKey = privateKey.replace(/\\n/g, "\n");
  if (!privateKey.includes("BEGIN")) {
    privateKey = "-----BEGIN PRIVATE KEY-----\n" + privateKey + "\n-----END PRIVATE KEY-----";
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

export async function getBalance() {
  try {
    const path = "/portfolio/balance";
    const headers = signRequest("GET", path);
    const res = await axios.get(KALSHI_API_BASE + path, { headers });
    return (res.data.balance || 0) / 100;
  } catch (e) {
    console.error("  [!] Balance error:", e.response?.data || e.message);
    return null;
  }
}

export async function getSportsMarkets(sport) {
  try {
    const path = "/markets?limit=200&status=open&series_ticker=" + sport;
    const headers = signRequest("GET", path);
    const res = await axios.get(KALSHI_API_BASE + path, { headers });
    return res.data.markets || [];
  } catch (e) {
    console.error("  [!] Markets error (" + sport + "):", e.response?.data || e.message);
    return [];
  }
}

export async function submitOrder(ticker, side, price, contracts) {
  try {
    const path = "/portfolio/orders";
    const headers = signRequest("POST", path);

    const body = {
      action: "buy",
      client_order_id: uuidv4(),
      count: Math.floor(contracts),
      side: side.toLowerCase(),
      ticker: ticker,
      type: "limit",
      yes_price: side.toLowerCase() === "yes" ? price : 100 - price,
    };

    console.log("  [ORDER] Submitting:", JSON.stringify(body));
    const res = await axios.post(KALSHI_API_BASE + path, body, { headers });
    console.log("  [ORDER] Response:", JSON.stringify(res.data));
    return res.data;
  } catch (e) {
    console.error("  [!] Order error:", e.response?.data || e.message);
    return null;
  }
}
