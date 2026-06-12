const MCP_URL = "https://agent.robinhood.com/mcp/trading";
const AUTHORIZATION_ENDPOINT = "https://robinhood.com/oauth";
const REGISTRATION_ENDPOINT = "https://agent.robinhood.com/oauth/trading/register";
const TOKEN_ENDPOINT = "https://api.robinhood.com/oauth2/token/";
const RESOURCE = "https://agent.robinhood.com/mcp/trading";
const DEFAULT_ORDER_TYPE = "limit";
const DEFAULT_TIME_IN_FORCE = "gfd";
const DEFAULT_MARKET_HOURS = "regular_hours";
const TOKEN_KEY = "robinhood:tokens";
const CLIENT_KEY = "robinhood:client";
const SNAPSHOT_KEY = "robinhood:snapshot";

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
          robinhood_configured: await robinhoodConfigured(env),
          account_configured: Boolean(accountNumber(env)),
          scorer_webhook_configured: Boolean(env.SCORER_WEBHOOK_SECRET),
          auto_trade_enabled: autoTradeEnabled(env),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/robinhood/connect") {
        return await handleRobinhoodConnect(request, env);
      }

      if (request.method === "GET" && url.pathname === "/api/robinhood/callback") {
        return await handleRobinhoodCallback(request, env);
      }

      if (request.method === "GET" && url.pathname === "/api/robinhood/logout") {
        await env.ROBINHOOD_STATE?.delete(TOKEN_KEY);
        return Response.redirect(dashboardUrl(env), 302);
      }

      if (request.method === "GET" && url.pathname === "/api/config") {
        return json(await publicConfig(env));
      }

      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        return await handleDashboard(env);
      }

      if (url.pathname === "/api/robinhood/snapshot") {
        if (request.method === "GET") return await handleGetRobinhoodSnapshot(env);
        if (request.method === "POST") return await handlePutRobinhoodSnapshot(request, env);
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

      if (request.method === "POST" && url.pathname === "/api/alerts/lux") {
        return await handleLuxAlert(request, env);
      }

      // ── Telegram / D1 signal routes ──────────────────────────────────────
      if (request.method === "GET" && url.pathname === "/api/signals/pending") {
        return await handlePendingSignals(env);
      }

      if (request.method === "GET" && url.pathname === "/api/signals/approved") {
        return await handleApprovedSignals(env);
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/signals/") && url.pathname.endsWith("/approve")) {
        const id = url.pathname.split("/")[3];
        return await handleApproveSignal(request, env, id);
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/signals/") && url.pathname.endsWith("/dismiss")) {
        const id = url.pathname.split("/")[3];
        return await handleDismissSignal(request, env, id);
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/signals/") && url.pathname.endsWith("/executed")) {
        const id = url.pathname.split("/")[3];
        return await handleMarkExecuted(env, id);
      }

      if (request.method === "POST" && url.pathname === "/api/signals/close") {
        const body = await request.json().catch(() => ({}));
        return await handleCloseSignal(env, body);
      }

      if (request.method === "POST" && url.pathname === "/api/alerts/ingest") {
        return await handleIngestAlert(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/alerts/tradingview") {
        return await handleTradingViewAlert(request, env);
      }

      if (url.pathname === "/api/agent-config") {
        if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const cfg = normalizeAgentConfig(body);
          await env.ROBINHOOD_STATE?.put("agent:config", JSON.stringify(cfg));
          return json({ ok: true });
        }
        return json({ ok: true, config: await getAgentConfig(env) });
      }

      // ── MCP server (for Claude Code to connect to) ───────────────────────
      if (url.pathname === "/mcp") {
        return await handleMcp(request, env);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ ok: false, error: errorMessage(error) }, 500);
    }
  },
};

async function handleDashboard(env) {
  if (!(await robinhoodConfigured(env))) {
    const snapshot = await getStoredSnapshot(env);
    if (snapshot) return json(snapshot);

    return json({
      ok: false,
      connected: false,
      setup: await setupChecklist(env),
      error: "Robinhood is not connected. Use Connect Robinhood to complete OAuth.",
    }, 503);
  }

  try {
    const accounts = await callRobinhood(env, "get_accounts", {});
    const account = selectAccount(accounts?.data?.accounts || [], env);
    if (!account) {
      return json({
        ok: false,
        connected: true,
        setup: await setupChecklist(env),
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
      source: "worker-robinhood-oauth",
      config: await publicConfig(env),
      account: publicAccount(account),
      accounts: (accounts?.data?.accounts || []).map(publicAccount),
      portfolio: normalizePortfolio(portfolio?.data),
      positions: normalizePositions(longPositions, quotes?.data?.results || []),
      orders: normalizeOrders(orders?.data?.orders || []),
      setup: await setupChecklist(env),
    });
  } catch (error) {
    const snapshot = await getStoredSnapshot(env);
    if (snapshot) return json({ ...snapshot, warning: errorMessage(error) });
    throw error;
  }
}

async function handleGetRobinhoodSnapshot(env) {
  const snapshot = await getStoredSnapshot(env);
  if (!snapshot) return json({ ok: false, connected: false, error: "No Robinhood snapshot has been synced yet." }, 404);
  return json(snapshot);
}

async function handlePutRobinhoodSnapshot(request, env) {
  requireSnapshotAuth(request, env);
  requireStateStore(env);
  const body = await request.json().catch(() => ({}));
  const snapshot = sanitizeSnapshot(body);
  await env.ROBINHOOD_STATE.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
  return json({ ok: true, synced_at: snapshot.synced_at, source: snapshot.source });
}

async function handleRobinhoodConnect(request, env) {
  requireStateStore(env);
  const client = await getOrRegisterClient(request, env);
  const state = base64Url(randomBytes(24));
  const codeVerifier = base64Url(randomBytes(48));
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const redirectUri = callbackUrl(request, env);

  await env.ROBINHOOD_STATE.put(`oauth:state:${state}`, JSON.stringify({
    codeVerifier,
    redirectUri,
    created_at: new Date().toISOString(),
  }), { expirationTtl: 600 });

  const auth = new URL(AUTHORIZATION_ENDPOINT);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", client.client_id);
  auth.searchParams.set("state", state);
  auth.searchParams.set("code_challenge", codeChallenge);
  auth.searchParams.set("code_challenge_method", "S256");
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("scope", "internal");
  auth.searchParams.set("resource", RESOURCE);
  return Response.redirect(auth.toString(), 302);
}

async function handleRobinhoodCallback(request, env) {
  requireStateStore(env);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return html("Robinhood OAuth callback is missing code or state.", 400);

  const stored = await env.ROBINHOOD_STATE.get(`oauth:state:${state}`, { type: "json" });
  if (!stored?.codeVerifier) return html("Robinhood OAuth state expired or was not found.", 400);
  await env.ROBINHOOD_STATE.delete(`oauth:state:${state}`);

  const client = await getOrRegisterClient(request, env);
  const token = await exchangeToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: stored.redirectUri,
    client_id: client.client_id,
    code_verifier: stored.codeVerifier,
    resource: RESOURCE,
  });
  await storeToken(env, token);
  return Response.redirect(dashboardUrl(env), 302);
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

// ── Telegram / D1 signal handlers ──────────────────────────────────────────

async function handleIngestAlert(request, env) {
  // Validate optional secret
  const secret = String(env.INGEST_SECRET || "").trim();
  if (secret) {
    const provided = request.headers.get("x-kalki-secret") || "";
    if (provided !== secret) return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const { ticker, grade, entry_price, stop_price, t1, t2, rr, raw, pattern, source, received_at } = body;
  if (!ticker || !grade || !entry_price) {
    return json({ ok: false, error: "ticker, grade, entry_price are required" }, 400);
  }

  if (!env.KALKI_SYNC_DB) return json({ ok: false, error: "KALKI_SYNC_DB not bound" }, 503);

  await ensureSignalColumns(env);

  const id = `auto-${ticker.toUpperCase()}-${Date.now()}`;
  const entryMid = Number(entry_price);
  const now = received_at || new Date().toISOString();

  // Build raw_json with all price data so parseSignalFromRow extracts correctly
  const rawJson = JSON.stringify({
    entryMid, entryLow: entryMid, entryHigh: entryMid,
    supLow: Number(stop_price) || null,
    resistances: [Number(t1)||null, Number(t2)||null].filter(Boolean),
    rr: Number(rr) || null,
    pattern: pattern || null,
    aiWhy: raw || null,
    source: source || "autotrader",
  });

  await env.KALKI_SYNC_DB.prepare(
    `INSERT OR REPLACE INTO group_alerts
      (id, sym, grade, note, raw_json, status, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
  ).bind(
    id,
    ticker.toUpperCase(),
    grade,
    pattern || null,
    rawJson,
    now,
    now,
  ).run();

  return json({ ok: true, ticker, grade, id });
}

async function handleTradingViewAlert(request, env) {
  const expected = String(env.TRADINGVIEW_WEBHOOK_SECRET || env.INGEST_SECRET || "").trim();
  const body = await request.json().catch(() => ({}));
  if (expected && String(body.secret || "").trim() !== expected) {
    return json({ ok: false, error: "Unauthorized TradingView webhook" }, 401);
  }
  const ticker = sanitizeTicker(body.ticker || body.symbol || body.syminfo?.ticker);
  const entry = positiveNumber(body.entry_price ?? body.entry ?? body.close ?? body.price);
  if (!ticker || !entry) return json({ ok: false, error: "ticker and entry_price are required" }, 400);

  const forwarded = new Request(request.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "tradingview",
      ticker,
      grade: body.grade || "A",
      entry_price: entry,
      stop_price: positiveNumber(body.stop_price ?? body.stop) || 0,
      t1: positiveNumber(body.t1 ?? body.target1) || 0,
      t2: positiveNumber(body.t2 ?? body.target2) || 0,
      rr: positiveNumber(body.rr) || null,
      pattern: body.pattern || body.alert_name || "TradingView alert",
      raw: body.raw || body.message || JSON.stringify(body),
      received_at: body.received_at || body.time || new Date().toISOString(),
    }),
  });
  return await handleIngestAlert(forwarded, { ...env, INGEST_SECRET: "" });
}

async function handleLuxAlert(request, env) {
  requireLuxAuth(request, env);
  if (!env.KALKI_SYNC_DB) return json({ ok: false, error: "KALKI_SYNC_DB not bound" }, 503);

  const body = await request.json().catch(() => ({}));
  const alert = normalizeLuxAlert(body);
  if (!alert) return json({ ok: false, error: "No tradeable Lux alert found in payload." }, 400);

  const now = alert.receivedAt || new Date().toISOString();
  const id = alert.id || `lux-${alert.ticker}-${stableSignalKey(alert)}`;
  const rawJson = JSON.stringify({
    source: "lux-algo-screener",
    sourceAlertId: alert.id || null,
    score: alert.score,
    scoreMax: alert.scoreMax,
    timeframe: alert.timeframe,
    entryMid: alert.entryMid,
    entryLow: alert.entryLow,
    entryHigh: alert.entryHigh,
    supLow: alert.stop,
    stop: alert.stop,
    resistances: alert.targets,
    rr: alert.rr,
    price: alert.price,
    changePct: alert.changePct,
    vwapLabel: alert.vwapLabel,
    vwapDev: alert.vwapDev,
    signal: alert.signal,
    pattern: alert.pattern,
    aiWhy: alert.note,
    rawAlert: alert.raw || null,
    receivedAt: now,
  });

  await env.KALKI_SYNC_DB.prepare(
    `INSERT OR REPLACE INTO group_alerts
      (id, sym, grade, note, raw_json, status, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
  ).bind(
    id,
    alert.ticker,
    alert.grade,
    alert.note,
    rawJson,
    now,
    now,
  ).run();

  return json({
    ok: true,
    id,
    ticker: alert.ticker,
    grade: alert.grade,
    entry_mid: alert.entryMid,
    stop: alert.stop,
    targets: alert.targets,
    app_queue: "/api/signals/pending",
  });
}

async function ensureSignalColumns(env) {
  const db = env.KALKI_SYNC_DB;
  await db.prepare(`ALTER TABLE group_alerts ADD COLUMN executed INTEGER DEFAULT 0`).run().catch(() => {});
  await db.prepare(`ALTER TABLE group_alerts ADD COLUMN executed_at TEXT`).run().catch(() => {});
  await db.prepare(`ALTER TABLE group_alerts ADD COLUMN approved INTEGER DEFAULT 0`).run().catch(() => {});
  await db.prepare(`ALTER TABLE group_alerts ADD COLUMN approved_at TEXT`).run().catch(() => {});
  await db.prepare(`ALTER TABLE group_alerts ADD COLUMN dismissed INTEGER DEFAULT 0`).run().catch(() => {});
  await db.prepare(`ALTER TABLE group_alerts ADD COLUMN dismissed_at TEXT`).run().catch(() => {});
  await db.prepare(`ALTER TABLE group_alerts ADD COLUMN dismissed_reason TEXT`).run().catch(() => {});
}

// keep alias for backward compat
const ensureExecutedColumn = ensureSignalColumns;

function parseSignalFromRow(row) {
  let raw = {};
  try { raw = row.raw_json ? JSON.parse(row.raw_json) : {}; } catch { raw = {}; }

  // Entry price: prefer parsed entryMid/entryLow, fall back to addedPrice (watchlist records)
  const entryMid = raw.entryMid ?? raw.addedPrice ?? null;
  const entryLow = raw.entryLow ?? entryMid;
  const entryHigh = raw.entryHigh ?? entryMid;

  // Stop: prefer parsed supLow, fall back to ~2% below entry
  const stop = raw.supLow ?? raw.stop ?? (entryMid ? Math.round(entryMid * 0.98 * 100) / 100 : null);

  // Targets: prefer resistances array, fall back to ~3% above entry
  const targets = (raw.resistances ?? raw.res ?? []).filter(Number.isFinite);
  const t1 = targets[0] ?? (entryMid ? Math.round(entryMid * 1.03 * 100) / 100 : null);
  const t2 = targets[1] ?? null;

  // Flag if prices were estimated vs parsed from a real alert
  const hasParsedPrices = Boolean(raw.entryMid ?? raw.entryLow ?? raw.supLow ?? raw.resistances);

  return {
    id: row.id,
    ticker: row.sym,
    grade: row.grade,
    score: raw.catalystScore ?? raw.aiScore ?? raw.score ?? null,
    pattern: row.note || raw.pattern || raw.aiSetup || null,
    entry_low: entryLow,
    entry_high: entryHigh,
    entry_mid: entryMid,
    stop,
    targets,
    t1,
    t2,
    has_parsed_prices: hasParsedPrices,
    ai_why: raw.aiWhy || null,
    source: raw.source || "telegram",
    added_at: row.added_at || row.updated_at,
  };
}

function normalizeAgentConfig(value = {}) {
  const cfg = value && typeof value === "object" ? value : {};
  const grades = Array.isArray(cfg.grades)
    ? cfg.grades.map((grade) => String(grade || "").trim()).filter(Boolean)
    : ["A+", "A"];
  const rawSources = cfg.sources && typeof cfg.sources === "object" ? cfg.sources : {};

  return {
    auto: cfg.auto === true,
    allGrades: cfg.allGrades === true,
    grades: grades.length ? grades : ["A+", "A"],
    sources: {
      telegram: rawSources.telegram !== false,
      tradingview: rawSources.tradingview !== false,
      cloudflarescreener: rawSources.cloudflarescreener !== false,
    },
    size: Number.isFinite(Number(cfg.size)) ? Number(cfg.size) : 500,
    maxSize: Number.isFinite(Number(cfg.maxSize)) ? Number(cfg.maxSize) : 1000,
    slip: Number.isFinite(Number(cfg.slip)) ? Number(cfg.slip) : 3,
    drop: Number.isFinite(Number(cfg.drop)) ? Number(cfg.drop) : 5,
    orderType: cfg.orderType || DEFAULT_ORDER_TYPE,
    tif: cfg.tif || DEFAULT_TIME_IN_FORCE,
    minBP: Number.isFinite(Number(cfg.minBP)) ? Number(cfg.minBP) : 200,
    allowEst: cfg.allowEst === true,
    autoT1: cfg.autoT1 === true,
    autoStop: cfg.autoStop === true,
    autoProfit: cfg.autoProfit === true,
    profitPct: Number.isFinite(Number(cfg.profitPct)) ? Math.max(0, Number(cfg.profitPct)) : 1,
  };
}

async function getAgentConfig(env) {
  const raw = await env.ROBINHOOD_STATE?.get("agent:config");
  if (!raw) return normalizeAgentConfig();
  try {
    return normalizeAgentConfig(JSON.parse(raw));
  } catch {
    return normalizeAgentConfig();
  }
}

function autoApproveSignalAllowed(signal, cfg) {
  if (!cfg.auto) return false;
  if (!signalSourceAllowed(signal, cfg)) return false;
  const gradeOk = cfg.allGrades || cfg.grades.includes(signal.grade);
  const priceOk = signal.has_parsed_prices || cfg.allowEst;
  return gradeOk && priceOk;
}

function configuredPositionSize(cfg) {
  const size = Number.isFinite(Number(cfg?.size)) ? Number(cfg.size) : 500;
  const maxSize = Number.isFinite(Number(cfg?.maxSize)) ? Number(cfg.maxSize) : 1000;
  return Math.max(0, Math.min(size, maxSize));
}

function signalNotional(signal, cfg) {
  const entry = Number(signal.entry_mid || signal.entry_high || signal.entry_low || 0);
  const positionSize = configuredPositionSize(cfg);
  if (!Number.isFinite(entry) || entry <= 0 || positionSize <= 0) return positionSize;
  const shares = Math.floor(positionSize / entry);
  if (shares < 1) return positionSize;
  return roundMoney(shares * entry);
}

function signalShares(signal, cfg) {
  const entry = Number(signal.entry_mid || signal.entry_high || signal.entry_low || 0);
  const positionSize = configuredPositionSize(cfg);
  if (!Number.isFinite(entry) || entry <= 0 || positionSize <= 0) return 0;
  return Math.floor(positionSize / entry);
}

async function currentBuyingPower(env) {
  try {
    if (await robinhoodConfigured(env)) {
      const accounts = await callRobinhood(env, "get_accounts", {});
      const account = selectAccount(accounts?.data?.accounts || [], env);
      if (account) {
        const portfolio = await callRobinhood(env, "get_portfolio", { account_number: account.account_number });
        return numberOrNull(portfolio?.data?.buying_power?.buying_power ?? portfolio?.data?.buying_power);
      }
    }
  } catch {}
  const snapshot = await getStoredSnapshot(env).catch(() => null);
  return numberOrNull(snapshot?.portfolio?.buying_power);
}

async function approvedOpenSignalReserve(env, cfg, excludeId = "") {
  if (!env.KALKI_SYNC_DB) return 0;
  const { results } = await env.KALKI_SYNC_DB.prepare(
    `SELECT id, sym, grade, note, added_at, updated_at, raw_json,
            approved, approved_at, executed, dismissed
     FROM group_alerts
     WHERE approved = 1
       AND (executed IS NULL OR executed = 0)
       AND (dismissed IS NULL OR dismissed = 0)
       AND (status IS NULL OR status != 'closed')
     ORDER BY approved_at DESC LIMIT 100`
  ).all();
  return (results || []).reduce((sum, row) => {
    if (row.id === excludeId) return sum;
    return sum + signalNotional(parseSignalFromRow(row), cfg);
  }, 0);
}

async function portfolioCapacityCheck(env, signal, cfg, excludeId = "") {
  const buyingPower = await currentBuyingPower(env);
  const shares = signalShares(signal, cfg);
  if (shares < 1) {
    return {
      ok: false,
      reason: `Position size too small for ${signal.ticker}. Increase position size above $${roundMoney(signal.entry_mid || signal.entry_high || signal.entry_low)} to buy at least 1 share.`,
      shares,
      required: signalNotional(signal, cfg),
    };
  }
  if (buyingPower == null) return { ok: true, reason: "buying power unavailable" };
  const reserve = await approvedOpenSignalReserve(env, cfg, excludeId);
  const available = Math.max(0, buyingPower - reserve);
  const notional = signalNotional(signal, cfg);
  if (notional <= 0) return { ok: false, reason: "position size is zero", buying_power: buyingPower, reserved: reserve, available, required: notional };
  if (available < notional) {
    return {
      ok: false,
      reason: `Not enough buying power. Available after approved queue: $${roundMoney(available)}; required: $${roundMoney(notional)}.`,
      buying_power: buyingPower,
      reserved: roundMoney(reserve),
      available: roundMoney(available),
      required: roundMoney(notional),
    };
  }
  return { ok: true, buying_power: buyingPower, reserved: roundMoney(reserve), available: roundMoney(available), required: roundMoney(notional) };
}

function signalSourceKey(signal) {
  const source = String(signal.source || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (source.includes("tradingview")) return "tradingview";
  if (source.includes("cloudflare") || source.includes("luxalgo") || source.includes("lux")) return "cloudflarescreener";
  return "telegram";
}

function signalSourceAllowed(signal, cfg) {
  const sources = cfg.sources || {};
  return sources[signalSourceKey(signal)] !== false;
}

async function handlePendingSignals(env) {
  if (!env.KALKI_SYNC_DB) {
    return json({ ok: false, error: "KALKI_SYNC_DB not bound." }, 503);
  }
  await ensureSignalColumns(env);
  const cfg = await getAgentConfig(env);
  const { results } = await env.KALKI_SYNC_DB.prepare(
    `SELECT id, sym, grade, note, added_at, updated_at, raw_json,
            approved, approved_at, executed, executed_at, dismissed, dismissed_at, dismissed_reason
     FROM group_alerts
     WHERE grade IN ('A+','A','B+')
       AND (status IS NULL OR status != 'closed')
     ORDER BY added_at DESC LIMIT 30`
  ).all();

  const signals = [];
  for (const row of results || []) {
    const signal = {
      ...parseSignalFromRow(row),
      approved: Boolean(row.approved),
      approved_at: row.approved_at || null,
      executed: Boolean(row.executed),
      executed_at: row.executed_at || null,
      dismissed: Boolean(row.dismissed),
      dismissed_at: row.dismissed_at || null,
      dismissed_reason: row.dismissed_reason || null,
    };

    if (!signalSourceAllowed(signal, cfg)) continue;

    if (!signal.executed && !signal.dismissed && !signal.approved && autoApproveSignalAllowed(signal, cfg)) {
      const capacity = await portfolioCapacityCheck(env, signal, cfg, signal.id);
      if (!capacity.ok) {
        signal.capacity = capacity;
        signals.push(signal);
        continue;
      }
      signal.approved = true;
      signal.approved_at = new Date().toISOString();
      await env.KALKI_SYNC_DB.prepare(
        `UPDATE group_alerts SET approved = 1, approved_at = ? WHERE id = ?`
      ).bind(signal.approved_at, signal.id).run();
    }

    signals.push(signal);
  }

  return json({ ok: true, signals });
}

async function handleApprovedSignals(env) {
  if (!env.KALKI_SYNC_DB) {
    return json({ ok: false, error: "KALKI_SYNC_DB not bound." }, 503);
  }
  await ensureSignalColumns(env);
  const cfg = await getAgentConfig(env);
  const { results } = await env.KALKI_SYNC_DB.prepare(
    `SELECT id, sym, grade, note, added_at, updated_at, raw_json,
            approved, approved_at, executed, executed_at, dismissed, dismissed_at, dismissed_reason
     FROM group_alerts
     WHERE approved = 1
       AND (executed IS NULL OR executed = 0)
       AND (dismissed IS NULL OR dismissed = 0)
       AND grade IN ('A+','A','B+')
     ORDER BY approved_at DESC LIMIT 20`
  ).all();
  const signals = (results || []).map(r => ({
    ...parseSignalFromRow(r),
    approved: true,
    approved_at: r.approved_at,
    executed: Boolean(r.executed),
    executed_at: r.executed_at || null,
    dismissed: Boolean(r.dismissed),
    dismissed_at: r.dismissed_at || null,
    dismissed_reason: r.dismissed_reason || null,
  })).filter(signal => signalSourceAllowed(signal, cfg));
  return json({ ok: true, signals });
}

async function handleCloseSignal(env, body) {
  if (!env.KALKI_SYNC_DB) return json({ ok: false, error: "KALKI_SYNC_DB not bound." }, 503);
  const symbol = String(body.symbol || "").trim().toUpperCase();
  const quantity = body.quantity != null ? String(body.quantity) : null;
  if (!symbol) return json({ ok: false, error: "symbol is required" }, 400);

  await ensureSignalColumns(env);
  const id = `close-${symbol.toLowerCase()}-${Date.now()}`;
  const now = new Date().toISOString();
  const raw = JSON.stringify({ side: "sell", quantity, aiWhy: `Dashboard close: sell all ${symbol}` });

  await env.KALKI_SYNC_DB.prepare(
    `INSERT OR REPLACE INTO group_alerts (id, sym, grade, note, raw_json, status, added_at, updated_at, approved, approved_at)
     VALUES (?, ?, 'A+', ?, ?, 'close', ?, ?, 1, ?)`
  ).bind(id, symbol, `Close position: ${symbol}`, raw, now, now, now).run();

  return json({ ok: true, id, symbol, message: `Close signal queued — Claude will sell ${symbol} shortly` });
}

async function handleApproveSignal(request, env, id) {
  if (!env.KALKI_SYNC_DB) return json({ ok: false, error: "KALKI_SYNC_DB not bound." }, 503);
  if (!id) return json({ ok: false, error: "Signal id required." }, 400);
  const body = await request.json().catch(() => ({}));
  if (body.manual !== true) {
    return json({ ok: false, error: "Manual approval confirmation is required." }, 409);
  }
  await ensureSignalColumns(env);
  const row = await env.KALKI_SYNC_DB.prepare(
    `SELECT id, sym, grade, note, added_at, updated_at, raw_json,
            approved, approved_at, executed, dismissed
     FROM group_alerts WHERE id = ?`
  ).bind(id).first();
  if (!row) return json({ ok: false, error: "Signal not found." }, 404);
  const cfg = await getAgentConfig(env);
  const capacity = await portfolioCapacityCheck(env, parseSignalFromRow(row), cfg, id);
  if (!capacity.ok) return json({ ok: false, error: capacity.reason, capacity }, 409);
  await env.KALKI_SYNC_DB.prepare(
    `UPDATE group_alerts SET approved = 1, approved_at = ? WHERE id = ?`
  ).bind(new Date().toISOString(), id).run();
  return json({ ok: true, id, approved: true });
}

async function handleDismissSignal(request, env, id) {
  if (!env.KALKI_SYNC_DB) return json({ ok: false, error: "KALKI_SYNC_DB not bound." }, 503);
  if (!id) return json({ ok: false, error: "Signal id required." }, 400);
  const body = await request.json().catch(() => ({}));
  const reason = sanitizeDismissReason(body.reason || body.message || "Dismissed from dashboard.");
  const dismissedAt = new Date().toISOString();
  await ensureSignalColumns(env);
  await env.KALKI_SYNC_DB.prepare(
    `UPDATE group_alerts SET dismissed = 1, dismissed_at = ?, dismissed_reason = ? WHERE id = ?`
  ).bind(dismissedAt, reason, id).run();
  return json({ ok: true, id, dismissed: true, dismissed_at: dismissedAt, dismissed_reason: reason });
}

function sanitizeDismissReason(value) {
  return String(value || "Dismissed.").replace(/\s+/g, " ").trim().slice(0, 500);
}

async function handleMarkExecuted(env, id) {
  if (!env.KALKI_SYNC_DB) return json({ ok: false, error: "KALKI_SYNC_DB not bound." }, 503);
  if (!id) return json({ ok: false, error: "Signal id required." }, 400);
  await ensureSignalColumns(env);
  await env.KALKI_SYNC_DB.prepare(
    `UPDATE group_alerts SET executed = 1, executed_at = ? WHERE id = ?`
  ).bind(new Date().toISOString(), id).run();
  return json({ ok: true, id, executed: true });
}

// ── MCP server — lets Claude Code connect via:
//    claude mcp add kalki-signals --transport http https://api.kalkianalysis.com/mcp
async function handleMcp(request, env) {
  if (request.method === "GET") {
    // SSE handshake for streamable-http transport
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = await request.json().catch(() => ({}));
  const { method, params, id } = body;

  // MCP initialize handshake
  if (method === "initialize") {
    return mcpResponse(id, {
      protocolVersion: "2024-11-05",
      serverInfo: { name: "kalki-signals", version: "1.0.0" },
      capabilities: { tools: {} },
    });
  }

  // List available tools
  if (method === "tools/list") {
    return mcpResponse(id, {
      tools: [
        {
          name: "get_pending_signals",
          description: "Get all pending Kalki signals (approved and unapproved). Use this to show the full feed.",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
          name: "get_approved_signals",
          description: "Get only user-approved signals ready for Robinhood execution. Poll this every 30s during market hours.",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
          name: "mark_signal_executed",
          description: "Mark a signal as executed after placing the Robinhood trade",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string", description: "Signal ID" } },
            required: ["id"],
          },
        },
        {
          name: "dismiss_signal",
          description: "Dismiss a signal without trading it. Include a concise reason so the dashboard can show the user why it was skipped.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", description: "Signal ID" },
              reason: { type: "string", description: "Human-readable reason for dismissal" },
            },
            required: ["id"],
          },
        },
      ],
    });
  }

  // Execute a tool
  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (toolName === "get_pending_signals") {
      if (!env.KALKI_SYNC_DB) return mcpError(id, "KALKI_SYNC_DB not bound.");
      await ensureSignalColumns(env);
      const { results } = await env.KALKI_SYNC_DB.prepare(
        `SELECT id, sym, grade, note, added_at, updated_at, raw_json, approved, approved_at, executed, dismissed
         FROM group_alerts
         WHERE (executed IS NULL OR executed = 0)
           AND (dismissed IS NULL OR dismissed = 0)
           AND grade IN ('A+','A','B+')
           AND (status IS NULL OR status != 'closed')
         ORDER BY added_at DESC LIMIT 20`
      ).all();
      const signals = results.map(r => ({ ...parseSignalFromRow(r), approved: Boolean(r.approved), approved_at: r.approved_at }));
      return mcpResponse(id, {
        content: [{ type: "text", text: JSON.stringify({ ok: true, count: signals.length, signals }) }],
      });
    }

    if (toolName === "get_approved_signals") {
      if (!env.KALKI_SYNC_DB) return mcpError(id, "KALKI_SYNC_DB not bound.");
      await ensureSignalColumns(env);
      const { results } = await env.KALKI_SYNC_DB.prepare(
        `SELECT id, sym, grade, note, added_at, updated_at, raw_json, approved, approved_at
         FROM group_alerts
         WHERE approved = 1
           AND (executed IS NULL OR executed = 0)
           AND (dismissed IS NULL OR dismissed = 0)
           AND grade IN ('A+','A','B+')
         ORDER BY approved_at DESC LIMIT 20`
      ).all();
      const signals = results.map(r => ({ ...parseSignalFromRow(r), approved: true, approved_at: r.approved_at }));
      return mcpResponse(id, {
        content: [{ type: "text", text: JSON.stringify({ ok: true, count: signals.length, signals }) }],
      });
    }

    if (toolName === "mark_signal_executed") {
      if (!env.KALKI_SYNC_DB) return mcpError(id, "KALKI_SYNC_DB not bound.");
      if (!args.id) return mcpError(id, "id is required");
      await ensureSignalColumns(env);
      await env.KALKI_SYNC_DB.prepare(
        `UPDATE group_alerts SET executed = 1, executed_at = ? WHERE id = ?`
      ).bind(new Date().toISOString(), args.id).run();
      return mcpResponse(id, {
        content: [{ type: "text", text: JSON.stringify({ ok: true, id: args.id, executed: true }) }],
      });
    }

    if (toolName === "dismiss_signal") {
      if (!env.KALKI_SYNC_DB) return mcpError(id, "KALKI_SYNC_DB not bound.");
      if (!args.id) return mcpError(id, "id is required");
      await ensureSignalColumns(env);
      const reason = sanitizeDismissReason(args.reason || "Dismissed by Claude.");
      const dismissedAt = new Date().toISOString();
      await env.KALKI_SYNC_DB.prepare(
        `UPDATE group_alerts SET dismissed = 1, dismissed_at = ?, dismissed_reason = ? WHERE id = ?`
      ).bind(dismissedAt, reason, args.id).run();
      return mcpResponse(id, {
        content: [{ type: "text", text: JSON.stringify({ ok: true, id: args.id, dismissed: true, dismissed_at: dismissedAt, dismissed_reason: reason }) }],
      });
    }

    return mcpError(id, `Unknown tool: ${toolName}`);
  }

  return mcpResponse(id, {});
}

function mcpResponse(id, result) {
  return json({ jsonrpc: "2.0", id, result });
}

function mcpError(id, message) {
  return json({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

async function callRobinhood(env, toolName, args) {
  requireRobinhood(env);
  const accessToken = await robinhoodAccessToken(env);
  const response = await fetch(env.ROBINHOOD_MCP_URL || MCP_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
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

async function robinhoodAccessToken(env) {
  if (env.ROBINHOOD_MCP_BEARER_TOKEN) return env.ROBINHOOD_MCP_BEARER_TOKEN;
  requireStateStore(env);
  const token = await env.ROBINHOOD_STATE.get(TOKEN_KEY, { type: "json" });
  if (!token?.access_token) throw new Error("Robinhood is not connected. Use Connect Robinhood first.");
  if (!token.expires_at || Date.now() < Number(token.expires_at) - 60_000) return token.access_token;
  if (!token.refresh_token) throw new Error("Robinhood access expired and no refresh token is available. Reconnect Robinhood.");

  const client = await env.ROBINHOOD_STATE.get(CLIENT_KEY, { type: "json" });
  const refreshed = await exchangeToken({
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
    client_id: client?.client_id || token.client_id,
    resource: RESOURCE,
  });
  await storeToken(env, { ...refreshed, refresh_token: refreshed.refresh_token || token.refresh_token, client_id: client?.client_id || token.client_id });
  return refreshed.access_token;
}

async function getOrRegisterClient(request, env) {
  requireStateStore(env);
  const redirectUri = callbackUrl(request, env);
  const cached = await env.ROBINHOOD_STATE.get(CLIENT_KEY, { type: "json" });
  if (cached?.client_id && cached.redirect_uris?.includes(redirectUri)) return cached;

  const response = await fetch(REGISTRATION_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      client_name: "Kalki Robinhood Dashboard",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "internal",
    }),
  });
  const client = await response.json().catch(() => ({}));
  if (!response.ok || !client.client_id) throw new Error(client.error_description || client.error || `Robinhood client registration failed with HTTP ${response.status}`);
  await env.ROBINHOOD_STATE.put(CLIENT_KEY, JSON.stringify(client));
  return client;
}

async function exchangeToken(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") body.set(key, value);
  }
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body,
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || !token.access_token) throw new Error(token.error_description || token.error || `Robinhood token exchange failed with HTTP ${response.status}`);
  return token;
}

async function storeToken(env, token) {
  const expiresIn = Number(token.expires_in || 3600);
  const payload = {
    ...token,
    expires_at: Date.now() + expiresIn * 1000,
    updated_at: new Date().toISOString(),
  };
  await env.ROBINHOOD_STATE.put(TOKEN_KEY, JSON.stringify(payload));
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

async function getStoredSnapshot(env) {
  const raw = await env.ROBINHOOD_STATE?.get(SNAPSHOT_KEY);
  if (!raw) return null;
  const snapshot = JSON.parse(raw);
  return {
    ok: true,
    connected: true,
    source: snapshot.source || "agent-pushed-snapshot",
    synced_at: snapshot.synced_at || null,
    stale: isSnapshotStale(snapshot.synced_at),
    config: await publicConfig(env),
    account: sanitizeAccount(snapshot.account || {}),
    accounts: Array.isArray(snapshot.accounts) ? snapshot.accounts.map(sanitizeAccount) : [],
    portfolio: sanitizePortfolio(snapshot.portfolio || {}),
    positions: Array.isArray(snapshot.positions) ? snapshot.positions.map(sanitizePosition).slice(0, 100) : [],
    orders: Array.isArray(snapshot.orders) ? snapshot.orders.map(sanitizeOrder).slice(0, 100) : [],
    option_positions: Array.isArray(snapshot.option_positions) ? snapshot.option_positions.map(sanitizeOptionPosition).slice(0, 100) : [],
    option_orders: Array.isArray(snapshot.option_orders) ? snapshot.option_orders.map(sanitizeOrder).slice(0, 100) : [],
    setup: await setupChecklist(env),
  };
}

function sanitizeSnapshot(body) {
  return {
    ok: true,
    connected: true,
    source: String(body.source || "robinhood-mcp-agent").slice(0, 80),
    synced_at: body.synced_at || new Date().toISOString(),
    account: sanitizeAccount(body.account || {}),
    accounts: Array.isArray(body.accounts) ? body.accounts.map(sanitizeAccount) : [],
    portfolio: sanitizePortfolio(body.portfolio || {}),
    positions: Array.isArray(body.positions) ? body.positions.map(sanitizePosition).slice(0, 100) : [],
    orders: Array.isArray(body.orders) ? body.orders.map(sanitizeOrder).slice(0, 100) : [],
    option_positions: Array.isArray(body.option_positions) ? body.option_positions.map(sanitizeOptionPosition).slice(0, 100) : [],
    option_orders: Array.isArray(body.option_orders) ? body.option_orders.map(sanitizeOrder).slice(0, 100) : [],
  };
}

function sanitizeAccount(account) {
  const raw = account.account_number || account.accountNumber || "";
  return {
    account_number: String(raw).startsWith("••••") ? String(raw) : maskAccount(raw),
    brokerage_account_type: account.brokerage_account_type || account.type || null,
    nickname: account.nickname || null,
    is_default: Boolean(account.is_default),
    agentic_allowed: Boolean(account.agentic_allowed),
    management_type: account.management_type || null,
    state: account.state || null,
  };
}

function sanitizePortfolio(portfolio) {
  return {
    total_value: numberOrNull(portfolio.total_value),
    equity_value: numberOrNull(portfolio.equity_value),
    options_value: numberOrNull(portfolio.options_value),
    crypto_value: numberOrNull(portfolio.crypto_value),
    cash: numberOrNull(portfolio.cash),
    buying_power: numberOrNull(portfolio.buying_power),
    currency: portfolio.currency || "USD",
  };
}

function sanitizePosition(position) {
  const unrealized = numberOrNull(position.unrealized);
  const quantity = numberOrNull(position.quantity) || 0;
  const currentPrice = numberOrNull(position.current_price);
  const marketValue = numberOrNull(position.market_value ?? position.equity)
    ?? (currentPrice == null ? null : roundMoney(quantity * currentPrice));
  return {
    symbol: String(position.symbol || "").toUpperCase().slice(0, 16),
    quantity,
    average_buy_price: numberOrNull(position.average_buy_price),
    current_price: currentPrice,
    market_value: marketValue,
    equity: marketValue,
    unrealized,
    unrealized_pct: numberOrNull(position.unrealized_pct),
    is_green: position.is_green == null && unrealized != null ? unrealized > 0 : Boolean(position.is_green),
  };
}

function sanitizeOptionPosition(position) {
  const unrealized = numberOrNull(position.unrealized);
  return {
    chain_symbol: String(position.chain_symbol || position.symbol || "").toUpperCase().slice(0, 16),
    option_type: position.option_type || position.type || null,
    expiration_date: position.expiration_date || null,
    strike_price: numberOrNull(position.strike_price),
    quantity: numberOrNull(position.quantity),
    average_price: numberOrNull(position.average_price || position.average_buy_price),
    market_value: numberOrNull(position.market_value),
    unrealized,
    is_green: position.is_green == null && unrealized != null ? unrealized > 0 : Boolean(position.is_green),
  };
}

function sanitizeOrder(order) {
  return {
    id: order.id ? String(order.id).slice(0, 80) : null,
    symbol: String(order.symbol || order.chain_symbol || "-").toUpperCase().slice(0, 16),
    side: order.side || null,
    type: order.type || null,
    state: order.state || null,
    quantity: numberOrNull(order.quantity),
    cumulative_quantity: numberOrNull(order.cumulative_quantity),
    price: numberOrNull(order.price),
    average_price: numberOrNull(order.average_price),
    created_at: order.created_at || null,
    last_transaction_at: order.last_transaction_at || order.updated_at || null,
    placed_agent: order.placed_agent || null,
  };
}

function isSnapshotStale(syncedAt) {
  const time = Date.parse(syncedAt || "");
  if (!Number.isFinite(time)) return true;
  return Date.now() - time > 15 * 60 * 1000;
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

function normalizeLuxAlert(body) {
  const value = body && typeof body === "object" ? body : {};
  const rawText = String(value.raw || value.text || value.alert || "").trim();
  const ticker = sanitizeTicker(value.ticker || value.symbol || extractTextMatch(rawText, /(?:ALERT|ANALYSIS)\s*[—-]\s*([A-Z][A-Z0-9.-]{0,9})/i));
  const entryMid = positiveNumber(value.entry ?? value.entry_price ?? value.entryMid ?? value.price);
  const price = positiveNumber(value.price) ?? entryMid;
  const stop = positiveNumber(value.stop ?? value.stop_price ?? value.stopLoss);
  const t1 = positiveNumber(value.t1 ?? value.target1 ?? value.tp1);
  const t2 = positiveNumber(value.t2 ?? value.target2 ?? value.tp2);
  const score = positiveNumber(value.score ?? value.confluenceScore) ?? parseScore(rawText);
  const scoreMax = positiveNumber(value.scoreMax ?? value.score_max) ?? 8;

  if (!ticker || !entryMid || !stop || !t1) return null;

  const targets = [t1, t2].filter(Number.isFinite).map(roundMoney);
  const grade = normalizeLuxGrade(value.grade, score, scoreMax);
  const timeframe = String(value.timeframe || value.tf || "").trim().slice(0, 12) || null;
  const pattern = String(value.pattern || value.setup || "Lux confluence alert").trim().slice(0, 160);
  const rr = entryMid > stop ? roundMoney((t1 - entryMid) / (entryMid - stop)) : null;
  const note = [
    pattern,
    Number.isFinite(score) ? `Score ${score}/${scoreMax}` : "",
    timeframe ? `TF ${timeframe}` : "",
    value.vwapLabel ? `VWAP ${String(value.vwapLabel).slice(0, 40)}` : "",
  ].filter(Boolean).join(" · ");

  return {
    id: sanitizeSignalId(value.id || value.signalId || value.signal_id),
    ticker,
    grade,
    score,
    scoreMax,
    timeframe,
    pattern,
    note,
    price: roundMoney(price),
    entryLow: roundMoney(positiveNumber(value.entryLow ?? value.entry_low) ?? entryMid),
    entryHigh: roundMoney(positiveNumber(value.entryHigh ?? value.entry_high) ?? entryMid),
    entryMid: roundMoney(entryMid),
    stop: roundMoney(stop),
    targets,
    rr,
    changePct: numberOrNull(value.changePct ?? value.change_pct),
    vwapLabel: value.vwapLabel || null,
    vwapDev: numberOrNull(value.vwapDev ?? value.vwap_dev),
    signal: value.signal || null,
    raw: rawText || JSON.stringify(value),
    receivedAt: normalizeIso(value.receivedAt || value.received_at),
  };
}

function sanitizeTicker(value) {
  const ticker = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9.-]/g, "");
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) ? ticker : "";
}

function sanitizeSignalId(value) {
  const id = String(value || "").trim().replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 120);
  return id || null;
}

function normalizeLuxGrade(value, score, scoreMax) {
  const raw = String(value || "").trim().toUpperCase();
  if (["A+", "A", "B+"].includes(raw)) return raw;
  const scaledScore = Number.isFinite(score) && Number.isFinite(scoreMax) && scoreMax > 0
    ? Math.round((score / scoreMax) * 8)
    : null;
  if (scaledScore >= 8) return "A+";
  if (scaledScore >= 7) return "A";
  return "B+";
}

function parseScore(value) {
  const match = String(value || "").match(/\b(?:Score|Confluence)\s*:\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) : null;
}

function extractTextMatch(value, regex) {
  return String(value || "").match(regex)?.[1] || "";
}

function stableSignalKey(alert) {
  const minute = (alert.receivedAt || new Date().toISOString()).slice(0, 16).replace(/[^0-9T]/g, "");
  return `${roundMoney(alert.entryMid)}-${roundMoney(alert.stop)}-${alert.targets[0] || "na"}-${minute}`.replace(/[^A-Za-z0-9_.:-]/g, "-");
}

function normalizeIso(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
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

async function publicConfig(env) {
  return {
    ok: true,
    connected: await robinhoodConfigured(env),
    snapshot_bridge_configured: Boolean(env.DASHBOARD_SNAPSHOT_TOKEN),
    account_configured: Boolean(accountNumber(env)),
    scorer_webhook_configured: Boolean(env.SCORER_WEBHOOK_SECRET),
    lux_webhook_configured: Boolean(env.LUX_WEBHOOK_SECRET || env.SCORER_WEBHOOK_SECRET),
    auto_trade_enabled: autoTradeEnabled(env),
    webhook_url: "/api/alerts/scorer",
    lux_webhook_url: "/api/alerts/lux",
    connect_url: "/api/robinhood/connect",
    logout_url: "/api/robinhood/logout",
    setup: await setupChecklist(env),
  };
}

function requireStateStore(env) {
  if (!env.ROBINHOOD_STATE) throw new Error("ROBINHOOD_STATE KV storage is not configured");
}

function callbackUrl(request, env) {
  if (env.ROBINHOOD_CALLBACK_URL) return env.ROBINHOOD_CALLBACK_URL;
  const url = new URL(request.url);
  url.pathname = "/api/robinhood/callback";
  url.search = "";
  return url.toString();
}

function dashboardUrl(env) {
  return env.DASHBOARD_URL || "https://kalki-robinhood-dashboard.pages.dev/";
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64Url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function html(message, status = 200) {
  return cors(`<!doctype html><title>Robinhood OAuth</title><body><main style="font-family:system-ui;padding:32px;max-width:720px;margin:auto"><h1>Robinhood OAuth</h1><p>${escapeHtml(message)}</p><p><a href="${dashboardUrl({})}">Return to dashboard</a></p></main></body>`, status, {
    "Content-Type": "text/html; charset=utf-8",
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

async function setupChecklist(env) {
  return [
    { key: "Robinhood OAuth", done: await robinhoodConfigured(env), label: "Connect Robinhood through OAuth from this dashboard" },
    { key: "DASHBOARD_SNAPSHOT_TOKEN", done: Boolean(env.DASHBOARD_SNAPSHOT_TOKEN), label: "Allow Claude/Codex to push Robinhood MCP snapshots into the dashboard" },
    { key: "ROBINHOOD_ACCOUNT_NUMBER", done: Boolean(accountNumber(env)), label: "Optional: pin a specific account number; otherwise the Worker selects an agentic/default account" },
    { key: "SCORER_WEBHOOK_SECRET", done: Boolean(env.SCORER_WEBHOOK_SECRET), label: "Set scorer webhook secret for authenticated alert intake" },
    { key: "LUX_WEBHOOK_SECRET", done: Boolean(env.LUX_WEBHOOK_SECRET || env.SCORER_WEBHOOK_SECRET), label: "Set Lux screener webhook secret, or reuse SCORER_WEBHOOK_SECRET" },
    { key: "ROBINHOOD_AUTO_TRADE", done: autoTradeEnabled(env), label: "Optional: enable automatic placement after review passes" },
  ];
}

function requireScorerAuth(request, env) {
  if (!env.SCORER_WEBHOOK_SECRET) throw new Error("SCORER_WEBHOOK_SECRET is not configured");
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : request.headers.get("x-scorer-secret");
  if (token !== env.SCORER_WEBHOOK_SECRET) throw new Error("Unauthorized scorer webhook request");
}

function requireLuxAuth(request, env) {
  const expected = env.LUX_WEBHOOK_SECRET || env.SCORER_WEBHOOK_SECRET;
  if (!expected) throw new Error("LUX_WEBHOOK_SECRET or SCORER_WEBHOOK_SECRET is not configured");
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : request.headers.get("x-lux-secret") || request.headers.get("x-scorer-secret");
  if (token !== expected) throw new Error("Unauthorized Lux webhook request");
}

function requireSnapshotAuth(request, env) {
  if (!env.DASHBOARD_SNAPSHOT_TOKEN) throw new Error("DASHBOARD_SNAPSHOT_TOKEN is not configured");
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : request.headers.get("x-dashboard-snapshot-token");
  if (token !== env.DASHBOARD_SNAPSHOT_TOKEN) throw new Error("Unauthorized dashboard snapshot request");
}

function requireRobinhood(env) {
  if (!env.ROBINHOOD_MCP_BEARER_TOKEN && !env.ROBINHOOD_STATE) throw new Error("Robinhood OAuth storage is not configured");
}

async function robinhoodConfigured(env) {
  if (env.ROBINHOOD_MCP_BEARER_TOKEN) return true;
  return Boolean(await env.ROBINHOOD_STATE?.get(TOKEN_KEY));
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

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
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
    "Cache-Control": "no-store",
  });
}

function cors(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Scorer-Secret,X-Lux-Secret,X-Dashboard-Snapshot-Token",
      ...headers,
    },
  });
}
