"""
Event bus for decoupled component communication.
Components publish events and subscribe to event types without knowing about each other.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Callable, Coroutine, Any

from models import Event, EventType

logger = logging.getLogger(__name__)

# Type alias for event handlers
EventHandler = Callable[[Event], Coroutine[Any, Any, None]]


class EventBus:
    """
    Async pub/sub event bus.
    
    Components subscribe to specific event types and receive events asynchronously.
    This decouples the wallet monitor from the trading engine, safety checks, etc.
    """

    def __init__(self) -> None:
        self._handlers: dict[EventType, list[EventHandler]] = defaultdict(list)
        self._history: list[Event] = []
        self._max_history: int = 1000

    def subscribe(self, event_type: EventType, handler: EventHandler) -> None:
        """Register a handler for a specific event type."""
        self._handlers[event_type].append(handler)
        logger.debug(
            f"Subscribed {handler.__qualname__} to {event_type.value}"
        )

    def unsubscribe(self, event_type: EventType, handler: EventHandler) -> None:
        """Remove a handler for a specific event type."""
        if handler in self._handlers[event_type]:
            self._handlers[event_type].remove(handler)

    async def publish(self, event: Event) -> None:
        """Publish an event to all subscribed handlers."""
        self._history.append(event)
        if len(self._history) > self._max_history:
            self._history = self._history[-self._max_history:]

        handlers = self._handlers.get(event.type, [])
        if not handlers:
            logger.debug(f"No handlers for event: {event.type.value}")
            return

        logger.debug(
            f"Publishing {event.type.value} to {len(handlers)} handler(s)"
        )

        # Run all handlers concurrently
        tasks = []
        for handler in handlers:
            tasks.append(self._safe_handle(handler, event))
        await asyncio.gather(*tasks)

    async def _safe_handle(self, handler: EventHandler, event: Event) -> None:
        """Execute a handler with error isolation."""
        try:
            await handler(event)
        except Exception as e:
            logger.error(
                f"Handler {handler.__qualname__} failed on "
                f"{event.type.value}: {e}",
                exc_info=True,
            )

    def get_history(
        self, event_type: EventType | None = None, limit: int = 50
    ) -> list[Event]:
        """Get recent event history, optionally filtered by type."""
        if event_type:
            filtered = [e for e in self._history if e.type == event_type]
        else:
            filtered = self._history
        return filtered[-limit:]

    def clear_history(self) -> None:
        self._history.clear()

    @property
    def subscriber_count(self) -> dict[str, int]:
        return {
            et.value: len(handlers)
            for et, handlers in self._handlers.items()
            if handlers
        }
