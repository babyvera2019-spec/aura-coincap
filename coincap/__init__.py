"""AURA CoinCap: a public AI-agent crypto dashboard built on the CoinMarketCap API."""
from __future__ import annotations

import hmac
import logging
from datetime import datetime

from flask import Flask, abort, jsonify, render_template, request

from . import cmc, news, triple_ai
from .config import Config

__version__ = "0.1.0"

# (active key, Flask endpoint, label)
MODULES = [
    ("overview", "overview", "Overview"),
    ("market", "market", "Market"),
    ("news", "news_page", "News"),
    ("triple_ai", "triple_ai_page", "Triple AI"),
]


def _fmt_usd(v, decimals=None):
    if v is None:
        return "—"
    if decimals is None:
        decimals = 2 if abs(v) >= 1 else 4 if abs(v) >= 0.01 else 8
    return f"${v:,.{decimals}f}"


def _fmt_big(v):
    if v is None:
        return "—"
    for unit, size in (("T", 1e12), ("B", 1e9), ("M", 1e6)):
        if abs(v) >= size:
            return f"${v / size:,.2f}{unit}"
    return f"${v:,.0f}"


def _fmt_pct(v):
    return "—" if v is None else f"{v:+.2f}%"


def _fmt_time(v):
    if not v:
        return ""
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00")).strftime("%b %d, %H:%M UTC")
    except ValueError:
        return v


def overview_payload() -> dict:
    listings = cmc.listings(100)
    heads = news.headlines(40)
    return {
        "global": cmc.global_metrics(),
        "fear_greed": cmc.fear_and_greed(),
        "top": listings["data"][:10],
        "movers": cmc.movers(listings["data"], 5),
        "market_source": listings["source"],
        "market_error": listings["error"],
        "headlines": heads["data"][:6],
        "news_sentiment": news.sentiment_summary(heads["data"]),
        "triple_ai": triple_ai.latest(),
    }


def create_app() -> Flask:
    logging.basicConfig(level=logging.INFO)
    app = Flask(__name__)
    app.jinja_env.filters.update(usd=_fmt_usd, big=_fmt_big, pct=_fmt_pct, when=_fmt_time)

    @app.context_processor
    def inject():
        return {
            "modules": MODULES,
            "demo_market": Config.demo_market(),
            "demo_ai": Config.demo_ai(),
            "version": __version__,
        }

    # ------------------------------------------------------------ pages ---
    @app.get("/")
    def overview():
        return render_template("overview.html", active="overview", **overview_payload())

    @app.get("/market")
    def market():
        listings = cmc.listings(100)
        return render_template(
            "market.html",
            active="market",
            coins=listings["data"],
            movers=cmc.movers(listings["data"], 5),
            global_=cmc.global_metrics(),
            source=listings["source"],
            error=listings["error"],
        )

    @app.get("/news")
    def news_page():
        heads = news.headlines(40)
        tag = request.args.get("tag", "")
        items = [h for h in heads["data"] if not tag or h["sentiment"] == tag]
        return render_template(
            "news.html",
            active="news",
            items=items,
            tag=tag,
            counts=news.sentiment_summary(heads["data"]),
            source=heads["source"],
            errors=heads["errors"],
        )

    @app.get("/triple-ai")
    def triple_ai_page():
        return render_template("triple_ai.html", active="triple_ai", run=triple_ai.latest())

    # -------------------------------------------------------------- API ---
    @app.get("/api/overview")
    def api_overview():
        return jsonify(overview_payload())

    @app.get("/api/market")
    def api_market():
        listings = cmc.listings(100)
        return jsonify({**listings, "movers": cmc.movers(listings["data"], 5), "global": cmc.global_metrics()})

    @app.get("/api/news")
    def api_news():
        return jsonify(news.headlines(40))

    @app.get("/api/triple-ai")
    def api_triple_ai():
        return jsonify(triple_ai.latest())

    @app.post("/api/triple-ai/run")
    def api_triple_ai_run():
        token = request.headers.get("X-Admin-Token", "")
        if not Config.ADMIN_TOKEN or not hmac.compare_digest(token, Config.ADMIN_TOKEN):
            abort(403)
        try:
            return jsonify(triple_ai.run_once())
        except triple_ai.RunRefused as exc:
            return jsonify({"refused": str(exc), "budget": triple_ai.budget_status()}), 429

    @app.get("/healthz")
    def healthz():
        return jsonify({"ok": True, "version": __version__, "demo_market": Config.demo_market(), "demo_ai": Config.demo_ai()})

    return app
