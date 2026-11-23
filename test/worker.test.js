// Offline tests: no network, no keys. Run with `npm test` (Node 18+).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { config } from "../src/config.js";
import * as cmc from "../src/cmc.js";
import * as news from "../src/news.js";
import * as triple from "../src/triple.js";
import { esc } from "../src/render.js";

const kv = () => {
  const m = new Map();
  return { m, get: async (k, t) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => void m.set(k, v) };
};

const CMC_LISTING = { data: [
  { cmc_rank: 1, name: "Bitcoin", symbol: "BTC", quote: { USD: { price: 90000, percent_change_1h: 0.1, percent_change_24h: 2.5, percent_change_7d: 4, market_cap: 1.8e12, volume_24h: 4e10 } } },
  { cmc_rank: 2, name: "Ethereum", symbol: "ETH", quote: { USD: { price: 3200, percent_change_1h: 0.2, percent_change_24h: 3.1, percent_change_7d: 5, market_cap: 3.9e11, volume_24h: 2e10 } } },
  { cmc_rank: 3, name: "Solana", symbol: "SOL", quote: { USD: { price: 150, percent_change_1h: -0.1, percent_change_24h: -1.2, percent_change_7d: 1, market_cap: 8e10, volume_24h: 5e9 } } },
] };
const CMC_GLOBAL = { data: { btc_dominance: 57.1, eth_dominance: 12.2, active_cryptocurrencies: 9900, quote: { USD: { total_market_cap: 3.1e12, total_volume_24h: 1.2e11, total_market_cap_yesterday_percentage_change: 1.4 } } } };
const CMC_FNG = { data: { value: 62, value_classification: "Greed", update_time: "2026-11-22T12:00:00Z" } };
const RSS = `<?xml version="1.0"?><rss><channel><title>Test Feed</title>
<item><title><![CDATA[Bitcoin surges to record high]]></title><link>https://example.com/a</link><pubDate>Sun, 22 Nov 2026 12:00:00 GMT</pubDate></item>
<item><title>Exchange hacked &amp; prices plunge</title><link>https://example.com/b</link><pubDate>Sun, 22 Nov 2026 11:00:00 GMT</pubDate></item>
<item><title>Bad link</title><link>javascript:alert(1)</link></item></channel></rss>`;

let calls = [];
function mockFetch({ cmcFail = false } = {}) {
  calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const ok = (body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
    if (url.includes("coinmarketcap")) {
      if (cmcFail) return new Response("quota", { status: 429 });
      if (url.includes("listings")) return ok(CMC_LISTING);
      if (url.includes("global-metrics")) return ok(CMC_GLOBAL);
      if (url.includes("fear-and-greed")) return ok(CMC_FNG);
    }
    if (url.includes("api.anthropic.com")) return ok({ content: [{ type: "text", text: '{"bias":"bullish","confidence":64,"summary":"Up","key_points":["a"],"risks":["b"]}' }], usage: { input_tokens: 1000, output_tokens: 200 } });
    if (url.includes("api.openai.com")) return ok({ choices: [{ message: { content: '{"agrees":true,"bias":"bullish","confidence":58,"critique":"ok","missing":[]}' } }], usage: { prompt_tokens: 1500, completion_tokens: 150 } });
    if (url.includes("feed") || url.includes("rss")) return ok(RSS);
    return new Response("no", { status: 404 });
  };
}

const ENV_DEMO = {};
const ENV_LIVE = () => ({ CMC_API_KEY: "k", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", ADMIN_TOKEN: "secret-token", STATE: kv() });
const get = (env, path) => worker.fetch(new Request("https://x.dev" + path), env);

beforeEach(() => { cmc._resetMemo(); news._resetMemo(); mockFetch(); });

for (const p of ["/", "/market", "/news", "/news?tag=bearish", "/triple-ai"]) {
  test(`page ${p} renders in demo mode`, async () => {
    const r = await get(ENV_DEMO, p);
    assert.equal(r.status, 200);
    const t = await r.text();
    assert.match(t, /AURA/);
    assert.match(t, /Not financial advice/);
    assert.match(t, /Demo mode/);
  });
}

for (const p of ["/api/overview", "/api/market", "/api/news", "/api/triple-ai", "/healthz"]) {
  test(`api ${p} returns JSON`, async () => {
    const r = await get(ENV_DEMO, p);
    assert.equal(r.status, 200);
    assert.ok(await r.json());
  });
}

test("404 for unknown path", async () => assert.equal((await get(ENV_DEMO, "/nope")).status, 404));

test("demo mode never calls CoinMarketCap", async () => {
  await get(ENV_DEMO, "/market");
  assert.ok(!calls.some((c) => c.url.includes("coinmarketcap")));
});

test("live market uses CMC with key header and shows real data", async () => {
  const env = ENV_LIVE();
  const t = await (await get(env, "/market")).text();
  assert.match(t, /\$90,000\.00/);
  assert.doesNotMatch(t, /Demo mode: market/);
  const c = calls.find((x) => x.url.includes("listings"));
  assert.equal(c.init.headers["X-CMC_PRO_API_KEY"], "k");
  assert.ok(env.STATE.m.has("market"));
});

test("CMC failure falls back to sample data with a warning", async () => {
  mockFetch({ cmcFail: true });
  const t = await (await get({ CMC_API_KEY: "k" }, "/market")).text();
  assert.match(t, /CoinMarketCap unavailable/);
});

test("RSS parsing, entities, CDATA, unsafe links dropped, sentiment", () => {
  const items = news.parseFeed(RSS, "host");
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Bitcoin surges to record high");
  assert.equal(items[0].sentiment, "bullish");
  assert.equal(items[1].title, "Exchange hacked & prices plunge");
  assert.equal(items[1].sentiment, "bearish");
  assert.equal(items[0].source, "Test Feed");
});

test("HTML escaping", () => assert.equal(esc(`<script>"x"&'`), "&lt;script&gt;&quot;x&quot;&amp;&#39;"));

test("consensus", () => {
  assert.equal(triple.consensus({ a: "bullish", b: "bullish", c: "bearish" }).verdict, "bullish");
  assert.equal(triple.consensus({ a: "bullish", b: "neutral", c: "bearish" }).verdict, "mixed");
  assert.ok(triple.consensus({ a: "bearish", b: "bearish", c: "bearish" }).unanimous);
});

test("run endpoint requires the admin token", async () => {
  const env = ENV_LIVE();
  const post = (h) => worker.fetch(new Request("https://x.dev/api/triple-ai/run", { method: "POST", headers: h }), env);
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ "X-Admin-Token": "wrong" })).status, 403);
});

test("run refused without KV storage, before any AI call", async () => {
  const env = ENV_LIVE(); delete env.STATE;
  await assert.rejects(triple.runOnce(config(env)), /KV storage/);
  assert.ok(!calls.some((c) => c.url.includes("anthropic") || c.url.includes("openai")));
});

test("run refused when budget would be exceeded, before any AI call", async () => {
  const env = { ...ENV_LIVE(), AI_DAILY_BUDGET_USD: "0" };
  await assert.rejects(triple.runOnce(config(env)), /daily AI budget/);
  assert.ok(!calls.some((c) => c.url.includes("anthropic") || c.url.includes("openai")));
});

test("live run: three votes, cost recorded, interval enforced, page shows it", async () => {
  const env = ENV_LIVE();
  const r = await worker.fetch(new Request("https://x.dev/api/triple-ai/run", { method: "POST", headers: { "X-Admin-Token": "secret-token" } }), env);
  assert.equal(r.status, 200);
  const run = await r.json();
  assert.deepEqual(Object.keys(run.votes), ["openai", "claude", "aura"]);
  assert.deepEqual(run.roles, { analyst: "openai", verifier: "claude", orchestrator: "aura" });
  assert.ok(["low", "medium", "high"].includes(run.synthesis.uncertainty));
  assert.equal(run.consensus.verdict, "bullish");
  const expected = (1000 * 3 + 200 * 15 + 1500 * 0.15 + 150 * 0.6) / 1e6;
  assert.ok(Math.abs(run.cost_usd - expected) < 1e-5);
  const st = JSON.parse(env.STATE.m.get("triple_state"));
  assert.ok(Math.abs(st.total_spend - expected) < 1e-9);
  const again = await worker.fetch(new Request("https://x.dev/api/triple-ai/run", { method: "POST", headers: { "X-Admin-Token": "secret-token" } }), env);
  assert.equal(again.status, 429);
  const page = await (await get(env, "/triple-ai")).text();
  assert.match(page, /live run/);
  assert.match(page, /Researcher &amp; Verifier/);
  const claudeCall = calls.find((c) => c.url.includes("anthropic"));
  const cb = JSON.parse(claudeCall.init.body);
  assert.equal(cb.model, "claude-sonnet-5-5");
  assert.ok(JSON.parse(cb.messages[0].content).analyst_view, "Claude verifies the analyst view");
  const order = calls.filter((c) => c.url.includes("openai") || c.url.includes("anthropic")).map((c) => (c.url.includes("openai") ? "openai" : "claude"));
  assert.deepEqual(order, ["openai", "claude"], "OpenAI analyzes first, then Claude verifies");
});

test("scheduled cron refreshes market into KV", async () => {
  const env = ENV_LIVE();
  const waits = [];
  await worker.scheduled({ cron: "*/15 * * * *" }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.ok(env.STATE.m.has("market"));
});

test("scheduled Triple AI in demo mode is skipped safely", async () => {
  const waits = [];
  await worker.scheduled({ cron: "7 */3 * * *" }, {}, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.ok(!calls.some((c) => c.url.includes("anthropic")));
});

// ---------------------------------------------------------------- v0.3 ---
const postCoin = (env, symbol, headers = { Origin: "https://x.dev", "CF-Connecting-IP": "1.2.3.4" }) =>
  worker.fetch(new Request("https://x.dev/triple-ai/coin", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: "symbol=" + symbol }), env);
const aiCalls = () => calls.filter((c) => c.url.includes("anthropic") || c.url.includes("openai")).length;

test("coin analysis: runs once, then serves the cache with no AI cost", async () => {
  const env = ENV_LIVE();
  const r = await postCoin(env, "eth");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("Location"), "/triple-ai/coin?symbol=ETH");
  assert.equal(aiCalls(), 2);
  const page = await (await get(env, "/triple-ai/coin?symbol=ETH")).text();
  assert.match(page, /ETH/); assert.match(page, /AURA verdict/); assert.match(page, /\$3,200\.00/);
  const r2 = await postCoin(env, "ETH");
  assert.equal(r2.headers.get("Location"), "/triple-ai/coin?symbol=ETH&msg=cached");
  assert.equal(aiCalls(), 2, "cache hit must not call the AI again");
  const api = await (await get(env, "/api/triple-ai/coin?symbol=ETH")).json();
  assert.equal(api.symbol, "ETH"); assert.equal(api.kind, "coin"); assert.equal(api.snapshot.focus, "ETH");
});

test("coin analysis refuses unknown coins and stablecoins before any AI call", async () => {
  const env = ENV_LIVE();
  assert.equal((await postCoin(env, "NOTACOIN")).headers.get("Location"), "/triple-ai/coin?symbol=NOTACOIN&msg=unknown_coin");
  assert.equal((await postCoin(env, "USDT")).headers.get("Location"), "/triple-ai/coin?symbol=USDT&msg=stablecoin");
  assert.equal(aiCalls(), 0);
});

test("coin analysis: cross-site posts never spend the budget", async () => {
  const env = ENV_LIVE();
  const r = await postCoin(env, "BTC", { Origin: "https://evil.example", "CF-Connecting-IP": "1.2.3.4" });
  assert.equal(r.headers.get("Location"), "/triple-ai/coin?symbol=BTC");
  const r2 = await postCoin(env, "BTC", {});
  assert.equal(r2.headers.get("Location"), "/triple-ai/coin?symbol=BTC");
  assert.equal(aiCalls(), 0);
});

test("coin analysis: daily cap and per-visitor hourly limit", async () => {
  const env = { ...ENV_LIVE(), AI_COIN_RUNS_PER_VISITOR_HOUR: "1" };
  await postCoin(env, "BTC");
  assert.equal((await postCoin(env, "SOL")).headers.get("Location"), "/triple-ai/coin?symbol=SOL&msg=visitor_limit");
  const env2 = { ...ENV_LIVE(), AI_COIN_RUNS_PER_DAY: "0" };
  assert.equal((await postCoin(env2, "BTC")).headers.get("Location"), "/triple-ai/coin?symbol=BTC&msg=daily_cap");
});

test("coin analysis refused when the budget would be exceeded", async () => {
  const env = { ...ENV_LIVE(), AI_DAILY_BUDGET_USD: "0" };
  assert.equal((await postCoin(env, "BTC")).headers.get("Location"), "/triple-ai/coin?symbol=BTC&msg=budget");
  assert.equal(aiCalls(), 0);
});

test("CMC call log is recorded and shown as evidence", async () => {
  const env = ENV_LIVE();
  const page = await (await get(env, "/market")).text();
  assert.match(page, /CoinMarketCap API calls behind this snapshot/);
  assert.match(page, /\/v1\/cryptocurrency\/listings\/latest/);
  const st = await (await get(env, "/api/cmc-status")).json();
  assert.equal(st.source, "coinmarketcap");
  assert.equal(st.calls.length, 3);
  assert.ok(st.calls.every((c) => c.http === 200));
});

test("runs stored before the role change still render correctly", async () => {
  const env = ENV_LIVE();
  const legacy = { created: "2026-11-23T15:07:00Z", mode: "live", models: { claude: "claude-sonnet-5-5", openai: "gpt-4o-mini", aura: "rules-v1" },
    agents: { claude: { bias: "neutral", confidence: 55, summary: "Old analyst text", key_points: ["k"], risks: ["r"] }, openai: { agrees: false, bias: "bearish", confidence: 70, critique: "Old critic text", missing: [] }, aura: { bias: "bullish", score: 3, reasons: ["x"] } },
    votes: { claude: "neutral", openai: "bearish", aura: "bullish" }, consensus: { verdict: "mixed", agreement: "1/3", unanimous: false }, cost_usd: 0.011 };
  await env.STATE.put("triple_state", JSON.stringify({ runs: [legacy], spend_by_day: {}, total_spend: 0.011 }));
  const t = await (await get(env, "/triple-ai")).text();
  assert.match(t, /Old analyst text/); assert.match(t, /Old critic text/); assert.match(t, /uncertainty|Uncertainty/);
  assert.equal((await get(env, "/")).status, 200);
});

test("sample run is labelled as illustrative, live runs as live", async () => {
  const t = await (await get(ENV_DEMO, "/triple-ai")).text();
  assert.match(t, /sample · illustrative/);
  assert.doesNotMatch(t, /for demonstration only/);
});
