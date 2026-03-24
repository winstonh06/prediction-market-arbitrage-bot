"""
Token safety analyzer.

Performs basic safety checks on tokens before the paper trader enters a position.
Checks liquidity, holder concentration, mint/freeze authority, etc.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from dex_client import DexClient
from solana_client import SolanaClient
from models import TokenInfo

logger = logging.getLogger(__name__)


@dataclass
class SafetyResult:
    """Result of a token safety check."""

    passed: bool
    token: TokenInfo
    reasons: list[str]  # Reasons for failure (empty if passed)
    warnings: list[str]  # Non-blocking warnings

    def __str__(self) -> str:
        status = "PASS" if self.passed else "FAIL"
        details = "; ".join(self.reasons) if self.reasons else "OK"
        return f"[{status}] {self.token.symbol} ({self.token.mint_address[:8]}...): {details}"


class TokenAnalyzer:
    """
    Performs safety analysis on tokens.
    
    Checks configurable safety criteria before allowing paper trades.
    """

    def __init__(
        self,
        solana_client: SolanaClient,
        dex_client: DexClient,
        config: dict[str, Any],
    ) -> None:
        self.solana = solana_client
        self.dex = dex_client
        self.min_liquidity_usd = config.get("min_liquidity_usd", 10000)
        self.max_holder_concentration = config.get("max_holder_concentration", 0.30)
        self.require_mint_revoked = config.get("require_mint_revoked", True)
        self.require_freeze_revoked = config.get("require_freeze_revoked", True)
        self.min_holders = config.get("min_holders", 100)
        self.max_token_age_hours = config.get("max_token_age_hours", 72)
        self.blacklist = set(config.get("blacklist", []))

    async def analyze(self, token: TokenInfo) -> SafetyResult:
        """
        Run all safety checks on a token.
        
        Returns SafetyResult with pass/fail and reasons.
        """
        reasons: list[str] = []
        warnings: list[str] = []

        # ── Blacklist check ──
        if token.mint_address in self.blacklist:
            reasons.append("Token is blacklisted")
            return SafetyResult(
                passed=False, token=token, reasons=reasons, warnings=warnings
            )

        # ── Fetch current price/liquidity ──
        try:
            price_data = await self.dex.get_token_price(token.mint_address)
            token.price_usd = price_data["price_usd"]
            token.price_sol = price_data["price_sol"]
        except Exception as e:
            warnings.append(f"Could not fetch price: {e}")

        # ── Liquidity check ──
        if token.liquidity_usd < self.min_liquidity_usd:
            if token.liquidity_usd == 0:
                warnings.append("Liquidity data unavailable - skipping liquidity check")
            else:
                reasons.append(
                    f"Liquidity too low: ${token.liquidity_usd:,.0f} "
                    f"(min: ${self.min_liquidity_usd:,.0f})"
                )

        # ── Holder concentration ──
        if token.top10_holder_pct > self.max_holder_concentration:
            reasons.append(
                f"Top-10 holder concentration too high: {token.top10_holder_pct:.1%} "
                f"(max: {self.max_holder_concentration:.1%})"
            )

        # ── Mint authority ──
        if self.require_mint_revoked and not token.mint_authority_revoked:
            try:
                account_info = await self.solana.get_account_info(
                    token.mint_address
                )
                if account_info and "value" in account_info:
                    parsed = (
                        account_info["value"]
                        .get("data", {})
                        .get("parsed", {})
                        .get("info", {})
                    )
                    mint_auth = parsed.get("mintAuthority")
                    freeze_auth = parsed.get("freezeAuthority")
                    token.mint_authority_revoked = mint_auth is None
                    token.freeze_authority_revoked = freeze_auth is None

                    if not token.mint_authority_revoked:
                        reasons.append("Mint authority not revoked (rug risk)")
                    if (
                        self.require_freeze_revoked
                        and not token.freeze_authority_revoked
                    ):
                        reasons.append("Freeze authority not revoked")
            except Exception as e:
                warnings.append(f"Could not check authorities: {e}")

        # ── Holder count ──
        if 0 < token.holder_count < self.min_holders:
            reasons.append(
                f"Too few holders: {token.holder_count} (min: {self.min_holders})"
            )

        passed = len(reasons) == 0

        result = SafetyResult(
            passed=passed, token=token, reasons=reasons, warnings=warnings
        )

        log_fn = logger.info if passed else logger.warning
        log_fn(f"Safety check: {result}")

        return result
