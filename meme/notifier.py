"""
Telegram notification system.
Sends trade alerts for entries, exits, and daily summaries.
"""

from __future__ import annotations

import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


class TelegramNotifier:
    API_URL = "https://api.telegram.org/bot{token}/sendMessage"

    def __init__(self, token: str, chat_id: str) -> None:
        self.token = token
        self.chat_id = chat_id
        self._client: Optional[httpx.AsyncClient] = None
        self.enabled = bool(token and chat_id)
        if not self.enabled:
            logger.warning("Telegram notifier disabled - no token/chat_id")

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=10.0)
        return self._client

    async def send(self, message: str) -> bool:
        if not self.enabled:
            return False
        try:
            client = await self._get_client()
            resp = await client.post(
                self.API_URL.format(token=self.token),
                json={
                    "chat_id": self.chat_id,
                    "text": message,
                    "parse_mode": "HTML",
                    "disable_web_page_preview": True,
                },
            )
            resp.raise_for_status()
            return True
        except Exception as e:
            logger.warning(f"Telegram send failed: {e}")
            return False

    async def notify_buy(self, token_symbol, token_mint, amount_sol, price_sol, wallet_label):
        msg = (
            f"🟢 <b>BUY</b>\n"
            f"Token: <b>{token_symbol}</b>\n"
            f"Mint: <code>{token_mint[:20]}...</code>\n"
            f"Amount: <b>{amount_sol:.4f} SOL</b>\n"
            f"Price: {price_sol:.10f} SOL\n"
            f"Triggered by: {wallet_label}"
        )
        await self.send(msg)

    async def notify_sell(self, token_symbol, pnl_sol, pnl_pct, reason, hold_minutes):
        emoji = "🟢" if pnl_sol >= 0 else "🔴"
        msg = (
            f"{emoji} <b>SELL</b>\n"
            f"Token: <b>{token_symbol}</b>\n"
            f"PnL: <b>{pnl_sol:+.4f} SOL ({pnl_pct:+.1%})</b>\n"
            f"Reason: {reason}\n"
            f"Hold time: {hold_minutes:.1f} min"
        )
        await self.send(msg)

    async def notify_safety_fail(self, token_mint, reasons):
        msg = (
            f"⚠️ <b>SAFETY REJECTED</b>\n"
            f"Mint: <code>{token_mint[:20]}...</code>\n"
            f"Reasons: {', '.join(reasons)}"
        )
        await self.send(msg)

    async def notify_summary(self, balance, total_value, pnl_sol, pnl_pct, open_positions, closed_today):
        emoji = "📈" if pnl_sol >= 0 else "📉"
        msg = (
            f"{emoji} <b>PORTFOLIO UPDATE</b>\n"
            f"Balance: {balance:.4f} SOL\n"
            f"Total Value: {total_value:.4f} SOL\n"
            f"Total PnL: <b>{pnl_sol:+.4f} SOL ({pnl_pct:+.1%})</b>\n"
            f"Open: {open_positions} | Closed today: {closed_today}"
        )
        await self.send(msg)

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
