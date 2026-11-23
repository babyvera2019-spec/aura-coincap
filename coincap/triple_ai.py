"""Triple AI: three independent "agents" review the same market snapshot.

1. Claude (Anthropic)  -> Analyst: reads the snapshot and gives a market view.
2. OpenAI              -> Critic: independently reviews the snapshot AND the
                          analyst's view, and challenges it.
3. AURA rules agent    -> Coordinator: a transparent, deterministic rules model
                          on the same CMC data, plus the final vote.

The verdict is the majority of the three votes. No agent places orders; this
is market commentary only, not financial advice.

Cost safety: visitors only ever see the last stored run. A new run needs the
ADMIN_TOKEN, respects a minimum interval, and is refused before any API call if
the estimated cost would exceed the daily or total budget.
"""
from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import cmc, news
from .config import Config
from .http import post_json

SAMPLE = Path(__file__).resolve().parent / "sample_data" / "triple_ai.json"
BIASES = ("bullish", "bearish", "neutral")
_lock = threading.Lock()

DISCLAIMER = "AI-generated market commentary for demonstration only. Not financial advice."

ANALYST_SYSTEM = (
    "You are the Analyst agent of AURA CoinCap, a crypto market dashboard. "
    "You receive a JSON snapshot built from CoinMarketCap data and news headlines. "
    "Give a short, balanced market read for the next 24 hours. Use only the data given; "
    "do not invent numbers. Do not give personal financial advice. "
    'Reply with JSON only: {"bias": "bullish|bearish|neutral", "confidence": 0-100, '
    '"summary": "max 2 sentences", "key_points": ["max 3 short items"], "risks": ["max 3 short items"]}'
)

CRITIC_SYSTEM = (
    "You are the Critic agent of AURA CoinCap. You receive a market snapshot and the Analyst "
    "agent's view. Independently check the view against the data, point out weak reasoning or "
    "missing factors, and give your own bias. Use only the data given; do not invent numbers. "
    'Reply with JSON only: {"agrees": true|false, "bias": "bullish|bearish|neutral", '
    '"confidence": 0-100, "critique": "max 2 sentences", "missing": ["max 3 short items"]}'
)


# ---------------------------------------------------------------- storage ---
def _state_path() -> Path:
    Config.STATE_DIR.mkdir(parents=True, exist_ok=True)
    return Config.STATE_DIR / "triple_ai_state.json"


def load_state() -> dict:
    p = _state_path()
    if p.is_file():
        return json.loads(p.read_text(encoding="utf-8"))
    return {"runs": [], "spend_by_day": {}, "total_spend": 0.0}


def _save_state(state: dict) -> None:
    p = _state_path()
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    tmp.replace(p)


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def budget_status(state: dict | None = None) -> dict:
    state = state or load_state()
    spent_today = state["spend_by_day"].get(_today(), 0.0)
    return {
        "spent_today_usd": round(spent_today, 4),
        "daily_cap_usd": Config.AI_DAILY_BUDGET_USD,
        "spent_total_usd": round(state["total_spend"], 4),
        "total_cap_usd": Config.AI_TOTAL_BUDGET_USD,
    }


# ---------------------------------------------------------------- context ---
def build_snapshot() -> dict:
    coins = cmc.listings(100)["data"]
    g = cmc.global_metrics()["data"]
    fng = cmc.fear_and_greed()["data"]
    heads = news.headlines(15)["data"]
    up = sum(1 for c in coins if (c.get("change_24h") or 0) > 0)
    mv = cmc.movers(coins, 3)

    def slim(c):
        return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in c.items()
                if k in ("symbol", "price", "change_24h", "change_7d")}

    return {
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "global": {k: (round(v, 2) if isinstance(v, float) else v) for k, v in g.items()},
        "fear_and_greed": fng,
        "breadth_top100_up_24h_pct": round(100 * up / len(coins), 1) if coins else None,
        "top10": [slim(c) for c in coins[:10]],
        "top_gainers_24h": [slim(c) for c in mv["gainers"]],
        "top_losers_24h": [slim(c) for c in mv["losers"]],
        "headlines": [{"title": h["title"], "tag": h["sentiment"]} for h in heads],
    }


def rules_vote(snap: dict) -> dict:
    """AURA coordinator's own transparent vote (no API cost)."""
    score, reasons = 0, []
    btc = next((c for c in snap["top10"] if c["symbol"] == "BTC"), None)
    if btc and btc.get("change_24h") is not None:
        if btc["change_24h"] > 1:
            score += 1; reasons.append(f"BTC up {btc['change_24h']:.1f}% in 24h")
        elif btc["change_24h"] < -1:
            score -= 1; reasons.append(f"BTC down {abs(btc['change_24h']):.1f}% in 24h")
    breadth = snap.get("breadth_top100_up_24h_pct")
    if breadth is not None:
        if breadth >= 60:
            score += 1; reasons.append(f"{breadth:.0f}% of top 100 coins are up")
        elif breadth <= 40:
            score -= 1; reasons.append(f"only {breadth:.0f}% of top 100 coins are up")
    fng = (snap.get("fear_and_greed") or {}).get("value")
    if isinstance(fng, (int, float)):
        if fng >= 75:
            score -= 1; reasons.append(f"Fear & Greed {fng} = extreme greed (contrarian caution)")
        elif fng <= 25:
            score += 1; reasons.append(f"Fear & Greed {fng} = extreme fear (contrarian support)")
    tags = [h["tag"] for h in snap.get("headlines", [])]
    if tags:
        net = tags.count("bullish") - tags.count("bearish")
        if net >= 3:
            score += 1; reasons.append("news flow leans positive")
        elif net <= -3:
            score -= 1; reasons.append("news flow leans negative")
    bias = "bullish" if score >= 2 else "bearish" if score <= -2 else "neutral"
    return {"bias": bias, "score": score, "reasons": reasons or ["no strong signal"]}


def consensus(votes: dict[str, str]) -> dict:
    tally = {b: sum(1 for v in votes.values() if v == b) for b in BIASES}
    top = max(tally, key=tally.get)
    if tally[top] >= 2:
        return {"verdict": top, "agreement": f"{tally[top]}/3", "unanimous": tally[top] == 3}
    return {"verdict": "mixed", "agreement": "1/3", "unanimous": False}


# ------------------------------------------------------------ model calls ---
def _extract_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("model did not return JSON")
    data = json.loads(m.group(0))
    if data.get("bias") not in BIASES:
        data["bias"] = "neutral"
    return data


def _cost(tokens_in: int, tokens_out: int, price_in: float, price_out: float) -> float:
    return tokens_in / 1e6 * price_in + tokens_out / 1e6 * price_out


def call_claude(snapshot: dict) -> tuple[dict, float]:
    resp = post_json(
        "https://api.anthropic.com/v1/messages",
        {
            "model": Config.CLAUDE_MODEL,
            "max_tokens": 600,
            "system": ANALYST_SYSTEM,
            "messages": [{"role": "user", "content": json.dumps(snapshot)}],
        },
        headers={"x-api-key": Config.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01"},
    )
    text = "".join(b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text")
    u = resp.get("usage", {})
    cost = _cost(u.get("input_tokens", 0), u.get("output_tokens", 0), Config.CLAUDE_PRICE_IN, Config.CLAUDE_PRICE_OUT)
    return _extract_json(text), cost


def call_openai(snapshot: dict, analyst: dict) -> tuple[dict, float]:
    resp = post_json(
        "https://api.openai.com/v1/chat/completions",
        {
            "model": Config.OPENAI_MODEL,
            "max_tokens": 600,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": CRITIC_SYSTEM},
                {"role": "user", "content": json.dumps({"snapshot": snapshot, "analyst_view": analyst})},
            ],
        },
        headers={"Authorization": f"Bearer {Config.OPENAI_API_KEY}"},
    )
    text = resp["choices"][0]["message"]["content"]
    u = resp.get("usage", {})
    cost = _cost(u.get("prompt_tokens", 0), u.get("completion_tokens", 0), Config.OPENAI_PRICE_IN, Config.OPENAI_PRICE_OUT)
    return _extract_json(text), cost


def _estimate_max_cost(snapshot: dict) -> float:
    approx_in = len(json.dumps(snapshot)) // 3 + 400  # generous chars->tokens estimate
    return _cost(approx_in, 600, Config.CLAUDE_PRICE_IN, Config.CLAUDE_PRICE_OUT) + _cost(
        approx_in * 2, 600, Config.OPENAI_PRICE_IN, Config.OPENAI_PRICE_OUT
    )


# ------------------------------------------------------------------ public ---
class RunRefused(Exception):
    pass


def latest() -> dict:
    state = load_state()
    if state["runs"]:
        run = state["runs"][-1]
    else:
        run = json.loads(SAMPLE.read_text(encoding="utf-8"))
    run = dict(run)
    run["budget"] = budget_status(state)
    run["disclaimer"] = DISCLAIMER
    return run


def run_once() -> dict:
    """Run the three agents once. Raises RunRefused if limits would be broken."""
    if Config.demo_ai():
        raise RunRefused("AI keys are not configured (demo mode)")
    with _lock:
        state = load_state()
        if state["runs"]:
            last = datetime.fromisoformat(state["runs"][-1]["created"])
            wait = timedelta(minutes=Config.AI_MIN_MINUTES_BETWEEN_RUNS)
            if datetime.now(timezone.utc) - last < wait:
                raise RunRefused(f"last run was less than {Config.AI_MIN_MINUTES_BETWEEN_RUNS} min ago")

        snapshot = build_snapshot()
        est = _estimate_max_cost(snapshot)
        b = budget_status(state)
        if b["spent_today_usd"] + est > Config.AI_DAILY_BUDGET_USD:
            raise RunRefused("daily AI budget would be exceeded")
        if b["spent_total_usd"] + est > Config.AI_TOTAL_BUDGET_USD:
            raise RunRefused("total AI budget would be exceeded")

        spent = 0.0
        try:
            analyst, c1 = call_claude(snapshot)
            spent += c1
            critic, c2 = call_openai(snapshot, analyst)
            spent += c2
        finally:
            # Record whatever was actually spent, even if the second call failed.
            day = _today()
            state["spend_by_day"][day] = state["spend_by_day"].get(day, 0.0) + spent
            state["total_spend"] += spent
            _save_state(state)

        coordinator = rules_vote(snapshot)
        votes = {"claude": analyst["bias"], "openai": critic["bias"], "aura": coordinator["bias"]}
        run = {
            "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "mode": "live",
            "models": {"claude": Config.CLAUDE_MODEL, "openai": Config.OPENAI_MODEL, "aura": "rules-v1"},
            "snapshot": snapshot,
            "agents": {"claude": analyst, "openai": critic, "aura": coordinator},
            "votes": votes,
            "consensus": consensus(votes),
            "cost_usd": round(spent, 5),
        }
        state["runs"] = (state["runs"] + [run])[-20:]
        _save_state(state)
        return run
