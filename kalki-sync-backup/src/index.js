const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Kalki-Key',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    try {
      if (!authorized(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
      if (url.pathname === '/d1/query') return handleQuery(request, env);
      if (url.pathname === '/d1/load') return handleLoad(env);
      if (url.pathname === '/d1/save') return handleSave(request, env);
      if (url.pathname === '/health') return json({ ok: true, service: 'kalki-sync-backup' });
      return json({ ok: false, error: 'Not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: err?.message || String(err) }, 500);
    }
  },
};

function authorized(request, env) {
  const expected = env.KALKI_SYNC_KEY || env.SYNC_KEY || env.API_KEY;
  if (!expected) return true;
  return request.headers.get('X-Kalki-Key') === expected;
}

async function handleQuery(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  const body = await request.json();
  const sql = String(body.sql || '').trim();
  const params = Array.isArray(body.params) ? body.params : [];
  if (!sql) return json({ ok: false, error: 'sql is required' }, 400);
  const result = await env.DB.prepare(sql).bind(...params).run();
  return json({ ok: true, result });
}

async function handleLoad(env) {
  const appState = await env.DB.prepare("SELECT payload, updated_at FROM app_state WHERE id='default' LIMIT 1").first();
  let record = {};
  if (appState?.payload) {
    try { record = JSON.parse(appState.payload) || {}; } catch { record = {}; }
  }
  const [portfolio, watchlist, groupTracker, subscribers] = await Promise.all([
    loadPortfolio(env),
    loadWatchlist(env),
    loadGroupAlerts(env),
    loadSubscribers(env),
  ]);
  return json({
    ok: true,
    record: {
      ...record,
      portfolio,
      watchlist,
      groupTracker,
      subscribers,
      updatedAt: appState?.updated_at || new Date().toISOString(),
    },
  });
}

async function handleSave(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  const payload = await request.json();
  const updatedAt = new Date().toISOString();

  const safePayload = { ...payload, updatedAt };
  delete safePayload.portfolio;
  await env.DB.prepare(`INSERT OR REPLACE INTO app_state (id, payload, updated_at) VALUES ('default', ?, ?)`)
    .bind(JSON.stringify(safePayload), updatedAt)
    .run();

  const portfolio = Array.isArray(payload.portfolio) ? sanitizePortfolio(payload.portfolio) : [];
  const watchlist = Array.isArray(payload.watchlist) ? payload.watchlist : [];
  const groupTracker = Array.isArray(payload.groupTracker) ? payload.groupTracker : [];
  const subscribers = Array.isArray(payload.subscribers) ? payload.subscribers : [];

  for (const item of portfolio) await upsertPortfolio(env, item, updatedAt);
  for (const item of watchlist) await upsertWatchlist(env, item, updatedAt);
  for (const item of groupTracker) await upsertGroupAlert(env, item, updatedAt);
  for (const item of subscribers) await upsertSubscriber(env, item, updatedAt);

  const summary = await env.DB.prepare(`SELECT COUNT(*) AS total FROM portfolio_positions`).first();
  return json({ ok: true, saved: true, mode: 'non_destructive_upsert', inputPortfolio: portfolio.length, portfolioRows: summary?.total || 0, updatedAt });
}

async function loadPortfolio(env) {
  const { results } = await env.DB.prepare(`SELECT raw_json FROM portfolio_positions ORDER BY COALESCE(entry_date, updated_at) DESC, updated_at DESC`).all();
  return (results || []).map(row => parseJson(row.raw_json)).filter(Boolean);
}

async function loadWatchlist(env) {
  const { results } = await env.DB.prepare(`SELECT raw_json FROM watchlist_items ORDER BY updated_at DESC`).all();
  return (results || []).map(row => parseJson(row.raw_json)).filter(Boolean);
}

async function loadGroupAlerts(env) {
  const { results } = await env.DB.prepare(`SELECT raw_json FROM group_alerts ORDER BY COALESCE(entry_date, added_at) DESC, added_at DESC`).all();
  return (results || []).map(row => parseJson(row.raw_json)).filter(Boolean);
}

async function loadSubscribers(env) {
  const { results } = await env.DB.prepare(`SELECT raw_json FROM subscribers ORDER BY updated_at DESC`).all();
  return (results || []).map(row => parseJson(row.raw_json)).filter(Boolean);
}

async function upsertPortfolio(env, item, updatedAt) {
  const id = text(item.id) || `pf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sym = text(item.sym)?.toUpperCase();
  if (!sym) return;
  const state = text(item.state) || 'open';
  await env.DB.prepare(`INSERT OR REPLACE INTO portfolio_positions
    (id, sym, grade, state, entry_date, entry_price, current_price, closed_price, pnl_pct, updated_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id,
      sym,
      text(item.grade) || '',
      state,
      text(item.entryDate || item.entry_date),
      num(item.entryPrice ?? item.entry_price),
      num(item.currentPrice ?? item.current_price),
      state === 'closed' ? num(item.closedPrice ?? item.closed_price) : null,
      num(item.pnlPct ?? item.pnl_pct),
      updatedAt,
      JSON.stringify({ ...item, id, sym, state })
    ).run();
}

async function upsertWatchlist(env, item, updatedAt) {
  const sym = text(item.sym)?.toUpperCase();
  if (!sym) return;
  await env.DB.prepare(`INSERT OR REPLACE INTO watchlist_items
    (sym, grade, status, support_low, support_high, breakdown, resistances_json, updated_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      sym,
      text(item.grade) || '',
      text(item.status) || '',
      num(item.supLow ?? item.support_low),
      num(item.supHigh ?? item.support_high),
      num(item.breakdown),
      JSON.stringify(Array.isArray(item.resistances) ? item.resistances : (Array.isArray(item.res) ? item.res : [])),
      updatedAt,
      JSON.stringify({ ...item, sym })
    ).run();
}

async function upsertGroupAlert(env, item, updatedAt) {
  const sym = text(item.sym)?.toUpperCase();
  if (!sym) return;
  const id = text(item.id) || `ga-${sym}-${Date.now()}`;
  await env.DB.prepare(`INSERT OR REPLACE INTO group_alerts
    (id, sym, note, entry_date, grade, linked_portfolio_id, status, pct_since_add, updated_at, added_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id,
      sym,
      text(item.note),
      text(item.entryDate || item.entry_date),
      text(item.grade) || '',
      text(item.portfolioId || item.linked_portfolio_id),
      text(item.status),
      num(item.pctSinceAdd ?? item.pct_since_add),
      updatedAt,
      text(item.addedIso || item.added_at) || updatedAt,
      JSON.stringify({ ...item, id, sym })
    ).run();
}

async function upsertSubscriber(env, item, updatedAt) {
  const id = text(item.id || item.telegramId || item.telegram_id || item.handle || item.name);
  if (!id) return;
  await env.DB.prepare(`INSERT OR REPLACE INTO subscribers
    (id, name, joined_date, handle, telegram_id, method, paid_date, status, expiry_date, amount, updated_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id,
      text(item.name),
      text(item.joinedDate || item.joined_date),
      text(item.handle),
      text(item.telegramId || item.telegram_id),
      text(item.method),
      text(item.paidDate || item.paid_date),
      text(item.status),
      text(item.expiryDate || item.expiry_date),
      num(item.amount),
      updatedAt,
      JSON.stringify({ ...item, id })
    ).run();
}

function sanitizePortfolio(items) {
  return items.filter(item => text(item?.sym));
}
function parseJson(value) { try { return JSON.parse(value); } catch { return null; } }
function text(value) { if (value == null) return null; const s = String(value).trim(); return s ? s : null; }
function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
