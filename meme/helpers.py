"""
Shared utility functions.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


def sol_to_lamports(sol: float) -> int:
    """Convert SOL to lamports."""
    return int(sol * 1_000_000_000)


def lamports_to_sol(lamports: int) -> float:
    """Convert lamports to SOL."""
    return lamports / 1_000_000_000


def format_sol(amount: float, decimals: int = 4) -> str:
    """Format SOL amount for display."""
    return f"{amount:,.{decimals}f} SOL"


def format_pct(pct: float) -> str:
    """Format percentage for display."""
    sign = "+" if pct >= 0 else ""
    return f"{sign}{pct:.2%}"


def format_usd(amount: float) -> str:
    """Format USD amount for display."""
    return f"${amount:,.2f}"


def short_address(address: str, chars: int = 4) -> str:
    """Shorten a Solana address for display."""
    if len(address) <= chars * 2 + 3:
        return address
    return f"{address[:chars]}...{address[-chars:]}"


def time_ago(timestamp: float) -> str:
    """Human-readable time ago string."""
    diff = time.time() - timestamp
    if diff < 60:
        return f"{int(diff)}s ago"
    elif diff < 3600:
        return f"{int(diff / 60)}m ago"
    elif diff < 86400:
        return f"{int(diff / 3600)}h ago"
    else:
        return f"{int(diff / 86400)}d ago"


def load_json(path: str, default: Any = None) -> Any:
    """Load JSON from file with fallback."""
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default if default is not None else {}


def save_json(path: str, data: Any) -> None:
    """Save data as JSON to file."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2, default=str)
