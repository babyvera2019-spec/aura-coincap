"""CoinMarketCap API client (listings, global metrics, Fear & Greed).

Responses are normalised into small dicts and cached, so the dashboard spends
very few API credits no matter how many people open it.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

from .config import Config
from .http import cache, get_json

log = logging.getLogger(__name__)
SAMPLE_DIR = Path(__file__).resolve().parent / "sample_data"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _sample(name: str) -> dict:
    return json.loads((SAMPLE_DIR / name).read_text(encoding="utf-8"))


def _cmc(path: str, params: dict | None = None) -> dict:
    url = f"{Config.CMC_BASE_URL}{path}"
    if params:
        url += "?" + urlencode(params)
    return get_json(url, headers={"X-CMC_PRO_API_KEY": Config.CMC_API_KEY}, timeout=Config.HTTP_TIMEOUT)


def _norm_coin(c: dict) -> dict:
    q = (c.get("quote") or {}).get("USD") or {}
    return {
        "rank": c.get("cmc_rank"),
        "name": c.get("name"),
        "symbol": c.get("symbol"),
        "price": q.get("price"),
        "change_1h": q.get("percent_change_1h"),
        "change_24h": q.get("percent_change_24h"),
        "change_7d": q.get("percent_change_7d"),
        "market_cap": q.get("market_cap"),
        "volume_24h": q.get("volume_24h"),
    }


def _norm_global(d: dict) -> dict:
    q = (d.get("quote") or {}).get("USD") or {}
    return {
        "total_market_cap": q.get("total_market_cap"),
        "total_volume_24h": q.get("total_volume_24h"),
        "market_cap_change_24h": q.get("total_market_cap_yesterday_percentage_change"),
        "btc_dominance": d.get("btc_dominance"),
        "eth_dominance": d.get("eth_dominance"),
        "active_cryptocurrencies": d.get("active_cryptocurrencies"),
    }


def _norm_fng(d: dict) -> dict:
    return {
        "value": d.get("value"),
        "classification": d.get("value_classification"),
        "updated": d.get("update_time"),
    }


def _fetch(kind: str, live, sample_file: str, normalise):
    """Return {'data', 'source', 'as_of', 'error'}; falls back to sample data."""
    if Config.demo_market():
        return {"data": normalise(_sample(sample_file)["data"]), "source": "demo-sample", "as_of": None, "error": None}
    try:
        raw = live()
        return {"data": normalise(raw["data"]), "source": "coinmarketcap", "as_of": _now_iso(), "error": None}
    except Exception as exc:  # network/quota errors must never break the page
        log.warning("CMC %s failed: %s", kind, exc)
        return {
            "data": normalise(_sample(sample_file)["data"]),
            "source": "demo-sample",
            "as_of": None,
            "error": f"CoinMarketCap unavailable ({type(exc).__name__}); showing sample data",
        }


def listings(limit: int = 100) -> dict:
    def produce():
        return _fetch(
            "listings",
            lambda: _cmc("/v1/cryptocurrency/listings/latest", {"start": 1, "limit": limit, "convert": "USD"}),
            "listings.json",
            lambda rows: [_norm_coin(c) for c in rows][:limit],
        )

    return cache.get_or_set(f"cmc:listings:{limit}", Config.CMC_CACHE_SECONDS, produce)


def global_metrics() -> dict:
    def produce():
        return _fetch(
            "global",
            lambda: _cmc("/v1/global-metrics/quotes/latest", {"convert": "USD"}),
            "global.json",
            _norm_global,
        )

    return cache.get_or_set("cmc:global", Config.CMC_CACHE_SECONDS, produce)


def fear_and_greed() -> dict:
    def produce():
        return _fetch("fear_greed", lambda: _cmc("/v3/fear-and-greed/latest"), "fear_greed.json", _norm_fng)

    return cache.get_or_set("cmc:fng", Config.CMC_CACHE_SECONDS, produce)


def movers(coins: list[dict], n: int = 5) -> dict:
    """Top gainers / losers over 24h, computed from the listings we already have."""
    valid = [c for c in coins if c.get("change_24h") is not None]
    ranked = sorted(valid, key=lambda c: c["change_24h"], reverse=True)
    return {"gainers": ranked[:n], "losers": list(reversed(ranked[-n:]))}
