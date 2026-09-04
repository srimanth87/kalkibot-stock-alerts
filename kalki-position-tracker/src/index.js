const DEFAULT_CHECK_LIMIT = 100;
const DEFAULT_YAHOO_PROXY_BASE_URL = "https://yahoo-proxy.srimanthgada87.workers.dev";
const DEFAULT_ALPACA_BASE_URL = "https://data.alpaca.markets";
const DEFAULT_TRADIER_BASE_URL = "https://api.tradier.com";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return json({
          ok: true,
          service: "kalki-position-tracker",
          db_bound: Boolean(env.DB),
          approval_configured: Boolean(getAlertChatId(env) && env.APPROVAL_GATE?.fetch),
          price_source: describePriceSource(env),
          check_limit: readLimit(env.CHECK_LIMIT),
        });
      }

      if ((request.method === "GET" || request.method === "POST") && url.pathname === "/check") {
        if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
        const dryRun = isTruthy(url.searchParams.get("dryRun")) || isTruthy(url.searchParams.get("dry_run"));
        return json(await checkOpenPositions(env, { dryRun }));
      }

      if (request.method === "POST" && url.pathname === "/close") {
        if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
        const body = await request.json().catch(() => ({}));
        const result = await closePosition(env, {
          sym: body.sym || body.ticker || body.symbol,
          id: body.id,
          price: body.price ?? body.exit ?? body.exitPrice,
          note: body.note || body.reason || "",
          dryRun: isTruthy(body.dryRun) || isTruthy(url.searchParams.get("dryRun")),
        });
        return json(result, result.ok ? 200 : 400);
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Position tracker failed", { message });
      return json({ ok: false, error: message }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkOpenPositions(env));
  },
};

export async function checkOpenPositions(env, options = {}) {
  requireDb(env);
  const dryRun = options.dryRun === true;
  const positions = await listOpenPositions(env.DB, options.limit || readLimit(env.CHECK_LIMIT));
  const results = [];

  // Most 5-minute ticks produce no events, so the table is only ensured on the
  // first event of an invocation rather than on every check.
  const priceCache = new Map();
  const maxPriceFetches = readMaxPriceFetches(env);
  let priceFetches = 0;

  let eventsTableReady = false;
  const ensureEventsTable = async () => {
    if (eventsTableReady) return;
    await ensureAlertEventsTable(env.DB);
    eventsTableReady = true;
  };

  for (const position of positions) {
    if (!getKalkiStocksReplyMessageId(env, position)) {
      results.push({ id: position.id, sym: position.sym, status: "skipped", reason: "missing original Kalki-stocks message id" });
      continue;
    }

    // One fetch per distinct ticker, capped per run: several positions can share
    // a symbol, and the Free plan allows only 50 subrequests per invocation.
    let price;
    if (priceCache.has(position.sym)) {
      price = priceCache.get(position.sym);
    } else if (priceFetches >= maxPriceFetches) {
      results.push({ id: position.id, sym: position.sym, status: "skipped", reason: "price budget reached, deferred to next run" });
      continue;
    } else {
      price = await getLatestPrice(env, position.sym, options.prices);
      priceFetches += 1;
      priceCache.set(position.sym, price);
    }

    if (!Number.isFinite(price)) {
      results.push({ id: position.id, sym: position.sym, status: "skipped", reason: "price unavailable" });
      continue;
    }

      const evaluation = evaluatePosition(position, price);
    const result = {
      id: position.id,
      sym: position.sym,
      price,
      status: evaluation.alert ? "alert" : "updated",
      event: evaluation.event,
      tpsHit: evaluation.tpsHit,
      nextTP: evaluation.nextTP,
      closed: evaluation.closed === true,
    };

    if (!dryRun && evaluation.alert) {
      await sendApproval(env, position, evaluation);
      await ensureEventsTable();
      result.recorded = await recordAlertEvent(
        env.DB,
        position,
        evaluation,
        getKalkiStocksReplyMessageId(env, position),
      );
    }

    if (!dryRun) {
      await updateTrackedPosition(env.DB, position, evaluation);
    }

    results.push(result);
  }

  return {
    ok: true,
    dryRun,
    checked: positions.length,
    alerts: results.filter((result) => result.status === "alert").length,
    priceFetches,
    deferred: results.filter((result) => result.reason === "price budget reached, deferred to next run").length,
    results,
  };
}

/**
 * Manual exit: closes an open position at an analyst-chosen price.
 *
 * Follows the same order as an automatic TP/SL hit — queue the approval, log the
 * event, then persist — so a manual close behaves identically to an automatic
 * one everywhere downstream (D1 state, alert_events, threaded Telegram reply).
 */
export async function closePosition(env, options = {}) {
  requireDb(env);

  const sym = String(options.sym || "").toUpperCase().replace(/[^A-Z0-9.-]/g, "");
  const id = String(options.id || "");
  if (!sym && !id) return { ok: false, error: "sym or id is required" };

  const positions = await listOpenPositions(env.DB, readLimit(env.CHECK_LIMIT));
  const position = positions.find((entry) => (id ? entry.id === id : entry.sym === sym));
  if (!position) {
    return { ok: false, error: `No open position found for ${id || sym}` };
  }

  const replyMessageId = getKalkiStocksReplyMessageId(env, position);
  if (!replyMessageId) {
    return { ok: false, error: `${position.sym} has no original Kalki-stocks message id, so the close cannot be threaded` };
  }

  // Fall back to the live price when the analyst does not name an exit.
  const requested = num(options.price);
  const price = Number.isFinite(requested) ? requested : await getLatestPrice(env, position.sym);
  if (!Number.isFinite(price)) {
    return { ok: false, error: `No exit price given and no live price available for ${position.sym}` };
  }

  const evaluation = {
    alert: true,
    event: "manual",
    label: "TRADE CLOSED",
    price,
    tpsHit: int(position.tpsHit),
    nextTP: null,
    pnlPct: calculatePnlPct(num(position.entryPrice), price),
    statusText: "CLOSED (manual)",
    stopAlerted: Boolean(position.stopAlerted),
    closed: true,
    note: String(options.note || ""),
  };

  if (options.dryRun) {
    return { ok: true, dryRun: true, id: position.id, sym: position.sym, price, pnlPct: evaluation.pnlPct };
  }

  await sendApproval(env, position, evaluation);
  await ensureAlertEventsTable(env.DB);
  const recorded = await recordAlertEvent(env.DB, position, evaluation, replyMessageId);
  await updateTrackedPosition(env.DB, position, evaluation);

  return {
    ok: true,
    id: position.id,
    sym: position.sym,
    entryPrice: num(position.entryPrice),
    exitPrice: price,
    pnlPct: evaluation.pnlPct,
    recorded,
    status: "closed",
  };
}

export function evaluatePosition(position, price) {
  const targets = normalizeTargets(position.resistances);
  const previousTpsHit = Math.max(0, Math.min(targets.length, int(position.tpsHit)));
  const tpsHit = targets.filter((target) => price >= target).length;
  const nextTP = targets.find((target) => price < target) || null;
  const breakdown = num(position.breakdown);
  const entryPrice = num(position.entryPrice);
  const pnlPct = calculatePnlPct(entryPrice, price);

  if (breakdown && price <= breakdown && !position.stopAlerted) {
    return {
      alert: true,
      event: "stop",
      label: "STOP LOSS HIT",
      price,
      tpsHit,
      nextTP,
      pnlPct,
      statusText: "STOP LOSS",
      stopAlerted: true,
      // Terminal: the trade is over, stop re-pricing it every 5 minutes.
      closed: true,
    };
  }

  if (tpsHit > previousTpsHit) {
    const target = targets[tpsHit - 1];
    return {
      alert: true,
      event: "target",
      label: `TP${tpsHit} HIT`,
      price,
      target,
      tpsHit,
      nextTP,
      pnlPct,
      statusText: nextTP ? `Watching TP${tpsHit + 1}` : "ALL TPs HIT",
      stopAlerted: Boolean(position.stopAlerted),
      // Terminal only once the final target is reached.
      closed: !nextTP,
    };
  }

  return {
    alert: false,
    event: null,
    price,
    tpsHit,
    nextTP,
    pnlPct,
    statusText: nextTP ? `Watching TP${tpsHit + 1}` : targets.length ? "ALL TPs HIT" : "Tracking",
    stopAlerted: Boolean(position.stopAlerted),
    closed: false,
  };
}

/**
 * Append-only trade history. The position row is overwritten on every check, so
 * without this the lifecycle (when each target was hit, at what price) is lost.
 * The unique index makes a re-run of the same event a no-op, so a cron retry
 * cannot create duplicate history.
 */
async function ensureAlertEventsTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS alert_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id TEXT NOT NULL,
    sym TEXT NOT NULL,
    event TEXT NOT NULL,
    price REAL,
    pnl_pct REAL,
    telegram_message_id TEXT,
    created_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS alert_events_unique
    ON alert_events(position_id, event)`).run();
}

function eventName(evaluation) {
  if (evaluation.event === "stop") return "STOP_HIT";
  if (evaluation.event === "manual") return "MANUAL_EXIT";
  if (evaluation.event === "target") return `TP${evaluation.tpsHit}_HIT`;
  return null;
}

async function recordAlertEvent(db, position, evaluation, telegramMessageId) {
  const name = eventName(evaluation);
  if (!name) return null;

  await db.prepare(`INSERT OR IGNORE INTO alert_events
    (position_id, sym, event, price, pnl_pct, telegram_message_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
      position.id,
      position.sym,
      name,
      evaluation.price,
      Number.isFinite(evaluation.pnlPct) ? evaluation.pnlPct : null,
      telegramMessageId ? String(telegramMessageId) : null,
      new Date().toISOString(),
    ).run();

  return name;
}

async function listOpenPositions(db, limit) {
  const result = await db.prepare(`SELECT id, sym, grade, state, entry_date, entry_price, current_price, closed_price, pnl_pct, updated_at, raw_json
    FROM portfolio_positions
    WHERE COALESCE(state, 'open') != 'closed'
    ORDER BY entry_date DESC, updated_at DESC
    LIMIT ?`).bind(limit).all();

  return rows(result).map(normalizePositionRow).filter((position) => position.sym);
}

async function updateTrackedPosition(db, position, evaluation) {
  const now = new Date().toISOString();
  const closing = evaluation.closed === true;
  const closedPrice = closing ? evaluation.price : position.closedPrice ?? null;
  const raw = {
    ...position.raw,
    currentPrice: evaluation.price,
    tpsHit: evaluation.tpsHit,
    nextTP: evaluation.nextTP,
    status: evaluation.statusText,
    pnlPct: evaluation.pnlPct,
    stopAlerted: evaluation.stopAlerted,
    lastTrackedAt: now,
    lastTrackerEvent: evaluation.event || position.raw.lastTrackerEvent || null,
  };

  if (closing) {
    raw.closedPrice = evaluation.price;
    raw.closedAt = now;
    raw.closeReason = evaluation.event === "stop"
      ? "stop"
      : evaluation.event === "manual"
        ? "manual"
        : "all_targets_hit";
    if (evaluation.note) raw.closeNote = evaluation.note;
  }

  await db.prepare(`INSERT OR REPLACE INTO portfolio_positions
    (id, sym, grade, state, entry_date, entry_price, current_price, closed_price, pnl_pct, updated_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      position.id,
      position.sym,
      position.grade || "",
      closing ? "closed" : position.state || "open",
      position.entryDate,
      position.entryPrice,
      evaluation.price,
      closedPrice,
      evaluation.pnlPct,
      now,
      JSON.stringify(raw),
    ).run();
}

async function getLatestPrice(env, sym, providedPrices) {
  const ticker = String(sym || "").toUpperCase();
  const injected = num(providedPrices?.[ticker]);
  if (Number.isFinite(injected)) return injected;

  const testPrices = parseJson(env.TEST_PRICES) || {};
  const testPrice = num(testPrices[ticker]);
  if (Number.isFinite(testPrice)) return testPrice;

  const yahooPrice = await fetchYahooProxyPrice(env, ticker);
  if (Number.isFinite(yahooPrice)) return yahooPrice;

  if (env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY) {
    const alpacaPrice = await fetchAlpacaPrice(env, ticker);
    if (Number.isFinite(alpacaPrice)) return alpacaPrice;
  }

  if (env.TRADIER_TOKEN) {
    const tradierPrice = await fetchTradierPrice(env, ticker);
    if (Number.isFinite(tradierPrice)) return tradierPrice;
  }

  return null;
}

async function fetchYahooProxyPrice(env, sym) {
  const proxyBaseUrl = getYahooProxyBaseUrl(env);
  if (!proxyBaseUrl) return null;

  const encodedSymbol = encodeURIComponent(sym);
  const params = `range=1d&interval=1m&includePrePost=true&cb=${Date.now()}`;
  const yahooUrls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?${params}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?${params}`,
  ];
  const attempts = yahooUrls.flatMap((yahooUrl) => [
    `${proxyBaseUrl}?url=${encodeURIComponent(yahooUrl)}`,
    `${proxyBaseUrl}/?url=${encodeURIComponent(yahooUrl)}`,
  ]);

  let lastError = null;
  for (const url of attempts) {
    try {
      const response = await fetchViaYahooProxy(env, url);
      if (!response.ok) {
        lastError = `${sym}: proxy HTTP ${response.status}`;
        continue;
      }
      const data = parseMaybeJson(await response.text());
      const result = data?.chart?.result?.[0] || null;
      const price = extractYahooPrice(result);
      if (Number.isFinite(price)) return price;
      lastError = data?.chart?.error?.description || `${sym}: no Yahoo price`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Yahoo proxy price fetch failed";
    }
  }

  if (lastError) console.warn("Yahoo proxy price unavailable", { sym, error: lastError });
  return null;
}

async function fetchViaYahooProxy(env, url) {
  const request = new Request(url, {
    headers: {
      Accept: "application/json, text/plain, */*",
      "Cache-Control": "no-cache",
    },
  });
  if (env.YAHOO_PROXY?.fetch) return await env.YAHOO_PROXY.fetch(request);
  return await fetch(request);
}

function extractYahooPrice(result) {
  const quote = result?.indicators?.quote?.[0] || {};
  const close = Array.isArray(quote.close) ? quote.close.filter((value) => Number.isFinite(Number(value))) : [];
  return num(result?.meta?.regularMarketPrice)
    ?? num(result?.meta?.postMarketPrice)
    ?? num(result?.meta?.previousClose)
    ?? num(close.at(-1));
}

async function fetchAlpacaPrice(env, sym) {
  const baseUrl = String(env.ALPACA_BASE_URL || DEFAULT_ALPACA_BASE_URL).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v2/stocks/${encodeURIComponent(sym)}/trades/latest`, {
    headers: {
      "APCA-API-KEY-ID": env.ALPACA_KEY_ID,
      "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.error || `Alpaca price failed with HTTP ${response.status}`);
  return num(data?.trade?.p);
}

async function fetchTradierPrice(env, sym) {
  const baseUrl = String(env.TRADIER_BASE_URL || DEFAULT_TRADIER_BASE_URL).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v1/markets/quotes?symbols=${encodeURIComponent(sym)}`, {
    headers: {
      Authorization: `Bearer ${env.TRADIER_TOKEN}`,
      Accept: "application/json",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.errors?.error || data?.error || `Tradier price failed with HTTP ${response.status}`);
  const quote = Array.isArray(data?.quotes?.quote) ? data.quotes.quote[0] : data?.quotes?.quote;
  return num(quote?.last ?? quote?.bid ?? quote?.ask);
}

async function sendApproval(env, position, evaluation) {
  const chatId = getAlertChatId(env);
  if (!chatId) {
    throw new Error("NASDAQ_SCANNER_CHAT_ID or ALERT_CHAT_ID is required for target approvals");
  }

  const body = {
    chat_id: chatId,
    text: buildTelegramAlert(position, evaluation),
    parse_mode: "HTML",
    sourceChatId: "position-tracker",
    sourceMessageId: `${position.id}:${evaluation.event}:${evaluation.tpsHit || "stop"}`,
    reply_to_message_id: getKalkiStocksReplyMessageId(env, position),
  };
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };

  const response = env.APPROVAL_GATE?.fetch
    ? await env.APPROVAL_GATE.fetch(new Request("https://approval-gate.internal/api/approval", init))
    : await fetch(getApprovalGateUrl(env), init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data?.error || data?.description || `Approval gate failed with HTTP ${response.status}`);
  }
  return data;
}

function buildTelegramAlert(position, evaluation) {
  const entry = num(position.entryPrice);
  const pnl = Number.isFinite(evaluation.pnlPct)
    ? `${evaluation.pnlPct >= 0 ? "+" : ""}${evaluation.pnlPct.toFixed(2)}%`
    : "n/a";

  if (evaluation.event === "manual") {
    const winner = Number.isFinite(evaluation.pnlPct) && evaluation.pnlPct >= 0;
    const lines = [
      `🔔 <b>${escapeHtml(position.sym)} CLOSED</b>`,
      "",
      `Entry: ${Number.isFinite(entry) ? `$${money(entry)}` : "n/a"}`,
      `Exit: $${money(evaluation.price)}`,
      "",
      `${winner ? "Profit" : "Loss"}: ${escapeHtml(pnl)} ${winner ? "✅" : "🔻"}`,
    ];
    if (evaluation.note) lines.push("", escapeHtml(evaluation.note));
    return lines.join("\n");
  }

  const targetLine = evaluation.event === "target"
    ? `Target: $${money(evaluation.target)}`
    : `Stop: $${money(position.breakdown)}`;
  const nextLine = evaluation.nextTP ? `Next: $${money(evaluation.nextTP)}` : "Next: none";

  return [
    `<b>Kalki Position Alert: ${escapeHtml(evaluation.label)}</b>`,
    `<b>${escapeHtml(position.sym)}</b>${position.grade ? ` (${escapeHtml(position.grade)})` : ""}`,
    `Price: $${money(evaluation.price)}`,
    `Entry: ${Number.isFinite(entry) ? `$${money(entry)}` : "n/a"} | P/L: ${escapeHtml(pnl)}`,
    targetLine,
    nextLine,
  ].join("\n");
}

function normalizePositionRow(row) {
  const raw = parseJson(row.raw_json) || {};
  const resistances = normalizeTargets(raw.resistances || raw.res || []);
  return {
    raw,
    id: row.id || raw.id,
    sym: String(row.sym || raw.sym || raw.ticker || "").toUpperCase().replace(/[^A-Z0-9.-]/g, ""),
    grade: row.grade || raw.grade || "",
    state: row.state || raw.state || "open",
    entryDate: row.entry_date || raw.entryDate || null,
    entryPrice: num(row.entry_price) ?? num(raw.entryPrice),
    currentPrice: num(row.current_price) ?? num(raw.currentPrice),
    closedPrice: num(row.closed_price) ?? num(raw.closedPrice),
    breakdown: num(raw.breakdown ?? raw.brk),
    resistances,
    tpsHit: int(raw.tpsHit),
    stopAlerted: raw.stopAlerted === true,
    sourceChatId: String(raw.sourceChatId || ""),
    sourceMessageId: String(raw.sourceMessageId || ""),
  };
}

/**
 * Accepts a comma-separated list so a test group can be tracked alongside
 * Kalki-stocks. Without this, alerts published to the test group are ingested
 * but then skipped as "missing original Kalki-stocks message id", which makes a
 * working pipeline look broken during verification.
 */
function getTrackedChatIds(env) {
  return String(env.KALKI_STOCKS_CHAT_ID || "-1003967721534")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getKalkiStocksReplyMessageId(env, position) {
  const sourceChatId = String(position.sourceChatId || position.raw?.sourceChatId || "");
  const trackedChatIds = getTrackedChatIds(env);
  if (sourceChatId && trackedChatIds.length && !trackedChatIds.includes(sourceChatId)) return null;
  const parsed = Number.parseInt(position.sourceMessageId || position.raw?.sourceMessageId || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getApprovalGateUrl(env) {
  const configured = String(env.APPROVAL_GATE_URL || "https://kalki-approval-gate.srimanthgada87.workers.dev/api/approval").trim();
  try {
    const url = new URL(configured);
    url.pathname = "/api/approval";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "https://kalki-approval-gate.srimanthgada87.workers.dev/api/approval";
  }
}

function normalizeTargets(values) {
  return (Array.isArray(values) ? values : [])
    .map(num)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

function describePriceSource(env) {
  if (env.TEST_PRICES) return "test_prices";
  if (getYahooProxyBaseUrl(env)) return env.YAHOO_PROXY?.fetch ? "yahoo_proxy_service" : "yahoo_proxy_http";
  if (env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY) return "alpaca";
  if (env.TRADIER_TOKEN) return "tradier";
  return "unconfigured";
}

function getYahooProxyBaseUrl(env) {
  return String(env.YAHOO_PROXY_BASE_URL || DEFAULT_YAHOO_PROXY_BASE_URL || "").replace(/\/+$/, "");
}

function authorized(request, env) {
  const expected = env.KALKI_TRACKER_KEY || env.KALKI_INGEST_KEY || env.API_KEY;
  if (!expected) return true;
  return request.headers.get("X-Kalki-Key") === expected;
}

function getAlertChatId(env) {
  return String(env.NASDAQ_SCANNER_CHAT_ID || env.ALERT_CHAT_ID || "").trim();
}

function readMaxPriceFetches(env) {
  const parsed = Number.parseInt(env.MAX_PRICE_FETCHES || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 40;
}

function readLimit(value) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(1000, parsed)) : DEFAULT_CHECK_LIMIT;
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function requireDb(env) {
  if (!env.DB) throw new Error("DB binding is required");
}

function rows(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

function calculatePnlPct(entryPrice, currentPrice) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice) || entryPrice <= 0) return null;
  return round(((currentPrice - entryPrice) / entryPrice) * 100, 2);
}

function money(value) {
  const number = num(value);
  return Number.isFinite(number) ? number.toFixed(2) : "n/a";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function round(value, places) {
  const scale = 10 ** places;
  return Math.round(Number(value) * scale) / scale;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseMaybeJson(text) {
  const trimmed = String(text || "").trim();
  const start = Math.min(
    trimmed.indexOf("{") >= 0 ? trimmed.indexOf("{") : Number.POSITIVE_INFINITY,
    trimmed.indexOf("[") >= 0 ? trimmed.indexOf("[") : Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(start)) return null;
  return parseJson(trimmed.slice(start));
}

function int(value) {
  const parsed = Number.parseInt(value || "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
