"""
Unit tests for core data models.
"""

import time
import pytest
from models import (
    Portfolio,
    Position,
    PositionStatus,
    TokenInfo,
    TradeDirection,
    WalletTrade,
    PaperTrade,
    WalletScore,
)


class TestTokenInfo:
    def test_create_default(self):
        token = TokenInfo(mint_address="abc123")
        assert token.symbol == "UNKNOWN"
        assert token.decimals == 9
        assert token.price_usd == 0.0

    def test_create_full(self):
        token = TokenInfo(
            mint_address="abc123",
            symbol="PEPE",
            name="Pepe Coin",
            decimals=6,
            liquidity_usd=50000,
            price_usd=0.001,
        )
        assert token.symbol == "PEPE"
        assert token.liquidity_usd == 50000


class TestWalletTrade:
    def test_price_per_token(self):
        trade = WalletTrade(
            wallet_address="wallet1",
            tx_signature="sig1",
            direction=TradeDirection.BUY,
            token=TokenInfo(mint_address="token1"),
            amount_token=1000.0,
            amount_sol=0.5,
        )
        assert trade.price_per_token == 0.0005

    def test_price_per_token_zero_amount(self):
        trade = WalletTrade(
            wallet_address="wallet1",
            tx_signature="sig1",
            direction=TradeDirection.BUY,
            token=TokenInfo(mint_address="token1"),
            amount_token=0,
            amount_sol=0.5,
        )
        assert trade.price_per_token == 0.0


class TestPosition:
    def _make_position(self, **kwargs):
        defaults = dict(
            token_mint="token1",
            token_symbol="TEST",
            entry_price_sol=0.001,
            entry_amount_token=1000,
            entry_cost_sol=1.0,
            current_price_sol=0.001,
            peak_price_sol=0.001,
        )
        defaults.update(kwargs)
        return Position(**defaults)

    def test_unrealized_pnl_profit(self):
        pos = self._make_position(current_price_sol=0.002)
        assert pos.unrealized_pnl_sol == pytest.approx(1.0)
        assert pos.unrealized_pnl_pct == pytest.approx(1.0)

    def test_unrealized_pnl_loss(self):
        pos = self._make_position(current_price_sol=0.0005)
        assert pos.unrealized_pnl_sol == pytest.approx(-0.5)

    def test_realized_pnl_when_open(self):
        pos = self._make_position()
        assert pos.realized_pnl_sol == 0.0

    def test_realized_pnl_when_closed(self):
        pos = self._make_position(
            status=PositionStatus.CLOSED_TAKE_PROFIT,
            exit_amount_sol=2.5,
        )
        assert pos.realized_pnl_sol == pytest.approx(1.5)
        assert pos.realized_pnl_pct == pytest.approx(1.5)


class TestPortfolio:
    def test_default_portfolio(self):
        p = Portfolio()
        assert p.balance_sol == 10.0
        assert p.total_value_sol == 10.0
        assert p.total_pnl_sol == 0.0
        assert p.win_rate == 0.0

    def test_win_rate(self):
        p = Portfolio(
            closed_positions=[
                Position(
                    token_mint="a",
                    status=PositionStatus.CLOSED_TAKE_PROFIT,
                    entry_cost_sol=1.0,
                    exit_amount_sol=2.0,
                ),
                Position(
                    token_mint="b",
                    status=PositionStatus.CLOSED_STOP_LOSS,
                    entry_cost_sol=1.0,
                    exit_amount_sol=0.5,
                ),
            ]
        )
        assert p.win_rate == pytest.approx(0.5)

    def test_save_load(self, tmp_path):
        p = Portfolio(balance_sol=5.0, total_trades=3)
        path = str(tmp_path / "portfolio.json")
        p.save(path)

        loaded = Portfolio.load(path)
        assert loaded.balance_sol == 5.0
        assert loaded.total_trades == 3

    def test_load_missing_file(self):
        p = Portfolio.load("/nonexistent/path.json")
        assert p.balance_sol == 10.0


class TestWalletScore:
    def test_default_score(self):
        score = WalletScore(address="wallet1")
        assert score.confidence_score == 0.0
        assert score.win_rate == 0.0
