"""
Core data models for the memecoin tracker.
All domain objects are defined here as Pydantic models for validation and serialization.
"""

from __future__ import annotations

import json
import time
import uuid
from enum import Enum
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field


# ── Enums ────────────────────────────────────────────────────────────────────


class TradeDirection(str, Enum):
    BUY = "buy"
    SELL = "sell"


class PositionStatus(str, Enum):
    OPEN = "open"
    CLOSED_STOP_LOSS = "closed_stop_loss"
    CLOSED_TAKE_PROFIT = "closed_take_profit"
    CLOSED_TRAILING_STOP = "closed_trailing_stop"
    CLOSED_MANUAL = "closed_manual"


class EventType(str, Enum):
    WALLET_TRADE_DETECTED = "wallet_trade_detected"
    TOKEN_SAFETY_PASSED = "token_safety_passed"
    TOKEN_SAFETY_FAILED = "token_safety_failed"
    PAPER_TRADE_EXECUTED = "paper_trade_executed"
    POSITION_OPENED = "position_opened"
    POSITION_CLOSED = "position_closed"
    STOP_LOSS_TRIGGERED = "stop_loss_triggered"
    TAKE_PROFIT_TRIGGERED = "take_profit_triggered"
    PRICE_UPDATE = "price_update"
    WALLET_SCORE_UPDATED = "wallet_score_updated"
    ERROR = "error"


# ── Token ────────────────────────────────────────────────────────────────────


class TokenInfo(BaseModel):
    """Represents a Solana SPL token."""

    mint_address: str
    symbol: str = "UNKNOWN"
    name: str = "Unknown Token"
    decimals: int = 9
    liquidity_usd: float = 0.0
    holder_count: int = 0
    top10_holder_pct: float = 0.0
    mint_authority_revoked: bool = False
    freeze_authority_revoked: bool = False
    created_at: Optional[float] = None
    price_usd: float = 0.0
    price_sol: float = 0.0


# ── Trade (observed from tracked wallet) ─────────────────────────────────────


class WalletTrade(BaseModel):
    """A trade detected from a tracked wallet's transaction history."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    wallet_address: str
    wallet_label: str = ""
    tx_signature: str
    direction: TradeDirection
    token: TokenInfo
    amount_token: float
    amount_sol: float
    timestamp: float = Field(default_factory=time.time)
    slot: int = 0

    @property
    def price_per_token(self) -> float:
        if self.amount_token == 0:
            return 0.0
        return self.amount_sol / self.amount_token


# ── Paper Trade ──────────────────────────────────────────────────────────────


class PaperTrade(BaseModel):
    """A simulated trade executed by the paper trading engine."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    triggered_by: str  # WalletTrade ID that triggered this
    wallet_address: str
    wallet_label: str = ""
    direction: TradeDirection
    token_mint: str
    token_symbol: str = "UNKNOWN"
    amount_token: float
    amount_sol: float
    price_per_token_sol: float
    slippage_sol: float = 0.0
    fee_sol: float = 0.0
    total_cost_sol: float = 0.0
    timestamp: float = Field(default_factory=time.time)


# ── Position ─────────────────────────────────────────────────────────────────


class Position(BaseModel):
    """An open or closed paper trading position."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    token_mint: str
    token_symbol: str = "UNKNOWN"
    status: PositionStatus = PositionStatus.OPEN

    # Entry
    entry_trade_id: str = ""
    entry_price_sol: float = 0.0
    entry_amount_token: float = 0.0
    entry_cost_sol: float = 0.0
    entry_timestamp: float = Field(default_factory=time.time)
    triggered_by_wallet: str = ""

    # Current state
    current_price_sol: float = 0.0
    peak_price_sol: float = 0.0

    # Exit
    exit_trade_id: Optional[str] = None
    exit_price_sol: float = 0.0
    exit_amount_sol: float = 0.0
    exit_timestamp: Optional[float] = None

    @property
    def unrealized_pnl_sol(self) -> float:
        if self.status != PositionStatus.OPEN:
            return 0.0
        current_value = self.entry_amount_token * self.current_price_sol
        return current_value - self.entry_cost_sol

    @property
    def unrealized_pnl_pct(self) -> float:
        if self.entry_cost_sol == 0:
            return 0.0
        return self.unrealized_pnl_sol / self.entry_cost_sol

    @property
    def realized_pnl_sol(self) -> float:
        if self.status == PositionStatus.OPEN:
            return 0.0
        return self.exit_amount_sol - self.entry_cost_sol

    @property
    def realized_pnl_pct(self) -> float:
        if self.entry_cost_sol == 0:
            return 0.0
        return self.realized_pnl_sol / self.entry_cost_sol

    @property
    def hold_duration_seconds(self) -> float:
        end = self.exit_timestamp or time.time()
        return end - self.entry_timestamp


# ── Portfolio ────────────────────────────────────────────────────────────────


class Portfolio(BaseModel):
    """Paper trading portfolio state."""

    balance_sol: float = 10.0
    starting_balance_sol: float = 10.0
    open_positions: list[Position] = Field(default_factory=list)
    closed_positions: list[Position] = Field(default_factory=list)
    trade_history: list[PaperTrade] = Field(default_factory=list)
    total_trades: int = 0
    created_at: float = Field(default_factory=time.time)

    @property
    def total_value_sol(self) -> float:
        open_value = sum(
            p.entry_amount_token * p.current_price_sol for p in self.open_positions
        )
        return self.balance_sol + open_value

    @property
    def total_pnl_sol(self) -> float:
        return self.total_value_sol - self.starting_balance_sol

    @property
    def total_pnl_pct(self) -> float:
        if self.starting_balance_sol == 0:
            return 0.0
        return self.total_pnl_sol / self.starting_balance_sol

    @property
    def win_rate(self) -> float:
        if not self.closed_positions:
            return 0.0
        wins = sum(1 for p in self.closed_positions if p.realized_pnl_sol > 0)
        return wins / len(self.closed_positions)

    def save(self, path: str) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            json.dump(self.model_dump(), f, indent=2, default=str)

    @classmethod
    def load(cls, path: str) -> Portfolio:
        try:
            with open(path, "r") as f:
                data = json.load(f)
            return cls.model_validate(data)
        except (FileNotFoundError, json.JSONDecodeError):
            return cls()


# ── Wallet Score ─────────────────────────────────────────────────────────────


class WalletScore(BaseModel):
    """Performance metrics for a tracked wallet."""

    address: str
    label: str = ""
    total_trades_observed: int = 0
    profitable_trades: int = 0
    win_rate: float = 0.0
    avg_return_pct: float = 0.0
    best_trade_pct: float = 0.0
    worst_trade_pct: float = 0.0
    total_pnl_sol: float = 0.0
    confidence_score: float = 0.0  # 0.0 - 1.0 composite score
    last_updated: float = Field(default_factory=time.time)


# ── Event ────────────────────────────────────────────────────────────────────


class Event(BaseModel):
    """Event for the internal pub/sub bus."""

    type: EventType
    data: dict = Field(default_factory=dict)
    timestamp: float = Field(default_factory=time.time)
    source: str = ""
