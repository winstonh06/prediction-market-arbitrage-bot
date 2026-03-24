"""
Trading strategy.

Configurable rules engine that decides whether to enter or exit positions
based on wallet trade signals, token safety, and portfolio state.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from models import (
    Portfolio,
    Position,
    PositionStatus,
    TradeDirection,
    WalletScore,
    WalletTrade,
)

logger = logging.getLogger(__name__)


class Strategy:
    """
    Configurable trading strategy for copy-trading tracked wallets.
    
    Entry rules:
    - Tracked wallet buys a token
    - Wallet score meets minimum threshold
    - Token passes safety checks
    - Portfolio has capacity (max positions, position sizing)
    - Not on cooldown for this token
    
    Exit rules:
    - Stop-loss hit
    - Take-profit hit → trailing stop activated
    - Tracked wallet sells (optional)
    """

    def __init__(self, config: dict[str, Any]) -> None:
        self.min_wallet_score = config.get("min_wallet_score", 0.5)
        self.max_position_size_pct = config.get("max_position_size_pct", 0.05)
        self.stop_loss_pct = config.get("stop_loss_pct", 0.30)
        self.take_profit_pct = config.get("take_profit_pct", 1.00)
        self.trailing_stop_pct = config.get("trailing_stop_pct", 0.20)
        self.max_open_positions = config.get("max_open_positions", 10)
        self.cooldown_seconds = config.get("cooldown_seconds", 300)
        self.copy_buys_only = config.get("copy_buys_only", True)

        # Track cooldowns: token_mint -> last_trade_timestamp
        self._cooldowns: dict[str, float] = {}

    def should_enter(
        self,
        trade: WalletTrade,
        portfolio: Portfolio,
        wallet_score: WalletScore | None = None,
        safety_passed: bool = True,
    ) -> tuple[bool, str, float]:
        """
        Decide whether to enter a position based on a detected wallet trade.
        
        Returns: (should_enter, reason, position_size_sol)
        """
        # Only copy buys
        if self.copy_buys_only and trade.direction != TradeDirection.BUY:
            return False, "Not a buy signal", 0.0

        # Check wallet score
        if wallet_score and wallet_score.confidence_score < self.min_wallet_score:
            return (
                False,
                f"Wallet score too low: {wallet_score.confidence_score:.2f} "
                f"(min: {self.min_wallet_score:.2f})",
                0.0,
            )

        # Check safety
        if not safety_passed:
            return False, "Token failed safety checks", 0.0

        # Check max positions
        if len(portfolio.open_positions) >= self.max_open_positions:
            return (
                False,
                f"Max open positions reached: {len(portfolio.open_positions)}"
                f"/{self.max_open_positions}",
                0.0,
            )

        # Check if already holding this token
        for pos in portfolio.open_positions:
            if pos.token_mint == trade.token.mint_address:
                return False, "Already holding this token", 0.0

        # Check cooldown
        mint = trade.token.mint_address
        if mint in self._cooldowns:
            elapsed = time.time() - self._cooldowns[mint]
            if elapsed < self.cooldown_seconds:
                remaining = self.cooldown_seconds - elapsed
                return (
                    False,
                    f"Token on cooldown ({remaining:.0f}s remaining)",
                    0.0,
                )

        # Calculate position size
        position_size_sol = portfolio.balance_sol * self.max_position_size_pct
        if position_size_sol <= 0:
            return False, "Insufficient balance", 0.0

        # Cap at available balance (leave some for fees)
        max_spend = portfolio.balance_sol * 0.95
        position_size_sol = min(position_size_sol, max_spend)

        # Update cooldown
        self._cooldowns[mint] = time.time()

        return True, "Entry criteria met", position_size_sol

    def check_exit(
        self, position: Position, current_price_sol: float
    ) -> tuple[bool, PositionStatus]:
        """
        Check if a position should be closed.
        
        Returns: (should_exit, exit_reason_status)
        """
        if position.entry_price_sol == 0:
            return False, PositionStatus.OPEN

        # Update position state
        position.current_price_sol = current_price_sol
        position.peak_price_sol = max(
            position.peak_price_sol, current_price_sol
        )

        price_change_pct = (
            (current_price_sol - position.entry_price_sol)
            / position.entry_price_sol
        )

        # ── Stop-loss ──
        if price_change_pct <= -self.stop_loss_pct:
            logger.info(
                f"[bold red]STOP-LOSS[/bold red] triggered for "
                f"{position.token_symbol} at {price_change_pct:.1%}",
                extra={"markup": True},
            )
            return True, PositionStatus.CLOSED_STOP_LOSS

        # ── Take-profit with trailing stop ──
        if price_change_pct >= self.take_profit_pct:
            # Check trailing stop from peak
            peak_change = (
                (position.peak_price_sol - position.entry_price_sol)
                / position.entry_price_sol
            )
            drop_from_peak_pct = (
                (position.peak_price_sol - current_price_sol)
                / position.peak_price_sol
                if position.peak_price_sol > 0
                else 0
            )

            if drop_from_peak_pct >= self.trailing_stop_pct:
                logger.info(
                    f"[bold yellow]TRAILING STOP[/bold yellow] triggered for "
                    f"{position.token_symbol} | "
                    f"Peak: {peak_change:.1%}, "
                    f"Drop from peak: {drop_from_peak_pct:.1%}",
                    extra={"markup": True},
                )
                return True, PositionStatus.CLOSED_TRAILING_STOP

        return False, PositionStatus.OPEN

    def get_position_size(self, portfolio: Portfolio) -> float:
        """Calculate position size in SOL based on current portfolio."""
        return portfolio.balance_sol * self.max_position_size_pct
