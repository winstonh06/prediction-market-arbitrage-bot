// ==============================================================
//  pricing.js — Fair probability math + volatility estimation
//  Default vol raised to 6% to prevent overpricing edges
// ==============================================================

function normalCDF(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);

  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

export function fairProbAbove(currentPrice, strike, minutesLeft, volPerDay) {
  if (minutesLeft <= 0) return currentPrice >= strike ? 100 : 0;
  const volPerMin = volPerDay / 100 / Math.sqrt(1440);
  const totalVol = volPerMin * Math.sqrt(minutesLeft);
  if (totalVol <= 0) return currentPrice >= strike ? 100 : 0;
  const d2 = Math.log(currentPrice / strike) / totalVol;
  return parseFloat(
    Math.max(0, Math.min(100, normalCDF(d2) * 100)).toFixed(1)
  );
}

export function fairProbBelow(cp, strike, mins, vol) {
  return parseFloat((100 - fairProbAbove(cp, strike, mins, vol)).toFixed(1));
}

export function fairProbRange(cp, low, high, mins, vol) {
  const pLow = fairProbAbove(cp, low, mins, vol);
  const pHigh = fairProbAbove(cp, high, mins, vol);
  return parseFloat(Math.max(0, pLow - pHigh).toFixed(1));
}

let recentPrices = [];
export function updateVolatility(price) {
  recentPrices.push(price);
  if (recentPrices.length > 500) recentPrices = recentPrices.slice(-500);
}

export function getVolatility() {
  if (recentPrices.length < 20) return 6.0;  // Higher default — prevents fake edges
  const ret = [];
  for (let i = 1; i < recentPrices.length; i++) {
    ret.push(Math.log(recentPrices[i] / recentPrices[i - 1]));
  }
  let sum = 0;
  for (const r of ret) sum += r;
  const mean = sum / ret.length;
  let v = 0;
  for (const r of ret) v += (r - mean) * (r - mean);
  v /= ret.length;
  const daily = Math.sqrt(v) * Math.sqrt(17280) * 100;
  return parseFloat(Math.max(1, Math.min(10, daily)).toFixed(2));
}
