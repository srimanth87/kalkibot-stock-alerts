const MCP_URL = "https://agent.robinhood.com/mcp/trading";
const DEFAULT_ORDER_TYPE = "limit";
const DEFAULT_TIME_IN_FORCE = "gfd";
const DEFAULT_MARKET_HOURS = "regular_hours";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return cors(null, 204);

    try {
      if (url.pathname === "/health") {
        return json({
          ok: true,
          service: "kalki-robinhood-dashboard",
          mode: "production-wiring",
          robinhood_configured: robinhoodConfigured(env),
          account_configured: Boolean(accountNumber(env)),
          scorer_webhook_configured: Boolean(env.SCORER_WEBHOOK_SECRET),
          auto_trade_enabled: autoTradeEnabled(env),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/config") {
        return json(publicConfig(env));
      }

      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        return await handleDashboard(env);
      }

      if (request.method === "POST" && url.pathname === "/api/review-order") {
        const body = await request.json().catch(() => ({}));
        return await handleReviewOrder(env, body);
      }

      if (request.method === "POST" && url.pathname === "/api/place-order") {
        const body = await request.json().catch(() => ({}));
        return await handlePlaceOrder(env, body);
      }

      if (request.method === "POST" && url.pathname === "/api/alerts/scorer") {
        return await handleScorerAlert(request, env);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ ok: false, error: errorMessage(error) }, 500);
    }
  },
};

async function handleDashboard(env) {
  if (!robinhoodConfigured(env)) {
    return json({
      ok: false,
      connected: false,
      setup: setupChecklist(env),
      error: "Robinhood MCP bearer token is not configured for this Worker.",
    }, 503);
  }

  const accounts = await callRobinhood(env, "get_accounts", {});
  const account = selectAccount(accounts?.data?.accounts || [], env);
  if (!account) {
    return json({
      ok: false,
      connected: true,
      setup: setupChecklist(env),
      accounts: accounts?.data?.accounts || [],
      error: "No Robinhood account selected. Set ROBINHOOD_ACCOUNT_NUMBER, or use an agentic_allowed account for trading.",
    }, 409);
  }

  const [portfolio, positions, orders] = await Promise.all([
    callRobinhood(env, "get_portfolio", { account_number: account.account_number }),
    callRobinhood(env, "get_equity_positions", { account_number: account.account_number }),
    callRobinhood(env, "get_equity_orders", { account_number: account.account_number }),
  ]);

  const longPositions = (positions?.data?.positions || []).filter((position) => Number(position.quantity || 0) > 0);
  const quoteSymbols = longPositions.map((position) => position.symbol).filter(Boolean).slice(0, 20);
  const quotes = quoteSymbols.length
    ? await callRobinhood(env, "get_equity_quotes", { symbols: quoteSymbols })
    : { data: { results: [] } };

  return json({
    ok: true,
    connected: true,
    config: publicConfig(env),
    account: publicAccount(account),
    accounts: (accounts?.data?.accounts || []).map(publicAccount),
    portfolio: normalizePortfolio(portfolio?.data),
    positions: normalizePositions(longPositions, quotes?.data?.results || []),
    orders: normalizeOrders(orders?.data?.orders || []),
    setup: setupChecklist(env),
  });
}

async function handleReviewOrder(env, body) {
  requireRobinhood(env);
  const order = normalizeOrderRequest(body, env);
  const review = await callRobinhood(env, "review_equity_order", order);
  return json({ ok: true, order, review: review?.data || review });
}

async function handlePlaceOrder(env, body) {
  requireRobinhood(env);
  if (body.confirm !== true) {
    return json({ ok: false, error: "Explicit confirm=true is required before placing a real Robinhood order." }, 400);
  }

  const order = normalizeOrderRequest(body, env);
  const review = await callRobinhood(env, "review_equity_order", order);
  const checks = review?.data?.order_checks || {};
  if (Object.keys(checks).length && body.overrideBrokerAlert !== true) {
    return json({
      ok: false,
      error: "Broker review returned alerts. Pass overrideBrokerAlert=true only after the user explicitly confirms the alert.",
      order,
      review: review?.data || review,
    }, 409);
  }

  const placed = await callRobinhood(env, "place_equity_order", {
    ...order,
    ref_id: crypto.randomUUID(),
  });
  return json({ ok: true, order, review: review?.data || review, placed: placed?.data || placed });
}

async function handleScorerAlert(request, env) {
  requireScorerAuth(request, env);
  requireRobinhood(env);

  const body = await request.json().catch(() => ({}));
  const text = body.text || body.alert || body.message?.text || body.channel_post?.text || "";
  const alert = parseKalkiAlert(text);
  if (!alert) return json({ ok: false, error: "No tradeable Kalki scorer alert found in payload." }, 400);

  const decision = buildDecision(alert, env);
  if (!decision.tradeable) {
    return json({ ok: true, status: "skipped", alert, decision });
  }

  const order = {
    account_number: accountNumber(env),
    symbol: alert.ticker,
    side: "buy",
    type: env.ROBINHOOD_ORDER_TYPE || DEFAULT_ORDER_TYPE,
    quantity: String(decision.shares),
    time_in_force: env.ROBINHOOD_TIME_IN_FORCE || DEFAULT_TIME_IN_FORCE,
    market_hours: env.ROBINHOOD_MARKET_HOURS || DEFAULT_MARKET_HOURS,
  };
  if (order.type === "limit") order.limit_price = toMoney(alert.entryPrice);

  const review = await callRobinhood(env, "review_equity_order", order);
  const reviewData = review?.data || review;

  if (!autoTradeEnabled(env)) {
    return json({
      ok: true,
      status: "reviewed_not_placed",
      reason: "ROBINHOOD_AUTO_TRADE is not enabled. The alert was reviewed but no order was placed.",
      alert,
      decision,
      order,
      review: reviewData,
    });
  }

  const checks = reviewData?.order_checks || {};
  if (Object.keys(checks).length && env.ROBINHOOD_ALLOW_BROKER_ALERT_OVERRIDES !== "true") {
    return json({
      ok: true,
      status: "skipped",
      reason: "Broker review returned alerts; auto-trade skipped.",
      alert,
      decision,
      order,
      review: reviewData,
    });
  }

  const placed = await callRobinhood(env, "place_equity_order", {
    ...order,
    ref_id: crypto.randomUUID(),
  });

  return json({
    ok: true,
    status: "submitted",
    alert,
    decision,
    order,
    review: reviewData,
    placed: placed?.data || placed,
  });
}

async function callRobinhood(env, toolName, args) {
  requireRobinhood(env);
  const response = await fetch(env.ROBINHOOD_MCP_URL || MCP_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.ROBINHOOD_MCP_BEARER_TOKEN}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    }),
  });

  const text = await response.text();
  const data = parseMcpResponse(text);
  if (!response.ok || data?.error) {
    throw new Error(data?.error?.message || data?.message || text || `Robinhood MCP ${toolName} failed with HTTP ${response.status}`);
  }

  const content = data?.result?.content;
  if (Array.isArray(content) && content[0]?.text) {
    return JSON.parse(content[0].text);
  }
  return data?.result || data;
}

function parseMcpResponse(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const dataLine = trimmed.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!dataLine) return {};
    return JSON.parse(dataLine.slice(5).trim());
  }
  return JSON.parse(trimmed);
}

function normalizeOrderRequest(body, env) {
  const account = String(body.account_number || body.accountNumber || accountNumber(env) || "").trim();
  if (!account) throw new Error("account_number is required. Set ROBINHOOD_ACCOUNT_NUMBER or pass account_number.");

  const type = String(body.type || DEFAULT_ORDER_TYPE).trim().toLowerCase();
  const order = {
    account_number: account,
    symbol: String(body.symbol || "").trim().toUpperCase(),
    side: String(body.side || "buy").trim().toLowerCase(),
    type,
    time_in_force: String(body.time_in_force || body.timeInForce || DEFAULT_TIME_IN_FORCE).trim().toLowerCase(),
    market_hours: String(body.market_hours || body.marketHours || DEFAULT_MARKET_HOURS).trim(),
  };
  if (!order.symbol) throw new Error("symbol is required");
  if (!["buy", "sell"].includes(order.side)) throw new Error("side must be buy or sell");
  if (!["market", "limit", "stop_market", "stop_limit"].includes(type)) throw new Error("unsupported order type");

  if (body.quantity != null && body.quantity !== "") order.quantity = String(body.quantity);
  if (body.dollar_amount != null || body.dollarAmount != null) order.dollar_amount = String(body.dollar_amount || body.dollarAmount);
  if (!order.quantity && !order.dollar_amount) throw new Error("quantity or dollar_amount is required");
  if (order.quantity && order.dollar_amount) throw new Error("provide exactly one of quantity or dollar_amount");
  if (type === "limit" || type === "stop_limit") order.limit_price = toMoney(body.limit_price || body.limitPrice);
  if (type === "stop_market" || type === "stop_limit") order.stop_price = toMoney(body.stop_price || body.stopPrice);

  return order;
}

function selectAccount(accounts, env) {
  const configured = accountNumber(env);
  if (configured) return accounts.find((account) => String(account.account_number) === configured) || null;
  return accounts.find((account) => account.agentic_allowed === true) || accounts.find((account) => account.is_default === true) || accounts[0] || null;
}

function publicAccount(account) {
  return {
    account_number: maskAccount(account.account_number),
    brokerage_account_type: account.brokerage_account_type || null,
    type: account.type || null,
    nickname: account.nickname || null,
    is_default: Boolean(account.is_default),
    agentic_allowed: Boolean(account.agentic_allowed),
    management_type: account.management_type || null,
    state: account.state || null,
  };
}

function normalizePortfolio(data = {}) {
  return {
    total_value: numberOrNull(data.total_value),
    equity_value: numberOrNull(data.equity_value),
    options_value: numberOrNull(data.options_value),
    crypto_value: numberOrNull(data.crypto_value),
    cash: numberOrNull(data.cash),
    buying_power: numberOrNull(data.buying_power?.buying_power),
    currency: data.currency || data.buying_power?.display_currency || "USD",
  };
}

function normalizePositions(positions, quoteResults) {
  const quoteBySymbol = new Map(quoteResults.map((result) => [result.quote?.symbol, result.quote]));
  return positions.map((position) => {
    const quote = quoteBySymbol.get(position.symbol) || {};
    const quantity = numberOrNull(position.quantity) || 0;
    const avg = numberOrNull(position.average_buy_price);
    const current = numberOrNull(quote.last_trade_price);
    const unrealized = avg != null && current != null ? roundMoney((current - avg) * quantity) : null;
    const unrealized_pct = avg && current != null ? ((current / avg) - 1) * 100 : null;
    return {
      symbol: position.symbol,
      quantity,
      average_buy_price: avg,
      current_price: current,
      unrealized,
      unrealized_pct: unrealized_pct == null ? null : roundMoney(unrealized_pct),
      is_green: unrealized != null ? unrealized > 0 : null,
    };
  });
}

function normalizeOrders(orders) {
  return orders.slice(0, 30).map((order) => ({
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    state: order.state,
    quantity: numberOrNull(order.quantity),
    cumulative_quantity: numberOrNull(order.cumulative_quantity),
    price: numberOrNull(order.price),
    average_price: numberOrNull(order.average_price),
    created_at: order.created_at,
    last_transaction_at: order.last_transaction_at,
    placed_agent: order.placed_agent,
  }));
}

function parseKalkiAlert(text) {
  const raw = String(text || "");
  const tickerMatch = raw.match(/(?:^|\n)\s*(?:[^\w\s]|\u26a1)?\s*\*?([A-Z][A-Z0-9.]{0,9})\*?(?:\s|$)/) ||
    raw.match(/\bTicker:\s*\*?([A-Z][A-Z0-9.]{0,9})\*?\b/i);
  const gradeMatch = raw.match(/Grade\s*:\s*\*?\s*([A-D][+-]?)/i);
  const entryRange = parseMoneyRange(raw, "Entry");
  const stopRange = parseMoneyRange(raw, "Stop(?:\\s+Loss)?");
  const t1Match = raw.match(/\b(?:T1|TP1|Target\s*1)\s*:\s*\*?\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!tickerMatch || !gradeMatch || !entryRange || !stopRange || !t1Match) return null;

  return {
    ticker: tickerMatch[1].toUpperCase(),
    grade: gradeMatch[1].toUpperCase(),
    entryPrice: roundMoney((entryRange.low + entryRange.high) / 2),
    stopPrice: roundMoney(stopRange.low),
    t1: Number(t1Match[1]),
    raw,
  };
}

function parseMoneyRange(text, labelPattern) {
  const match = String(text || "").match(new RegExp(`${labelPattern}\\s*:\\s*\\*?\\s*\\$?\\s*([0-9]+(?:\\.[0-9]+)?)(?:\\s*(?:-|–|—|to)\\s*\\$?\\s*([0-9]+(?:\\.[0-9]+)?))?`, "i"));
  if (!match) return null;
  const first = Number.parseFloat(match[1]);
  const second = match[2] ? Number.parseFloat(match[2]) : first;
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  return { low: Math.min(first, second), high: Math.max(first, second) };
}

function buildDecision(alert, env) {
  const positionSize = Math.max(0, Number(env.ROBINHOOD_POSITION_SIZE || 100));
  const shares = Math.floor(positionSize / alert.entryPrice);
  if (shares < 1) return { tradeable: false, reason: "position size too small", shares, position_size: positionSize };
  return { tradeable: true, reason: "accepted", shares, position_size: positionSize, notional: roundMoney(shares * alert.entryPrice) };
}

function publicConfig(env) {
  return {
    ok: true,
    connected: robinhoodConfigured(env),
    account_configured: Boolean(accountNumber(env)),
    scorer_webhook_configured: Boolean(env.SCORER_WEBHOOK_SECRET),
    auto_trade_enabled: autoTradeEnabled(env),
    webhook_url: "/api/alerts/scorer",
    setup: setupChecklist(env),
  };
}

function setupChecklist(env) {
  return [
    { key: "ROBINHOOD_MCP_BEARER_TOKEN", done: robinhoodConfigured(env), label: "Set Robinhood MCP bearer token as a Worker secret" },
    { key: "ROBINHOOD_ACCOUNT_NUMBER", done: Boolean(accountNumber(env)), label: "Set the Robinhood account number to use for reads/trades" },
    { key: "SCORER_WEBHOOK_SECRET", done: Boolean(env.SCORER_WEBHOOK_SECRET), label: "Set scorer webhook secret for authenticated alert intake" },
    { key: "ROBINHOOD_AUTO_TRADE", done: autoTradeEnabled(env), label: "Optional: enable automatic placement after review passes" },
  ];
}

function requireScorerAuth(request, env) {
  if (!env.SCORER_WEBHOOK_SECRET) throw new Error("SCORER_WEBHOOK_SECRET is not configured");
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : request.headers.get("x-scorer-secret");
  if (token !== env.SCORER_WEBHOOK_SECRET) throw new Error("Unauthorized scorer webhook request");
}

function requireRobinhood(env) {
  if (!robinhoodConfigured(env)) throw new Error("ROBINHOOD_MCP_BEARER_TOKEN is not configured");
}

function robinhoodConfigured(env) {
  return Boolean(env.ROBINHOOD_MCP_BEARER_TOKEN);
}

function autoTradeEnabled(env) {
  return env.ROBINHOOD_AUTO_TRADE === "true";
}

function accountNumber(env) {
  return String(env.ROBINHOOD_ACCOUNT_NUMBER || "").trim();
}

function maskAccount(value) {
  const raw = String(value || "");
  return raw ? `••••${raw.slice(-4)}` : "";
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function toMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error("price must be a positive number");
  return number.toFixed(2);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "Unknown error";
}

function json(data, status = 200) {
  return cors(JSON.stringify(data), status, {
    "Content-Type": "application/json; charset=utf-8",
  });
}

function cors(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Scorer-Secret",
      ...headers,
    },
  });
}
