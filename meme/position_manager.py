"""
Position manager.
Monitors open positions, checks exit conditions, and triggers sells.
"""

from __future__ import annotations

import asyncio
import logging

from event_bus import EventBus
from models import Event, EventType, PositionStatus
from paper_trader import PaperTrader
from strategy import Strategy

logger = logging.getLogger(__name__)


class PositionManager:
    def __init__(
        self,
        paper_trader: PaperTrader,
        strategy: Strategy,
        event_bus: EventBus,
        check_interval: float = 15.0,
        notifier=None,
    ) -> None:
        self.trader = paper_trader
        self.strategy = strategy
        self.event_bus = event_bus
        self.check_interval = check_interval
        self.notifier = notifier
        self._running = False

    async def start(self) -> None:
        self._running = True
        logger.info(f"Position manager started - checking every {self.check_interval}s")
        while self._running:
            try:
                await self._check_positions()
            except Exception as e:
                logger.error(f"Position check error: {e}", exc_info=True)
            await asyncio.sleep(self.check_interval)

    async def stop(self) -> None:
        self._running = False
        logger.info("Position manager stopped")

    async def _check_positions(self) -> None:
        portfolio = self.trader.portfolio
        if not portfolio.open_positions:
            return

        await self.trader.update_positions()

        for position in list(portfolio.open_positions):
            should_exit, exit_status = self.strategy.check_exit(
                position, position.current_price_sol
            )

            if should_exit:
                trade = await self.trader.execute_sell(position, exit_status)

                if trade:
                    if self.notifier:
                        await self.notifier.notify_sell(
                            token_symbol=position.token_symbol,
                            pnl_sol=position.realized_pnl_sol,
                            pnl_pct=position.realized_pnl_pct,
                            reason=exit_status.value,
                            hold_minutes=position.hold_duration_seconds / 60,
                        )

                    await self.event_bus.publish(
                        Event(
                            type=EventType.POSITION_CLOSED,
                            data={
                                "position_id": position.id,
                                "token": position.token_symbol,
                                "reason": exit_status.value,
                                "pnl_sol": position.realized_pnl_sol,
                                "pnl_pct": position.realized_pnl_pct,
                                "hold_minutes": position.hold_duration_seconds / 60,
                            },
                            source="position_manager",
                        )
                    )

        if portfolio.open_positions:
            total_unrealized = sum(p.unrealized_pnl_sol for p in portfolio.open_positions)
            logger.debug(
                f"Open positions: {len(portfolio.open_positions)} | "
                f"Unrealized PnL: {total_unrealized:+.4f} SOL | "
                f"Balance: {portfolio.balance_sol:.4f} SOL | "
                f"Total value: {portfolio.total_value_sol:.4f} SOL"
            )
