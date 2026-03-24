"""
Wallet scorer.

Tracks and ranks wallet performance based on paper trading results.
Used by the strategy to weight signals from higher-performing wallets.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from models import Portfolio, PositionStatus, WalletScore

logger = logging.getLogger(__name__)


class WalletScorer:
    """
    Scores tracked wallets based on observed trading performance.
    
    Computes a composite confidence score (0-1) from:
    - Win rate (weight: 0.35)
    - Average return per trade (weight: 0.30)
    - Consistency / Sharpe-like ratio (weight: 0.20)
    - Trade count / data reliability (weight: 0.15)
    """

    WEIGHT_WIN_RATE = 0.35
    WEIGHT_AVG_RETURN = 0.30
    WEIGHT_CONSISTENCY = 0.20
    WEIGHT_DATA_RELIABILITY = 0.15

    # Minimum trades for a meaningful score
    MIN_TRADES_FOR_SCORE = 5

    def __init__(self, scores_file: str = "data/wallet_scores.json") -> None:
        self.scores_file = scores_file
        self.scores: dict[str, WalletScore] = {}
        self._load()

    def update_from_portfolio(self, portfolio: Portfolio) -> None:
        """
        Recalculate wallet scores from closed positions in the portfolio.
        """
        # Group closed positions by wallet
        wallet_positions: dict[str, list] = {}
        for pos in portfolio.closed_positions:
            addr = pos.triggered_by_wallet
            if addr not in wallet_positions:
                wallet_positions[addr] = []
            wallet_positions[addr].append(pos)

        for addr, positions in wallet_positions.items():
            total = len(positions)
            wins = sum(1 for p in positions if p.realized_pnl_sol > 0)
            returns = [p.realized_pnl_pct for p in positions]

            win_rate = wins / total if total > 0 else 0.0
            avg_return = sum(returns) / len(returns) if returns else 0.0
            total_pnl = sum(p.realized_pnl_sol for p in positions)

            # Consistency: lower variance = higher consistency
            if len(returns) > 1:
                mean = avg_return
                variance = sum((r - mean) ** 2 for r in returns) / len(returns)
                std_dev = variance**0.5
                consistency = 1.0 / (1.0 + std_dev) if std_dev > 0 else 1.0
            else:
                consistency = 0.5

            # Data reliability: more trades = more reliable
            reliability = min(total / 20.0, 1.0)

            # Normalize components to 0-1 range
            norm_win_rate = win_rate  # Already 0-1
            norm_avg_return = min(max(avg_return + 0.5, 0), 1.0)  # Center around 0
            norm_consistency = consistency
            norm_reliability = reliability

            # Composite score
            confidence = (
                self.WEIGHT_WIN_RATE * norm_win_rate
                + self.WEIGHT_AVG_RETURN * norm_avg_return
                + self.WEIGHT_CONSISTENCY * norm_consistency
                + self.WEIGHT_DATA_RELIABILITY * norm_reliability
            )

            best = max(returns) if returns else 0.0
            worst = min(returns) if returns else 0.0

            existing = self.scores.get(addr)
            label = existing.label if existing else ""

            self.scores[addr] = WalletScore(
                address=addr,
                label=label,
                total_trades_observed=total,
                profitable_trades=wins,
                win_rate=win_rate,
                avg_return_pct=avg_return,
                best_trade_pct=best,
                worst_trade_pct=worst,
                total_pnl_sol=total_pnl,
                confidence_score=round(confidence, 4),
            )

        self._save()

    def get_score(self, wallet_address: str) -> WalletScore | None:
        """Get the score for a specific wallet. Returns None if not scored."""
        score = self.scores.get(wallet_address)
        if score and score.total_trades_observed == 0:
            return None
        return score

    def get_all_scores(self) -> list[WalletScore]:
        """Get all wallet scores, sorted by confidence (desc)."""
        return sorted(
            self.scores.values(),
            key=lambda s: s.confidence_score,
            reverse=True,
        )

    def set_label(self, address: str, label: str) -> None:
        """Set or update a wallet's label."""
        if address in self.scores:
            self.scores[address].label = label
        else:
            self.scores[address] = WalletScore(address=address, label=label)
        self._save()

    def get_default_score(self, address: str) -> WalletScore:
        """
        Get score for a wallet, returning a default if not yet scored.
        New wallets start with a neutral score to allow initial trades.
        """
        if address in self.scores:
            return self.scores[address]

        # Default score for unscored wallets - moderately optimistic
        return WalletScore(
            address=address,
            confidence_score=0.6,  # Above most min thresholds
        )

    def _save(self) -> None:
        Path(self.scores_file).parent.mkdir(parents=True, exist_ok=True)
        data = {addr: s.model_dump() for addr, s in self.scores.items()}
        with open(self.scores_file, "w") as f:
            json.dump(data, f, indent=2, default=str)

    def _load(self) -> None:
        try:
            with open(self.scores_file, "r") as f:
                data = json.load(f)
            for addr, score_data in data.items():
                self.scores[addr] = WalletScore.model_validate(score_data)
            logger.info(f"Loaded {len(self.scores)} wallet score(s)")
        except (FileNotFoundError, json.JSONDecodeError):
            logger.debug("No existing wallet scores found")
