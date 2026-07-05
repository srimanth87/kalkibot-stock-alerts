const DEFAULT_WEBHOOK_URL = "https://tv.kalkianalysis.com/api/tv/webhook";
const MAX_WEBHOOK_BYTES = 64 * 1024;
const DEFAULT_YAHOO_PROXY_BASE_URL = "https://yahoo-proxy.srimanthgada87.workers.dev";
const SETUP_PASSCODE = "1515";
const DEFAULT_ACCOUNT_EQUITY = 25000;
const DEFAULT_RISK_PER_TRADE_PCT = 0.0025;
const DEFAULT_STRATEGY_MODE = "filtered_risk";
const OLD_FIXED_STRATEGY_MODE = "raw_fixed";
const MIN_BUY_MINUTES_ET = 10 * 60;
const MAX_BUY_MINUTES_ET = 15 * 60 + 15;
const BLOCKED_BUY_TICKERS = new Set([
  "SPXL",
  "FNGU",
  "TSLL",
  "TQQQ",
  "SQQQ",
  "SOXL",
  "SOXS",
  "SVIX",
  "UVXY",
  "UPRO",
  "SPXU",
  "LABU",
  "LABD",
]);

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors(null, 204);
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        await ensureSchema(env);
        return json({ ok: true, service: "kalki-tv-dashboard", db: Boolean(env.DB) });
      }

      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        const shared = await requireSharedProfile(env, request);
        return await handleDashboard(env, shared, request);
      }
      if (request.method === "POST" && url.pathname === "/api/profile/settings") {
        requireSetupPasscode(request);
        const shared = await requireSharedProfile(env, request);
        return await handleSettings(request, env, shared.profile);
      }
      if (request.method === "POST" && url.pathname === "/api/profile/rotate-webhook") {
        requireSetupPasscode(request);
        const shared = await requireSharedProfile(env, request);
        return await handleRotateWebhook(request, env, shared.profile);
      }
      if (request.method === "POST" && isTradingViewWebhookPath(url.pathname)) {
        return await handleTradingViewWebhook(request, env, url);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ ok: false, error: errorMessage(error) }, errorStatus(error));
    }
  },
};

async function ensureSchema(env) {
  if (!env.DB) throw new Error("DB binding is not configured");
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tv_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hashes TEXT NOT NULL,
      access_code_hash TEXT NOT NULL,
      webhook_secret_hash TEXT NOT NULL UNIQUE,
      allocation_per_alert REAL NOT NULL DEFAULT 1000,
      default_tp_pct REAL NOT NULL DEFAULT 3,
      default_stop_pct REAL NOT NULL DEFAULT 2,
      strategy_mode TEXT NOT NULL DEFAULT 'filtered_risk',
      account_equity REAL NOT NULL DEFAULT 25000,
      risk_per_trade_pct REAL NOT NULL DEFAULT 0.25,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tv_alerts (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      ticker TEXT NOT NULL,
      price REAL,
      timeframe TEXT,
      grade TEXT,
      raw_json TEXT NOT NULL,
      raw_text TEXT,
      idempotency_key TEXT NOT NULL,
      received_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      duplicate INTEGER DEFAULT 0,
      filter_status TEXT,
      filter_reason TEXT,
      filter_details TEXT
    )`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tv_alerts_profile_idempotency ON tv_alerts(profile_id, idempotency_key)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_tv_alerts_profile_created ON tv_alerts(profile_id, created_at DESC)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tv_trades (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      status TEXT NOT NULL,
      entry_alert_id TEXT,
      exit_alert_id TEXT,
      entry_price REAL NOT NULL,
      exit_price REAL,
      allocation REAL NOT NULL,
      shares REAL NOT NULL,
      tp1_price REAL NOT NULL,
      stop_price REAL NOT NULL,
      outcome TEXT,
      pnl REAL DEFAULT 0,
      pnl_pct REAL DEFAULT 0,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_tv_trades_profile_status ON tv_trades(profile_id, status, opened_at DESC)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_tv_trades_profile_closed ON tv_trades(profile_id, closed_at DESC)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tv_raw_trades (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      status TEXT NOT NULL,
      entry_alert_id TEXT,
      exit_alert_id TEXT,
      entry_price REAL NOT NULL,
      exit_price REAL,
      allocation REAL NOT NULL,
      shares REAL NOT NULL,
      tp1_price REAL NOT NULL,
      stop_price REAL NOT NULL,
      outcome TEXT,
      pnl REAL DEFAULT 0,
      pnl_pct REAL DEFAULT 0,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_tv_raw_trades_profile_status ON tv_raw_trades(profile_id, status, opened_at DESC)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_tv_raw_trades_profile_closed ON tv_raw_trades(profile_id, closed_at DESC)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tv_app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tv_quote_cache (
      ticker TEXT PRIMARY KEY,
      price REAL NOT NULL,
      updated_at TEXT NOT NULL
    )`),
  ]);
  await addColumnIfMissing(env, "tv_alerts", "filter_status", "TEXT");
  await addColumnIfMissing(env, "tv_alerts", "filter_reason", "TEXT");
  await addColumnIfMissing(env, "tv_alerts", "filter_details", "TEXT");
  await addColumnIfMissing(env, "tv_profiles", "strategy_mode", "TEXT NOT NULL DEFAULT 'filtered_risk'");
  await addColumnIfMissing(env, "tv_profiles", "account_equity", "REAL NOT NULL DEFAULT 25000");
  await addColumnIfMissing(env, "tv_profiles", "risk_per_trade_pct", "REAL NOT NULL DEFAULT 0.25");
  await migrateLegacyTradesToRaw(env);
}

async function migrateLegacyTradesToRaw(env) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO tv_raw_trades
        (id, profile_id, ticker, status, entry_alert_id, exit_alert_id, entry_price, exit_price,
         allocation, shares, tp1_price, stop_price, outcome, pnl, pnl_pct, opened_at, closed_at, updated_at)
       SELECT
         t.id, t.profile_id, t.ticker, t.status, t.entry_alert_id, t.exit_alert_id, t.entry_price, t.exit_price,
         t.allocation, t.shares, t.tp1_price, t.stop_price, t.outcome, t.pnl, t.pnl_pct, t.opened_at, t.closed_at, t.updated_at
       FROM tv_trades t
       LEFT JOIN tv_alerts a ON a.id = t.entry_alert_id
       WHERE a.filter_status IS NULL`
    ),
    env.DB.prepare(
      `DELETE FROM tv_trades
       WHERE id IN (
         SELECT t.id
         FROM tv_trades t
         LEFT JOIN tv_alerts a ON a.id = t.entry_alert_id
         WHERE a.filter_status IS NULL
       )`
    ),
  ]);
}

async function requireSharedProfile(env, request) {
  await ensureSchema(env);
  const now = new Date().toISOString();
  let sharedProfileId = await getState(env, "shared_profile_id");
  let webhookSecret = await getState(env, "shared_webhook_secret");
  let profile = sharedProfileId
    ? await env.DB.prepare(`SELECT * FROM tv_profiles WHERE id = ?`).bind(sharedProfileId).first()
    : null;

  if (!profile) {
    profile = await env.DB.prepare(`SELECT * FROM tv_profiles ORDER BY updated_at DESC LIMIT 1`).first();
  }

  if (!profile) {
    const nextSecret = webhookSecret || makeToken();
    profile = {
      id: crypto.randomUUID(),
      name: "TradingView signals",
      token_hashes: "[]",
      access_code_hash: await sha256Hex(normalizeAccessCode(makeAccessCode())),
      webhook_secret_hash: await sha256Hex(nextSecret),
      allocation_per_alert: 1000,
      default_tp_pct: 3,
      default_stop_pct: 2,
      strategy_mode: DEFAULT_STRATEGY_MODE,
      account_equity: DEFAULT_ACCOUNT_EQUITY,
      risk_per_trade_pct: DEFAULT_RISK_PER_TRADE_PCT * 100,
      created_at: now,
      updated_at: now,
    };
    await env.DB.prepare(
      `INSERT INTO tv_profiles
        (id, name, token_hashes, access_code_hash, webhook_secret_hash, allocation_per_alert, default_tp_pct, default_stop_pct, strategy_mode, account_equity, risk_per_trade_pct, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      profile.id,
      profile.name,
      profile.token_hashes,
      profile.access_code_hash,
      profile.webhook_secret_hash,
      profile.allocation_per_alert,
      profile.default_tp_pct,
      profile.default_stop_pct,
      profile.strategy_mode,
      profile.account_equity,
      profile.risk_per_trade_pct,
      profile.created_at,
      profile.updated_at,
    ).run();
    webhookSecret = nextSecret;
  }

  if (!webhookSecret) {
    webhookSecret = makeToken();
  }

  await env.DB.prepare(`UPDATE tv_profiles SET webhook_secret_hash = ?, updated_at = ? WHERE id = ?`)
    .bind(await sha256Hex(webhookSecret), now, profile.id).run();
  await setState(env, "shared_profile_id", profile.id, now);
  await setState(env, "shared_webhook_secret", webhookSecret, now);
  profile = await env.DB.prepare(`SELECT * FROM tv_profiles WHERE id = ?`).bind(profile.id).first();

  return {
    profile,
    webhookSecret,
    webhookUrl: webhookUrl(request, webhookSecret),
  };
}

async function handleSettings(request, env, profile) {
  const body = await request.json().catch(() => ({}));
  const allocation = positiveNumber(body.allocationPerAlert) || profile.allocation_per_alert || 1000;
  const tp = positiveNumber(body.defaultTpPct) || profile.default_tp_pct || 3;
  const stop = positiveNumber(body.defaultStopPct) || profile.default_stop_pct || 2;
  const mode = normalizeStrategyMode(body.strategyMode || profile.strategy_mode);
  const equity = positiveNumber(body.accountEquity) || accountEquity(profile);
  const riskPct = positiveNumber(body.riskPerTradePct) || riskPerTradePct(profile);
  const name = body.name != null ? cleanName(body.name) : profile.name;
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE tv_profiles
     SET name = ?, allocation_per_alert = ?, default_tp_pct = ?, default_stop_pct = ?,
         strategy_mode = ?, account_equity = ?, risk_per_trade_pct = ?, updated_at = ?
     WHERE id = ?`
  ).bind(name, allocation, tp, stop, mode, equity, riskPct, updatedAt, profile.id).run();
  const next = {
    ...profile,
    name,
    allocation_per_alert: allocation,
    default_tp_pct: tp,
    default_stop_pct: stop,
    strategy_mode: mode,
    account_equity: equity,
    risk_per_trade_pct: riskPct,
    updated_at: updatedAt,
  };
  return json({ ok: true, profile: publicProfile(next), updatedOpenTrades: false });
}

async function handleRotateWebhook(request, env, profile) {
  const webhookSecret = makeToken();
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`UPDATE tv_profiles SET webhook_secret_hash = ?, updated_at = ? WHERE id = ?`)
    .bind(await sha256Hex(webhookSecret), updatedAt, profile.id).run();
  await setState(env, "shared_webhook_secret", webhookSecret, updatedAt);
  return json({ ok: true, webhookSecret, webhookUrl: webhookUrl(request, webhookSecret) });
}

async function handleDashboard(env, shared, request) {
  const { profile, webhookSecret } = shared;
  const setupUnlocked = hasSetupPasscode(request);
  let tradeRows = await loadTradeRows(env, profile, "tv_trades");
  let rawTradeRows = await loadTradeRows(env, profile, "tv_raw_trades");

  const initialTrades = (tradeRows || []).map(normalizeTrade);
  const initialRawTrades = (rawTradeRows || []).map(normalizeTrade);
  const openTrades = initialTrades.filter((trade) => trade.status === "open");
  const openRawTrades = initialRawTrades.filter((trade) => trade.status === "open");
  const quotes = await fetchCachedQuotesForTrades(env, [...openTrades, ...openRawTrades]);

  const { results: alertRows } = await env.DB.prepare(
    `SELECT * FROM tv_alerts WHERE profile_id = ? ORDER BY created_at DESC LIMIT 80`
  ).bind(profile.id).all();

  const trades = (tradeRows || []).map((row) => {
    const trade = normalizeTrade(row);
    return enrichTradeWithQuote(trade, quotes.get(trade.ticker));
  });
  const rawTrades = (rawTradeRows || []).map((row) => {
    const trade = normalizeTrade(row);
    return enrichTradeWithQuote(trade, quotes.get(trade.ticker));
  });
  const active = trades.filter((trade) => trade.status === "open");
  const history = trades.filter((trade) => trade.status !== "open");
  const rawActive = rawTrades.filter((trade) => trade.status === "open");
  const rawHistory = rawTrades.filter((trade) => trade.status !== "open");
  const closedToday = trades.filter((trade) => trade.status === "closed" && sameEtDay(trade.closedAt));
  const rawClosedToday = rawTrades.filter((trade) => trade.status === "closed" && sameEtDay(trade.closedAt));
  const winsToday = closedToday.filter((trade) => trade.pnl > 0);
  const lossesToday = closedToday.filter((trade) => trade.pnl < 0);
  const netToday = roundMoney(closedToday.reduce((sum, trade) => sum + trade.pnl, 0));
  const rawNetToday = roundMoney(rawClosedToday.reduce((sum, trade) => sum + trade.pnl, 0));
  const investedOpen = roundMoney(active.reduce((sum, trade) => sum + trade.allocation, 0));
  const unrealizedOpen = roundMoney(active.reduce((sum, trade) => sum + (trade.currentPnl || 0), 0));
  const winRate = closedToday.length ? Math.round((winsToday.length / closedToday.length) * 1000) / 10 : 0;
  const comparison = buildDailyComparison(rawTrades, trades);

  return json({
    ok: true,
    profile: publicProfile(profile),
    setupUnlocked,
    webhookSecret: setupUnlocked ? webhookSecret : null,
    webhookUrl: setupUnlocked ? webhookUrl(request, webhookSecret) : null,
    summary: {
      activeTrades: active.length,
      historyTrades: history.length,
      closedToday: closedToday.length,
      winsToday: winsToday.length,
      lossesToday: lossesToday.length,
      winRate,
      netToday,
      rawNetToday,
      improvementToday: roundMoney(netToday - rawNetToday),
      investedOpen,
      unrealizedOpen,
    },
    active,
    history,
    rawActive,
    rawHistory,
    comparison,
    alerts: (alertRows || []).map(normalizeAlert),
  });
}

async function loadTradeRows(env, profile, tableName) {
  const table = tradeTableName(tableName);
  const { results } = await env.DB.prepare(
    `SELECT
        t.*,
        entry_alert.raw_text AS entry_alert_raw_text,
        entry_alert.raw_json AS entry_alert_raw_json,
        entry_alert.filter_status AS entry_alert_filter_status,
        exit_alert.raw_text AS exit_alert_raw_text,
        exit_alert.raw_json AS exit_alert_raw_json
      FROM ${table} t
      LEFT JOIN tv_alerts entry_alert ON entry_alert.id = t.entry_alert_id
      LEFT JOIN tv_alerts exit_alert ON exit_alert.id = t.exit_alert_id
      WHERE t.profile_id = ?
      ORDER BY COALESCE(t.closed_at, t.opened_at) DESC
      LIMIT 300`
  ).bind(profile.id).all();
  return results || [];
}

function buildDailyComparison(rawTrades, filteredTrades) {
  const byDate = new Map();
  const ensure = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, {
        date,
        oldTrades: 0,
        oldWins: 0,
        oldLosses: 0,
        oldPnl: 0,
        newTrades: 0,
        newWins: 0,
        newLosses: 0,
        newPnl: 0,
      });
    }
    return byDate.get(date);
  };

  for (const trade of rawTrades || []) {
    if (trade.status !== "closed") continue;
    if (!trade.entryFilterStatus) continue;
    const row = ensure(etDayKey(Date.parse(trade.closedAt || trade.openedAt)));
    row.oldTrades += 1;
    row.oldPnl = roundMoney(row.oldPnl + trade.pnl);
    if (trade.pnl > 0) row.oldWins += 1;
    if (trade.pnl < 0) row.oldLosses += 1;
  }
  for (const trade of filteredTrades || []) {
    if (trade.status !== "closed") continue;
    const date = etDayKey(Date.parse(trade.closedAt || trade.openedAt));
    if (!byDate.has(date)) continue;
    const row = ensure(date);
    row.newTrades += 1;
    row.newPnl = roundMoney(row.newPnl + trade.pnl);
    if (trade.pnl > 0) row.newWins += 1;
    if (trade.pnl < 0) row.newLosses += 1;
  }

  return [...byDate.values()]
    .map((row) => ({
      ...row,
      rejectedTrades: Math.max(0, row.oldTrades - row.newTrades),
      improvement: roundMoney(row.newPnl - row.oldPnl),
      oldWinRate: row.oldTrades ? Math.round((row.oldWins / row.oldTrades) * 1000) / 10 : 0,
      newWinRate: row.newTrades ? Math.round((row.newWins / row.newTrades) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

async function handleTradingViewWebhook(request, env, url) {
  const shared = await requireSharedProfile(env, request);
  const secret = decodeURIComponent(url.pathname.slice("/api/tv/webhook/".length)).trim();
  if (!secret) {
    return json({ ok: false, error: "Webhook secret must be in the URL path: /api/tv/webhook/YOUR_SECRET" }, 401);
  }
  if ((await sha256Hex(secret)) !== shared.profile.webhook_secret_hash) {
    return json({ ok: false, error: "Invalid TradingView secret" }, 401);
  }

  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_WEBHOOK_BYTES) return json({ ok: false, error: "Alert body is too large" }, 413);

  const profile = shared.profile;
  const rawBody = await request.text();
  const body = parseWebhookBody(rawBody);
  const alert = normalizeTvAlert(body, profile);
  if (!alert.eventType) return json({ ok: false, error: "Could not detect BUY or EXIT in alert text" }, 400);
  if (!alert.ticker || !alert.price) {
    return json({ ok: false, error: "Could not detect ticker and price from TradingView alert text" }, 400);
  }
  const idempotencyKey = await sha256Hex(`${profile.id}:${alert.eventType}:${alert.ticker}:${alert.price}:${alert.receivedAt}:${alert.rawText}`);
  const now = new Date().toISOString();
  const alertId = crypto.randomUUID();

  try {
    await env.DB.prepare(
      `INSERT INTO tv_alerts
        (id, profile_id, event_type, ticker, price, timeframe, grade, raw_json, raw_text, idempotency_key, received_at, created_at, duplicate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(
      alertId,
      profile.id,
      alert.eventType,
      alert.ticker,
      alert.price,
      alert.timeframe,
      alert.grade,
      JSON.stringify(body),
      alert.rawText,
      idempotencyKey,
      alert.receivedAt,
      now,
    ).run();
  } catch {
    return json({ ok: true, duplicate: true, event_type: alert.eventType, ticker: alert.ticker });
  }

  if (alert.eventType === "exit") {
    await closeRawTradeForExit(env, profile, alert, alertId);
    return await closeTradeForExit(env, profile, alert, alertId);
  }
  await openRawTradeForBuy(env, profile, alert, alertId);
  return await openTradeForBuy(env, profile, alert, alertId);
}

async function openTradeForBuy(env, profile, alert, alertId) {
  const existing = await env.DB.prepare(
    `SELECT * FROM tv_trades WHERE profile_id = ? AND ticker = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`
  ).bind(profile.id, alert.ticker).first();
  if (existing) {
    await markAlertFilter(env, alertId, "skipped", "open filtered trade already exists");
    return json({ ok: true, skipped: "open_trade_exists", alert_id: alertId, trade: normalizeTrade(existing) });
  }

  const tp1 = positiveNumber(alert.t1) || roundMoney(alert.price * (1 + (profile.default_tp_pct || 3) / 100));
  const stop = positiveNumber(alert.stop) || roundMoney(alert.price * (1 - (profile.default_stop_pct || 2) / 100));
  if (strategyMode(profile) === OLD_FIXED_STRATEGY_MODE) {
    const allocation = positiveNumber(alert.allocation) || profile.allocation_per_alert || 1000;
    const shares = allocation / alert.price;
    await markAlertFilter(env, alertId, "bypassed", "old fixed allocation mode");
    return await insertFilteredTrade(env, profile, alert, alertId, {
      allocation,
      shares,
      tp1,
      stop,
    });
  }

  const filter = await passesBuyFilter(alert);
  if (!filter.ok) {
    await markAlertFilter(env, alertId, "rejected", filter.reason, filter.details);
    return json({
      ok: true,
      action: "rejected",
      alert_id: alertId,
      ticker: alert.ticker,
      reason: filter.reason,
      details: filter.details || null,
    });
  }

  const sizing = calculateRiskSizing(alert.price, stop, profile);
  await markAlertFilter(env, alertId, "passed", "accepted by filtered strategy", filter.details);
  return await insertFilteredTrade(env, profile, alert, alertId, {
    allocation: sizing.allocation,
    shares: sizing.shares,
    tp1,
    stop,
  });
}

async function insertFilteredTrade(env, profile, alert, alertId, sizing) {
  const trade = {
    id: crypto.randomUUID(),
    profile_id: profile.id,
    ticker: alert.ticker,
    status: "open",
    entry_alert_id: alertId,
    entry_price: alert.price,
    allocation: sizing.allocation,
    shares: sizing.shares,
    tp1_price: sizing.tp1,
    stop_price: sizing.stop,
    opened_at: alert.receivedAt,
    updated_at: new Date().toISOString(),
  };
  await env.DB.prepare(
    `INSERT INTO tv_trades
      (id, profile_id, ticker, status, entry_alert_id, entry_price, allocation, shares, tp1_price, stop_price, opened_at, updated_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    trade.id,
    trade.profile_id,
    trade.ticker,
    trade.entry_alert_id,
    trade.entry_price,
    trade.allocation,
    trade.shares,
    trade.tp1_price,
    trade.stop_price,
    trade.opened_at,
    trade.updated_at,
  ).run();
  return json({ ok: true, action: "opened", alert_id: alertId, trade: normalizeTrade(trade) });
}

async function openRawTradeForBuy(env, profile, alert, alertId) {
  const existing = await env.DB.prepare(
    `SELECT * FROM tv_raw_trades WHERE profile_id = ? AND ticker = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`
  ).bind(profile.id, alert.ticker).first();
  if (existing) return normalizeTrade(existing);

  const allocation = positiveNumber(alert.allocation) || profile.allocation_per_alert || 1000;
  const shares = allocation / alert.price;
  const tp1 = positiveNumber(alert.t1) || roundMoney(alert.price * (1 + (profile.default_tp_pct || 3) / 100));
  const stop = positiveNumber(alert.stop) || roundMoney(alert.price * (1 - (profile.default_stop_pct || 2) / 100));
  const trade = {
    id: crypto.randomUUID(),
    profile_id: profile.id,
    ticker: alert.ticker,
    status: "open",
    entry_alert_id: alertId,
    entry_price: alert.price,
    allocation,
    shares,
    tp1_price: tp1,
    stop_price: stop,
    opened_at: alert.receivedAt,
    updated_at: new Date().toISOString(),
  };
  await env.DB.prepare(
    `INSERT INTO tv_raw_trades
      (id, profile_id, ticker, status, entry_alert_id, entry_price, allocation, shares, tp1_price, stop_price, opened_at, updated_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    trade.id,
    trade.profile_id,
    trade.ticker,
    trade.entry_alert_id,
    trade.entry_price,
    trade.allocation,
    trade.shares,
    trade.tp1_price,
    trade.stop_price,
    trade.opened_at,
    trade.updated_at,
  ).run();
  return normalizeTrade(trade);
}

async function markAlertFilter(env, alertId, status, reason = "", details = null) {
  await env.DB.prepare(
    `UPDATE tv_alerts SET filter_status = ?, filter_reason = ?, filter_details = ? WHERE id = ?`
  ).bind(status, reason, details ? JSON.stringify(details) : null, alertId).run();
}

async function passesBuyFilter(alert) {
  const ticker = sanitizeTicker(alert.ticker);
  if (!ticker) return { ok: false, reason: "missing ticker" };
  const minutes = etMinutes(alert.receivedAt);
  if (minutes < MIN_BUY_MINUTES_ET) return { ok: false, reason: "before 10:00 AM ET" };
  if (minutes > MAX_BUY_MINUTES_ET) return { ok: false, reason: "after 3:15 PM ET" };
  if (BLOCKED_BUY_TICKERS.has(ticker)) {
    return { ok: false, reason: "blocked leveraged or volatility product" };
  }

  const [tickerBars, spyBars] = await Promise.all([
    fetchYahooProxyBars(ticker, { range: "15d", interval: "15m" }),
    fetchYahooProxyBars("SPY", { range: "15d", interval: "15m" }),
  ]);
  const tickerSnapshot = buildFilterSnapshot(tickerBars, alert.receivedAt);
  const spySnapshot = buildFilterSnapshot(spyBars, alert.receivedAt);

  if (!tickerSnapshot) return { ok: false, reason: "not enough ticker market data" };
  if (!spySnapshot) return { ok: false, reason: "not enough SPY market data" };

  const details = {
    close: roundMoney(tickerSnapshot.close),
    ema200: roundMoney(tickerSnapshot.ema200),
    vwap: roundMoney(tickerSnapshot.vwap),
    atr14: roundMoney(tickerSnapshot.atr14),
    vwapDistanceAtr: Math.round(tickerSnapshot.vwapDistanceAtr * 100) / 100,
    volumeRatio: Math.round(tickerSnapshot.volumeRatio * 100) / 100,
    spyClose: roundMoney(spySnapshot.close),
    spyVwap: roundMoney(spySnapshot.vwap),
  };

  if (!(tickerSnapshot.close > tickerSnapshot.ema200)) {
    return { ok: false, reason: "price below 200 EMA", details };
  }
  if (!(tickerSnapshot.close > tickerSnapshot.vwap)) {
    return { ok: false, reason: "price below VWAP", details };
  }
  if (!(spySnapshot.close > spySnapshot.vwap)) {
    return { ok: false, reason: "SPY below VWAP", details };
  }
  if (tickerSnapshot.vwapDistanceAtr > 1.5) {
    return { ok: false, reason: "price more than 1.5 ATR above VWAP", details };
  }
  if (!(tickerSnapshot.volumeRatio >= 1)) {
    return { ok: false, reason: "volume below 1.0x 20-bar average", details };
  }

  return { ok: true, details };
}

function calculateRiskSizing(entryPrice, stopPrice, profile) {
  const riskDollars = accountEquity(profile) * (riskPerTradePct(profile) / 100);
  const riskPerShare = entryPrice - stopPrice;
  if (!(riskPerShare > 0)) {
    const allocation = riskDollars;
    return { allocation, shares: allocation / entryPrice };
  }
  const shares = riskDollars / riskPerShare;
  return {
    allocation: roundMoney(shares * entryPrice),
    shares,
  };
}

async function closeTradeForExit(env, profile, alert, alertId) {
  const trade = await env.DB.prepare(
    `SELECT * FROM tv_trades WHERE profile_id = ? AND ticker = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`
  ).bind(profile.id, alert.ticker).first();
  if (!trade) return json({ ok: true, skipped: "no_open_trade", alert_id: alertId, ticker: alert.ticker });

  const pnl = roundMoney((alert.price - trade.entry_price) * trade.shares);
  const pnlPct = roundMoney(((alert.price - trade.entry_price) / trade.entry_price) * 100);
  const outcome = alert.price >= trade.entry_price ? "take_profit" : "stop_loss";
  const closedAt = alert.receivedAt;
  await env.DB.prepare(
    `UPDATE tv_trades
     SET status = 'closed', exit_alert_id = ?, exit_price = ?, outcome = ?, pnl = ?, pnl_pct = ?, closed_at = ?, updated_at = ?
     WHERE id = ?`
  ).bind(alertId, alert.price, outcome, pnl, pnlPct, closedAt, new Date().toISOString(), trade.id).run();
  return json({
    ok: true,
    action: "closed",
    alert_id: alertId,
    trade: normalizeTrade({ ...trade, status: "closed", exit_alert_id: alertId, exit_price: alert.price, outcome, pnl, pnl_pct: pnlPct, closed_at: closedAt }),
  });
}

async function closeRawTradeForExit(env, profile, alert, alertId) {
  const trade = await env.DB.prepare(
    `SELECT * FROM tv_raw_trades WHERE profile_id = ? AND ticker = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`
  ).bind(profile.id, alert.ticker).first();
  if (!trade) return null;

  const pnl = roundMoney((alert.price - trade.entry_price) * trade.shares);
  const pnlPct = roundMoney(((alert.price - trade.entry_price) / trade.entry_price) * 100);
  const outcome = alert.price >= trade.entry_price ? "take_profit" : "stop_loss";
  const closedAt = alert.receivedAt;
  await env.DB.prepare(
    `UPDATE tv_raw_trades
     SET status = 'closed', exit_alert_id = ?, exit_price = ?, outcome = ?, pnl = ?, pnl_pct = ?, closed_at = ?, updated_at = ?
     WHERE id = ?`
  ).bind(alertId, alert.price, outcome, pnl, pnlPct, closedAt, new Date().toISOString(), trade.id).run();
  return normalizeTrade({ ...trade, status: "closed", exit_alert_id: alertId, exit_price: alert.price, outcome, pnl, pnl_pct: pnlPct, closed_at: closedAt });
}

function normalizeTvAlert(body, profile) {
  const rawText = String(body.rawText || body.raw || body.message || body.pattern || body.alert || "").trim();
  const embeddedFields = extractEmbeddedPayloadFields(rawText);
  const explicitAction = String(body.event || body.action || body.side || inferActionFromPayload(rawText) || "").trim().toLowerCase();
  let eventType = null;
  if (["exit", "sell", "close"].includes(explicitAction)) {
    eventType = "exit";
  } else if (["buy", "entry", "long"].includes(explicitAction)) {
    eventType = "buy";
  } else {
    eventType = detectAlertAction(rawText || body.alert);
  }
  const textFields = parseAlertText(rawText);
  const price =
    positiveNumber(body.price ?? body.close ?? body.entry_price ?? body.entry ?? body.ohlcv?.close ?? embeddedFields.close) ||
    textFields.price;
  return {
    eventType,
    ticker: sanitizeTicker(body.ticker || body.symbol || body.syminfo?.ticker || embeddedFields.ticker || textFields.ticker),
    price,
    timeframe: String(body.timeframe || body.interval || body.tf || embeddedFields.tf || textFields.timeframe || "").slice(0, 24) || null,
    grade: String(body.grade || "A").slice(0, 8),
    rawText,
    receivedAt: normalizeTimestamp(body.received_at || body.time || embeddedFields.bartime),
    allocation: positiveNumber(body.allocation || body.allocation_per_alert) || profile.allocation_per_alert,
    stop: positiveNumber(body.stop_price || body.stop || body.stop_loss) || textFields.stop,
    t1: positiveNumber(body.t1 || body.tp1 || body.take_profit || body.take_profit_1) || textFields.t1,
  };
}

function parseWebhookBody(rawBody) {
  const rawText = String(rawBody || "").trim();
  if (!rawText) return { rawText };
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...parsed, rawText: String(parsed.raw || parsed.message || parsed.pattern || rawText).trim() };
    }
  } catch {
    // TradingView plain @alert messages are the primary input.
  }
  const embedded = extractEmbeddedPayloadFields(rawText);
  const fallback = { rawText };
  if (embedded.action) fallback.action = embedded.action;
  if (embedded.ticker) fallback.ticker = embedded.ticker;
  if (embedded.tf) fallback.tf = embedded.tf;
  if (embedded.bartime) fallback.bartime = embedded.bartime;
  if (embedded.close) fallback.ohlcv = { close: embedded.close };
  return fallback;
}

function detectAlertAction(rawText) {
  const text = String(rawText || "").toLowerCase();
  if (/\b(exit|sell|closed|take\s*profit|tp1?|stop\s*loss|sl)\b/.test(text)) return "exit";
  if (/\b(buy|long|entry|enter|open)\b/.test(text)) return "buy";
  if (/\bbullish\b.*\bconfirmation\b|\bconfirmation\b.*\bbullish\b|\bbullish\+\b|\bbullish\s+contrarian\b/.test(text)) return "buy";
  if (/\bbearish\b.*\bconfirmation\b|\bconfirmation\b.*\bbearish\b|\bbearish\+\b|\bbearish\s+contrarian\b/.test(text)) return "exit";
  return null;
}

function inferActionFromPayload(rawText) {
  const text = String(rawText || "");
  const quotedAction = text.match(/"action"\s*:\s*"(buy|exit|sell|close|long|entry)"/i)?.[1];
  if (quotedAction) return quotedAction.toLowerCase();
  const plainAction = text.match(/\baction\s*[:=]\s*(buy|exit|sell|close|long|entry)\b/i)?.[1];
  return plainAction ? plainAction.toLowerCase() : "";
}

function extractEmbeddedPayloadFields(rawText) {
  const text = String(rawText || "");
  return {
    action: text.match(/"action"\s*:\s*"(buy|exit|sell|close|long|entry)"/i)?.[1] || "",
    ticker: text.match(/"ticker"\s*:\s*"([^"]+)"/i)?.[1] || "",
    tf: text.match(/"tf"\s*:\s*"([^"]+)"/i)?.[1] || "",
    close: text.match(/"close"\s*:\s*"([0-9]+(?:\.[0-9]+)?)"/i)?.[1] || "",
    bartime: text.match(/"bartime"\s*:\s*([0-9]{10,})/i)?.[1] || "",
  };
}

function parseAlertText(rawText) {
  const text = String(rawText || "");
  const ticker =
    matchGroup(text, /\b(?:ticker|symbol|pair)\s*[:=]\s*([A-Z][A-Z0-9_.:-]{0,19})\b/i) ||
    matchGroup(text, /\b(?:on|for)\s+([A-Z][A-Z0-9_.:-]{0,19})\b/) ||
    firstTickerCandidate(text);
  const price = firstPositiveNumber(
    matchGroup(text, /\b(?:price|close|entry|at)\s*[:=]?\s*\$?([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/i),
    matchGroup(text, /\$([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/),
    firstPriceCandidate(text),
  );
  const stop = firstPositiveNumber(matchGroup(text, /\b(?:stop|stop\s*loss|sl)\s*[:=]?\s*\$?([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/i));
  const t1 = firstPositiveNumber(matchGroup(text, /\b(?:tp1?|target|take\s*profit)\s*[:=]?\s*\$?([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/i));
  const timeframe = matchGroup(text, /\b(?:timeframe|interval|tf)\s*[:=]\s*([0-9]+[A-Z]+|[A-Z0-9]+)\b/i);
  return { ticker, price, stop, t1, timeframe };
}

function isTradingViewWebhookPath(pathname) {
  return pathname === "/api/tv/webhook" || pathname.startsWith("/api/tv/webhook/");
}

function firstTickerCandidate(text) {
  const reserved = new Set(["BUY", "EXIT", "SELL", "LONG", "SHORT", "ENTRY", "CLOSE", "CLOSED", "ALERT", "LUXALGO", "TP", "TP1", "SL"]);
  const matches = String(text || "").match(/\b[A-Z][A-Z0-9_.:-]{1,19}\b/g) || [];
  return matches.find((value) => !reserved.has(value.toUpperCase())) || "";
}

function matchGroup(text, regex) {
  return String(text || "").match(regex)?.[1] || "";
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = positiveNumber(String(value || "").replace(/,/g, ""));
    if (number) return number;
  }
  return null;
}

function firstPriceCandidate(text) {
  const matches = String(text || "").match(/\b[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?\b/g) || [];
  const filtered = matches.filter((value, index) => {
    const slice = String(text || "").slice(Math.max(0, String(text || "").indexOf(value) - 8), String(text || "").indexOf(value) + value.length + 8).toLowerCase();
    if (/\btf\b|\bbartime\b/.test(slice)) return false;
    return true;
  });
  return filtered.find((value) => {
    const number = Number(value.replace(/,/g, ""));
    return Number.isFinite(number) && number > 0 && number < 1000000;
  }) || matches.find((value) => {
    const number = Number(value.replace(/,/g, ""));
    return Number.isFinite(number) && number > 0 && number < 1000000;
  }) || "";
}

function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    allocationPerAlert: Number(profile.allocation_per_alert || 1000),
    defaultTpPct: Number(profile.default_tp_pct || 3),
    defaultStopPct: Number(profile.default_stop_pct || 2),
    strategyMode: strategyMode(profile),
    accountEquity: accountEquity(profile),
    riskPerTradePct: riskPerTradePct(profile),
    createdAt: profile.created_at,
    updatedAt: profile.updated_at,
  };
}

function normalizeStrategyMode(value) {
  return value === OLD_FIXED_STRATEGY_MODE ? OLD_FIXED_STRATEGY_MODE : DEFAULT_STRATEGY_MODE;
}

function strategyMode(profile) {
  return normalizeStrategyMode(profile?.strategy_mode);
}

function accountEquity(profile) {
  return positiveNumber(profile?.account_equity) || DEFAULT_ACCOUNT_EQUITY;
}

function riskPerTradePct(profile) {
  return positiveNumber(profile?.risk_per_trade_pct) || DEFAULT_RISK_PER_TRADE_PCT * 100;
}

function normalizeTrade(row) {
  return {
    id: row.id,
    ticker: row.ticker,
    status: row.status,
    entryAlertId: row.entry_alert_id || null,
    exitAlertId: row.exit_alert_id || null,
    entryFilterStatus: row.entry_alert_filter_status || null,
    entryPrice: numberOrNull(row.entry_price),
    exitPrice: numberOrNull(row.exit_price),
    allocation: numberOrNull(row.allocation) || 0,
    shares: numberOrNull(row.shares) || 0,
    tp1Price: numberOrNull(row.tp1_price),
    stopPrice: numberOrNull(row.stop_price),
    outcome: row.outcome || null,
    entryTrigger: summarizeAlertTrigger(row.entry_alert_raw_text, row.entry_alert_raw_json, "buy"),
    exitTrigger: summarizeAlertTrigger(row.exit_alert_raw_text, row.exit_alert_raw_json, row.outcome || "closed"),
    pnl: numberOrNull(row.pnl) || 0,
    pnlPct: numberOrNull(row.pnl_pct) || 0,
    currentPrice: null,
    currentPnl: 0,
    currentPnlPct: 0,
    openedAt: row.opened_at,
    closedAt: row.closed_at || null,
    updatedAt: row.updated_at,
  };
}

function normalizeAlert(row) {
  return {
    id: row.id,
    eventType: row.event_type,
    ticker: row.ticker,
    price: numberOrNull(row.price),
    timeframe: row.timeframe || null,
    grade: row.grade || null,
    rawText: row.raw_text || "",
    filterStatus: row.filter_status || null,
    filterReason: row.filter_reason || null,
    filterDetails: parseLooseJson(row.filter_details) || null,
    receivedAt: row.received_at,
    createdAt: row.created_at,
    duplicate: Boolean(row.duplicate),
  };
}

async function getState(env, key) {
  const row = await env.DB.prepare(`SELECT value FROM tv_app_state WHERE key = ?`).bind(key).first();
  return row?.value || null;
}

async function setState(env, key, value, updatedAt = new Date().toISOString()) {
  await env.DB.prepare(
    `INSERT INTO tv_app_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, String(value), updatedAt).run();
}

async function addColumnIfMissing(env, table, column, type) {
  try {
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  } catch (error) {
    const message = errorMessage(error).toLowerCase();
    if (!message.includes("duplicate column") && !message.includes("already exists")) throw error;
  }
}

function sameEtDay(value) {
  if (!value) return false;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date(value)) === fmt.format(new Date());
}

function webhookUrl(request, secret = "") {
  const host = new URL(request.url).host;
  const suffix = secret ? `/${encodeURIComponent(secret)}` : "";
  if (host === "tv.kalkianalysis.com") return `${DEFAULT_WEBHOOK_URL}${suffix}`;
  const url = new URL(request.url);
  url.pathname = `/api/tv/webhook${suffix}`;
  url.search = "";
  return url.toString();
}

function enrichTradeWithQuote(trade, quote) {
  if (!trade || trade.status !== "open" || !quote?.price) return trade;
  const currentPrice = roundMoney(quote.price);
  const currentPnl = roundMoney((currentPrice - trade.entryPrice) * trade.shares);
  const currentPnlPct = trade.entryPrice ? roundMoney(((currentPrice - trade.entryPrice) / trade.entryPrice) * 100) : 0;
  return {
    ...trade,
    currentPrice,
    currentPnl,
    currentPnlPct,
  };
}

async function fetchQuotesForTrades(env, trades) {
  const tickers = [...new Set((trades || []).map((trade) => sanitizeTicker(trade.ticker)).filter(Boolean))];
  const map = new Map();
  if (!tickers.length) return map;

  const results = await Promise.all(tickers.map(async (ticker) => {
    const price = await fetchYahooProxyPrice(ticker);
    return price ? { ticker, price } : null;
  }));
  for (const result of results) {
    if (!result) continue;
    map.set(result.ticker, { price: result.price });
    await saveQuoteCache(env, result.ticker, result.price);
  }

  const missingTickers = tickers.filter((ticker) => !map.has(ticker));
  if (missingTickers.length) {
    const cached = await loadQuoteCache(env, missingTickers);
    for (const quote of cached) {
      map.set(quote.ticker, { price: quote.price, cached: true });
    }
  }

  return map;
}

async function fetchCachedQuotesForTrades(env, trades) {
  const tickers = [...new Set((trades || []).map((trade) => sanitizeTicker(trade.ticker)).filter(Boolean))];
  const map = new Map();
  if (!tickers.length) return map;
  const cached = await loadQuoteCache(env, tickers);
  for (const quote of cached) {
    map.set(quote.ticker, { price: quote.price, cached: true });
  }
  return map;
}

async function saveQuoteCache(env, ticker, price) {
  await env.DB.prepare(
    `INSERT INTO tv_quote_cache (ticker, price, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(ticker) DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at`
  ).bind(ticker, price, new Date().toISOString()).run();
}

async function loadQuoteCache(env, tickers) {
  const quotes = [];
  for (const ticker of tickers || []) {
    const row = await env.DB.prepare(`SELECT ticker, price FROM tv_quote_cache WHERE ticker = ?`).bind(ticker).first();
    const price = positiveNumber(row?.price);
    if (row?.ticker && price) quotes.push({ ticker: row.ticker, price });
  }
  return quotes;
}

async function autoCloseTradesFromQuotes(env, profile, trades, quotes) {
  for (const trade of trades || []) {
    if (!trade || trade.status !== "open") continue;
    const currentPrice = positiveNumber(quotes.get(trade.ticker)?.price);
    if (!currentPrice) continue;

    let outcome = null;
    if (trade.stopPrice && currentPrice <= trade.stopPrice) {
      outcome = "stop_loss";
    } else if (trade.tp1Price && currentPrice >= trade.tp1Price) {
      outcome = "take_profit";
    }
    if (!outcome) continue;

    await closeTradeFromSystemPrice(env, profile, trade, currentPrice, outcome, "tv_trades");
  }
}

async function closeTradeFromSystemPrice(env, profile, trade, exitPrice, outcome, tableName = "tv_trades") {
  const table = tradeTableName(tableName);
  const closedAt = new Date().toISOString();
  const rawText = outcome === "take_profit"
    ? `AUTO TAKE PROFIT ${trade.ticker} @ ${exitPrice}`
    : `AUTO STOP LOSS ${trade.ticker} @ ${exitPrice}`;
  const idempotencyKey = await sha256Hex(`${profile.id}:${table}:auto:${outcome}:${trade.id}:${exitPrice}:${sameMinute(closedAt)}`);
  const alertId = crypto.randomUUID();

  try {
    await env.DB.prepare(
      `INSERT INTO tv_alerts
        (id, profile_id, event_type, ticker, price, timeframe, grade, raw_json, raw_text, idempotency_key, received_at, created_at, duplicate)
       VALUES (?, ?, 'exit', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(
      alertId,
      profile.id,
      trade.ticker,
      exitPrice,
      null,
      "SYS",
      JSON.stringify({ action: "exit", source: "quote-monitor", outcome, ticker: trade.ticker, price: exitPrice }),
      rawText,
      idempotencyKey,
      closedAt,
      closedAt,
    ).run();
  } catch {
    return;
  }

  const pnl = roundMoney((exitPrice - trade.entryPrice) * trade.shares);
  const pnlPct = roundMoney(((exitPrice - trade.entryPrice) / trade.entryPrice) * 100);
  await env.DB.prepare(
    `UPDATE ${table}
     SET status = 'closed', exit_alert_id = ?, exit_price = ?, outcome = ?, pnl = ?, pnl_pct = ?, closed_at = ?, updated_at = ?
     WHERE id = ? AND status = 'open'`
  ).bind(alertId, exitPrice, outcome, pnl, pnlPct, closedAt, closedAt, trade.id).run();
}

async function autoCloseRawTradesFromQuotes(env, profile, trades, quotes) {
  for (const trade of trades || []) {
    if (!trade || trade.status !== "open") continue;
    const currentPrice = positiveNumber(quotes.get(trade.ticker)?.price);
    if (!currentPrice) continue;

    let outcome = null;
    if (trade.stopPrice && currentPrice <= trade.stopPrice) {
      outcome = "stop_loss";
    } else if (trade.tp1Price && currentPrice >= trade.tp1Price) {
      outcome = "take_profit";
    }
    if (!outcome) continue;

    await closeTradeFromSystemPrice(env, profile, trade, currentPrice, outcome, "tv_raw_trades");
  }
}

function tradeTableName(value) {
  if (value === "tv_raw_trades") return "tv_raw_trades";
  return "tv_trades";
}

function toYahooSymbol(ticker) {
  const value = sanitizeTicker(ticker);
  const aliases = {
    ES1: "ES=F",
    NQ1: "NQ=F",
    YM1: "YM=F",
    RTY1: "RTY=F",
    CL1: "CL=F",
    GC1: "GC=F",
    SI1: "SI=F",
    HG1: "HG=F",
    NG1: "NG=F",
  };
  return aliases[value] || value;
}

function fromYahooSymbol(symbol) {
  const value = String(symbol || "").trim().toUpperCase();
  const aliases = {
    "ES=F": "ES1",
    "NQ=F": "NQ1",
    "YM=F": "YM1",
    "RTY=F": "RTY1",
    "CL=F": "CL1",
    "GC=F": "GC1",
    "SI=F": "SI1",
    "HG=F": "HG1",
    "NG=F": "NG1",
  };
  return aliases[value] || sanitizeTicker(value);
}

function sameMinute(value) {
  return String(value || "").slice(0, 16);
}

function hasSetupPasscode(request) {
  return String(request.headers.get("x-setup-passcode") || "").trim() === SETUP_PASSCODE;
}

function requireSetupPasscode(request) {
  if (hasSetupPasscode(request)) return;
  const error = new Error("Setup passcode required");
  error.status = 401;
  throw error;
}

function summarizeAlertTrigger(rawText, rawJson, fallback) {
  const text = String(rawText || "").trim();
  if (!text && !rawJson) return fallback || null;
  if (/^AUTO\s+/i.test(text)) return text;

  const parsed = parseLooseJson(rawJson) || parseLooseJson(text);
  const alertLabel = String(parsed?.alert || "").trim();
  if (alertLabel && alertLabel.toLowerCase() !== "scripted alert") return alertLabel;

  const lowered = `${alertLabel} ${text}`.toLowerCase();
  if (lowered.includes("bullish exit")) return "Bullish Exit";
  if (lowered.includes("bearish exit")) return "Bearish Exit";
  if (lowered.includes("bearish contrarian")) return "Bearish Contrarian";
  if (lowered.includes("bullish contrarian")) return "Bullish Contrarian";
  if (lowered.includes("take profit")) return "Take Profit";
  if (lowered.includes("stop loss")) return "Stop Loss";
  if (lowered.includes("bullish confirmation")) return "Bullish Confirmation";
  if (lowered.includes("bearish confirmation")) return "Bearish Confirmation";

  return fallback || "Alert";
}

function parseLooseJson(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchYahooProxyPrice(ticker) {
  const symbol = toYahooSymbol(ticker);
  if (!symbol) return null;
  const encodedSymbol = encodeURIComponent(symbol);
  const params = `range=1d&interval=1m&includePrePost=true&cb=${Date.now()}`;
  const yahooUrls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?${params}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?${params}`,
  ];
  const proxyBaseUrl = DEFAULT_YAHOO_PROXY_BASE_URL;
  const attempts = yahooUrls.flatMap((yahooUrl) => [
    `${proxyBaseUrl}?url=${encodeURIComponent(yahooUrl)}`,
    `${proxyBaseUrl}/?url=${encodeURIComponent(yahooUrl)}`,
  ]);

  for (const url of attempts) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0 KalkiTV/1.0",
        },
      });
      if (!response.ok) continue;
      const payload = await response.json().catch(() => null);
      const result = payload?.chart?.result?.[0];
      if (!result) continue;
      const meta = result.meta || {};
      const quote = result.indicators?.quote?.[0] || {};
      const close = Array.isArray(quote.close) ? quote.close.map(Number).filter(Number.isFinite) : [];
      const price = positiveNumber(meta.regularMarketPrice) || positiveNumber(close.at(-1));
      if (price) return price;
    } catch {
      continue;
    }
  }

  return null;
}

async function fetchYahooProxyBars(ticker, { range = "15d", interval = "15m" } = {}) {
  const symbol = toYahooSymbol(ticker);
  if (!symbol) return [];
  const encodedSymbol = encodeURIComponent(symbol);
  const params = `range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false&cb=${Date.now()}`;
  const yahooUrls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?${params}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?${params}`,
  ];
  const proxyBaseUrl = DEFAULT_YAHOO_PROXY_BASE_URL;
  const attempts = yahooUrls.flatMap((yahooUrl) => [
    `${proxyBaseUrl}?url=${encodeURIComponent(yahooUrl)}`,
    `${proxyBaseUrl}/?url=${encodeURIComponent(yahooUrl)}`,
  ]);

  for (const url of attempts) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0 KalkiTV/1.0",
        },
      });
      if (!response.ok) continue;
      const payload = await response.json().catch(() => null);
      const result = payload?.chart?.result?.[0];
      const timestamps = result?.timestamp || [];
      const quote = result?.indicators?.quote?.[0] || {};
      const bars = timestamps.map((timestamp, index) => ({
        time: Number(timestamp) * 1000,
        open: Number(quote.open?.[index]),
        high: Number(quote.high?.[index]),
        low: Number(quote.low?.[index]),
        close: Number(quote.close?.[index]),
        volume: Number(quote.volume?.[index]),
      })).filter((bar) => (
        Number.isFinite(bar.time)
        && Number.isFinite(bar.high)
        && Number.isFinite(bar.low)
        && Number.isFinite(bar.close)
        && Number.isFinite(bar.volume)
      ));
      if (bars.length) return bars;
    } catch {
      continue;
    }
  }

  return [];
}

function buildFilterSnapshot(bars, alertTime) {
  const cutoff = Date.parse(alertTime || "");
  const usableBars = (bars || [])
    .filter((bar) => Number.isFinite(bar.close) && (!Number.isFinite(cutoff) || bar.time <= cutoff))
    .sort((a, b) => a.time - b.time);
  if (usableBars.length < 201) return null;

  const latest = usableBars.at(-1);
  const ema200 = ema(usableBars.map((bar) => bar.close), 200);
  const dayBars = barsForSameEtDay(usableBars, latest.time);
  const vwap = intradayVwap(dayBars);
  const previous20 = usableBars.slice(-21, -1);
  const averageVolume20 = average(previous20.map((bar) => bar.volume));
  const atr14 = atr(usableBars, 14);
  if (!ema200 || !vwap || !averageVolume20 || !atr14) return null;

  return {
    close: latest.close,
    ema200,
    vwap,
    atr14,
    vwapDistanceAtr: (latest.close - vwap) / atr14,
    volumeRatio: latest.volume / averageVolume20,
  };
}

function atr(bars, length) {
  const clean = (bars || []).filter((bar) => (
    Number.isFinite(bar.high)
    && Number.isFinite(bar.low)
    && Number.isFinite(bar.close)
  ));
  if (clean.length < length + 1) return null;
  const trueRanges = [];
  for (let index = 1; index < clean.length; index += 1) {
    const bar = clean[index];
    const previousClose = clean[index - 1].close;
    trueRanges.push(Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    ));
  }
  return average(trueRanges.slice(-length));
}

function ema(values, length) {
  const clean = (values || []).map(Number).filter(Number.isFinite);
  if (clean.length < length) return null;
  const multiplier = 2 / (length + 1);
  let current = clean.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  for (const value of clean.slice(length)) {
    current = (value - current) * multiplier + current;
  }
  return current;
}

function barsForSameEtDay(bars, time) {
  const day = etDayKey(time);
  return (bars || []).filter((bar) => etDayKey(bar.time) === day);
}

function intradayVwap(bars) {
  let volume = 0;
  let priceVolume = 0;
  for (const bar of bars || []) {
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    volume += bar.volume;
    priceVolume += typicalPrice * bar.volume;
  }
  return volume > 0 ? priceVolume / volume : null;
}

function average(values) {
  const clean = (values || []).map(Number).filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function etDayKey(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function etMinutes(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(value));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return hour * 60 + minute;
}

function cleanName(value) {
  return String(value || "TradingView signals").replace(/\s+/g, " ").trim().slice(0, 80) || "TradingView signals";
}

function sanitizeTicker(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9_.:-]/g, "").slice(0, 20);
}

function normalizeTimestamp(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function makeToken() {
  return base64Url(randomBytes(32));
}

function makeAccessCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "KALKI-TV";
  for (const group of [4, 4, 4]) {
    out += "-";
    for (let index = 0; index < group; index += 1) out += alphabet[randomBytes(1)[0] % alphabet.length];
  }
  return out;
}

function normalizeAccessCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64Url(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "Unknown error";
}

function errorStatus(error) {
  const status = Number(error?.status || 500);
  return Number.isFinite(status) && status >= 400 && status < 600 ? status : 500;
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
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Client-Id,X-Client-Token",
      ...headers,
    },
  });
}
