// Reads settings from the Worker environment (vars + secrets).
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function config(env = {}) {
  return {
    cmcKey: env.CMC_API_KEY || "",
    cmcBase: env.CMC_BASE_URL || "https://pro-api.coinmarketcap.com",
    newsFeeds: (env.NEWS_FEEDS ||
      "https://www.coindesk.com/arc/outboundfeeds/rss/,https://cointelegraph.com/rss,https://decrypt.co/feed")
      .split(",").map((s) => s.trim()).filter(Boolean),
    anthropicKey: env.ANTHROPIC_API_KEY || "",
    claudeModel: env.CLAUDE_MODEL || "claude-sonnet-5-5",
    openaiKey: env.OPENAI_API_KEY || "",
    openaiModel: env.OPENAI_MODEL || "gpt-4o-mini",
    claudeIn: num(env.CLAUDE_PRICE_IN_PER_MTOK, 3),
    claudeOut: num(env.CLAUDE_PRICE_OUT_PER_MTOK, 15),
    openaiIn: num(env.OPENAI_PRICE_IN_PER_MTOK, 0.15),
    openaiOut: num(env.OPENAI_PRICE_OUT_PER_MTOK, 0.6),
    dailyBudget: num(env.AI_DAILY_BUDGET_USD, 0.3),
    totalBudget: num(env.AI_TOTAL_BUDGET_USD, 10),
    minMinutes: num(env.AI_MIN_MINUTES_BETWEEN_RUNS, 30),
    adminToken: env.ADMIN_TOKEN || "",
    kv: env.STATE || null,
    get demoMarket() { return !this.cmcKey; },
    get demoAi() { return !(this.anthropicKey && this.openaiKey); },
  };
}
