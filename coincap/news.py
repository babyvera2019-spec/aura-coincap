"""Crypto news headlines from public RSS feeds, tagged with a simple sentiment.

Only the headline, source, time and link are shown (we never republish article
bodies). Sentiment is a transparent keyword score; the Triple AI module gives
the deeper, AI-written interpretation.
"""
from __future__ import annotations

import json
import logging
import re
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlparse

from .config import Config
from .http import cache, get_bytes

log = logging.getLogger(__name__)
SAMPLE = Path(__file__).resolve().parent / "sample_data" / "news.json"

BULLISH = {
    "surge", "surges", "rally", "rallies", "soar", "soars", "jump", "jumps", "gain", "gains",
    "record", "high", "approval", "approved", "inflow", "inflows", "adoption", "bullish",
    "rebound", "rebounds", "breakout", "upgrade", "launch", "launches", "partnership", "buy",
}
BEARISH = {
    "crash", "crashes", "plunge", "plunges", "drop", "drops", "fall", "falls", "slump",
    "hack", "hacked", "exploit", "lawsuit", "sues", "ban", "outflow", "outflows", "bearish",
    "liquidation", "liquidations", "selloff", "sell-off", "fraud", "low", "decline", "declines",
    "delay", "delays", "reject", "rejects", "rejected", "fine", "fined",
}
WORD = re.compile(r"[a-z][a-z\-]+")


def sentiment(title: str) -> str:
    words = WORD.findall(title.lower())
    score = sum(w in BULLISH for w in words) - sum(w in BEARISH for w in words)
    return "bullish" if score > 0 else "bearish" if score < 0 else "neutral"


def _text(el, tag: str) -> str:
    found = el.find(tag)
    return (found.text or "").strip() if found is not None and found.text else ""


def parse_feed(xml_bytes: bytes, fallback_source: str) -> list[dict]:
    root = ET.fromstring(xml_bytes)
    channel_title = _text(root.find("channel"), "title") if root.find("channel") is not None else ""
    items = []
    for it in root.iter("item"):
        title = _text(it, "title")
        link = _text(it, "link")
        if not title or not link:
            continue
        published = None
        pub = _text(it, "pubDate")
        if pub:
            try:
                published = parsedate_to_datetime(pub).isoformat()
            except (TypeError, ValueError):
                published = None
        items.append(
            {
                "title": title,
                "link": link,
                "source": channel_title or fallback_source,
                "published": published,
                "sentiment": sentiment(title),
            }
        )
    return items


def _demo() -> dict:
    data = json.loads(SAMPLE.read_text(encoding="utf-8"))["data"]
    for item in data:
        item["sentiment"] = sentiment(item["title"])
    return {"data": data, "source": "demo-sample", "errors": []}


def headlines(limit: int = 40) -> dict:
    def produce():
        items, errors = [], []
        for url in Config.NEWS_FEEDS:
            host = urlparse(url).netloc
            try:
                items.extend(parse_feed(get_bytes(url, timeout=Config.HTTP_TIMEOUT), host))
            except Exception as exc:
                log.warning("feed %s failed: %s", url, exc)
                errors.append(f"{host}: {type(exc).__name__}")
        if not items:
            demo = _demo()
            demo["errors"] = errors
            return demo
        seen, unique = set(), []
        for item in sorted(items, key=lambda i: i["published"] or "", reverse=True):
            key = item["title"].lower()
            if key not in seen:
                seen.add(key)
                unique.append(item)
        return {"data": unique[:limit], "source": "rss", "errors": errors}

    return cache.get_or_set(f"news:{limit}", Config.NEWS_CACHE_SECONDS, produce)


def sentiment_summary(items: list[dict]) -> dict:
    counts = {"bullish": 0, "bearish": 0, "neutral": 0}
    for i in items:
        counts[i["sentiment"]] += 1
    return counts
