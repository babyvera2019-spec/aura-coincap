// Triple AI: three independent agents review the same market snapshot.
//   1. Claude (Anthropic)  -> Analyst
//   2. OpenAI              -> Critic (checks the data AND the analyst's view)
//   3. AURA rules agent    -> Coordinator (transparent rules, no API cost)
// Verdict = majority of the three votes. Market commentary only; no trading.
//
// Cost safety: visitors only read the stored last run. Runs come from the cron
// trigger or an admin-token request, need KV storage (to track spend), respect
// a minimum interval, and are refused BEFORE any API call if the estimated
// cost would exceed the daily or total budget.
import { TRIPLE_AI } from "./sample/data.js";
import { getMarket, movers } from "./cmc.js";
import { getNews } from "./news.js";

export const DISCLAIMER = "AI-generated market commentary for demonstration only. Not financial advice.";
const BIASES = ["bullish", "bearish", "neutral"];
const MAX_TOKENS = 600;

const ANALYST_SYSTEM =
  "You are the Analyst agent of AURA CoinCap, a crypto market dashboard. You receive a JSON snapshot built " +
  "from CoinMarketCap data and news headlines. Give a short, balanced market read for the next 24 hours. Use " +
  "only the data given; do not invent numbers. Do not give personal financial advice. Reply with JSON only: " +
  '{"bias": "bullish|bearish|neutral", "confidence": 0-100, "summary": "max 2 sentences", ' +
  '"key_points": ["max 3 short items"], "risks": ["max 3 short items"]}';

const CRITIC_SYSTEM =
  "You are the Critic agent of AURA CoinCap. You receive a market snapshot and the Analyst agent's view. " +
  "Independently check the view against the data, point out weak reasoning or missing factors, and give your " +
  "own bias. Use only the data given; do not invent numbers. Reply with JSON only: " +
  '{"agrees": true|false, "bias": "bullish|bearish|neutral", "confidence": 0-100, ' +
  '"critique": "max 2 sentences", "missing": ["max 3 short items"]}';

export class RunRefused extends Error {}

const today = () => new Date().toISOString().slice(0, 10);
const round = (v, d) => (typeof v === "number" ? Number(v.toFixed(d)) : v);

// ------------------------------------------------------------- storage ---
export async function loadState(cfg) {
  const empty = { runs: [], spend_by_day: {}, total_spend: 0 };
  if (!cfg.kv) return empty;
  return (await cfg.kv.get("triple_state", "json")) || empty;
}

const saveState = (cfg, state) => cfg.kv.put("triple_state", JSON.stringify(state));

export function budgetStatus(cfg, state) {
  return {
    spent_today_usd: round(state.spend_by_day[today()] || 0, 4),
    daily_cap_usd: cfg.dailyBudget,
    spent_total_usd: round(state.total_spend, 4),
    total_cap_usd: cfg.totalBudget,
  };
}

// ------------------------------------------------------------ snapshot ---
export async function buildSnapshot(cfg) {
  const market = await getMarket(cfg);
  const news = await getNews(cfg, 15);
  const coins = market.coins;
  const up = coins.filter((c) => (c.change_24h || 0) > 0).length;
  const mv = movers(coins, 3);
  const slim = (c) => ({ symbol: c.symbol, price: round(c.price, 4), change_24h: round(c.change_24h, 2), change_7d: round(c.change_7d, 2) });
  const g = Object.fromEntries(Object.entries(market.global).map(([k, v]) => [k, round(v, 2)]));
  return {
    as_of: new Date().toISOString(),
    data_source: market.source,
    global: g,
    fear_and_greed: market.fear_greed,
    breadth_top100_up_24h_pct: coins.length ? round((100 * up) / coins.length, 1) : null,
    top10: coins.slice(0, 10).map(slim),
    top_gainers_24h: mv.gainers.map(slim),
    top_losers_24h: mv.losers.map(slim),
    headlines: news.items.slice(0, 15).map((h) => ({ title: h.title, tag: h.sentiment })),
  };
}

export function rulesVote(snap) {
  let score = 0;
  const reasons = [];
  const btc = snap.top10.find((c) => c.symbol === "BTC");
  if (btc && typeof btc.change_24h === "number") {
    if (btc.change_24h > 1) { score++; reasons.push(`BTC up ${btc.change_24h.toFixed(1)}% in 24h`); }
    else if (btc.change_24h < -1) { score--; reasons.push(`BTC down ${Math.abs(btc.change_24h).toFixed(1)}% in 24h`); }
  }
  const b = snap.breadth_top100_up_24h_pct;
  if (typeof b === "number") {
    if (b >= 60) { score++; reasons.push(`${Math.round(b)}% of top 100 coins are up`); }
    else if (b <= 40) { score--; reasons.push(`only ${Math.round(b)}% of top 100 coins are up`); }
  }
  const f = snap.fear_and_greed && snap.fear_and_greed.value;
  if (typeof f === "number") {
    if (f >= 75) { score--; reasons.push(`Fear & Greed ${f} = extreme greed (contrarian caution)`); }
    else if (f <= 25) { score++; reasons.push(`Fear & Greed ${f} = extreme fear (contrarian support)`); }
  }
  const tags = snap.headlines.map((h) => h.tag);
  const net = tags.filter((t) => t === "bullish").length - tags.filter((t) => t === "bearish").length;
  if (net >= 3) { score++; reasons.push("news flow leans positive"); }
  else if (net <= -3) { score--; reasons.push("news flow leans negative"); }
  const bias = score >= 2 ? "bullish" : score <= -2 ? "bearish" : "neutral";
  return { bias, score, reasons: reasons.length ? reasons : ["no strong signal"] };
}

export function consensus(votes) {
  const tally = Object.fromEntries(BIASES.map((b) => [b, Object.values(votes).filter((v) => v === b).length]));
  const top = BIASES.reduce((a, b) => (tally[b] > tally[a] ? b : a));
  if (tally[top] >= 2) return { verdict: top, agreement: `${tally[top]}/3`, unanimous: tally[top] === 3 };
  return { verdict: "mixed", agreement: "1/3", unanimous: false };
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

export const api = {
  async claude(cfg, snapshot) {
    const resp = await postJson("https://api.anthropic.com/v1/messages", {
      model: cfg.claudeModel, max_tokens: MAX_TOKENS, system: ANALYST_SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(snapshot) }],
    }, { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01" });
    const text = (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const u = resp.usage || {};
    return [extractJson(text), cost(u.input_tokens || 0, u.output_tokens || 0, cfg.claudeIn, cfg.claudeOut)];
  },
  async openai(cfg, snapshot, analyst) {
    const resp = await postJson("https://api.openai.com/v1/chat/completions", {
      model: cfg.openaiModel, max_tokens: MAX_TOKENS, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CRITIC_SYSTEM },
        { role: "user", content: JSON.stringify({ snapshot, analyst_view: analyst }) },
      ],
    }, { Authorization: `Bearer ${cfg.openaiKey}` });
    const u = resp.usage || {};
    return [extractJson(resp.choices[0].message.content), cost(u.prompt_tokens || 0, u.completion_tokens || 0, cfg.openaiIn, cfg.openaiOut)];
  },
};

function estimateMaxCost(cfg, snapshot) {
  const approxIn = Math.ceil(JSON.stringify(snapshot).length / 3) + 400;
  return cost(approxIn, MAX_TOKENS, cfg.claudeIn, cfg.claudeOut) + cost(approxIn * 2, MAX_TOKENS, cfg.openaiIn, cfg.openaiOut);
}

// --------------------------------------------------------------- public ---
export async function latest(cfg) {
  const state = await loadState(cfg);
  const run = state.runs.length ? state.runs[state.runs.length - 1] : TRIPLE_AI;
  return { ...run, budget: budgetStatus(cfg, state), disclaimer: DISCLAIMER, storage: Boolean(cfg.kv) };
}

export async function runOnce(cfg) {
  if (cfg.demoAi) throw new RunRefused("AI keys are not configured (demo mode)");
  if (!cfg.kv) throw new RunRefused("KV storage (STATE) is not connected, so spend cannot be tracked");
  const state = await loadState(cfg);
  const last = state.runs[state.runs.length - 1];
  if (last && Date.now() - Date.parse(last.created) < cfg.minMinutes * 60 * 1000) {
    throw new RunRefused(`last run was less than ${cfg.minMinutes} min ago`);
  }
  const snapshot = await buildSnapshot(cfg);
  if (snapshot.data_source !== "coinmarketcap") throw new RunRefused("live CoinMarketCap data is not available");
  const est = estimateMaxCost(cfg, snapshot);
  const b = budgetStatus(cfg, state);
  if (b.spent_today_usd + est > cfg.dailyBudget) throw new RunRefused("daily AI budget would be exceeded");
  if (b.spent_total_usd + est > cfg.totalBudget) throw new RunRefused("total AI budget would be exceeded");

  let spent = 0;
  let analyst, critic;
  try {
    let c;
    [analyst, c] = await api.claude(cfg, snapshot);
    spent += c;
    [critic, c] = await api.openai(cfg, snapshot, analyst);
    spent += c;
  } finally {
    // Always record what was actually spent, even if the second call failed.
    const d = today();
    state.spend_by_day[d] = (state.spend_by_day[d] || 0) + spent;
    state.total_spend += spent;
    for (const k of Object.keys(state.spend_by_day).sort().slice(0, -31)) delete state.spend_by_day[k];
    await saveState(cfg, state);
  }

  const coordinator = rulesVote(snapshot);
  const votes = { claude: analyst.bias, openai: critic.bias, aura: coordinator.bias };
  const run = {
    created: new Date().toISOString(),
    mode: "live",
    models: { claude: cfg.claudeModel, openai: cfg.openaiModel, aura: "rules-v1" },
    snapshot,
    agents: { claude: analyst, openai: critic, aura: coordinator },
    votes,
    consensus: consensus(votes),
    cost_usd: round(spent, 5),
  };
  state.runs = [...state.runs, run].slice(-10);
  await saveState(cfg, state);
  return run;
}
