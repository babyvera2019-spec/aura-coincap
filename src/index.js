// AURA CoinCap — Cloudflare Worker entry point.
// Pages: /, /market, /news, /triple-ai · JSON: /api/* · Cron: market refresh + Triple AI.
import { config } from "./config.js";
import { getMarket, movers, refreshMarket } from "./cmc.js";
import { getNews, sentimentSummary } from "./news.js";
import * as triple from "./triple.js";
import { layout, overviewPage, marketPage, newsPage, triplePage } from "./render.js";

export const VERSION = "0.2.0";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
};

const html = (body, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60", ...SECURITY_HEADERS } });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" } });

// Constant-time comparison for the admin token.
function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function overviewData(cfg) {
  const [market, news, run] = await Promise.all([getMarket(cfg), getNews(cfg, 40), triple.latest(cfg)]);
  return { market, mv: movers(market.coins, 5), news, counts: sentimentSummary(news.items), run };
}

export default {
  async fetch(request, env) {
    const cfg = config(env);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const page = (title, active, body) => html(layout({ title, active, body, demoMarket: cfg.demoMarket, demoAi: cfg.demoAi }));

    try {
      if (request.method === "GET") {
        switch (path) {
          case "/":
            return page("Overview", "overview", overviewPage(await overviewData(cfg)));
          case "/market": {
            const market = await getMarket(cfg);
            return page("Market", "market", marketPage({ market, mv: movers(market.coins, 5) }));
          }
          case "/news": {
            const news = await getNews(cfg, 40);
            const t = url.searchParams.get("tag");
            const filter = ["bullish", "bearish", "neutral"].includes(t) ? t : "";
            return page("News", "news", newsPage({ news, counts: sentimentSummary(news.items), filter }));
          }
          case "/triple-ai":
            return page("Triple AI", "triple", triplePage({ run: await triple.latest(cfg) }));
          case "/api/overview": {
            const d = await overviewData(cfg);
            return json({ market: d.market, movers: d.mv, news: d.news, sentiment: d.counts, triple_ai: d.run });
          }
          case "/api/market": {
            const market = await getMarket(cfg);
            return json({ ...market, movers: movers(market.coins, 5) });
          }
          case "/api/news":
            return json(await getNews(cfg, 40));
          case "/api/triple-ai":
            return json(await triple.latest(cfg));
          case "/healthz":
            return json({ ok: true, version: VERSION, demo_market: cfg.demoMarket, demo_ai: cfg.demoAi, storage: Boolean(cfg.kv) });
        }
      }
      if (request.method === "POST" && path === "/api/triple-ai/run") {
        if (!cfg.adminToken || !safeEqual(request.headers.get("X-Admin-Token") || "", cfg.adminToken)) return json({ error: "forbidden" }, 403);
        try {
          return json(await triple.runOnce(cfg));
        } catch (e) {
          if (e instanceof triple.RunRefused) return json({ refused: e.message, budget: triple.budgetStatus(cfg, await triple.loadState(cfg)) }, 429);
          throw e;
        }
      }
      return html(layout({ title: "Not found", active: "", body: `<h1>Not found</h1><p class="muted"><a href="/">Back to the dashboard</a></p>`, demoMarket: false, demoAi: false }), 404);
    } catch (e) {
      console.error("request failed", e);
      return html(layout({ title: "Error", active: "", body: `<h1>Something went wrong</h1><p class="muted">Please try again in a minute.</p>`, demoMarket: false, demoAi: false }), 500);
    }
  },

  async scheduled(event, env, ctx) {
    const cfg = config(env);
    if (event.cron === "*/15 * * * *") {
      if (!cfg.demoMarket) ctx.waitUntil(refreshMarket(cfg).catch((e) => console.error("market refresh failed", e)));
      return;
    }
    ctx.waitUntil(
      triple.runOnce(cfg)
        .then((run) => console.log("triple ai", JSON.stringify({ verdict: run.consensus, cost: run.cost_usd })))
        .catch((e) => console.log("triple ai skipped:", e.message)),
    );
  },
};
