const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Kalki-Key",
};

const DEFAULT_WEBHOOK_PATH = "/telegram/webhook";
const DEFAULT_TZ = "America/New_York";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        const count = env.DB ? await countPositions(env.DB) : null;
        return json({ ok: true, service: "kalki-d1-ingestion", db_bound: Boolean(env.DB), portfolio_positions: count });
      }

      if (request.method === "POST" && (url.pathname === "/ingest" || url.pathname === "/api/ingest")) {
        if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
        const body = await request.json().catch(() => ({}));
        return json(await ingestText(env, {
          text: body.text || body.raw || "",
          sourceChatId: text(body.sourceChatId || body.source_chat_id) || "manual",
          sourceMessageId: text(body.sourceMessageId || body.source_message_id) || null,
          receivedAt: body.receivedAt || body.received_at || null,
        }));
      }

      if (request.method === "GET" && url.pathname === "/api/alerts") {
        requireDb(env);
        return json({ ok: true, alerts: await listGroupAlerts(env.DB, readLimit(url, 100)) });
      }

      if (request.method === "GET" && url.pathname === "/api/portfolio") {
        requireDb(env);
        return json({ ok: true, positions: await listPortfolioPositions(env.DB, {
          state: text(url.searchParams.get("state")),
          limit: readLimit(url, 100),
        }) });
      }

      if (request.method === "GET" && url.pathname === "/api/watchlist") {
        requireDb(env);
        return json({ ok: true, watchlist: await listWatchlist(env.DB, readLimit(url, 250)) });
      }

      if (request.method === "GET" && url.pathname === "/api/reports") {
        requireDb(env);
        return json({ ok: true, reports: await buildReports(env.DB) });
      }

      if (request.method === "POST" && (url.pathname === "/api/portfolio" || url.pathname === "/api/portfolio/correct")) {
        if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
        const body = await request.json().catch(() => ({}));
        return json(await upsertManualPortfolioPosition(env, body));
      }

      const webhookPath = env.TELEGRAM_WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH;
      if (request.method === "POST" && url.pathname === webhookPath) {
        return json(await handleTelegramWebhook(request, env));
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("D1 ingestion failed", { message });
      return json({ ok: false, error: message }, 500);
    }
  },
};

async function handleTelegramWebhook(request, env) {
  const secretToken = env.TELEGRAM_WEBHOOK_SECRET;
  if (secretToken && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secretToken) {
    return { ok: false, error: "Unauthorized webhook request" };
  }

  const update = await request.json().catch(() => ({}));
  const post = update.message || update.channel_post || update.edited_message || update.edited_channel_post;
  if (!post) return { ok: true, ignored: true, reason: "No Telegram message found" };

  const sourceChatId = String(post.chat?.id ?? "");
  const allowed = parseChatList(env.SOURCE_CHAT_IDS || env.SOURCE_CHAT_ID || env.SOURCE_CHANNEL_ID);
  if (allowed.length && !allowed.includes(sourceChatId)) {
    return { ok: true, ignored: true, reason: "Message is from a different source chat", received_chat_id: sourceChatId };
  }

  return ingestText(env, {
    text: getPostText(post),
    sourceChatId,
    sourceMessageId: text(post.message_id),
    receivedAt: messageDateToIso(post.date),
  });
}

export async function ingestText(env, input) {
  requireDb(env);
  const alert = parseScoredAlert(input.text);
  if (!alert) return { ok: true, ignored: true, reason: "No final scored alert found" };

  const now = new Date().toISOString();
  const updatedAt = input.receivedAt || now;
  const sourceChatId = text(input.sourceChatId) || "unknown";
  const sourceMessageId = text(input.sourceMessageId) || stableHash(alert.raw);
  const id = `tg-${sourceChatId}-${sourceMessageId}`.replace(/[^A-Za-z0-9_.:-]/g, "-");
  const rows = buildD1Rows(alert, { id, sourceChatId, sourceMessageId, updatedAt });

  await upsertWatchlist(env.DB, rows.watchlist, updatedAt);
  await upsertGroupAlert(env.DB, rows.groupAlert, updatedAt);
  await upsertPortfolioPosition(env.DB, rows.position, updatedAt);

  const count = await countPositions(env.DB);
  return { ok: true, ticker: alert.sym, id, upserted: ["watchlist_items", "group_alerts", "portfolio_positions"], portfolio_positions: count };
}

export async function upsertManualPortfolioPosition(env, body) {
  requireDb(env);
  const now = new Date().toISOString();
  const patch = normalizePortfolioPatch(body);
  if (!patch.sym && !patch.id) {
    return { ok: false, error: "sym or id is required" };
  }

  const id = patch.id || `manual-${patch.sym}-${stableHash(JSON.stringify(patch))}`;
  const existing = await env.DB.prepare("SELECT * FROM portfolio_positions WHERE id = ? LIMIT 1")
    .bind(id)
    .first();
  const existingRaw = parseJson(existing?.raw_json) || {};
  const mergedRaw = {
    ...existingRaw,
    ...patch.rawFields,
    id,
    sym: patch.sym || existing?.sym || existingRaw.sym,
    manualCorrection: true,
    source: "manual",
    updatedAt: now,
  };

  const state = patch.state || existing?.state || existingRaw.state || "open";
  const entryDate = patch.entryDate || existing?.entry_date || existingRaw.entryDate || new Date().toLocaleDateString("en-CA", { timeZone: DEFAULT_TZ });
  const entryPrice = patch.entryPrice ?? num(existing?.entry_price) ?? num(existingRaw.entryPrice);
  const currentPrice = patch.currentPrice ?? num(existing?.current_price) ?? num(existingRaw.currentPrice) ?? entryPrice;
  const closedPrice = state === "closed"
    ? patch.closedPrice ?? num(existing?.closed_price) ?? num(existingRaw.closedPrice) ?? currentPrice
    : null;
  const pnlPct = patch.pnlPct ?? calculatePnlPct(entryPrice, closedPrice ?? currentPrice);

  mergedRaw.state = state;
  mergedRaw.entryDate = entryDate;
  mergedRaw.entryPrice = entryPrice;
  mergedRaw.currentPrice = currentPrice;
  mergedRaw.closedPrice = closedPrice;
  mergedRaw.pnlPct = pnlPct;

  await env.DB.prepare(`INSERT OR REPLACE INTO portfolio_positions
    (id, sym, grade, state, entry_date, entry_price, current_price, closed_price, pnl_pct, updated_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id,
      mergedRaw.sym,
      patch.grade ?? existing?.grade ?? existingRaw.grade ?? "",
      state,
      entryDate,
      entryPrice,
      currentPrice,
      closedPrice,
      pnlPct,
      now,
      JSON.stringify(mergedRaw),
    ).run();

  return { ok: true, position: await getPortfolioPosition(env.DB, id) };
}

export function parseScoredAlert(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const ticker = raw.match(/(?:^|\n)\s*⚡\s*\*?([A-Z][A-Z0-9.-]{0,9})\*?/i)
    || raw.match(/\bTicker\s*:\s*([A-Z][A-Z0-9.-]{0,9})\b/i);
  const entry = extractMoneyRange(raw, "Entry");
  const stop = extractMoneyRange(raw, "Stop");
  const targets = [...raw.matchAll(/\bT(\d+)\s*:\s*\$?\s*(\d+(?:\.\d+)?)/gi)]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((match) => roundPrice(Number.parseFloat(match[2])))
    .filter(Number.isFinite);

  if (!ticker || !entry || !stop || targets.length === 0) return null;

  const price = extractMoneyRange(raw, "Price");
  const score = raw.match(/Score\s*:\s*\*?\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+)\s*\*?/i);
  const setup = raw.match(/\bSetup\s*\*?\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+)|%)\s*\*?/i);
  const pattern = raw.match(/Pattern\s*:\s*([^\n]+)/i)?.[1]?.trim() || "";
  const volumeContext = parseVolumeContext(raw);

  return {
    sym: ticker[1].toUpperCase().replace(/[^A-Z0-9.-]/g, ""),
    grade: (raw.match(/Grade\s*:\s*\*?\s*([A-D][+-]?)/i)?.[1] || "").toUpperCase(),
    score: score ? Number.parseFloat(score[1]) : setup ? Number.parseFloat(setup[1]) : null,
    scoreMax: score?.[2] ? Number.parseFloat(score[2]) : setup?.[2] ? Number.parseFloat(setup[2]) : setup ? 100 : null,
    pattern,
    price: price ? roundPrice((price.low + price.high) / 2) : null,
    entryLow: roundPrice(entry.low),
    entryHigh: roundPrice(entry.high),
    entryMid: roundPrice((entry.low + entry.high) / 2),
    stop: roundPrice(stop.low),
    targets: [...new Set(targets)],
    entryDate: parseAlertEntryDate(raw),
    volume: volumeContext.volume,
    volumeRatio: volumeContext.volumeRatio,
    avgVolume20: volumeContext.avgVolume20,
    raw,
  };
}

export function buildD1Rows(alert, meta) {
  const note = [
    alert.pattern ? `Pattern: ${alert.pattern}` : "",
    Number.isFinite(alert.score) ? `Score ${alert.score}${alert.scoreMax ? `/${alert.scoreMax}` : ""}` : "",
    alert.volume ? `Volume ${formatCompactNumber(alert.volume)}${Number.isFinite(alert.volumeRatio) ? ` · ${alert.volumeRatio}x avg` : ""}` : "",
  ].filter(Boolean).join(" · ") || "Final scored Telegram alert";

  const baseRaw = {
    source: "kalki-d1-ingestion",
    sourceChatId: meta.sourceChatId,
    sourceMessageId: meta.sourceMessageId,
    syncedAt: meta.updatedAt,
    rawAlert: alert.raw,
  };

  const position = {
    ...baseRaw,
    id: meta.id,
    sym: alert.sym,
    grade: alert.grade || "",
    entryPrice: alert.entryMid,
    entryDate: alert.entryDate,
    invest: 1000,
    currentPrice: alert.price ?? alert.entryMid,
    state: "open",
    status: "Watching TP1",
    breakdown: alert.stop,
    supLow: alert.entryLow,
    supHigh: alert.entryHigh,
    resistances: alert.targets,
    nextTP: alert.targets.find((value) => value > alert.entryMid) || alert.targets[0] || null,
    tpsHit: 0,
    closedPrice: null,
    closeDate: null,
    pnlPct: null,
    notes: note,
    score: alert.score,
    scoreMax: alert.scoreMax,
    volume: alert.volume,
    volumeRatio: alert.volumeRatio,
    avgVolume20: alert.avgVolume20,
  };

  const groupAlert = {
    ...baseRaw,
    id: meta.id,
    sym: alert.sym,
    note,
    entryDate: alert.entryDate,
    grade: alert.grade || "",
    portfolioId: meta.id,
    addedIso: meta.updatedAt,
    addedPrice: alert.entryMid,
    currentPrice: alert.price,
    pctSinceAdd: null,
    catalystScore: alert.score,
    scoreMax: alert.scoreMax,
    volume: alert.volume,
    volumeRatio: alert.volumeRatio,
    avgVolume20: alert.avgVolume20,
  };

  const watchlist = {
    ...baseRaw,
    sym: alert.sym,
    grade: alert.grade || "",
    status: "neutral",
    supLow: alert.entryLow,
    supHigh: alert.entryHigh,
    brk: alert.stop,
    res: alert.targets,
    price: alert.price,
    monitorTrend: false,
    volume: alert.volume,
    volumeRatio: alert.volumeRatio,
    avgVolume20: alert.avgVolume20,
  };

  return { position, groupAlert, watchlist };
}

async function upsertPortfolioPosition(db, item, updatedAt) {
  const existing = await db.prepare("SELECT state, closed_price, raw_json FROM portfolio_positions WHERE id = ? LIMIT 1")
    .bind(item.id)
    .first();
  let raw = item;
  let state = item.state;
  let closedPrice = null;

  if (existing?.state === "closed") {
    const existingRaw = parseJson(existing.raw_json) || {};
    state = "closed";
    closedPrice = num(existing.closed_price) ?? num(existingRaw.closedPrice);
    raw = { ...existingRaw, ...item, state, closedPrice, closeDate: existingRaw.closeDate ?? item.closeDate ?? null };
  }

  await db.prepare(`INSERT OR REPLACE INTO portfolio_positions
    (id, sym, grade, state, entry_date, entry_price, current_price, closed_price, pnl_pct, updated_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      item.id,
      item.sym,
      item.grade || "",
      state,
      item.entryDate,
      item.entryPrice,
      item.currentPrice,
      state === "closed" ? closedPrice : null,
      num(raw.pnlPct),
      updatedAt,
      JSON.stringify(raw),
    ).run();
}

async function upsertGroupAlert(db, item, updatedAt) {
  await db.prepare(`INSERT OR REPLACE INTO group_alerts
    (id, sym, note, entry_date, grade, linked_portfolio_id, status, pct_since_add, updated_at, added_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      item.id,
      item.sym,
      item.note,
      item.entryDate,
      item.grade || "",
      item.portfolioId,
      "open",
      null,
      updatedAt,
      item.addedIso || updatedAt,
      JSON.stringify(item),
    ).run();
}

async function upsertWatchlist(db, item, updatedAt) {
  await db.prepare(`INSERT OR REPLACE INTO watchlist_items
    (sym, grade, status, support_low, support_high, breakdown, resistances_json, updated_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      item.sym,
      item.grade || "",
      item.status || "neutral",
      item.supLow,
      item.supHigh,
      item.brk,
      JSON.stringify(item.res || []),
      updatedAt,
      JSON.stringify(item),
    ).run();
}

async function countPositions(db) {
  const row = await db.prepare("SELECT COUNT(*) AS total FROM portfolio_positions").first();
  return Number(row?.total || 0);
}

async function listGroupAlerts(db, limit) {
  const result = await db.prepare(`SELECT id, sym, note, entry_date, grade, linked_portfolio_id, status, pct_since_add, updated_at, added_at, raw_json
    FROM group_alerts
    ORDER BY added_at DESC
    LIMIT ?`).bind(limit).all();
  return rows(result).map((row) => ({ ...parseJson(row.raw_json), ...row, raw_json: undefined }));
}

async function listPortfolioPositions(db, options = {}) {
  const state = text(options.state);
  const limit = options.limit || 100;
  const statement = state
    ? db.prepare(`SELECT id, sym, grade, state, entry_date, entry_price, current_price, closed_price, pnl_pct, updated_at, raw_json
        FROM portfolio_positions
        WHERE state = ?
        ORDER BY entry_date DESC, updated_at DESC
        LIMIT ?`).bind(state, limit)
    : db.prepare(`SELECT id, sym, grade, state, entry_date, entry_price, current_price, closed_price, pnl_pct, updated_at, raw_json
        FROM portfolio_positions
        ORDER BY entry_date DESC, updated_at DESC
        LIMIT ?`).bind(limit);
  const result = await statement.all();
  return rows(result).map(hydratePositionRow);
}

async function getPortfolioPosition(db, id) {
  const row = await db.prepare(`SELECT id, sym, grade, state, entry_date, entry_price, current_price, closed_price, pnl_pct, updated_at, raw_json
    FROM portfolio_positions
    WHERE id = ?
    LIMIT 1`).bind(id).first();
  return row ? hydratePositionRow(row) : null;
}

async function listWatchlist(db, limit) {
  const result = await db.prepare(`SELECT sym, grade, status, support_low, support_high, breakdown, resistances_json, updated_at, raw_json
    FROM watchlist_items
    ORDER BY updated_at DESC
    LIMIT ?`).bind(limit).all();
  return rows(result).map((row) => ({ ...parseJson(row.raw_json), ...row, raw_json: undefined }));
}

async function buildReports(db) {
  const positions = await listPortfolioPositions(db, { limit: 1000 });
  const alerts = await listGroupAlerts(db, 1000);
  const open = positions.filter((position) => position.state !== "closed");
  const closed = positions.filter((position) => position.state === "closed");
  const totalPnlPct = closed.reduce((sum, position) => sum + (num(position.pnl_pct) ?? num(position.pnlPct) ?? 0), 0);

  return {
    totals: {
      alerts: alerts.length,
      positions: positions.length,
      open: open.length,
      closed: closed.length,
      avgClosedPnlPct: closed.length ? roundPrice(totalPnlPct / closed.length) : 0,
    },
    byGrade: summarizeBy(positions, "grade"),
    byState: summarizeBy(positions, "state"),
    recentAlerts: alerts.slice(0, 10),
    recentPositions: positions.slice(0, 10),
  };
}

function hydratePositionRow(row) {
  return {
    ...parseJson(row.raw_json),
    ...row,
    raw_json: undefined,
  };
}

function rows(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

function summarizeBy(items, key) {
  const counts = new Map();
  for (const item of items) {
    const label = text(item[key]) || "unknown";
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ [key]: label, count }))
    .sort((a, b) => b.count - a.count || String(a[key]).localeCompare(String(b[key])));
}

function normalizePortfolioPatch(body) {
  const source = body && typeof body === "object" ? body : {};
  const rawFields = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) rawFields[key] = value;
  }

  return {
    id: text(source.id),
    sym: text(source.sym || source.ticker)?.toUpperCase().replace(/[^A-Z0-9.-]/g, ""),
    grade: text(source.grade)?.toUpperCase(),
    state: normalizeState(source.state || source.status),
    entryDate: text(source.entryDate || source.entry_date),
    entryPrice: num(source.entryPrice ?? source.entry_price),
    currentPrice: num(source.currentPrice ?? source.current_price),
    closedPrice: num(source.closedPrice ?? source.closed_price),
    pnlPct: num(source.pnlPct ?? source.pnl_pct),
    rawFields,
  };
}

function normalizeState(value) {
  const normalized = text(value)?.toLowerCase();
  if (!normalized) return null;
  return ["open", "closed", "watching", "paused", "cancelled"].includes(normalized) ? normalized : "open";
}

function calculatePnlPct(entryPrice, currentPrice) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice) || entryPrice <= 0) return null;
  return roundPrice(((currentPrice - entryPrice) / entryPrice) * 100);
}

function extractMoneyRange(raw, label) {
  const re = new RegExp(`${label}\\s*:\\s*\\*?\\s*\\$?\\s*(\\d+(?:\\.\\d+)?)(?:\\s*(?:-|–|—|to)\\s*\\$?\\s*(\\d+(?:\\.\\d+)?))?`, "i");
  const match = String(raw || "").match(re);
  if (!match) return null;
  const first = Number.parseFloat(match[1]);
  const second = match[2] ? Number.parseFloat(match[2]) : first;
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  return { low: Math.min(first, second), high: Math.max(first, second) };
}

function parseAlertEntryDate(raw) {
  const match = String(raw || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  return new Date().toLocaleDateString("en-CA", { timeZone: DEFAULT_TZ });
}

function parseVolumeContext(raw) {
  const line = String(raw || "").match(/Volume\s*:\s*([0-9.,]+)\s*([KMB])?(?:\s*shares?)?(?:\s*[·|,-]\s*([0-9.]+)\s*x\s*avg)?/i);
  if (!line) return { volume: null, volumeRatio: null, avgVolume20: null };
  const volume = parseHumanVolume(line[1], line[2]);
  const volumeRatio = Number.parseFloat(line[3] || "");
  return {
    volume,
    volumeRatio: Number.isFinite(volumeRatio) ? volumeRatio : null,
    avgVolume20: volume && Number.isFinite(volumeRatio) && volumeRatio > 0 ? Math.round(volume / volumeRatio) : null,
  };
}

function parseHumanVolume(numberText, suffix) {
  const value = Number.parseFloat(String(numberText || "").replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const mult = String(suffix || "").toUpperCase() === "B" ? 1e9
    : String(suffix || "").toUpperCase() === "M" ? 1e6
      : String(suffix || "").toUpperCase() === "K" ? 1e3
        : 1;
  return Math.round(value * mult);
}

function formatCompactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  if (Math.abs(number) >= 1e9) return `${roundPrice(number / 1e9)}B`;
  if (Math.abs(number) >= 1e6) return `${roundPrice(number / 1e6)}M`;
  if (Math.abs(number) >= 1e3) return `${roundPrice(number / 1e3)}K`;
  return String(Math.round(number));
}

function getPostText(post) {
  return String(post?.text || post?.caption || "").trim();
}

function parseChatList(value) {
  return String(value || "").split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
}

function authorized(request, env) {
  const expected = env.KALKI_INGEST_KEY || env.KALKI_SYNC_KEY || env.API_KEY;
  if (!expected) return true;
  return request.headers.get("X-Kalki-Key") === expected;
}

function requireDb(env) {
  if (!env.DB) throw new Error("DB binding is required");
}

function readLimit(url, fallback) {
  const limit = Number.parseInt(url.searchParams.get("limit") || "", 10);
  return Number.isFinite(limit) ? Math.max(1, Math.min(1000, limit)) : fallback;
}

function messageDateToIso(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function roundPrice(value) {
  return Math.round(Number(value) * 100) / 100;
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function text(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
