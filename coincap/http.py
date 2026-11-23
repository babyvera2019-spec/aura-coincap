"""Tiny HTTP helpers on top of the standard library, plus a TTL cache."""
from __future__ import annotations

import json
import threading
import time
import urllib.request
from typing import Any, Callable

USER_AGENT = "AURA-CoinCap-Demo/0.1 (+hackathon)"


def get_json(url: str, headers: dict | None = None, timeout: int = 20) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_bytes(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def post_json(url: str, payload: dict, headers: dict | None = None, timeout: int = 60) -> Any:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"User-Agent": USER_AGENT, "Content-Type": "application/json", **(headers or {})},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


class TTLCache:
    """Thread-safe cache so many visitors share one upstream request."""

    def __init__(self) -> None:
        self._data: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get_or_set(self, key: str, ttl: int, producer: Callable[[], Any]) -> Any:
        now = time.time()
        with self._lock:
            hit = self._data.get(key)
            if hit and now - hit[0] < ttl:
                return hit[1]
        value = producer()
        with self._lock:
            self._data[key] = (time.time(), value)
        return value

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


cache = TTLCache()
