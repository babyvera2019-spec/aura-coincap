// Crypto headlines from public RSS feeds with a transparent keyword sentiment.
// Only title, source, time and link are shown; article bodies are never copied.
import { NEWS } from "./sample/data.js";

const BULLISH = new Set(("surge surges rally rallies soar soars jump jumps gain gains record high approval approved " +
  "inflow inflows adoption bullish rebound rebounds breakout upgrade launch launches partnership buy").split(" "));
const BEARISH = new Set(("crash crashes plunge plunges drop drops fall falls slump hack hacked exploit lawsuit sues ban " +
  "outflow outflows bearish liquidation liquidations selloff sell-off fraud low decline declines delay delays reject " +
  "rejects rejected fine fined").split(" "));

const TTL_MS = 10 * 60 * 1000;
let memo = null;

export function sentiment(title) {
  const words = title.toLowerCase().match(/[a-z][a-z-]+/g) || [];
  let score = 0;
  for (const w of words) score += BULLISH.has(w) ? 1 : BEARISH.has(w) ? -1 : 0;
  return score > 0 ? "bullish" : score < 0 ? "bearish" : "neutral";
}

const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, "&")
  .replace(/<[^>]+>/g, "")
  .trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
};

export function parseFeed(xml, fallbackSource) {
  const channel = xml.split(/<item[\s>]/i)[0];
  const source = tag(channel, "title") || fallbackSource;
  const items = [];
  for (const m of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
    const title = tag(m[1], "title");
    const link = tag(m[1], "link");
    if (!title || !/^https?:\/\//.test(link)) continue;
    const pub = Date.parse(tag(m[1], "pubDate"));
    items.push({ title, link, source, published: Number.isNaN(pub) ? null : new Date(pub).toISOString(), sentiment: sentiment(title) });
  }
  return items;
}

function sampleNews(errors = []) {
  return { items: NEWS.data.map((i) => ({ ...i, sentiment: sentiment(i.title) })), source: "demo-sample", errors };
}

export async function getNews(cfg, limit = 40) {
  if (memo && Date.now() - memo.at < TTL_MS) return memo.value;
  const errors = [];
  const results = await Promise.allSettled(cfg.newsFeeds.map(async (url) => {
    const r = await fetch(url, { headers: { "User-Agent": "AURA-CoinCap-Demo/0.2" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return parseFeed(await r.text(), new URL(url).host);
  }));
  let all = [];
  results.forEach((res, i) => {
    if (res.status === "fulfilled") all = all.concat(res.value);
    else errors.push(`${new URL(cfg.newsFeeds[i]).host}: ${res.reason.message}`);
  });
  if (!all.length) return sampleNews(errors);
  const seen = new Set();
  const items = all
    .sort((a, b) => (b.published || "").localeCompare(a.published || ""))
    .filter((i) => { const k = i.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, limit);
  const value = { items, source: "rss", errors };
  memo = { at: Date.now(), value };
  return value;
}

export function sentimentSummary(items) {
  const c = { bullish: 0, bearish: 0, neutral: 0 };
  for (const i of items) c[i.sentiment]++;
  return c;
}

export function _resetMemo() { memo = null; }
