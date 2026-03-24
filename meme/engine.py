"""
Main engine orchestrator.
Wires all components together, manages the event-driven lifecycle,
and runs the main async event loop.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from wallet_scorer import WalletScorer
from dex_client import DexClient
from solana_client import SolanaClient
from event_bus import EventBus
from models import (
    Event,
    EventType,
    Portfolio,
    WalletTrade,
)
from token_analyzer import TokenAnalyzer
from wallet_monitor import WalletMonitor
from paper_trader import PaperTrader
from position_manager import PositionManager
from strategy import Strategy
from notifier import TelegramNotifier

logger = logging.getLogger(__name__)


class Engine:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.event_bus = EventBus()

        rpc_config = config.get("rpc", {})
        self.solana_client = SolanaClient(
            endpoint=rpc_config.get("endpoint", "https://api.mainnet-beta.solana.com"),
            rate_limit=rpc_config.get("rate_limit", 5),
            timeout=rpc_config.get("timeout", 30),
        )
        self.dex_client = DexClient(rate_limit=rpc_config.get("rate_limit", 5))

        monitoring_config = config.get("monitoring", {})
        self.wallet_monitor = WalletMonitor(
            solana_client=self.solana_client,
            event_bus=self.event_bus,
            wallets=config.get("wallets", []),
            poll_interval=monitoring_config.get("poll_interval", 10),
            tx_fetch_limit=monitoring_config.get("tx_fetch_limit", 20),
        )

        self.token_analyzer = TokenAnalyzer(
            solana_client=self.solana_client,
            dex_client=self.dex_client,
            config=config.get("safety", {}),
        )

        self.strategy = Strategy(config.get("strategy", {}))

        paper_config = config.get("paper_trading", {})
        data_config = config.get("data", {})
        paper_config["portfolio_file"] = data_config.get("portfolio_file", "data/portfolio.json")

        portfolio = Portfolio.load(paper_config["portfolio_file"])
        if portfolio.total_trades == 0:
            starting = paper_config.get("starting_balance_sol", 10.0)
            portfolio.balance_sol = starting
            portfolio.starting_balance_sol = starting

        self.paper_trader = PaperTrader(
            dex_client=self.dex_client,
            config=paper_config,
            portfolio=portfolio,
        )

        # Telegram notifications
        tg_config = config.get("telegram", {})
        self.notifier = TelegramNotifier(
            token=tg_config.get("bot_token", ""),
            chat_id=str(tg_config.get("chat_id", "")),
        )

        self.position_manager = PositionManager(
            paper_trader=self.paper_trader,
            strategy=self.strategy,
            event_bus=self.event_bus,
            check_interval=monitoring_config.get("poll_interval", 10) * 1.5,
            notifier=self.notifier,
        )

        self.wallet_scorer = WalletScorer(
            scores_file=data_config.get("scores_file", "data/wallet_scores.json")
        )

        for w in config.get("wallets", []):
            if w.get("label"):
                self.wallet_scorer.set_label(w["address"], w["label"])

    def _wire_events(self) -> None:
        self.event_bus.subscribe(EventType.WALLET_TRADE_DETECTED, self._on_wallet_trade_detected)
        self.event_bus.subscribe(EventType.POSITION_CLOSED, self._on_position_closed)

    async def _on_wallet_trade_detected(self, event: Event) -> None:
        try:
            trade = WalletTrade.model_validate(event.data)

            logger.info(
                f"Processing trade from {trade.wallet_label or trade.wallet_address[:8]}... | "
                f"{trade.direction.value.upper()} {trade.token.mint_address[:12]}..."
            )

            safety_result = await self.token_analyzer.analyze(trade.token)

            if not safety_result.passed:
                await self.notifier.notify_safety_fail(
                    trade.token.mint_address, safety_result.reasons
                )
                await self.event_bus.publish(
                    Event(
                        type=EventType.TOKEN_SAFETY_FAILED,
                        data={"token": trade.token.mint_address, "reasons": safety_result.reasons},
                        source="engine",
                    )
                )
                return

            wallet_score = self.wallet_scorer.get_default_score(trade.wallet_address)

            should_enter, reason, size_sol = self.strategy.should_enter(
                trade=trade,
                portfolio=self.paper_trader.portfolio,
                wallet_score=wallet_score,
                safety_passed=True,
            )

            if not should_enter:
                logger.info(f"Skipping trade: {reason}")
                return

            paper_trade = await self.paper_trader.execute_buy(trade, size_sol)

            if paper_trade:
                await self.notifier.notify_buy(
                    token_symbol=trade.token.symbol,
                    token_mint=trade.token.mint_address,
                    amount_sol=paper_trade.amount_sol,
                    price_sol=paper_trade.price_per_token_sol,
                    wallet_label=trade.wallet_label,
                )
                await self.event_bus.publish(
                    Event(
                        type=EventType.PAPER_TRADE_EXECUTED,
                        data=paper_trade.model_dump(),
                        source="engine",
                    )
                )

        except Exception as e:
            logger.error(f"Error handling wallet trade: {e}", exc_info=True)

    async def _on_position_closed(self, event: Event) -> None:
        try:
            self.wallet_scorer.update_from_portfolio(self.paper_trader.portfolio)
        except Exception as e:
            logger.error(f"Error updating wallet scores: {e}")

    async def run(self) -> None:
        self._wire_events()

        portfolio = self.paper_trader.portfolio
        logger.info(
            f"[bold blue]Engine starting[/bold blue] | "
            f"Balance: {portfolio.balance_sol:.4f} SOL | "
            f"Open positions: {len(portfolio.open_positions)} | "
            f"Closed trades: {len(portfolio.closed_positions)}",
            extra={"markup": True},
        )

        await self.notifier.send(
            f"🐋 <b>Bot Started</b>\n"
            f"Tracking {len(self.config.get('wallets', []))} wallets\n"
            f"Balance: {portfolio.balance_sol:.4f} SOL\n"
            f"Open positions: {len(portfolio.open_positions)}"
        )

        try:
            await asyncio.gather(
                self.wallet_monitor.start(),
                self.position_manager.start(),
            )
        except asyncio.CancelledError:
            logger.info("Engine shutting down...")
        finally:
            await self.shutdown()

    async def shutdown(self) -> None:
        logger.info("Shutting down...")
        await self.wallet_monitor.stop()
        await self.position_manager.stop()
        self.paper_trader.save()
        await self.solana_client.close()
        await self.dex_client.close()
        await self.notifier.close()
        logger.info(
            "[bold blue]Engine stopped.[/bold blue] Portfolio state saved.",
            extra={"markup": True},
        )
