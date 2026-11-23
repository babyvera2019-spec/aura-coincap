"""Configuration loaded from environment variables (and an optional .env file).

No secret is ever hard-coded. Every key is optional: when a key is missing the
app runs in demo mode with bundled sample data, so the dashboard always works.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader (no extra dependency). Existing env vars win."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


_load_dotenv(ROOT / ".env")


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


class Config:
    # --- CoinMarketCap -----------------------------------------------------
    CMC_API_KEY = os.environ.get("CMC_API_KEY", "")
    CMC_BASE_URL = os.environ.get("CMC_BASE_URL", "https://pro-api.coinmarketcap.com")
    CMC_CACHE_SECONDS = _int("CMC_CACHE_SECONDS", 300)  # protects the free credit quota

    # --- News (public RSS headlines; only title + link are shown) ----------
    NEWS_FEEDS = [
        f.strip()
        for f in os.environ.get(
            "NEWS_FEEDS",
            "https://www.coindesk.com/arc/outboundfeeds/rss/,"
            "https://cointelegraph.com/rss,"
            "https://decrypt.co/feed",
        ).split(",")
        if f.strip()
    ]
    NEWS_CACHE_SECONDS = _int("NEWS_CACHE_SECONDS", 600)

    # --- Triple AI ----------------------------------------------------------
    ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
    CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-5-5")
    OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
    OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

    # Estimated USD prices per million tokens (override if your pricing differs).
    CLAUDE_PRICE_IN = _float("CLAUDE_PRICE_IN_PER_MTOK", 3.0)
    CLAUDE_PRICE_OUT = _float("CLAUDE_PRICE_OUT_PER_MTOK", 15.0)
    OPENAI_PRICE_IN = _float("OPENAI_PRICE_IN_PER_MTOK", 0.15)
    OPENAI_PRICE_OUT = _float("OPENAI_PRICE_OUT_PER_MTOK", 0.60)

    # Hard spending caps. Visitors never trigger paid calls directly.
    AI_DAILY_BUDGET_USD = _float("AI_DAILY_BUDGET_USD", 0.30)
    AI_TOTAL_BUDGET_USD = _float("AI_TOTAL_BUDGET_USD", 10.0)
    AI_MIN_MINUTES_BETWEEN_RUNS = _int("AI_MIN_MINUTES_BETWEEN_RUNS", 30)
    ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")  # required to trigger a new AI run

    # --- Storage --------------------------------------------------------------
    STATE_DIR = Path(os.environ.get("STATE_DIR", ROOT / "instance"))
    HTTP_TIMEOUT = _int("HTTP_TIMEOUT", 20)

    @classmethod
    def demo_market(cls) -> bool:
        return not cls.CMC_API_KEY

    @classmethod
    def demo_ai(cls) -> bool:
        return not (cls.ANTHROPIC_API_KEY and cls.OPENAI_API_KEY)
