# AURA CoinCap

**Three AI agents read the crypto market, so you don't have to.**

AURA CoinCap is a public crypto dashboard built on the **CoinMarketCap API** for the
*Build with CMC: API Hackathon* (track: **AI Agents and Automation**). It runs as a single
**Cloudflare Worker**: live market data, news sentiment and a cross-checked AI market verdict
on one screen, refreshed automatically by cron triggers.

> AI-generated market commentary. Not financial advice. No agent places trades.

## Modules

| Module | What it shows | Data |
|---|---|---|
| **Overview** | Market cap, volume, BTC dominance, Fear & Greed, Triple AI verdict, top 10, headlines, top movers | CMC listings, global metrics, Fear & Greed |
| **Market** | Top 100 coins with 1h / 24h / 7d change, gainers & losers | CMC `/v1/cryptocurrency/listings/latest`, `/v1/global-metrics/quotes/latest` |
| **News** | Latest crypto headlines tagged bullish / bearish / neutral, with filters | Public RSS feeds (title + link only) |
| **Triple AI** | Three agents debate the same market snapshot and vote: OpenAI analyzes, Claude verifies, AURA orchestrates | CMC data + headlines, OpenAI, Claude, AURA rules |
| **Coin analysis** | Pick any of the top 50 non-stablecoins and the three agents analyze that coin on demand | CMC listings (coin row + market context) + headlines that mention the coin |

## How Triple AI works

| Agent | Role | What it does |
|---|---|---|
| **AURA** (transparent rules, no API cost) | Orchestrator | Builds one compact snapshot from CoinMarketCap and the headlines, casts a rules vote, compares the three views and presents the verdict |
| **OpenAI** | Analyst | Independent read for the next 24 hours: trend, volatility, bullish case, bearish case, risks |
| **Claude** | Researcher & Verifier | Checks each analyst claim against the same data, flags claims the data does not support, adds what was missed, gives its own view |

1. **Snapshot** – AURA builds one JSON snapshot from CoinMarketCap: global metrics, Fear & Greed, breadth of
   the top 100, top 10 and top movers (or, for a coin analysis, the coin's price, 1h/24h/7d change, market cap,
   volume and volume-to-market-cap ratio, plus BTC and market context) and the tagged headlines.
2. **Analyst (OpenAI)** returns a bias, confidence, summary, bullish case, bearish case and risks.
3. **Verifier (Claude)** receives the same snapshot *and* the analyst's view and checks it.
4. **AURA rules vote** – market: BTC 24h move, breadth, contrarian Fear & Greed, headline tone;
   coin: the coin's 24h and 7d move, contrarian Fear & Greed, tone of the headlines about that coin.
5. **AURA verdict** – majority of the three votes (`bullish`, `bearish`, `neutral` or `mixed`), the
   **discrepancies** between the agents, and the **level of uncertainty** (low / medium / high, from the
   agreement and the models' confidence).

### Automation, cost and safety

- Cron `*/15 * * * *` refreshes the market snapshot into KV (~3 CMC credits per run), so visitor
  traffic does not spend API credits.
- Cron `7 */3 * * *` runs the whole-market Triple AI every 3 hours.
- Coin analyses are served from a 60-minute cache per coin; new ones are capped per day
  (`AI_COIN_RUNS_PER_DAY`, default 15) and per visitor per hour (`AI_COIN_RUNS_PER_VISITOR_HOUR`, default 3),
  and the form only accepts same-site posts.
- Visitors see the **stored** market run; manual market runs need `POST /api/triple-ai/run` with header `X-Admin-Token`.
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

## CoinMarketCap API usage

| Endpoint | Used for | Credits per call |
|---|---|---|
| `GET /v1/cryptocurrency/listings/latest` (`start=1, limit=100, convert=USD`) | Top 100 table, movers, breadth, coin snapshots for the AI | 1 |
| `GET /v1/global-metrics/quotes/latest` (`convert=USD`) | Total market cap, 24h volume, BTC/ETH dominance | 1 |
| `GET /v3/fear-and-greed/latest` | Fear & Greed index (optional: the rest works without it) | 1 |

The three calls run together every 15 minutes from a cron trigger (about 3 credits per refresh), are stored in
Workers KV and served to every visitor and every AI run from there, so page views never spend credits.
The key is sent only from the Worker in the `X-CMC_PRO_API_KEY` header; it never reaches the browser.

### Evidence of real API calls

Every live call is logged from the `status` block of the CoinMarketCap response (endpoint, HTTP status, CMC
timestamp, `credit_count`, `elapsed`) and published with the snapshot:

- on the **Market** page, in the table *CoinMarketCap API calls behind this snapshot*;
- as JSON at [`/api/cmc-status`](https://aura-coincap.babyvera2019.workers.dev/api/cmc-status);
- inside every Triple AI run (`snapshot.cmc_as_of`, `snapshot.data_source: "coinmarketcap"`).

The call itself (`src/cmc.js`):

```js
const r = await fetch(url, { headers: { "X-CMC_PRO_API_KEY": cfg.cmcKey, Accept: "application/json" } });
let body = null;
try { body = await r.json(); } catch { body = null; }
log.push(callLog(path, r.status, body)); // endpoint, http, cmc_timestamp, error_code, credit_count, elapsed_ms
```

### What the API made possible, and where it got in the way

- **Made possible:** one listings call gives 100 coins with 1h/24h/7d change, market cap and volume, enough to
  build both the dashboard and a compact, factual snapshot for three AI agents. Global metrics and Fear & Greed
  add the market-wide context the agents need, and the `status` block (credits, elapsed time) made it easy to
  prove and budget every call.
- **Got in the way:** credits are the limit, so the design had to separate reads from calls (cron + KV cache)
  instead of calling the API per visitor. Fear & Greed is not guaranteed on every plan, so it is optional.
  The endpoints we used carry no news or per-coin sentiment, so headlines come from public RSS feeds, and without
  historical candles the agents reason on 1h/24h/7d changes rather than full price history.

## JSON API

| Endpoint | Description |
|---|---|
| `GET /api/overview` | Everything on the Overview page |
| `GET /api/market` | Top 100 coins, movers, global metrics |
| `GET /api/news` | Tagged headlines |
| `GET /api/triple-ai` | Latest whole-market Triple AI run + budget status |
| `GET /api/triple-ai/coin?symbol=ETH` | Latest analysis of one coin |
| `GET /api/cmc-status` | The CoinMarketCap calls behind the current snapshot |
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
  triple.js    the three agents (OpenAI analyst, Claude verifier, AURA orchestrator), coin analysis, budget guard
  render.js    HTML pages (all values escaped)
  style.js     styles
  sample/      demo-mode data (illustrative, not real)
test/          offline tests
wrangler.jsonc Cloudflare config (crons, vars, KV binding)
```

## License

Apache License 2.0 – see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Market data © CoinMarketCap, used under its API terms. Headlines link to their original publishers.
