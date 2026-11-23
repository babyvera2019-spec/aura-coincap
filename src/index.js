// AURA CoinCap — Cloudflare Worker entry point.
// Pages: /, /market, /news, /triple-ai · JSON: /api/* · Cron: market refresh + Triple AI.
import { config } from "./config.js";
import { getMarket, movers, refreshMarket } from "./cmc.js";
import { getNews, sentimentSummary } from "./news.js";
import * as triple from "./triple.js";
import { layout, overviewPage, marketPage, newsPage, triplePage, coinPage } from "./render.js";

export const VERSION = "0.3.0";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'",
};

const html = (body, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60", ...SECURITY_HEADERS } });
const noStore = (r) => { r.headers.set("Cache-Control", "no-store"); return r; };
const redirect = (to) => new Response(null, { status: 303, headers: { Location: to, "Cache-Control": "no-store" } });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" } });

// Constant-time comparison for the admin token.
function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Top 50 coins a visitor can pick for a coin analysis (no stablecoins).
const pickable = (market) => market.coins.filter(triple.isAnalyzable).slice(0, 50);

// Same-site check for the coin form, so other websites cannot make visitors spend the AI budget.
function sameSite(request, url) {
  const src = request.headers.get("Origin") || request.headers.get("Referer");
  if (!src) return false;
  try { return new URL(src).host === url.host; } catch { return false; }
}

async function coinView(cfg, symbol, msg) {
  const [market, run, state] = await Promise.all([getMarket(cfg), triple.latestCoin(cfg, symbol), triple.loadState(cfg)]);
  return { symbol, coin: market.coins.find((c) => c.symbol === symbol) || null, run, coins: pickable(market), msg, budget: triple.budgetStatus(cfg, state) };
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
          case "/triple-ai": {
            const [run, market, recent] = await Promise.all([triple.latest(cfg), getMarket(cfg), triple.recentCoins(cfg)]);
            return page("Triple AI", "triple", triplePage({ run: { ...run, coin_cache_minutes: cfg.coinCacheMinutes }, coins: pickable(market), recent }));
          }
          case "/triple-ai/coin": {
            const symbol = triple.normalizeSymbol(url.searchParams.get("symbol"));
            if (!symbol) return redirect("/triple-ai");
            const msg = (url.searchParams.get("msg") || "").replace(/[^a-z_]/g, "");
            return noStore(page(`${symbol} · Triple AI`, "triple", coinPage(await coinView(cfg, symbol, msg))));
          }
          case "/api/triple-ai/coin": {
            const symbol = triple.normalizeSymbol(url.searchParams.get("symbol"));
            const run = symbol ? await triple.latestCoin(cfg, symbol) : null;
            return run ? json(run) : json({ error: "no analysis for this symbol yet" }, 404);
          }
          case "/api/cmc-status": {
            const market = await getMarket(cfg);
            return json({ source: market.source, as_of: market.as_of, calls: market.calls || [], error: market.error });
          }
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
      if (request.method === "POST" && path === "/triple-ai/coin") {
        const form = await request.formData().catch(() => null);
        const symbol = triple.normalizeSymbol(form && form.get("symbol"));
        if (!symbol) return redirect("/triple-ai");
        const back = (msg) => redirect(`/triple-ai/coin?symbol=${encodeURIComponent(symbol)}${msg ? "&msg=" + msg : ""}`);
        if (!sameSite(request, url)) return back("");
        try {
          const { cached } = await triple.runCoin(cfg, symbol, request.headers.get("CF-Connecting-IP") || "");
          return back(cached ? "cached" : "");
        } catch (e) {
          if (e instanceof triple.RunRefused) return back(e.code);
          console.error("coin run failed", e);
          return back("error");
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
