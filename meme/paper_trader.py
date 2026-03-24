"""
Paper trading engine.

Simulates trade execution with realistic slippage and fee modeling.
Manages the paper portfolio state and persists trades to disk.
"""

from __future__ import annotations

import logging
import math
import time
from typing import Any

from dex_client import DexClient
from models import (
    PaperTrade,
    Portfolio,
    Position,
    PositionStatus,
    TradeDirection,
    WalletTrade,
)

logger = logging.getLogger(__name__)


class PaperTrader:
    """
    Paper trading engine that simulates real trading conditions.
    
    Features:
    - Configurable slippage model (linear or sqrt price impact)
    - Realistic fee simulation
    - Portfolio state persistence
    - Position tracking with PnL
    """

    def __init__(
        self,
        dex_client: DexClient,
        config: dict[str, Any],
        portfolio: Portfolio | None = None,
    ) -> None:
        self.dex = dex_client
        self.slippage_pct = config.get("slippage_pct", 0.02)
        self.fee_pct = config.get("fee_pct", 0.0025)
        self.price_impact_model = config.get("price_impact_model", "sqrt")
        self.save_interval = config.get("save_interval", 5)
        self.portfolio_path = config.get("portfolio_file", "data/portfolio.json")

        starting_balance = config.get("starting_balance_sol", 10.0)
        self.portfolio = portfolio or Portfolio(
            balance_sol=starting_balance,
            starting_balance_sol=starting_balance,
        )

        self._trades_since_save = 0

    async def execute_buy(
        self,
        wallet_trade: WalletTrade,
        amount_sol: float,
    ) -> PaperTrade | None:
        """
        Execute a simulated buy order.
        
        Applies slippage and fees to simulate realistic execution.
        """
        if amount_sol <= 0 or amount_sol > self.portfolio.balance_sol:
            logger.warning(
                f"Invalid buy amount: {amount_sol:.4f} SOL "
                f"(balance: {self.portfolio.balance_sol:.4f})"
            )
            return None

        # Get current price
        price_data = await self.dex.get_token_price(
            wallet_trade.token.mint_address
        )
        price_sol = price_data["price_sol"]
        if price_sol <= 0:
            # Fallback: use the price from the detected trade
            price_sol = wallet_trade.price_per_token
            if price_sol <= 0:
                logger.warning("Cannot determine token price, skipping buy")
                return None

        # Apply slippage (price goes up when buying)
        slippage_multiplier = 1.0 + self._calculate_slippage(amount_sol)
        effective_price = price_sol * slippage_multiplier

        # Calculate fees
        fee_sol = amount_sol * self.fee_pct

        # Calculate tokens received
        net_sol = amount_sol - fee_sol
        tokens_received = net_sol / effective_price if effective_price > 0 else 0

        if tokens_received <= 0:
            return None

        slippage_cost = amount_sol * (slippage_multiplier - 1.0)

        # Create paper trade
        trade = PaperTrade(
            triggered_by=wallet_trade.id,
            wallet_address=wallet_trade.wallet_address,
            wallet_label=wallet_trade.wallet_label,
            direction=TradeDirection.BUY,
            token_mint=wallet_trade.token.mint_address,
            token_symbol=wallet_trade.token.symbol,
            amount_token=tokens_received,
            amount_sol=amount_sol,
            price_per_token_sol=effective_price,
            slippage_sol=slippage_cost,
            fee_sol=fee_sol,
            total_cost_sol=amount_sol,
        )

        # Update portfolio
        self.portfolio.balance_sol -= amount_sol
        self.portfolio.trade_history.append(trade)
        self.portfolio.total_trades += 1

        # Create position
        position = Position(
            token_mint=wallet_trade.token.mint_address,
            token_symbol=wallet_trade.token.symbol,
            entry_trade_id=trade.id,
            entry_price_sol=effective_price,
            entry_amount_token=tokens_received,
            entry_cost_sol=amount_sol,
            current_price_sol=effective_price,
            peak_price_sol=effective_price,
            triggered_by_wallet=wallet_trade.wallet_address,
        )
        self.portfolio.open_positions.append(position)

        logger.info(
            f"[bold green]PAPER BUY[/bold green] | "
            f"{wallet_trade.token.symbol} | "
            f"{tokens_received:,.2f} tokens @ {effective_price:.10f} SOL | "
            f"Cost: {amount_sol:.4f} SOL | "
            f"Slippage: {slippage_cost:.4f} SOL | "
            f"Fee: {fee_sol:.4f} SOL",
            extra={"markup": True},
        )

        self._maybe_save()
        return trade

    async def execute_sell(
        self,
        position: Position,
        reason: PositionStatus,
    ) -> PaperTrade | None:
        """
        Execute a simulated sell order to close a position.
        """
        if position.status != PositionStatus.OPEN:
            return None

        # Get current price
        price_data = await self.dex.get_token_price(position.token_mint)
        price_sol = price_data["price_sol"]
        if price_sol <= 0:
            price_sol = position.current_price_sol

        # Apply slippage (price goes down when selling)
        slippage_multiplier = 1.0 - self._calculate_slippage(
            position.entry_amount_token * price_sol
        )
        effective_price = price_sol * slippage_multiplier

        # Calculate proceeds
        gross_sol = position.entry_amount_token * effective_price
        fee_sol = gross_sol * self.fee_pct
        net_sol = gross_sol - fee_sol
        slippage_cost = position.entry_amount_token * price_sol * (
            1.0 - slippage_multiplier
        )

        # Create paper trade
        trade = PaperTrade(
            triggered_by=position.entry_trade_id,
            wallet_address=position.triggered_by_wallet,
            direction=TradeDirection.SELL,
            token_mint=position.token_mint,
            token_symbol=position.token_symbol,
            amount_token=position.entry_amount_token,
            amount_sol=net_sol,
            price_per_token_sol=effective_price,
            slippage_sol=slippage_cost,
            fee_sol=fee_sol,
            total_cost_sol=net_sol,
        )

        # Update position
        position.status = reason
        position.exit_trade_id = trade.id
        position.exit_price_sol = effective_price
        position.exit_amount_sol = net_sol
        position.exit_timestamp = time.time()

        # Move to closed
        self.portfolio.open_positions = [
            p for p in self.portfolio.open_positions if p.id != position.id
        ]
        self.portfolio.closed_positions.append(position)

        # Credit balance
        self.portfolio.balance_sol += net_sol
        self.portfolio.trade_history.append(trade)
        self.portfolio.total_trades += 1

        pnl_sol = position.realized_pnl_sol
        pnl_pct = position.realized_pnl_pct
        pnl_color = "green" if pnl_sol >= 0 else "red"

        logger.info(
            f"[bold {pnl_color}]PAPER SELL[/bold {pnl_color}] | "
            f"{position.token_symbol} | "
            f"Reason: {reason.value} | "
            f"PnL: {pnl_sol:+.4f} SOL ({pnl_pct:+.1%}) | "
            f"Hold: {position.hold_duration_seconds / 60:.1f}min",
            extra={"markup": True},
        )

        self._maybe_save()
        return trade

    async def update_positions(self) -> None:
        """
        Update current prices for all open positions.
        Used for stop-loss/take-profit checking.
        """
        if not self.portfolio.open_positions:
            return

        mints = [p.token_mint for p in self.portfolio.open_positions]
        prices = await self.dex.get_multiple_prices(mints)

        for position in self.portfolio.open_positions:
            if position.token_mint in prices:
                new_price = prices[position.token_mint]["price_sol"]
                if new_price > 0:
                    position.current_price_sol = new_price
                    position.peak_price_sol = max(
                        position.peak_price_sol, new_price
                    )

    def _calculate_slippage(self, trade_size_sol: float) -> float:
        """
        Calculate simulated slippage based on trade size.
        
        Models:
        - linear: slippage scales linearly with trade size
        - sqrt: slippage scales with sqrt of trade size (more realistic)
        """
        base = self.slippage_pct

        if self.price_impact_model == "sqrt":
            # Larger trades have proportionally higher slippage
            impact = base * math.sqrt(max(trade_size_sol, 0.01))
        else:
            impact = base * trade_size_sol

        # Cap slippage at 10%
        return min(impact, 0.10)

    def _maybe_save(self) -> None:
        """Save portfolio state periodically."""
        self._trades_since_save += 1
        if self._trades_since_save >= self.save_interval:
            self.portfolio.save(self.portfolio_path)
            self._trades_since_save = 0

    def save(self) -> None:
        """Force save portfolio state."""
        self.portfolio.save(self.portfolio_path)
