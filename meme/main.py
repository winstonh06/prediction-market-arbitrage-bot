"""
Solana Memecoin Wallet Tracker & Paper Trading Bot
Entry point.

Usage:
    python main.py              # Start tracking & paper trading
    python main.py --report     # Show performance report
    python main.py --config     # Show current configuration
"""

from __future__ import annotations

import argparse
import asyncio
import signal
import sys
from pathlib import Path

import yaml

from report_generator import ReportGenerator
from wallet_scorer import WalletScorer
from engine import Engine
from models import Portfolio
from logger import setup_logger


def load_config(path: str = "settings.yaml") -> dict:
    """Load configuration from YAML file."""
    config_path = Path(path)
    if not config_path.exists():
        print(f"Error: Config file not found: {path}")
        print("Copy settings.yaml.example to settings.yaml and configure it.")
        sys.exit(1)

    with open(config_path, "r") as f:
        return yaml.safe_load(f)


def show_report(config: dict) -> None:
    """Display performance report."""
    data_config = config.get("data", {})
    portfolio_path = data_config.get("portfolio_file", "data/portfolio.json")
    scores_path = data_config.get("scores_file", "data/wallet_scores.json")

    portfolio = Portfolio.load(portfolio_path)
    scorer = WalletScorer(scores_file=scores_path)

    if portfolio.total_trades == 0:
        print("\nNo trades yet. Start the bot first with: python main.py\n")
        return

    report = ReportGenerator(portfolio, scorer)
    report.print_full_report()


def show_config(config: dict) -> None:
    """Display current configuration."""
    print("\n" + yaml.dump(config, default_flow_style=False, sort_keys=False))


async def run_bot(config: dict) -> None:
    """Run the main bot."""
    engine = Engine(config)

    # Handle graceful shutdown
    loop = asyncio.get_event_loop()

    def _shutdown_handler():
        print("\nShutting down gracefully...")
        for task in asyncio.all_tasks(loop):
            task.cancel()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _shutdown_handler)
        except NotImplementedError:
            # Windows doesn't support add_signal_handler
            pass

    await engine.run()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Solana Memecoin Wallet Tracker & Paper Trading Bot"
    )
    parser.add_argument(
        "--report",
        action="store_true",
        help="Show performance report",
    )
    parser.add_argument(
        "--config",
        action="store_true",
        help="Show current configuration",
    )
    parser.add_argument(
        "--config-file",
        default="settings.yaml",
        help="Path to config file (default: settings.yaml)",
    )

    args = parser.parse_args()
    config = load_config(args.config_file)

    # Setup logging
    log_config = config.get("logging", {})
    setup_logger(
        level=log_config.get("level", "INFO"),
        file_enabled=log_config.get("file_enabled", True),
        file_path=log_config.get("file_path", "data/tracker.log"),
        rich_console=log_config.get("rich_console", True),
    )

    if args.report:
        show_report(config)
    elif args.config:
        show_config(config)
    else:
        # Validate wallets are configured
        wallets = config.get("wallets", [])
        example_wallets = [
            w for w in wallets
            if w.get("address", "").startswith("EXAMPLE")
        ]
        if not wallets or len(wallets) == len(example_wallets):
            print(
                "\n⚠️  No wallets configured!\n"
                "Edit settings.yaml and add wallet addresses to track.\n"
                "Find profitable wallets on birdeye.so, cielo.finance, or similar.\n"
            )
            sys.exit(1)

        print(
            "\n🐋 Solana Memecoin Wallet Tracker\n"
            f"   Tracking {len(wallets)} wallet(s) | "
            f"Paper trading mode\n"
            "   Press Ctrl+C to stop\n"
        )

        asyncio.run(run_bot(config))


if __name__ == "__main__":
    main()
