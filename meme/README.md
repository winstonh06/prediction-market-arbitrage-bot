# 🐋 Solana Memecoin Wallet Tracker & Paper Trading Bot

A professional-grade Solana wallet tracking system that monitors high-performing wallets, detects memecoin trades, and executes paper trades to validate strategies before going live.

## Architecture

```
memecoin-tracker/
├── config/
│   └── settings.yaml          # All configuration (wallets, strategy, RPC, etc.)
├── src/
│   ├── core/
│   │   ├── engine.py           # Main orchestrator / event loop
│   │   ├── event_bus.py        # Pub/sub event system for decoupled components
│   │   └── models.py           # Data models (Token, Trade, Position, etc.)
│   ├── tracker/
│   │   ├── wallet_monitor.py   # Polls tracked wallets for new transactions
│   │   ├── transaction_parser.py # Parses Solana TXs into structured trade data
│   │   └── token_analyzer.py   # Token safety checks (rug detection, liquidity)
│   ├── trading/
│   │   ├── paper_trader.py     # Paper trading engine with realistic simulation
│   │   ├── position_manager.py # Manages open positions, PnL, stop-losses
│   │   └── strategy.py         # Configurable entry/exit strategy logic
│   ├── analysis/
│   │   ├── wallet_scorer.py    # Ranks tracked wallets by historical performance
│   │   └── report_generator.py # Generates performance reports
│   ├── api/
│   │   ├── solana_client.py    # Solana RPC client wrapper
│   │   ├── dex_client.py       # DEX price lookups (Raydium, Jupiter)
│   │   └── rate_limiter.py     # Request rate limiting
│   └── utils/
│       ├── logger.py           # Structured logging
│       └── helpers.py          # Shared utilities
├── tests/
│   └── test_models.py          # Unit tests
├── data/                       # Runtime data (trades, portfolio state)
├── main.py                     # Entry point
├── requirements.txt
└── README.md
```

## Features

- **Wallet Tracking**: Monitor unlimited Solana wallets for swap transactions
- **Transaction Parsing**: Detects buys/sells on Raydium and Jupiter
- **Token Safety Analysis**: Checks liquidity, top holder concentration, mint authority
- **Paper Trading**: Simulated trading with realistic slippage and fee modeling
- **Position Management**: Automatic stop-loss, take-profit, and trailing stops
- **Wallet Scoring**: Ranks wallets by win rate, avg return, and consistency
- **Event-Driven Architecture**: Decoupled components communicate via event bus
- **Performance Reports**: CLI reports on PnL, best/worst trades, wallet leaderboard

## Quick Start

### 1. Install dependencies
```bash
pip install -r requirements.txt
```

### 2. Configure
Edit `config/settings.yaml`:
- Add your Solana RPC endpoint (Helius, QuickNode, or public)
- Add wallet addresses to track
- Tune strategy parameters

### 3. Run in paper trading mode
```bash
python main.py
```

### 4. View performance
```bash
python main.py --report
```

## Configuration

All settings live in `config/settings.yaml`. Key sections:

- **rpc**: Solana RPC endpoint and rate limits
- **wallets**: List of wallet addresses to track with labels
- **strategy**: Entry/exit rules, position sizing, stop-loss/take-profit
- **paper_trading**: Starting balance, slippage model, fee simulation
- **safety**: Token filters (min liquidity, max holder concentration, etc.)

## Strategy Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `max_position_size_pct` | 5% | Max % of portfolio per trade |
| `stop_loss_pct` | 30% | Stop-loss trigger |
| `take_profit_pct` | 100% | Take-profit trigger |
| `trailing_stop_pct` | 20% | Trailing stop after take-profit hit |
| `min_wallet_score` | 0.6 | Min wallet confidence score to copy |
| `min_liquidity_usd` | 10000 | Min token liquidity to enter |
| `max_holder_concentration` | 0.3 | Max top-10 holder % |

## Moving to Live Trading

This bot is designed for paper trading first. When ready for live:
1. Validate strategy over 2+ weeks of paper trading
2. Review performance reports
3. Swap `PaperTrader` for a live trading module (not included — intentionally)
4. Start with minimal capital

## Disclaimer

This is an educational tool. Memecoin trading is extremely risky. Most tokens go to zero. Never trade with money you can't afford to lose. Past performance of tracked wallets does not guarantee future results.
