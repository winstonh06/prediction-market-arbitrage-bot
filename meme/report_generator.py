"""
Report generator.

Produces formatted performance reports for the paper trading portfolio,
including PnL summaries, wallet leaderboards, and trade history.
"""

from __future__ import annotations

import time
from typing import Any

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from wallet_scorer import WalletScorer
from models import Portfolio, PositionStatus
from helpers import format_pct, format_sol, short_address, time_ago

console = Console()


class ReportGenerator:
    """Generates formatted CLI reports for paper trading performance."""

    def __init__(
        self, portfolio: Portfolio, wallet_scorer: WalletScorer
    ) -> None:
        self.portfolio = portfolio
        self.scorer = wallet_scorer

    def print_full_report(self) -> None:
        """Print a comprehensive performance report."""
        console.print()
        self._print_portfolio_summary()
        console.print()
        self._print_open_positions()
        console.print()
        self._print_closed_positions()
        console.print()
        self._print_wallet_leaderboard()
        console.print()
        self._print_stats()
        console.print()

    def _print_portfolio_summary(self) -> None:
        """Print portfolio overview panel."""
        p = self.portfolio
        pnl_color = "green" if p.total_pnl_sol >= 0 else "red"

        summary = Table(show_header=False, box=None, padding=(0, 2))
        summary.add_column("Label", style="bold")
        summary.add_column("Value")

        summary.add_row("Starting Balance", format_sol(p.starting_balance_sol))
        summary.add_row("Current Balance", format_sol(p.balance_sol))
        summary.add_row(
            "Total Value",
            Text(format_sol(p.total_value_sol), style="bold"),
        )
        summary.add_row(
            "Total PnL",
            Text(
                f"{format_sol(p.total_pnl_sol)} ({format_pct(p.total_pnl_pct)})",
                style=f"bold {pnl_color}",
            ),
        )
        summary.add_row("Open Positions", str(len(p.open_positions)))
        summary.add_row("Closed Trades", str(len(p.closed_positions)))
        summary.add_row("Total Trades", str(p.total_trades))
        summary.add_row(
            "Win Rate",
            format_pct(p.win_rate) if p.closed_positions else "N/A",
        )

        uptime = time.time() - p.created_at
        hours = uptime / 3600
        summary.add_row("Uptime", f"{hours:.1f} hours")

        console.print(
            Panel(summary, title="Portfolio Summary", border_style="blue")
        )

    def _print_open_positions(self) -> None:
        """Print table of open positions."""
        positions = self.portfolio.open_positions
        if not positions:
            console.print(
                Panel("[dim]No open positions[/dim]", title="Open Positions")
            )
            return

        table = Table(title="Open Positions", show_lines=True)
        table.add_column("Token", style="cyan")
        table.add_column("Entry Price", justify="right")
        table.add_column("Current Price", justify="right")
        table.add_column("Unrealized PnL", justify="right")
        table.add_column("Peak", justify="right")
        table.add_column("Hold Time")
        table.add_column("Wallet")

        for pos in positions:
            pnl = pos.unrealized_pnl_sol
            pnl_pct = pos.unrealized_pnl_pct
            pnl_style = "green" if pnl >= 0 else "red"

            table.add_row(
                pos.token_symbol,
                f"{pos.entry_price_sol:.10f}",
                f"{pos.current_price_sol:.10f}",
                Text(
                    f"{pnl:+.4f} SOL ({pnl_pct:+.1%})", style=pnl_style
                ),
                f"{pos.peak_price_sol:.10f}",
                time_ago(pos.entry_timestamp),
                short_address(pos.triggered_by_wallet),
            )

        console.print(table)

    def _print_closed_positions(self) -> None:
        """Print recent closed positions."""
        positions = self.portfolio.closed_positions[-20:]  # Last 20
        if not positions:
            console.print(
                Panel(
                    "[dim]No closed positions yet[/dim]",
                    title="Recent Closed Positions",
                )
            )
            return

        table = Table(title="Recent Closed Positions", show_lines=True)
        table.add_column("Token", style="cyan")
        table.add_column("Entry", justify="right")
        table.add_column("Exit", justify="right")
        table.add_column("PnL", justify="right")
        table.add_column("Reason")
        table.add_column("Hold Time")

        for pos in reversed(positions):
            pnl = pos.realized_pnl_sol
            pnl_pct = pos.realized_pnl_pct
            pnl_style = "green" if pnl >= 0 else "red"

            reason_map = {
                PositionStatus.CLOSED_STOP_LOSS: "[red]Stop Loss[/red]",
                PositionStatus.CLOSED_TAKE_PROFIT: "[green]Take Profit[/green]",
                PositionStatus.CLOSED_TRAILING_STOP: "[yellow]Trailing Stop[/yellow]",
                PositionStatus.CLOSED_MANUAL: "[blue]Manual[/blue]",
            }

            table.add_row(
                pos.token_symbol,
                f"{pos.entry_cost_sol:.4f} SOL",
                f"{pos.exit_amount_sol:.4f} SOL",
                Text(
                    f"{pnl:+.4f} SOL ({pnl_pct:+.1%})", style=pnl_style
                ),
                reason_map.get(pos.status, pos.status.value),
                f"{pos.hold_duration_seconds / 60:.1f}min",
            )

        console.print(table)

    def _print_wallet_leaderboard(self) -> None:
        """Print wallet performance leaderboard."""
        scores = self.scorer.get_all_scores()
        if not scores:
            console.print(
                Panel(
                    "[dim]No wallet scores yet[/dim]",
                    title="Wallet Leaderboard",
                )
            )
            return

        table = Table(title="Wallet Leaderboard", show_lines=True)
        table.add_column("Rank", justify="center")
        table.add_column("Label", style="cyan")
        table.add_column("Address")
        table.add_column("Score", justify="right", style="bold")
        table.add_column("Win Rate", justify="right")
        table.add_column("Avg Return", justify="right")
        table.add_column("Trades", justify="right")
        table.add_column("Total PnL", justify="right")

        for i, score in enumerate(scores, 1):
            pnl_style = "green" if score.total_pnl_sol >= 0 else "red"

            table.add_row(
                f"#{i}",
                score.label or "-",
                short_address(score.address),
                f"{score.confidence_score:.2f}",
                format_pct(score.win_rate),
                format_pct(score.avg_return_pct),
                str(score.total_trades_observed),
                Text(format_sol(score.total_pnl_sol), style=pnl_style),
            )

        console.print(table)

    def _print_stats(self) -> None:
        """Print additional statistics."""
        p = self.portfolio
        if not p.closed_positions:
            return

        returns = [pos.realized_pnl_pct for pos in p.closed_positions]
        best = max(returns)
        worst = min(returns)
        avg = sum(returns) / len(returns)

        # Calculate max drawdown
        peak_value = p.starting_balance_sol
        max_dd = 0.0
        running_value = p.starting_balance_sol

        for pos in p.closed_positions:
            running_value += pos.realized_pnl_sol
            peak_value = max(peak_value, running_value)
            dd = (peak_value - running_value) / peak_value if peak_value > 0 else 0
            max_dd = max(max_dd, dd)

        stats = Table(show_header=False, box=None, padding=(0, 2))
        stats.add_column("Stat", style="bold")
        stats.add_column("Value")

        stats.add_row(
            "Best Trade",
            Text(format_pct(best), style="green"),
        )
        stats.add_row(
            "Worst Trade",
            Text(format_pct(worst), style="red"),
        )
        stats.add_row("Average Return", format_pct(avg))
        stats.add_row(
            "Max Drawdown",
            Text(format_pct(-max_dd), style="red"),
        )

        # Exit reason breakdown
        reasons = {}
        for pos in p.closed_positions:
            r = pos.status.value
            reasons[r] = reasons.get(r, 0) + 1

        for reason, count in sorted(reasons.items()):
            stats.add_row(f"Exits: {reason}", str(count))

        console.print(
            Panel(stats, title="Trading Statistics", border_style="magenta")
        )
