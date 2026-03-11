import json
import random
import statistics
import os

def load_trades(path="trades.json"):
    if not os.path.exists(path):
        print("ERROR: trades.json not found.")
        exit(1)
    with open(path, "r") as f:
        data = json.load(f)
    trades = data.get("trades", [])
    resolved = [t for t in trades if t.get("won") is not None]
    if len(resolved) == 0:
        print("ERROR: No resolved trades found.")
        exit(1)
    return data, resolved

def build_outcomes(resolved_trades):
    outcomes = []
    for t in resolved_trades:
        bet = t.get("betSize", t.get("maxLoss", 0))
        won = t.get("won", False)
        payout = t.get("maxProfit", 0)
        if won:
            pnl = payout
        else:
            pnl = -bet
        outcomes.append({
            "pnl": pnl,
            "bet": bet,
            "won": won
        })
    return outcomes

def run_montecarlo(outcomes, starting_bankroll, num_simulations=10000, trades_per_sim=100):
    win_rate = sum(1 for o in outcomes if o["won"]) / len(outcomes)
    avg_win = statistics.mean(o["pnl"] for o in outcomes if o["won"]) if any(o["won"] for o in outcomes) else 0
    avg_loss = statistics.mean(abs(o["pnl"]) for o in outcomes if not o["won"]) if any(not o["won"] for o in outcomes) else 0
    avg_bet = statistics.mean(o["bet"] for o in outcomes)

    print("")
    print("=" * 55)
    print("  MONTE CARLO - KALSHI BTC BOT")
    print("=" * 55)
    print(f"  Real trades used:     {len(outcomes)}")
    print(f"  Win rate:             {win_rate*100:.1f}%")
    print(f"  Avg win:              ${avg_win:.2f}")
    print(f"  Avg loss:             ${avg_loss:.2f}")
    print(f"  Avg bet:              ${avg_bet:.2f}")
    print(f"  Starting bankroll:    ${starting_bankroll:.2f}")
    print(f"  Simulations:          {num_simulations:,}")
    print(f"  Trades per sim:       {trades_per_sim}")
    print("=" * 55)

    final_bankrolls = []
    bust_count = 0
    drawdown_list = []
    profitable_count = 0

    for sim in range(num_simulations):
        bankroll = starting_bankroll
        peak = starting_bankroll
        max_drawdown = 0

        for _ in range(trades_per_sim):
            sample = random.choice(outcomes)
            bet_fraction = sample["bet"] / starting_bankroll
            scaled_bet = bankroll * bet_fraction
            scaled_bet = max(5, min(scaled_bet, bankroll * 0.10))

            if sample["won"]:
                profit_ratio = sample["pnl"] / sample["bet"]
                bankroll += scaled_bet * profit_ratio
            else:
                bankroll -= scaled_bet

            if bankroll > peak:
                peak = bankroll
            drawdown = (peak - bankroll) / peak * 100
            if drawdown > max_drawdown:
                max_drawdown = drawdown

            if bankroll <= 50:
                bust_count += 1
                bankroll = 0
                break

        final_bankrolls.append(bankroll)
        drawdown_list.append(max_drawdown)
        if bankroll > starting_bankroll:
            profitable_count += 1

    final_bankrolls.sort()
    p5  = final_bankrolls[int(num_simulations * 0.05)]
    p25 = final_bankrolls[int(num_simulations * 0.25)]
    p50 = final_bankrolls[int(num_simulations * 0.50)]
    p75 = final_bankrolls[int(num_simulations * 0.75)]
    p95 = final_bankrolls[int(num_simulations * 0.95)]

    avg_final = statistics.mean(final_bankrolls)
    avg_drawdown = statistics.mean(drawdown_list)
    max_drawdown_seen = max(drawdown_list)

    print("")
    print(f"  OUTCOMES AFTER {trades_per_sim} TRADES")
    print("-" * 55)
    print(f"  5th  percentile (worst):   ${p5:.2f}")
    print(f"  25th percentile:           ${p25:.2f}")
    print(f"  50th percentile (median):  ${p50:.2f}")
    print(f"  75th percentile:           ${p75:.2f}")
    print(f"  95th percentile (best):    ${p95:.2f}")
    print(f"  Average final bankroll:    ${avg_final:.2f}")
    print("")
    print("  RISK METRICS")
    print("-" * 55)
    print(f"  Profitable sims:       {profitable_count/num_simulations*100:.1f}%")
    print(f"  Bust rate:             {bust_count/num_simulations*100:.2f}%")
    print(f"  Avg max drawdown:      {avg_drawdown:.1f}%")
    print(f"  Worst drawdown seen:   {max_drawdown_seen:.1f}%")
    print("")
    print("  GROWTH")
    print("-" * 55)
    print(f"  Median growth:         {((p50-starting_bankroll)/starting_bankroll)*100:.1f}%")
    print(f"  Average growth:        {((avg_final-starting_bankroll)/starting_bankroll)*100:.1f}%")
    print("=" * 55)

def run_scenarios(outcomes, starting_bankroll):
    print("")
    print("  SCENARIO ANALYSIS (median outcome)")
    print("-" * 55)
    print(f"  {'Trades':<10} {'Median $':<15} {'Growth':<15} {'Bust %'}")
    print("-" * 55)

    for n_trades in [50, 100, 250, 500, 1000]:
        results = []
        busts = 0
        for _ in range(2000):
            bankroll = starting_bankroll
            for _ in range(n_trades):
                sample = random.choice(outcomes)
                bet_fraction = sample["bet"] / starting_bankroll
                scaled_bet = bankroll * bet_fraction
                scaled_bet = max(5, min(scaled_bet, bankroll * 0.10))
                if sample["won"]:
                    profit_ratio = sample["pnl"] / sample["bet"]
                    bankroll += scaled_bet * profit_ratio
                else:
                    bankroll -= scaled_bet
                if bankroll <= 50:
                    busts += 1
                    bankroll = 0
                    break
            results.append(bankroll)
        results.sort()
        median = results[len(results) // 2]
        growth = ((median - starting_bankroll) / starting_bankroll) * 100
        bust_pct = busts / 2000 * 100
        print(f"  {n_trades:<10} ${median:<14.2f} {growth:<14.1f}% {bust_pct:.2f}%")

    print("=" * 55)

if __name__ == "__main__":
    data, resolved = load_trades("../trades.json")
    starting_bankroll = data.get("bankroll", 1000)
    outcomes = build_outcomes(resolved)
    run_montecarlo(outcomes, starting_bankroll)
    run_scenarios(outcomes, starting_bankroll)
