"""
Solana RPC client wrapper with rate limiting and error handling.
Provides high-level methods for wallet monitoring operations.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from rate_limiter import RateLimiter

logger = logging.getLogger(__name__)


class SolanaClient:
    """
    Async Solana JSON-RPC client.
    
    Wraps raw RPC calls with rate limiting, retries, and structured responses.
    Uses httpx directly for maximum control over connection handling.
    """

    def __init__(
        self,
        endpoint: str = "https://api.mainnet-beta.solana.com",
        rate_limit: float = 5.0,
        timeout: float = 30.0,
    ) -> None:
        self.endpoint = endpoint
        self.rate_limiter = RateLimiter(max_rate=rate_limit)
        self.timeout = timeout
        self._client: Optional[httpx.AsyncClient] = None
        self._request_id = 0

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=self.timeout,
                headers={"Content-Type": "application/json"},
                limits=httpx.Limits(
                    max_connections=10, max_keepalive_connections=5
                ),
            )
        return self._client

    async def _rpc_call(
        self, method: str, params: list[Any] | None = None, retries: int = 3
    ) -> dict[str, Any]:
        """Execute a JSON-RPC call with rate limiting and retries."""
        await self.rate_limiter.acquire()

        self._request_id += 1
        payload = {
            "jsonrpc": "2.0",
            "id": self._request_id,
            "method": method,
            "params": params or [],
        }

        client = await self._get_client()

        for attempt in range(retries):
            try:
                response = await client.post(self.endpoint, json=payload)
                response.raise_for_status()
                data = response.json()

                if "error" in data:
                    error = data["error"]
                    logger.warning(
                        f"RPC error on {method}: {error.get('message', error)}"
                    )
                    if attempt < retries - 1:
                        continue
                    return {"error": error}

                return data.get("result", {})

            except httpx.TimeoutException:
                logger.warning(
                    f"Timeout on {method} (attempt {attempt + 1}/{retries})"
                )
            except httpx.HTTPStatusError as e:
                logger.warning(
                    f"HTTP {e.response.status_code} on {method} "
                    f"(attempt {attempt + 1}/{retries})"
                )
            except Exception as e:
                logger.error(f"Unexpected error on {method}: {e}")
                if attempt < retries - 1:
                    continue
                raise

        return {"error": f"Failed after {retries} retries"}

    # ── High-Level Methods ───────────────────────────────────────────────

    async def get_signatures_for_address(
        self,
        address: str,
        limit: int = 20,
        before: str | None = None,
    ) -> list[dict[str, Any]]:
        """Get recent transaction signatures for a wallet address."""
        params: dict[str, Any] = {"limit": limit}
        if before:
            params["before"] = before

        result = await self._rpc_call(
            "getSignaturesForAddress", [address, params]
        )

        if isinstance(result, dict) and "error" in result:
            logger.error(f"Failed to get signatures for {address[:8]}...")
            return []

        return result if isinstance(result, list) else []

    async def get_transaction(
        self, signature: str
    ) -> dict[str, Any] | None:
        """Get full transaction details by signature."""
        result = await self._rpc_call(
            "getTransaction",
            [
                signature,
                {
                    "encoding": "jsonParsed",
                    "maxSupportedTransactionVersion": 0,
                },
            ],
        )

        if isinstance(result, dict) and "error" in result:
            return None

        return result if result else None

    async def get_account_info(
        self, address: str
    ) -> dict[str, Any] | None:
        """Get account info for an address."""
        result = await self._rpc_call(
            "getAccountInfo",
            [address, {"encoding": "jsonParsed"}],
        )

        if isinstance(result, dict) and "error" in result:
            return None

        return result

    async def get_token_accounts_by_owner(
        self, owner: str, mint: str | None = None
    ) -> list[dict[str, Any]]:
        """Get SPL token accounts for a wallet."""
        if mint:
            filter_param = {"mint": mint}
        else:
            filter_param = {"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"}

        result = await self._rpc_call(
            "getTokenAccountsByOwner",
            [owner, filter_param, {"encoding": "jsonParsed"}],
        )

        if isinstance(result, dict) and "value" in result:
            return result["value"]
        return []

    async def get_slot(self) -> int:
        """Get current slot number."""
        result = await self._rpc_call("getSlot")
        return result if isinstance(result, int) else 0

    async def get_balance(self, address: str) -> float:
        """Get SOL balance for an address in SOL."""
        result = await self._rpc_call("getBalance", [address])
        if isinstance(result, dict) and "value" in result:
            return result["value"] / 1_000_000_000
        return 0.0

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
