# AURA CoinCap

**Three AI agents read the crypto market, so you don't have to.**

AURA CoinCap is a public crypto dashboard built on the **CoinMarketCap API** for the
*Build with CMC: API Hackathon* (track: **AI Agents and Automation**). It runs as a single
**Cloudflare Worker**: live market data, news sentiment and a cross-checked AI market verdict
on one screen, refreshed automatically by cron triggers.

> AI-generated commentary for demonstration only. Not financial advice. No agent places trades.

## Modules

| Module | What it shows | Data |
|---|---|---|
| **Overview** | Market cap, volume, BTC dominance, Fear & Greed, Triple AI verdict, top 10, headlines, top movers | CMC listings, global metrics, Fear & Greed |
| **Market** | Top 100 coins with 1h / 24h / 7d change, gainers & losers | CMC `/v1/cryptocurrency/listings/latest`, `/v1/global-metrics/quotes/latest` |
| **News** | Latest crypto headlines tagged bullish / bearish / neutral, with filters | Public RSS feeds (title + link only) |
| **Triple AI** | Three agents debate the same market snapshot and vote | CMC data + headlines, Claude, OpenAI, AURA rules |

## How Triple AI works

1. **Snapshot** – one compact JSON snapshot from CoinMarketCap (global metrics, Fear & Greed,
   top 10, breadth of the top 100, top movers) plus tagged headlines.
2. **Analyst (Claude)** – returns a bias, confidence, key points and risks.
3. **Critic (OpenAI)** – independently checks the snapshot *and* the analyst's view.
4. **Coordinator (AURA rules)** – a transparent rule model on the same data (BTC 24h move,
   market breadth, contrarian Fear & Greed, headline tone) casts the third vote.
5. **Verdict** – majority of the three votes (`bullish`, `bearish`, `neutral` or `mixed`).

### Automation, cost and safety

- Cron `*/15 * * * *` refreshes the market snapshot into KV (~3 CMC credits per run), so visitor
  traffic does not spend API credits.
- Cron `7 */3 * * *` runs Triple AI every 3 hours.
- Visitors only see the **stored** last run; they cannot trigger paid AI calls.
  Manual runs: `POST /api/triple-ai/run` with header `X-Admin-Token`.
- A run is **refused before any AI call** if KV storage is missing, live CMC data is
  unavailable, it is too soon after the last run, or its estimated cost would exceed the daily
  (`AI_DAILY_BUDGET_USD`) or total (`AI_TOTAL_BUDGET_USD`) budget.
- Secrets live only in Cloudflare (encrypted), never in this repository.
- Without keys the Worker runs in **demo mode** with clearly labelled sample data.

## Deploy on Cloudflare (free plan)

1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick this repo.
   Deploy command: `npx wrangler deploy` (default).
2. Worker → **Settings → Variables and Secrets** → add as **Secret**:
   `CMC_API_KEY` (then later `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ADMIN_TOKEN`).
3. For Triple AI storage: **Storage & Databases → KV → Create** a namespace, paste its ID in
   `wrangler.jsonc` under `kv_namespaces` with binding `STATE`, and push.

Non-secret settings (models, budgets, prices) are in `wrangler.jsonc` → `vars`.

## JSON API

| Endpoint | Description |
|---|---|
| `GET /api/overview` | Everything on the Overview page |
| `GET /api/market` | Top 100 coins, movers, global metrics |
| `GET /api/news` | Tagged headlines |
| `GET /api/triple-ai` | Latest Triple AI run + budget status |
| `POST /api/triple-ai/run` | New run (needs `X-Admin-Token`) |
| `GET /healthz` | Health, mode and storage status |

## Develop and test

```bash
npm test            # offline tests (Node 18+, no dependencies)
npx wrangler dev    # local Worker at http://localhost:8787
```

## Project layout

```
src/
  index.js     Worker entry: routes, JSON API, cron handlers
  config.js    settings from vars + secrets
  cmc.js       CoinMarketCap client (KV + memory cache, sample fallback)
  news.js      RSS headlines + keyword sentiment
  triple.js    the three agents, consensus and budget guard
  render.js    HTML pages (all values escaped)
  style.js     styles
  sample/      demo-mode data (illustrative, not real)
test/          offline tests
wrangler.jsonc Cloudflare config (crons, vars, KV binding)
```

## License

Apache License 2.0 – see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Market data © CoinMarketCap, used under its API terms. Headlines link to their original publishers.
