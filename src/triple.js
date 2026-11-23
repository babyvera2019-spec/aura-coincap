// Triple AI: three independent agents review the same CoinMarketCap snapshot.
//   1. OpenAI   -> Analyst: independent read of trend, volatility, bull case, bear case and risks
//   2. Claude   -> Researcher & Verifier: checks every claim of the analyst against the data and gives its own view
//   3. AURA     -> Orchestrator: builds the snapshot, casts a transparent rules vote, compares the three views
//                  and presents the verdict, the discrepancies and the level of uncertainty (no API cost)
// Market commentary only; no agent can trade.
//
// Two kinds of run:
//   - market run: whole-market snapshot, every 3 hours by cron (or admin token)
//   - coin run:   one coin chosen by a visitor (top 100 by market cap), served from a 60-minute cache,
//                 with a daily cap on new coin runs and a per-visitor hourly limit
// Cost safety: every run needs KV storage (to track spend) and is refused BEFORE any API call
// if its estimated cost would exceed the daily or total budget.
import { TRIPLE_AI } from "./sample/data.js";
import { getMarket, movers } from "./cmc.js";
import { getNews } from "./news.js";

export const DISCLAIMER = "AI-generated market commentary. Not financial advice. No agent places trades.";
const BIASES = ["bullish", "bearish", "neutral"];
const MAX_TOKENS = 700;
export const ROLES = { analyst: "openai", verifier: "claude", orchestrator: "aura" };
const LEGACY_ROLES = { analyst: "claude", verifier: "openai", orchestrator: "aura" }; // runs stored before 2026-11-23
const STABLES = new Set(["USDT", "USDC", "DAI", "FDUSD", "USDE", "TUSD", "PYUSD", "USDD", "USD1", "BUSD", "USDS", "USDG", "RLUSD"]);

const ANALYST_SYSTEM =
  "You are the Analyst agent of AURA CoinCap, a crypto market dashboard. You receive a JSON snapshot built " +
  "from CoinMarketCap data and news headlines. FOCUS. Give an independent, balanced read for the next 24 hours: " +
  "trend, volatility, the bullish case, the bearish case and the main risks. Use only the data given; do not invent " +
  "numbers or events. Do not give personal financial advice. Reply with JSON only: " +
  '{"bias": "bullish|bearish|neutral", "confidence": 0-100, "summary": "max 2 sentences", ' +
  '"bull_case": ["max 3 short items"], "bear_case": ["max 3 short items"], "risks": ["max 3 short items"]}';

const VERIFIER_SYSTEM =
  "You are the Researcher & Verifier agent of AURA CoinCap. You receive a market snapshot built from " +
  "CoinMarketCap data and the Analyst agent's view. FOCUS. Check each claim of the analyst against the data: " +
  "flag claims the data does not support, add important factors the analyst missed, and give your own independent " +
  "bias. Use only the data given; do not invent numbers or events. Reply with JSON only: " +
  '{"agrees": true|false, "bias": "bullish|bearish|neutral", "confidence": 0-100, ' +
  '"verification": "max 2 sentences", "unsupported_claims": ["max 3 short items"], "missing": ["max 3 short items"]}';

export class RunRefused extends Error {
  constructor(message, code = "refused") { super(message); this.code = code; }
}

const today = () => new Date().toISOString().slice(0, 10);
const round = (v, d) => (typeof v === "number" ? Number(v.toFixed(d)) : v);

// ------------------------------------------------------------- storage ---
export async function loadState(cfg) {
  const empty = { runs: [], coin_runs: {}, coin_count_by_day: {}, spend_by_day: {}, total_spend: 0 };
  if (!cfg.kv) return empty;
  const s = (await cfg.kv.get("triple_state", "json")) || empty;
  return { ...empty, ...s };
}

const saveState = (cfg, state) => cfg.kv.put("triple_state", JSON.stringify(state));

export function budgetStatus(cfg, state) {
  return {
    spent_today_usd: round(state.spend_by_day[today()] || 0, 4),
    daily_cap_usd: cfg.dailyBudget,
    spent_total_usd: round(state.total_spend, 4),
    total_cap_usd: cfg.totalBudget,
    coin_runs_today: state.coin_count_by_day[today()] || 0,
    coin_runs_daily_cap: cfg.coinRunsPerDay,
  };
}

// ----------------------------------------------------------- snapshots ---
const slim = (c) => ({ rank: c.rank, symbol: c.symbol, price: round(c.price, 6), change_1h: round(c.change_1h, 2), change_24h: round(c.change_24h, 2), change_7d: round(c.change_7d, 2) });

function marketContext(market) {
  const coins = market.coins;
  const up = coins.filter((c) => (c.change_24h || 0) > 0).length;
  return {
    data_source: market.source,
    cmc_as_of: market.as_of,
    global: Object.fromEntries(Object.entries(market.global).map(([k, v]) => [k, round(v, 2)])),
    fear_and_greed: market.fear_greed,
    breadth_top100_up_24h_pct: coins.length ? round((100 * up) / coins.length, 1) : null,
  };
}

export async function buildSnapshot(cfg) {
  const market = await getMarket(cfg);
  const news = await getNews(cfg, 15);
  const mv = movers(market.coins, 3);
  return {
    as_of: new Date().toISOString(),
    ...marketContext(market),
    top10: market.coins.slice(0, 10).map(slim),
    top_gainers_24h: mv.gainers.map(slim),
    top_losers_24h: mv.losers.map(slim),
    headlines: news.items.slice(0, 15).map((h) => ({ title: h.title, tag: h.sentiment })),
  };
}

const mentions = (title, coin) => {
  const t = title.toLowerCase();
  const words = [coin.symbol.toLowerCase(), coin.name.toLowerCase()].filter((w) => w.length >= 3);
  return words.some((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(t));
};

export async function buildCoinSnapshot(cfg, symbol) {
  const market = await getMarket(cfg);
  const coin = market.coins.find((c) => c.symbol === symbol);
  if (!coin) throw new RunRefused(`${symbol} is not in the CoinMarketCap top 100 right now`, "unknown_coin");
  const news = await getNews(cfg, 40);
  const btc = market.coins.find((c) => c.symbol === "BTC");
  const coinNews = news.items.filter((h) => mentions(h.title, coin)).slice(0, 10);
  return {
    as_of: new Date().toISOString(),
    focus: symbol,
    coin: { ...slim(coin), name: coin.name, market_cap: round(coin.market_cap, 0), volume_24h: round(coin.volume_24h, 0),
      volume_to_market_cap: coin.market_cap ? round(coin.volume_24h / coin.market_cap, 4) : null },
    btc: btc ? slim(btc) : null,
    ...marketContext(market),
    coin_headlines: coinNews.map((h) => ({ title: h.title, tag: h.sentiment })),
    market_headlines: news.items.slice(0, 8).map((h) => ({ title: h.title, tag: h.sentiment })),
  };
}

// ---------------------------------------------------- AURA rules votes ---
function vote(score, reasons) {
  const bias = score >= 2 ? "bullish" : score <= -2 ? "bearish" : "neutral";
  return { bias, score, reasons: reasons.length ? reasons : ["no strong signal"] };
}

function fngRule(snap, add) {
  const f = snap.fear_and_greed && snap.fear_and_greed.value;
  if (typeof f !== "number") return;
  if (f >= 75) add(-1, `Fear & Greed ${f} = extreme greed (contrarian caution)`);
  else if (f <= 25) add(1, `Fear & Greed ${f} = extreme fear (contrarian support)`);
}

export function rulesVote(snap) {
  let score = 0; const reasons = []; const add = (s, r) => { score += s; reasons.push(r); };
  const btc = snap.top10.find((c) => c.symbol === "BTC");
  if (btc && typeof btc.change_24h === "number") {
    if (btc.change_24h > 1) add(1, `BTC up ${btc.change_24h.toFixed(1)}% in 24h`);
    else if (btc.change_24h < -1) add(-1, `BTC down ${Math.abs(btc.change_24h).toFixed(1)}% in 24h`);
  }
  const b = snap.breadth_top100_up_24h_pct;
  if (typeof b === "number") {
    if (b >= 60) add(1, `${Math.round(b)}% of top 100 coins are up`);
    else if (b <= 40) add(-1, `only ${Math.round(b)}% of top 100 coins are up`);
  }
  fngRule(snap, add);
  const tags = snap.headlines.map((h) => h.tag);
  const net = tags.filter((t) => t === "bullish").length - tags.filter((t) => t === "bearish").length;
  if (net >= 3) add(1, "news flow leans positive");
  else if (net <= -3) add(-1, "news flow leans negative");
  return vote(score, reasons);
}

export function rulesVoteCoin(snap) {
  let score = 0; const reasons = []; const add = (s, r) => { score += s; reasons.push(r); };
  const c = snap.coin;
  if (typeof c.change_24h === "number") {
    if (c.change_24h > 2) add(1, `${c.symbol} up ${c.change_24h.toFixed(1)}% in 24h`);
    else if (c.change_24h < -2) add(-1, `${c.symbol} down ${Math.abs(c.change_24h).toFixed(1)}% in 24h`);
  }
  if (typeof c.change_7d === "number") {
    if (c.change_7d > 5) add(1, `${c.symbol} up ${c.change_7d.toFixed(1)}% in 7 days`);
    else if (c.change_7d < -5) add(-1, `${c.symbol} down ${Math.abs(c.change_7d).toFixed(1)}% in 7 days`);
  }
  fngRule(snap, add);
  const tags = snap.coin_headlines.map((h) => h.tag);
  const net = tags.filter((t) => t === "bullish").length - tags.filter((t) => t === "bearish").length;
  if (net >= 2) add(1, `headlines about ${c.symbol} lean positive`);
  else if (net <= -2) add(-1, `headlines about ${c.symbol} lean negative`);
  return vote(score, reasons);
}

export function consensus(votes) {
  const tally = Object.fromEntries(BIASES.map((b) => [b, Object.values(votes).filter((v) => v === b).length]));
  const top = BIASES.reduce((a, b) => (tally[b] > tally[a] ? b : a));
  if (tally[top] >= 2) return { verdict: top, agreement: `${tally[top]}/3`, unanimous: tally[top] === 3 };
  return { verdict: "mixed", agreement: "1/3", unanimous: false };
}

// ------------------------------------------- AURA orchestrator synthesis ---
const NAMES = { openai: "OpenAI", claude: "Claude", aura: "AURA" };

export function rolesOf(run) { return run.roles || LEGACY_ROLES; }

export function synthesize(run) {
  if (run.synthesis) return run.synthesis;
  const roles = rolesOf(run);
  const an = run.agents[roles.analyst] || {}, ve = run.agents[roles.verifier] || {}, au = run.agents[roles.orchestrator] || {};
  const c = run.consensus;
  const confs = [an.confidence, ve.confidence].filter((x) => typeof x === "number");
  const avg = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 50;
  const uncertainty = c.verdict === "mixed" || avg < 50 ? "high" : c.unanimous && avg >= 65 ? "low" : "medium";
  const discrepancies = [];
  if (an.bias && ve.bias && an.bias !== ve.bias) discrepancies.push(`Analyst (${NAMES[roles.analyst]}) reads ${an.bias}; verifier (${NAMES[roles.verifier]}) reads ${ve.bias}.`);
  if (au.bias && c.verdict !== "mixed" && au.bias !== c.verdict) discrepancies.push(`AURA's rules vote (${au.bias}) goes against the majority.`);
  for (const x of (ve.unsupported_claims || []).slice(0, 2)) discrepancies.push(`Not supported by the data: ${x}`);
  const conclusion = c.verdict === "mixed"
    ? "No majority: the three views disagree, so there is no clear direction in this data."
    : `Majority ${c.verdict} (${c.agreement})${c.unanimous ? ", all three agents agree" : ""}.`;
  return { uncertainty, discrepancies, conclusion, avg_confidence: Math.round(avg) };
}

// --------------------------------------------------------- model calls ---
export function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("model did not return JSON");
  const data = JSON.parse(m[0]);
  if (!BIASES.includes(data.bias)) data.bias = "neutral";
  return data;
}

const cost = (tin, tout, pin, pout) => (tin / 1e6) * pin + (tout / 1e6) * pout;

async function postJson(url, body, headers) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return r.json();
}

const focusText = (snapshot) => (snapshot.focus
  ? `This run is about ${snapshot.focus}; the market data is context`
  : "This run is about the overall crypto market");

export const api = {
  async openai(cfg, snapshot) {
    const resp = await postJson("https://api.openai.com/v1/chat/completions", {
      model: cfg.openaiModel, max_tokens: MAX_TOKENS, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: ANALYST_SYSTEM.replace("FOCUS", focusText(snapshot)) },
        { role: "user", content: JSON.stringify(snapshot) },
      ],
    }, { Authorization: `Bearer ${cfg.openaiKey}` });
    const u = resp.usage || {};
    return [extractJson(resp.choices[0].message.content), cost(u.prompt_tokens || 0, u.completion_tokens || 0, cfg.openaiIn, cfg.openaiOut)];
  },
  async claude(cfg, snapshot, analyst) {
    const resp = await postJson("https://api.anthropic.com/v1/messages", {
      model: cfg.claudeModel, max_tokens: MAX_TOKENS, system: VERIFIER_SYSTEM.replace("FOCUS", focusText(snapshot)),
      messages: [{ role: "user", content: JSON.stringify({ snapshot, analyst_view: analyst }) }],
    }, { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01" });
    const text = (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const u = resp.usage || {};
    return [extractJson(text), cost(u.input_tokens || 0, u.output_tokens || 0, cfg.claudeIn, cfg.claudeOut)];
  },
};

function estimateMaxCost(cfg, snapshot) {
  const approxIn = Math.ceil(JSON.stringify(snapshot).length / 3) + 500;
  return cost(approxIn, MAX_TOKENS, cfg.openaiIn, cfg.openaiOut) + cost(approxIn + 800, MAX_TOKENS, cfg.claudeIn, cfg.claudeOut);
}

function checkBasics(cfg) {
  if (cfg.demoAi) throw new RunRefused("AI keys are not configured (demo mode)", "demo");
  if (!cfg.kv) throw new RunRefused("KV storage (STATE) is not connected, so spend cannot be tracked", "no_storage");
}

function checkBudget(cfg, state, snapshot) {
  if (snapshot.data_source !== "coinmarketcap") throw new RunRefused("live CoinMarketCap data is not available", "no_data");
  const est = estimateMaxCost(cfg, snapshot);
  const b = budgetStatus(cfg, state);
  if (b.spent_today_usd + est > cfg.dailyBudget) throw new RunRefused("daily AI budget would be exceeded", "budget");
  if (b.spent_total_usd + est > cfg.totalBudget) throw new RunRefused("total AI budget would be exceeded", "budget");
}

// Runs the three agents on one snapshot and records the spend (even if a call fails).
async function pipeline(cfg, state, snapshot, rules, extra) {
  let spent = 0, analyst, verifier;
  try {
    let c;
    [analyst, c] = await api.openai(cfg, snapshot);
    spent += c;
    [verifier, c] = await api.claude(cfg, snapshot, analyst);
    spent += c;
  } finally {
    const d = today();
    state.spend_by_day[d] = (state.spend_by_day[d] || 0) + spent;
    state.total_spend += spent;
    for (const k of Object.keys(state.spend_by_day).sort().slice(0, -31)) delete state.spend_by_day[k];
    await saveState(cfg, state);
  }
  const votes = { openai: analyst.bias, claude: verifier.bias, aura: rules.bias };
  const run = {
    created: new Date().toISOString(), mode: "live", ...extra, roles: ROLES,
    models: { openai: cfg.openaiModel, claude: cfg.claudeModel, aura: "rules-v1" },
    snapshot, agents: { openai: analyst, claude: verifier, aura: rules }, votes,
    consensus: consensus(votes), cost_usd: round(spent, 5),
  };
  run.synthesis = synthesize(run);
  return run;
}

// --------------------------------------------------------------- public ---
export async function latest(cfg) {
  const state = await loadState(cfg);
  const run = state.runs.length ? state.runs[state.runs.length - 1] : TRIPLE_AI;
  return { ...run, roles: rolesOf(run), synthesis: synthesize(run), budget: budgetStatus(cfg, state), disclaimer: DISCLAIMER, storage: Boolean(cfg.kv) };
}

export async function runOnce(cfg) {
  checkBasics(cfg);
  const state = await loadState(cfg);
  const last = state.runs[state.runs.length - 1];
  if (last && Date.now() - Date.parse(last.created) < cfg.minMinutes * 60 * 1000) {
    throw new RunRefused(`last run was less than ${cfg.minMinutes} min ago`, "too_soon");
  }
  const snapshot = await buildSnapshot(cfg);
  checkBudget(cfg, state, snapshot);
  const run = await pipeline(cfg, state, snapshot, rulesVote(snapshot), { kind: "market" });
  state.runs = [...state.runs, run].slice(-10);
  await saveState(cfg, state);
  return run;
}

export function normalizeSymbol(s) {
  const v = String(s || "").trim().toUpperCase();
  return /^[A-Z0-9]{1,12}$/.test(v) ? v : "";
}

export function isAnalyzable(coin) { return coin && !STABLES.has(coin.symbol); }

export async function latestCoin(cfg, symbol) {
  const state = await loadState(cfg);
  const run = state.coin_runs[symbol];
  return run ? { ...run, roles: rolesOf(run), synthesis: synthesize(run), disclaimer: DISCLAIMER } : null;
}

export async function recentCoins(cfg, n = 12) {
  const state = await loadState(cfg);
  return Object.values(state.coin_runs).sort((a, b) => Date.parse(b.created) - Date.parse(a.created)).slice(0, n)
    .map((r) => ({ symbol: r.symbol, created: r.created, verdict: r.consensus.verdict }));
}

async function hitLimit(cfg, clientId) {
  if (!clientId) return false;
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientId)));
  const key = "rl:" + Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("") + ":" + new Date().toISOString().slice(0, 13);
  const n = Number(await cfg.kv.get(key)) || 0;
  if (n >= cfg.coinPerVisitorHour) return true;
  await cfg.kv.put(key, String(n + 1), { expirationTtl: 3700 });
  return false;
}

// A visitor asks for one coin. Returns { run, cached }.
export async function runCoin(cfg, rawSymbol, clientId = "") {
  checkBasics(cfg);
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) throw new RunRefused("invalid coin symbol", "unknown_coin");
  if (STABLES.has(symbol)) throw new RunRefused(`${symbol} is a stablecoin`, "stablecoin");
  const state = await loadState(cfg);
  const cached = state.coin_runs[symbol];
  if (cached && Date.now() - Date.parse(cached.created) < cfg.coinCacheMinutes * 60 * 1000) return { run: cached, cached: true };
  if ((state.coin_count_by_day[today()] || 0) >= cfg.coinRunsPerDay) throw new RunRefused("today's limit of new coin analyses was reached", "daily_cap");
  if (await hitLimit(cfg, clientId)) throw new RunRefused("too many requests from this visitor; try again later", "visitor_limit");
  const snapshot = await buildCoinSnapshot(cfg, symbol);
  checkBudget(cfg, state, snapshot);
  const run = await pipeline(cfg, state, snapshot, rulesVoteCoin(snapshot), { kind: "coin", symbol });
  const d = today();
  state.coin_count_by_day[d] = (state.coin_count_by_day[d] || 0) + 1;
  for (const k of Object.keys(state.coin_count_by_day).sort().slice(0, -7)) delete state.coin_count_by_day[k];
  state.coin_runs[symbol] = run;
  const keep = Object.values(state.coin_runs).sort((a, b) => Date.parse(b.created) - Date.parse(a.created)).slice(0, 30);
  state.coin_runs = Object.fromEntries(keep.map((r) => [r.symbol, r]));
  await saveState(cfg, state);
  return { run, cached: false };
}
