"""
Transaction parser for Solana swap transactions.

Analyzes raw transaction data to extract structured trade information,
identifying token swaps on DEXes like Raydium and Jupiter.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from dex_client import DEX_PROGRAMS, WSOL_MINT
from models import TokenInfo, TradeDirection, WalletTrade

logger = logging.getLogger(__name__)


class TransactionParser:
    """
    Parses Solana transactions into structured WalletTrade objects.
    
    Focuses on detecting swap transactions by analyzing:
    1. Program invocations (is a DEX program involved?)
    2. Token balance changes (what tokens moved and in what direction?)
    3. SOL balance changes (how much SOL was spent/received?)
    """

    def parse_transaction(
        self,
        tx_data: dict[str, Any],
        wallet_address: str,
        wallet_label: str = "",
    ) -> Optional[WalletTrade]:
        """
        Parse a transaction and return a WalletTrade if it's a swap.
        
        Returns None if the transaction is not a swap or can't be parsed.
        """
        try:
            if not tx_data or "meta" not in tx_data:
                return None

            meta = tx_data["meta"]
            if meta.get("err") is not None:
                return None  # Skip failed transactions

            transaction = tx_data.get("transaction", {})
            message = transaction.get("message", {})

            # Check if any DEX program is involved
            if not self._involves_dex(message):
                return None

            # Extract token balance changes for the wallet
            token_changes = self._get_token_balance_changes(
                meta, message, wallet_address
            )
            sol_change = self._get_sol_change(meta, message, wallet_address)

            if not token_changes:
                return None

            # Determine trade direction and token
            trade = self._build_trade(
                token_changes=token_changes,
                sol_change=sol_change,
                wallet_address=wallet_address,
                wallet_label=wallet_label,
                tx_data=tx_data,
            )

            return trade

        except Exception as e:
            sig = self._get_signature(tx_data)
            logger.debug(f"Failed to parse tx {sig[:12] if sig else '?'}...: {e}")
            return None

    def _involves_dex(self, message: dict[str, Any]) -> bool:
        """Check if the transaction involves a known DEX program."""
        account_keys = self._get_account_keys(message)
        for key in account_keys:
            addr = key if isinstance(key, str) else key.get("pubkey", "")
            if addr in DEX_PROGRAMS:
                return True

        # Also check inner instructions log for program invocations
        instructions = message.get("instructions", [])
        for ix in instructions:
            program_id = ix.get("programId", "")
            if program_id in DEX_PROGRAMS:
                return True

        return False

    def _get_token_balance_changes(
        self,
        meta: dict[str, Any],
        message: dict[str, Any],
        wallet_address: str,
    ) -> list[dict[str, Any]]:
        """
        Extract token balance changes for the wallet from pre/post token balances.
        
        Returns list of dicts with: mint, change (positive = received, negative = sent)
        """
        pre_balances = meta.get("preTokenBalances", [])
        post_balances = meta.get("postTokenBalances", [])

        # Index pre-balances by (account_index, mint)
        pre_map: dict[tuple[int, str], float] = {}
        for bal in pre_balances:
            owner = bal.get("owner", "")
            if owner == wallet_address:
                mint = bal.get("mint", "")
                amount = float(
                    bal.get("uiTokenAmount", {}).get("uiAmount", 0) or 0
                )
                idx = bal.get("accountIndex", -1)
                pre_map[(idx, mint)] = amount

        # Calculate changes from post-balances
        changes = []
        for bal in post_balances:
            owner = bal.get("owner", "")
            if owner == wallet_address:
                mint = bal.get("mint", "")
                if mint == WSOL_MINT:
                    continue  # Handle SOL separately
                post_amount = float(
                    bal.get("uiTokenAmount", {}).get("uiAmount", 0) or 0
                )
                idx = bal.get("accountIndex", -1)
                pre_amount = pre_map.get((idx, mint), 0.0)
                change = post_amount - pre_amount

                if abs(change) > 0:
                    decimals = int(
                        bal.get("uiTokenAmount", {}).get("decimals", 9)
                    )
                    changes.append(
                        {
                            "mint": mint,
                            "change": change,
                            "decimals": decimals,
                        }
                    )

        # Check for tokens in pre but not in post (fully sold)
        post_mints = {
            (bal.get("accountIndex"), bal.get("mint"))
            for bal in post_balances
            if bal.get("owner") == wallet_address
        }
        for (idx, mint), pre_amount in pre_map.items():
            if (idx, mint) not in post_mints and mint != WSOL_MINT:
                changes.append(
                    {"mint": mint, "change": -pre_amount, "decimals": 9}
                )

        return changes

    def _get_sol_change(
        self,
        meta: dict[str, Any],
        message: dict[str, Any],
        wallet_address: str,
    ) -> float:
        """Get SOL balance change for the wallet (in SOL, not lamports)."""
        account_keys = self._get_account_keys(message)
        pre_balances = meta.get("preBalances", [])
        post_balances = meta.get("postBalances", [])

        for i, key in enumerate(account_keys):
            addr = key if isinstance(key, str) else key.get("pubkey", "")
            if addr == wallet_address:
                if i < len(pre_balances) and i < len(post_balances):
                    change_lamports = post_balances[i] - pre_balances[i]
                    return change_lamports / 1_000_000_000
        return 0.0

    def _build_trade(
        self,
        token_changes: list[dict[str, Any]],
        sol_change: float,
        wallet_address: str,
        wallet_label: str,
        tx_data: dict[str, Any],
    ) -> Optional[WalletTrade]:
        """Build a WalletTrade from parsed balance changes."""
        # Find the primary token change (largest absolute change, excluding WSOL)
        primary = max(token_changes, key=lambda c: abs(c["change"]))

        if primary["change"] > 0:
            # Received tokens = BUY
            direction = TradeDirection.BUY
            amount_token = primary["change"]
            amount_sol = abs(sol_change)
        elif primary["change"] < 0:
            # Sent tokens = SELL
            direction = TradeDirection.SELL
            amount_token = abs(primary["change"])
            amount_sol = abs(sol_change)
        else:
            return None

        if amount_token == 0 or amount_sol == 0:
            return None

        token = TokenInfo(
            mint_address=primary["mint"],
            decimals=primary["decimals"],
        )

        sig = self._get_signature(tx_data)
        slot = tx_data.get("slot", 0)
        block_time = tx_data.get("blockTime", 0)

        return WalletTrade(
            wallet_address=wallet_address,
            wallet_label=wallet_label,
            tx_signature=sig or "",
            direction=direction,
            token=token,
            amount_token=amount_token,
            amount_sol=amount_sol,
            timestamp=float(block_time) if block_time else 0.0,
            slot=slot,
        )

    @staticmethod
    def _get_account_keys(message: dict[str, Any]) -> list[Any]:
        """Extract account keys from message, handling both formats."""
        keys = message.get("accountKeys", [])
        if not keys:
            # Some formats nest under different key
            keys = message.get("instructions", [{}])[0].get("accounts", [])
        return keys

    @staticmethod
    def _get_signature(tx_data: dict[str, Any]) -> Optional[str]:
        """Extract transaction signature."""
        tx = tx_data.get("transaction", {})
        sigs = tx.get("signatures", [])
        return sigs[0] if sigs else None
