# AURA CoinCap

**Three AI agents read the crypto market, so you don't have to.**

AURA CoinCap is a public crypto dashboard built on the **CoinMarketCap API** for the
*Build with CMC: API Hackathon* (track: **AI Agents and Automation**). It puts live market
data, news sentiment and a cross-checked AI market verdict on one screen.

> AI-generated commentary for demonstration only. Not financial advice. No agent places trades.

## Modules

| Module | What it shows | Data |
|---|---|---|
| **Overview** | Market cap, volume, BTC dominance, Fear & Greed, Triple AI verdict, top 10, headlines, top movers | CMC listings, global metrics, Fear & Greed |
| **Market** | Top 100 coins with 1h / 24h / 7d change, gainers & losers | CMC `/v1/cryptocurrency/listings/latest`, `/v1/global-metrics/quotes/latest` |
| **News** | Latest crypto headlines tagged bullish / bearish / neutral, with filters | Public RSS feeds (title + link only) |
| **Triple AI** | Three agents debate the same market snapshot and vote | CMC data + headlines, Claude, OpenAI, AURA rules |

## How Triple AI works

1. **Snapshot** – the app builds one compact JSON snapshot from CoinMarketCap (global metrics,
   Fear & Greed, top 10, breadth of the top 100, top movers) plus tagged headlines.
2. **Analyst (Claude)** – reads the snapshot and returns a bias, confidence, key points and risks.
3. **Critic (OpenAI)** – independently checks the snapshot *and* the analyst's view, and says
   what was missed or overstated.
4. **Coordinator (AURA rules)** – a transparent, deterministic rule model on the same data
   (BTC 24h move, market breadth, contrarian Fear & Greed, headline tone) casts the third vote.
5. **Verdict** – majority of the three votes (`bullish`, `bearish`, `neutral`, or `mixed`).

### Cost and safety controls

- Visitors only ever see the **stored** last run; they cannot trigger paid AI calls.
- New runs come from a schedule (`python -m coincap.run_ai`) or `POST /api/triple-ai/run`
  with the `X-Admin-Token` header.
- Each run is **refused before any API call** if its estimated cost would exceed the daily
  (`AI_DAILY_BUDGET_USD`) or total (`AI_TOTAL_BUDGET_USD`) budget, or if it comes too soon
  after the previous run (`AI_MIN_MINUTES_BETWEEN_RUNS`).
- CoinMarketCap and news responses are cached (5 and 10 minutes by default), so traffic does not
  burn API credits.
- No secrets in the repository: keys live in `.env`, which is git-ignored.

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # optional: add your keys
python run.py               # http://127.0.0.1:5000
```

Without any keys the app runs in **demo mode** with clearly labelled sample data, so it always
works. Add `CMC_API_KEY` for live market data, and `ANTHROPIC_API_KEY` + `OPENAI_API_KEY` +
`ADMIN_TOKEN` for live Triple AI runs:

```bash
python -m coincap.run_ai    # one Triple AI run (respects all limits)
```

## JSON API

| Endpoint | Description |
|---|---|
| `GET /api/overview` | Everything on the Overview page |
| `GET /api/market` | Top 100 coins, movers, global metrics |
| `GET /api/news` | Tagged headlines |
| `GET /api/triple-ai` | Latest Triple AI run + budget status |
| `POST /api/triple-ai/run` | New run (needs `X-Admin-Token`) |
| `GET /healthz` | Health and mode |

## Tests

```bash
pip install pytest && python -m pytest -q
```

The tests run fully offline in demo mode.

## Project layout

```
coincap/
  __init__.py     Flask app, pages and JSON API
  config.py       settings from environment / .env
  cmc.py          CoinMarketCap client (cached, with sample-data fallback)
  news.py         RSS headlines + keyword sentiment
  triple_ai.py    the three agents, consensus and budget guard
  run_ai.py       scheduled run entry point
  templates/      pages
  static/         styles
  sample_data/    demo-mode data (illustrative, not real)
tests/            offline tests
```

## License

Apache License 2.0 – see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Market data © CoinMarketCap, used under its API terms. Headlines link to their original publishers.
