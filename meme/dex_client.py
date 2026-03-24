"""
DEX price client for Solana tokens.
Uses DexScreener API for price lookups (free, no auth required).
"""

from __future__ import annotations

import logging
from typing import Optional

import httpx

from rate_limiter import RateLimiter

logger = logging.getLogger(__name__)

WSOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
RAYDIUM_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
JUPITER_LIMIT = "j1to2NQfVoaxPZUoKL7Kd7hTMu3bRbWANcVbgPHHMJF"
ORCA_WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"

DEX_PROGRAMS = {
    RAYDIUM_AMM_V4: "Raydium AMM V4",
    RAYDIUM_CLMM: "Raydium CLMM",
    JUPITER_V6: "Jupiter V6",
    JUPITER_LIMIT: "Jupiter Limit",
    ORCA_WHIRLPOOL: "Orca Whirlpool",
}


class DexClient:
    DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/tokens"

    def __init__(self, rate_limit: float = 5.0) -> None:
        self.rate_limiter = RateLimiter(max_rate=rate_limit)
        self._client: Optional[httpx.AsyncClient] = None
        self._sol_price_cache: float = 0.0

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=15.0)
        return self._client

    async def get_token_price(self, mint_address: str) -> dict[str, float]:
        await self.rate_limiter.acquire()
        client = await self._get_client()
        try:
            resp = await client.get(f"{self.DEXSCREENER_API}/{mint_address}")
            resp.raise_for_status()
            data = resp.json()
            price_usd = 0.0
            pairs = data.get("pairs") or []
            if pairs:
                price_usd = float(pairs[0].get("priceUsd", 0) or 0)
            sol_price_usd = await self._get_sol_price_usd()
            price_sol = price_usd / sol_price_usd if sol_price_usd > 0 else 0.0
            return {"price_usd": price_usd, "price_sol": price_sol}
        except Exception as e:
            logger.warning(f"Price lookup failed for {mint_address[:8]}...: {e}")
            return {"price_usd": 0.0, "price_sol": 0.0}

    async def get_multiple_prices(self, mint_addresses: list[str]) -> dict[str, dict[str, float]]:
        results = {}
        for mint in mint_addresses:
            results[mint] = await self.get_token_price(mint)
        return results

    async def _get_sol_price_usd(self) -> float:
        if self._sol_price_cache > 0:
            return self._sol_price_cache
        client = await self._get_client()
        try:
            resp = await client.get(f"{self.DEXSCREENER_API}/{WSOL_MINT}")
            resp.raise_for_status()
            data = resp.json()
            pairs = data.get("pairs") or []
            if pairs:
                self._sol_price_cache = float(pairs[0].get("priceUsd", 0) or 0)
                return self._sol_price_cache
        except Exception:
            pass
        return 150.0

    @staticmethod
    def is_dex_program(program_id: str) -> bool:
        return program_id in DEX_PROGRAMS

    @staticmethod
    def get_dex_name(program_id: str) -> str:
        return DEX_PROGRAMS.get(program_id, "Unknown DEX")

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
