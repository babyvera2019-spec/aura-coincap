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
  if (demoAi) parts.push("Triple AI shows a sample run");
  const banner = parts.length ? `<div class="banner">Demo mode: ${parts.join("; ")}. Live data turns on when the API keys are added.</div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · AURA CoinCap</title><meta name="description" content="Three AI agents read the crypto market on live CoinMarketCap data.">
<style>${CSS}</style></head><body>
<header class="top"><a class="brand" href="/"><span class="dot"></span>AURA <b>CoinCap</b></a><nav>${nav}</nav></header>
${banner}<main>${body}</main>
<footer><p>Market data: CoinMarketCap API · Headlines: public RSS feeds (links to the original articles).</p>
<p>AI-generated commentary for demonstration only. Not financial advice.</p></footer></body></html>`;
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

export function overviewPage({ market, mv, news, counts, run }) {
  const votes = [["claude", "Claude · Analyst"], ["openai", "OpenAI · Critic"], ["aura", "AURA · Coordinator"]]
    .map(([k, l]) => `<div><span class="muted">${l}</span>${tag(run.votes[k])}</div>`).join("");
  return `<section class="hero"><h1>Three AI agents read the crypto market, so you don't have to.</h1>
<p class="muted">Live CoinMarketCap data, news sentiment and a cross-checked AI verdict in one screen.</p></section>
${market.error ? `<div class="warn">${esc(market.error)}</div>` : ""}
${kpis(market.global, market.fear_greed)}
<section class="card verdict v-${esc(run.consensus.verdict)}"><div><h3>Triple AI verdict</h3>
<p class="big">${esc(run.consensus.verdict.toUpperCase())} <span class="muted">· ${esc(run.consensus.agreement)} agents agree</span></p>
<p class="muted">${esc(run.agents.claude.summary)}</p></div>
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
${moversBox(mv)}<section class="card">${coinTable(market.coins)}</section>`;
}

export function newsPage({ news, counts, filter }) {
  const items = filter ? news.items.filter((i) => i.sentiment === filter) : news.items;
  const f = (val, label, n) => `<a href="/news${val ? "?tag=" + val : ""}" class="${filter === val ? "on" : ""}">${label} (${n})</a>`;
  return `<h1>News</h1><p class="muted">Latest crypto headlines from public feeds, tagged with a transparent keyword sentiment. Click a headline to read it at the source.</p>
${news.errors.length ? `<div class="warn">Some feeds could not be reached: ${esc(news.errors.join(", "))}</div>` : ""}
<div class="filters">${f("", "All", counts.bullish + counts.bearish + counts.neutral)}${f("bullish", "Bullish", counts.bullish)}${f("bearish", "Bearish", counts.bearish)}${f("neutral", "Neutral", counts.neutral)}</div>
<section class="card"><ul class="news">${newsList(items)}</ul></section>`;
}

export function triplePage({ run }) {
  const a = run.agents.claude, o = run.agents.openai, r = run.agents.aura;
  const ul = (xs) => (xs && xs.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
  const b = run.budget;
  return `<h1>Triple AI</h1><p class="muted">Three independent agents review the same CoinMarketCap snapshot. The verdict is their majority vote.</p>
<section class="card verdict v-${esc(run.consensus.verdict)}"><div><h3>Verdict</h3>
<p class="big">${esc(run.consensus.verdict.toUpperCase())} <span class="muted">· ${esc(run.consensus.agreement)} agree${run.consensus.unanimous ? " (unanimous)" : ""}</span></p>
<p class="muted small">Run: ${when(run.created)} · mode: ${esc(run.mode)}${run.cost_usd ? ` · cost $${run.cost_usd.toFixed(4)}` : ""}</p></div></section>
<div class="grid3">
<section class="card agent"><h3>1 · Analyst <span class="muted small">Claude · ${esc(run.models.claude)}</span></h3>
<p>${tag(a.bias)} <span class="muted">confidence ${esc(a.confidence)}%</span></p><p>${esc(a.summary)}</p>
${a.key_points && a.key_points.length ? "<h4>Key points</h4>" + ul(a.key_points) : ""}${a.risks && a.risks.length ? "<h4>Risks</h4>" + ul(a.risks) : ""}</section>
<section class="card agent"><h3>2 · Critic <span class="muted small">OpenAI · ${esc(run.models.openai)}</span></h3>
<p>${tag(o.bias)} <span class="muted">confidence ${esc(o.confidence)}% · ${o.agrees ? "agrees" : "disagrees"} with analyst</span></p><p>${esc(o.critique)}</p>
${o.missing && o.missing.length ? "<h4>What the analyst missed</h4>" + ul(o.missing) : ""}</section>
<section class="card agent"><h3>3 · Coordinator <span class="muted small">AURA · ${esc(run.models.aura)}</span></h3>
<p>${tag(r.bias)} <span class="muted">rule score ${esc(r.score)}</span></p>
<p class="muted small">Transparent rules on the same data: BTC 24h move, market breadth, Fear &amp; Greed (contrarian) and headline tone.</p>${ul(r.reasons)}</section></div>
<section class="card"><h3>Safety &amp; cost controls</h3><ul>
<li>Visitors only see stored runs; new runs are scheduled every 3 hours (or need an admin token).</li>
<li>AI spend today: $${b.spent_today_usd.toFixed(4)} of $${b.daily_cap_usd.toFixed(2)} · total $${b.spent_total_usd.toFixed(2)} of $${b.total_cap_usd.toFixed(2)}.</li>
<li>No agent can place trades. ${esc(run.disclaimer)}</li></ul></section>`;
}
