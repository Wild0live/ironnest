"""Per-profile token bucket rate limiter.

Simple in-memory implementation; per-process. Sufficient for a single
memory-gateway container. If we ever run multiple gateway replicas, swap
in a Redis-backed bucket (extension point — keep the same interface).
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field


@dataclass(slots=True)
class _Bucket:
    capacity: float
    refill_per_sec: float
    tokens: float = 0.0
    last_refill: float = field(default_factory=time.monotonic)


class RateLimiter:
    """Per-key (profile) token bucket. Thread-safe."""

    def __init__(self, capacity: int, refill_per_sec: float) -> None:
        self._capacity = float(capacity)
        self._refill = float(refill_per_sec)
        self._buckets: dict[str, _Bucket] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, cost: float = 1.0) -> bool:
        with self._lock:
            now = time.monotonic()
            b = self._buckets.get(key)
            if b is None:
                b = _Bucket(capacity=self._capacity, refill_per_sec=self._refill,
                            tokens=self._capacity, last_refill=now)
                self._buckets[key] = b
            # Refill
            elapsed = now - b.last_refill
            b.tokens = min(b.capacity, b.tokens + elapsed * b.refill_per_sec)
            b.last_refill = now
            if b.tokens >= cost:
                b.tokens -= cost
                return True
            return False
