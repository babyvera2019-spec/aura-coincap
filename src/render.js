// Server-side HTML rendering. Every dynamic value goes through esc().
import { CSS } from "./style.js";

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const usd = (v) => {
  if (typeof v !== "number") return "—";
  const d = Math.abs(v) >= 1 ? 2 : Math.abs(v) >= 0.01 ? 4 : 8;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};

export const big = (v) => {
  if (typeof v !== "number") return "—";
  for (const [u, s] of [["T", 1e12], ["B", 1e9], ["M", 1e6]]) {
    if (Math.abs(v) >= s) return "$" + (v / s).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + u;
  }
  return "$" + Math.round(v).toLocaleString("en-US");
};

const pctText = (v) => (typeof v === "number" ? (v >= 0 ? "+" : "") + v.toFixed(2) + "%" : "—");
export const pct = (v) => `<span class="${typeof v === "number" && v > 0 ? "up" : typeof v === "number" && v < 0 ? "down" : "flat"}">${pctText(v)}</span>`;
const tag = (s) => `<span class="tag ${esc(s)}">${esc(s)}</span>`;
const one = (v, d = 1) => (typeof v === "number" ? v.toFixed(d) : "—");

export const when = (iso) => {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return esc(iso);
  return t.toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC";
};

const NAV = [["overview", "/", "Overview"], ["market", "/market", "Market"], ["news", "/news", "News"], ["triple", "/triple-ai", "Triple AI"]];

export function layout({ title, active, body, demoMarket, demoAi }) {
  const nav = NAV.map(([k, href, label]) => `<a href="${href}" class="${k === active ? "on" : ""}">${label}</a>`).join("");
  const parts = [];
  if (demoMarket) parts.push("market data is illustrative sample data");
  if (demoAi) parts.push("Triple AI shows an illustrative sample run");
  const banner = parts.length ? `<div class="banner">Demo mode: ${parts.join("; ")}. Live data turns on when the API keys are added.</div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · AURA CoinCap</title><meta name="description" content="Three AI agents read the crypto market on live CoinMarketCap data.">
<style>${CSS}</style></head><body>
<header class="top"><a class="brand" href="/"><span class="dot"></span>AURA <b>CoinCap</b></a><nav>${nav}</nav></header>
${banner}<main>${body}</main>
<footer><p>Market data: CoinMarketCap API · Headlines: public RSS feeds (links to the original articles).</p>
<p>AI-generated market commentary. Not financial advice. No agent places trades.</p></footer></body></html>`;
}

function coinTable(coins, compact = false) {
  const head = `<tr><th>#</th><th>Coin</th><th class="r">Price</th>${compact ? "" : '<th class="r">1h</th>'}<th class="r">24h</th><th class="r">7d</th><th class="r hide-sm">Market cap</th>${compact ? "" : '<th class="r hide-sm">Volume 24h</th>'}</tr>`;
  const rows = coins.map((c) => `<tr><td class="muted">${esc(c.rank)}</td><td><b>${esc(c.symbol)}</b> <span class="muted hide-sm">${esc(c.name)}</span></td>
<td class="r">${usd(c.price)}</td>${compact ? "" : `<td class="r">${pct(c.change_1h)}</td>`}<td class="r">${pct(c.change_24h)}</td><td class="r">${pct(c.change_7d)}</td>
<td class="r hide-sm">${big(c.market_cap)}</td>${compact ? "" : `<td class="r hide-sm">${big(c.volume_24h)}</td>`}</tr>`).join("");
  return `<table class="coins"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

function moversBox(m) {
  const li = (c) => `<li><b>${esc(c.symbol)}</b> <span>${usd(c.price)}</span> ${pct(c.change_24h)}</li>`;
  return `<div class="grid2"><div class="card"><h3>Top gainers 24h</h3><ul class="list">${m.gainers.map(li).join("")}</ul></div>
<div class="card"><h3>Top losers 24h</h3><ul class="list">${m.losers.map(li).join("")}</ul></div></div>`;
}

const newsList = (items) => items.length
  ? items.map((h) => `<li>${tag(h.sentiment)} <a href="${esc(h.link)}" target="_blank" rel="noopener">${esc(h.title)}</a><span class="muted small">${esc(h.source)} · ${when(h.published)}</span></li>`).join("")
  : '<li class="muted">No headlines in this filter.</li>';

function kpis(g, fng) {
  return `<section class="kpis">
<div class="kpi"><span>Total market cap</span><b>${big(g.total_market_cap)}</b>${pct(g.market_cap_change_24h)}</div>
<div class="kpi"><span>Volume 24h</span><b>${big(g.total_volume_24h)}</b></div>
<div class="kpi"><span>BTC dominance</span><b>${one(g.btc_dominance)}%</b></div>
<div class="kpi"><span>Fear &amp; Greed</span><b>${esc(fng.value ?? "—")}</b><span class="muted">${esc(fng.classification || "")}</span></div></section>`;
}

const AGENT_LABEL = { openai: "OpenAI", claude: "Claude", aura: "AURA" };
const ROLE_LABEL = { analyst: "Analyst", verifier: "Researcher & Verifier", orchestrator: "Orchestrator" };

export function overviewPage({ market, mv, news, counts, run }) {
  const r = run.roles;
  const votes = [["analyst", r.analyst], ["verifier", r.verifier], ["orchestrator", r.orchestrator]]
    .map(([role, k]) => `<div><span class="muted">${AGENT_LABEL[k]} · ${esc(ROLE_LABEL[role])}</span>${tag(run.votes[k])}</div>`).join("");
  return `<section class="hero"><h1>Three AI agents read the crypto market, so you don't have to.</h1>
<p class="muted">Live CoinMarketCap data, news sentiment and a cross-checked AI verdict in one screen.</p></section>
${market.error ? `<div class="warn">${esc(market.error)}</div>` : ""}
${kpis(market.global, market.fear_greed)}
<section class="card verdict v-${esc(run.consensus.verdict)}"><div><h3>Triple AI verdict ${modeBadge(run)}</h3>
<p class="big">${esc(run.consensus.verdict.toUpperCase())} <span class="muted">· ${esc(run.consensus.agreement)} agents agree · uncertainty ${esc(run.synthesis.uncertainty)}</span></p>
<p class="muted">${esc((run.agents[r.analyst] || {}).summary)}</p></div>
<div class="votes">${votes}<a class="btn" href="/triple-ai">See the debate →</a></div></section>
<div class="grid2"><section class="card"><h3>Top 10 by market cap</h3>${coinTable(market.coins.slice(0, 10), true)}<a class="more" href="/market">Full market →</a></section>
<section class="card"><h3>Latest headlines</h3><p class="muted small">Sentiment: ${counts.bullish} bullish · ${counts.bearish} bearish · ${counts.neutral} neutral</p>
<ul class="news">${newsList(news.items.slice(0, 6))}</ul><a class="more" href="/news">All news →</a></section></div>
${moversBox(mv)}`;
}

export function marketPage({ market, mv }) {
  const g = market.global;
  return `<h1>Market</h1><p class="muted">Top 100 cryptocurrencies by market cap · source: ${market.source === "coinmarketcap" ? "CoinMarketCap" : "sample data"}${market.as_of ? " · updated " + when(market.as_of) : ""}</p>
${market.error ? `<div class="warn">${esc(market.error)}</div>` : ""}
<section class="kpis"><div class="kpi"><span>Total market cap</span><b>${big(g.total_market_cap)}</b>${pct(g.market_cap_change_24h)}</div>
<div class="kpi"><span>BTC dominance</span><b>${one(g.btc_dominance)}%</b></div>
<div class="kpi"><span>ETH dominance</span><b>${one(g.eth_dominance)}%</b></div>
<div class="kpi"><span>Active coins</span><b>${typeof g.active_cryptocurrencies === "number" ? g.active_cryptocurrencies.toLocaleString("en-US") : "—"}</b></div></section>
${moversBox(mv)}<section class="card">${coinTable(market.coins)}</section>
${callsBox(market)}`;
}

export function newsPage({ news, counts, filter }) {
  const items = filter ? news.items.filter((i) => i.sentiment === filter) : news.items;
  const f = (val, label, n) => `<a href="/news${val ? "?tag=" + val : ""}" class="${filter === val ? "on" : ""}">${label} (${n})</a>`;
  return `<h1>News</h1><p class="muted">Latest crypto headlines from public feeds, tagged with a transparent keyword sentiment. Click a headline to read it at the source.</p>
${news.errors.length ? `<div class="warn">Some feeds could not be reached: ${esc(news.errors.join(", "))}</div>` : ""}
<div class="filters">${f("", "All", counts.bullish + counts.bearish + counts.neutral)}${f("bullish", "Bullish", counts.bullish)}${f("bearish", "Bearish", counts.bearish)}${f("neutral", "Neutral", counts.neutral)}</div>
<section class="card"><ul class="news">${newsList(items)}</ul></section>`;
}

export const modeBadge = (run) => (run.mode === "live"
  ? `<span class="tag live">live run</span>`
  : `<span class="tag sample">sample · illustrative</span>`);

export function callsBox(market) {
  if (!market.calls || !market.calls.length) return "";
  const rows = market.calls.map((c) => `<tr><td><code>${esc(c.endpoint)}</code></td><td class="r">${esc(c.http)}</td><td>${when(c.cmc_timestamp)}</td><td class="r">${esc(c.credit_count ?? "—")}</td><td class="r hide-sm">${esc(c.elapsed_ms ?? "—")}</td></tr>`).join("");
  return `<section class="card"><h3>CoinMarketCap API calls behind this snapshot</h3>
<table class="coins"><thead><tr><th>Endpoint</th><th class="r">HTTP</th><th>CMC timestamp</th><th class="r">Credits</th><th class="r hide-sm">Elapsed ms</th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted small">Values come from the <code>status</code> block of each CoinMarketCap response. Also at <a href="/api/cmc-status">/api/cmc-status</a>.</p></section>`;
}

const ul = (xs) => (xs && xs.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
const sec = (title, xs) => (xs && xs.length ? `<h4>${title}</h4>${ul(xs)}` : "");

function debate(run) {
  const r = run.roles, a = run.agents[r.analyst] || {}, v = run.agents[r.verifier] || {}, o = run.agents[r.orchestrator] || {}, s = run.synthesis;
  return `<section class="card verdict v-${esc(run.consensus.verdict)}"><div><h3>AURA verdict ${modeBadge(run)}</h3>
<p class="big">${esc(run.consensus.verdict.toUpperCase())} <span class="muted">· ${esc(run.consensus.agreement)} agree${run.consensus.unanimous ? " (unanimous)" : ""}</span></p>
<p>${esc(s.conclusion)} Uncertainty: <b>${esc(s.uncertainty)}</b> (average model confidence ${esc(s.avg_confidence)}%).</p>
${s.discrepancies.length ? "<h4>Discrepancies between the agents</h4>" + ul(s.discrepancies) : '<p class="muted small">No discrepancies between the agents.</p>'}
<p class="muted small">Run: ${when(run.created)}${run.cost_usd ? ` · AI cost $${run.cost_usd.toFixed(4)}` : ""}${run.snapshot && run.snapshot.cmc_as_of ? ` · CoinMarketCap data of ${when(run.snapshot.cmc_as_of)}` : ""}</p></div></section>
<div class="grid3">
<section class="card agent"><h3>1 · ${esc(ROLE_LABEL.analyst)} <span class="muted small">${AGENT_LABEL[r.analyst]} · ${esc(run.models[r.analyst])}</span></h3>
<p>${tag(a.bias)} <span class="muted">confidence ${esc(a.confidence)}%</span></p><p>${esc(a.summary)}</p>
${sec("Bullish case", a.bull_case)}${sec("Bearish case", a.bear_case)}${sec("Key points", a.key_points)}${sec("Risks", a.risks)}</section>
<section class="card agent"><h3>2 · ${esc(ROLE_LABEL.verifier)} <span class="muted small">${AGENT_LABEL[r.verifier]} · ${esc(run.models[r.verifier])}</span></h3>
<p>${tag(v.bias)} <span class="muted">confidence ${esc(v.confidence)}% · ${v.agrees ? "agrees" : "disagrees"} with the analyst</span></p><p>${esc(v.verification || v.critique)}</p>
${sec("Claims the data does not support", v.unsupported_claims)}${sec("What the analyst missed", v.missing)}</section>
<section class="card agent"><h3>3 · ${esc(ROLE_LABEL.orchestrator)} <span class="muted small">${AGENT_LABEL[r.orchestrator]} · ${esc(run.models[r.orchestrator])}</span></h3>
<p>${tag(o.bias)} <span class="muted">rule score ${esc(o.score)}</span></p>
<p class="muted small">AURA builds the CoinMarketCap snapshot, casts a transparent rules vote, then compares the three views.</p>${ul(o.reasons)}</section></div>`;
}

function coinPicker(coins, current = "") {
  const opts = coins.map((c) => `<option value="${esc(c.symbol)}"${c.symbol === current ? " selected" : ""}>${esc(c.rank)}. ${esc(c.symbol)} · ${esc(c.name)}</option>`).join("");
  return `<form class="picker" method="post" action="/triple-ai/coin"><label for="sym">Analyze one coin</label>
<select id="sym" name="symbol">${opts}</select><button class="btn" type="submit">Analyze</button></form>`;
}

const budgetLine = (b) => `AI spend today: $${b.spent_today_usd.toFixed(4)} of $${b.daily_cap_usd.toFixed(2)} · total $${b.spent_total_usd.toFixed(2)} of $${b.total_cap_usd.toFixed(2)} · coin analyses today: ${b.coin_runs_today} of ${b.coin_runs_daily_cap}.`;

export function triplePage({ run, coins, recent }) {
  const rec = recent && recent.length
    ? `<p class="muted small">Recently analyzed: ${recent.map((x) => `<a href="/triple-ai/coin?symbol=${encodeURIComponent(x.symbol)}">${esc(x.symbol)}</a> ${tag(x.verdict === "mixed" ? "neutral" : x.verdict)}`).join(" · ")}</p>` : "";
  return `<h1>Triple AI</h1><p class="muted">Three independent agents review the same CoinMarketCap snapshot: OpenAI analyzes, Claude verifies, AURA orchestrates and decides by majority vote.</p>
<section class="card">${coinPicker(coins)}${rec}</section>
<h2>Whole market</h2>${debate(run)}
<section class="card"><h3>Safety &amp; cost controls</h3><ul>
<li>The market run is scheduled every 3 hours. A coin analysis is served from a ${esc(run.coin_cache_minutes || 60)}-minute cache; new ones are capped per day and per visitor.</li>
<li>Every run is refused <b>before</b> any AI call if it would exceed the daily or total budget.</li>
<li>${budgetLine(run.budget)}</li>
<li>${esc(run.disclaimer)}</li></ul></section>`;
}

const COIN_MSG = {
  daily_cap: "Today's limit of new coin analyses was reached. Showing the latest stored analysis, if any.",
  visitor_limit: "You asked for several new analyses in the last hour. Please try again later.",
  budget: "The AI budget for today is used up. New analyses resume tomorrow.",
  unknown_coin: "That coin is not in the CoinMarketCap top 100 right now.",
  stablecoin: "Stablecoins are not analyzed.",
  demo: "AI keys are not configured, so new analyses are off.",
  no_storage: "Storage is not connected, so new analyses are off.",
  no_data: "Live CoinMarketCap data is not available right now. Please try again in a few minutes.",
  error: "Something went wrong with the AI providers. Please try again in a few minutes.",
  cached: "Served from the cache (analyzed less than an hour ago); no new AI cost.",
};

export function coinPage({ symbol, coin, run, coins, msg, budget }) {
  const note = msg && COIN_MSG[msg] ? `<div class="${msg === "cached" ? "banner-ok" : "warn"}">${COIN_MSG[msg]}</div>` : "";
  const head = coin
    ? `<section class="kpis"><div class="kpi"><span>Price</span><b>${usd(coin.price)}</b>${pct(coin.change_24h)}</div>
<div class="kpi"><span>7 days</span><b>${pct(coin.change_7d)}</b></div><div class="kpi"><span>Market cap</span><b>${big(coin.market_cap)}</b><span class="muted">rank #${esc(coin.rank)}</span></div>
<div class="kpi"><span>Volume 24h</span><b>${big(coin.volume_24h)}</b></div></section>` : "";
  const body = run
    ? debate(run)
    : `<section class="card"><p>No analysis of ${esc(symbol)} yet. Press <b>Analyze</b> to ask the three agents.</p></section>`;
  return `<p class="muted small"><a href="/triple-ai">← Triple AI</a></p><h1>${esc(symbol)}${coin ? ` <span class="muted">${esc(coin.name)}</span>` : ""}</h1>
${note}${head}<section class="card">${coinPicker(coins, symbol)}</section>${body}
${budget ? `<p class="muted small">${budgetLine(budget)}</p>` : ""}`;
}
