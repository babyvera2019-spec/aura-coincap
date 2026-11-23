"""Smoke tests that run fully offline (demo mode, no API keys, no network)."""
import os

os.environ["CMC_API_KEY"] = ""
os.environ["ANTHROPIC_API_KEY"] = ""
os.environ["OPENAI_API_KEY"] = ""
os.environ["NEWS_FEEDS"] = "http://127.0.0.1:9/unreachable"  # forces the sample headlines
os.environ["HTTP_TIMEOUT"] = "1"

import pytest  # noqa: E402

from coincap import cmc, create_app, news, triple_ai  # noqa: E402
from coincap.config import Config  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(Config, "STATE_DIR", tmp_path)
    monkeypatch.setattr(Config, "ADMIN_TOKEN", "secret")
    return create_app().test_client()


@pytest.mark.parametrize("path", ["/", "/market", "/news", "/news?tag=bearish", "/triple-ai"])
def test_pages_render(client, path):
    r = client.get(path)
    assert r.status_code == 200
    assert b"AURA" in r.data and b"Not financial advice" in r.data


@pytest.mark.parametrize("path", ["/api/overview", "/api/market", "/api/news", "/api/triple-ai", "/healthz"])
def test_api(client, path):
    r = client.get(path)
    assert r.status_code == 200
    assert r.is_json


def test_run_requires_token(client):
    assert client.post("/api/triple-ai/run").status_code == 403
    assert client.post("/api/triple-ai/run", headers={"X-Admin-Token": "wrong"}).status_code == 403


def test_run_refused_in_demo(client):
    r = client.post("/api/triple-ai/run", headers={"X-Admin-Token": "secret"})
    assert r.status_code == 429 and "demo" in r.get_json()["refused"]


def test_sentiment():
    assert news.sentiment("Bitcoin surges to record high") == "bullish"
    assert news.sentiment("Exchange hacked, prices plunge") == "bearish"
    assert news.sentiment("Fed meeting on Wednesday") == "neutral"


def test_consensus():
    assert triple_ai.consensus({"a": "bullish", "b": "bullish", "c": "bearish"})["verdict"] == "bullish"
    assert triple_ai.consensus({"a": "bullish", "b": "neutral", "c": "bearish"})["verdict"] == "mixed"
    assert triple_ai.consensus({"a": "bearish", "b": "bearish", "c": "bearish"})["unanimous"]


def test_rules_vote_on_sample():
    vote = triple_ai.rules_vote(triple_ai.build_snapshot())
    assert vote["bias"] in ("bullish", "bearish", "neutral") and vote["reasons"]


def test_movers():
    m = cmc.movers(cmc.listings(100)["data"], 5)
    assert len(m["gainers"]) == 5 and m["gainers"][0]["change_24h"] >= m["losers"][0]["change_24h"]


def test_budget_blocks_before_spending(tmp_path, monkeypatch):
    monkeypatch.setattr(Config, "STATE_DIR", tmp_path)
    monkeypatch.setattr(Config, "ANTHROPIC_API_KEY", "x")
    monkeypatch.setattr(Config, "OPENAI_API_KEY", "x")
    monkeypatch.setattr(Config, "AI_DAILY_BUDGET_USD", 0.0)
    called = []
    monkeypatch.setattr(triple_ai, "call_claude", lambda *a: called.append(1))
    with pytest.raises(triple_ai.RunRefused):
        triple_ai.run_once()
    assert not called  # no paid API call was attempted


def test_live_run_records_cost(tmp_path, monkeypatch):
    monkeypatch.setattr(Config, "STATE_DIR", tmp_path)
    monkeypatch.setattr(Config, "ANTHROPIC_API_KEY", "x")
    monkeypatch.setattr(Config, "OPENAI_API_KEY", "x")
    monkeypatch.setattr(triple_ai, "call_claude", lambda s: ({"bias": "bullish", "confidence": 60, "summary": "s"}, 0.01))
    monkeypatch.setattr(triple_ai, "call_openai", lambda s, a: ({"bias": "bullish", "agrees": True, "confidence": 55, "critique": "c"}, 0.002))
    run = triple_ai.run_once()
    assert run["consensus"]["verdict"] in ("bullish", "mixed")
    assert abs(triple_ai.budget_status()["spent_total_usd"] - 0.012) < 1e-9
    with pytest.raises(triple_ai.RunRefused):  # minimum interval between runs
        triple_ai.run_once()
