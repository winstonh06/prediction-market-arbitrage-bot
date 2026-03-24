"""
Wallet monitor.

Continuously polls tracked wallet addresses for new transactions,
parses them, and publishes trade events to the event bus.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from solana_client import SolanaClient
from event_bus import EventBus
from models import Event, EventType, WalletTrade
from transaction_parser import TransactionParser

logger = logging.getLogger(__name__)


class WalletMonitor:
    """
    Monitors tracked wallets for new swap transactions.
    
    Polls each wallet's recent transaction history, detects new swaps,
    and publishes WalletTrade events to the event bus.
    """

    def __init__(
        self,
        solana_client: SolanaClient,
        event_bus: EventBus,
        wallets: list[dict[str, Any]],
        poll_interval: float = 10.0,
        tx_fetch_limit: int = 20,
    ) -> None:
        self.solana = solana_client
        self.event_bus = event_bus
        self.parser = TransactionParser()
        self.poll_interval = poll_interval
        self.tx_fetch_limit = tx_fetch_limit

        # Wallet configs (address, label, enabled)
        self.wallets = [w for w in wallets if w.get("enabled", True)]

        # Track seen transaction signatures to avoid duplicates
        self._seen_signatures: set[str] = set()
        self._max_seen = 10000

        # Stats
        self.total_polls = 0
        self.total_trades_detected = 0

        self._running = False

    async def start(self) -> None:
        """Start the monitoring loop."""
        self._running = True
        logger.info(
            f"[bold green]Wallet monitor started[/bold green] - "
            f"tracking {len(self.wallets)} wallet(s), "
            f"polling every {self.poll_interval}s",
            extra={"markup": True},
        )

        while self._running:
            try:
                await self._poll_all_wallets()
                self.total_polls += 1
            except Exception as e:
                logger.error(f"Poll cycle error: {e}", exc_info=True)

            await asyncio.sleep(self.poll_interval)

    async def stop(self) -> None:
        """Stop the monitoring loop."""
        self._running = False
        logger.info("Wallet monitor stopped")

    async def _poll_all_wallets(self) -> None:
        """Poll all tracked wallets for new transactions."""
        tasks = [
            self._poll_wallet(w["address"], w.get("label", ""))
            for w in self.wallets
        ]
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _poll_wallet(self, address: str, label: str) -> None:
        """Poll a single wallet for new transactions."""
        try:
            signatures = await self.solana.get_signatures_for_address(
                address, limit=self.tx_fetch_limit
            )

            new_sigs = [
                s for s in signatures
                if s.get("signature") not in self._seen_signatures
                and s.get("err") is None  # Skip failed TXs
            ]

            if not new_sigs:
                return

            logger.debug(
                f"Found {len(new_sigs)} new tx(s) for {label or address[:8]}..."
            )

            for sig_info in new_sigs:
                sig = sig_info["signature"]
                self._seen_signatures.add(sig)

                # Trim seen set if it gets too large
                if len(self._seen_signatures) > self._max_seen:
                    # Keep most recent half
                    self._seen_signatures = set(
                        list(self._seen_signatures)[-self._max_seen // 2:]
                    )

                # Fetch full transaction
                tx_data = await self.solana.get_transaction(sig)
                if not tx_data:
                    continue

                # Parse into trade
                trade = self.parser.parse_transaction(
                    tx_data, address, label
                )
                if trade is None:
                    continue

                self.total_trades_detected += 1
                logger.info(
                    f"[bold cyan]Trade detected[/bold cyan] | "
                    f"Wallet: {label or address[:8]}... | "
                    f"{trade.direction.value.upper()} | "
                    f"Token: {trade.token.mint_address[:8]}... | "
                    f"Amount: {trade.amount_sol:.4f} SOL",
                    extra={"markup": True},
                )

                # Publish event
                await self.event_bus.publish(
                    Event(
                        type=EventType.WALLET_TRADE_DETECTED,
                        data=trade.model_dump(),
                        source=f"wallet_monitor:{address[:8]}",
                    )
                )

        except Exception as e:
            logger.warning(
                f"Error polling wallet {label or address[:8]}...: {e}"
            )

    async def backfill(self, hours: float = 24.0) -> list[WalletTrade]:
        """
        Backfill recent trades from tracked wallets.
        
        Used on startup to catch up on trades that happened while offline.
        """
        cutoff = time.time() - (hours * 3600)
        all_trades: list[WalletTrade] = []

        for wallet in self.wallets:
            address = wallet["address"]
            label = wallet.get("label", "")

            logger.info(f"Backfilling {label or address[:8]}... ({hours}h)")

            try:
                signatures = await self.solana.get_signatures_for_address(
                    address, limit=50
                )

                for sig_info in signatures:
                    block_time = sig_info.get("blockTime", 0)
                    if block_time and block_time < cutoff:
                        break

                    sig = sig_info["signature"]
                    self._seen_signatures.add(sig)

                    if sig_info.get("err"):
                        continue

                    tx_data = await self.solana.get_transaction(sig)
                    if not tx_data:
                        continue

                    trade = self.parser.parse_transaction(
                        tx_data, address, label
                    )
                    if trade:
                        all_trades.append(trade)

            except Exception as e:
                logger.warning(f"Backfill error for {label}: {e}")

        logger.info(f"Backfill complete: {len(all_trades)} trade(s) found")
        return all_trades
