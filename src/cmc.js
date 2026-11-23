// CoinMarketCap client: listings, global metrics, Fear & Greed.
// Every live call is logged in market.calls (endpoint, HTTP status, CMC timestamp, credits, elapsed ms)
// so the dashboard can show proof of the real API calls behind each snapshot.
// Builds one "market" object; cached in memory and (if KV is bound) in KV,
// so visitor traffic does not spend CMC credits.
import { LISTINGS, GLOBAL, FEAR_GREED } from "./sample/data.js";

const MEM_TTL_MS = 5 * 60 * 1000;
let memo = null; // { at, value }

const normCoin = (c) => {
  const q = (c.quote && c.quote.USD) || {};
  return {
    rank: c.cmc_rank, name: c.name, symbol: c.symbol, price: q.price ?? null,
    change_1h: q.percent_change_1h ?? null, change_24h: q.percent_change_24h ?? null,
    change_7d: q.percent_change_7d ?? null, market_cap: q.market_cap ?? null, volume_24h: q.volume_24h ?? null,
  };
};

const normGlobal = (d) => {
  const q = (d.quote && d.quote.USD) || {};
  return {
    total_market_cap: q.total_market_cap ?? null,
    total_volume_24h: q.total_volume_24h ?? null,
    market_cap_change_24h: q.total_market_cap_yesterday_percentage_change ?? null,
    btc_dominance: d.btc_dominance ?? null,
    eth_dominance: d.eth_dominance ?? null,
    active_cryptocurrencies: d.active_cryptocurrencies ?? null,
  };
};

const normFng = (d) => ({ value: d.value ?? null, classification: d.value_classification ?? null, updated: d.update_time ?? null });

export function sampleMarket(error = null) {
  return {
    coins: LISTINGS.data.map(normCoin),
    global: normGlobal(GLOBAL.data),
    fear_greed: normFng(FEAR_GREED.data),
    source: "demo-sample",
    as_of: null,
    calls: [],
    error,
  };
}

const callLog = (path, http, body) => {
  const st = (body && body.status) || {};
  return { endpoint: path, http, cmc_timestamp: st.timestamp ?? null, error_code: st.error_code ?? null, credit_count: st.credit_count ?? null, elapsed_ms: st.elapsed ?? null };
};

async function cmcGet(cfg, path, params = {}, log = []) {
  const url = new URL(cfg.cmcBase + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { "X-CMC_PRO_API_KEY": cfg.cmcKey, Accept: "application/json" } });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  log.push(callLog(path, r.status, body));
  if (!r.ok) throw new Error(`CMC ${path} HTTP ${r.status}`);
  return body;
}

// Live fetch from CMC (3 credits). Fear & Greed is optional: if the plan
// does not include it, the rest still works.
export async function fetchMarket(cfg) {
  const log = [];
  const [listings, glob, fng] = await Promise.allSettled([
    cmcGet(cfg, "/v1/cryptocurrency/listings/latest", { start: 1, limit: 100, convert: "USD" }, log),
    cmcGet(cfg, "/v1/global-metrics/quotes/latest", { convert: "USD" }, log),
    cmcGet(cfg, "/v3/fear-and-greed/latest", {}, log),
  ]);
  if (listings.status !== "fulfilled") throw listings.reason;
  return {
    coins: listings.value.data.map(normCoin),
    global: glob.status === "fulfilled" ? normGlobal(glob.value.data) : normGlobal({}),
    fear_greed: fng.status === "fulfilled" ? normFng(fng.value.data) : normFng({}),
    source: "coinmarketcap",
    as_of: new Date().toISOString(),
    calls: log,
    error: null,
  };
}

// Called by the cron trigger: refresh and store in KV.
export async function refreshMarket(cfg) {
  const m = await fetchMarket(cfg);
  memo = { at: Date.now(), value: m };
  if (cfg.kv) await cfg.kv.put("market", JSON.stringify(m));
  return m;
}

// Called by pages: KV first (cron keeps it fresh), else in-memory, else live.
export async function getMarket(cfg) {
  if (cfg.demoMarket) return sampleMarket();
  if (memo && Date.now() - memo.at < MEM_TTL_MS) return memo.value;
  try {
    if (cfg.kv) {
      const stored = await cfg.kv.get("market", "json");
      if (stored && Date.now() - Date.parse(stored.as_of) < 30 * 60 * 1000) {
        memo = { at: Date.now(), value: stored };
        return stored;
      }
    }
    return await refreshMarket(cfg);
  } catch (e) {
    return sampleMarket(`CoinMarketCap unavailable (${e.message}); showing sample data`);
  }
}

export function movers(coins, n = 5) {
  const valid = coins.filter((c) => typeof c.change_24h === "number");
  const ranked = [...valid].sort((a, b) => b.change_24h - a.change_24h);
  return { gainers: ranked.slice(0, n), losers: ranked.slice(-n).reverse() };
}

export function _resetMemo() { memo = null; }
