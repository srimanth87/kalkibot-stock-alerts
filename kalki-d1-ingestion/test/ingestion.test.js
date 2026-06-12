import test from "node:test";
import assert from "node:assert/strict";
import worker, { buildD1Rows, ingestText, parseScoredAlert, upsertManualPortfolioPosition } from "../src/index.js";

const SAMPLE_ALERT = `⚡ *TSLA*
📊 Grade: *A* | Score: *6/8*

💰 Price: $181.04
📈 Entry: *$176–$181*
🛑 Stop: $169.50 (-5.1%)
🎯 T1: $190 (+6.4%)
🎯 T2: $205 (+14.8%)

Volume: 24.5M · 1.8x avg
⏰ 05/30/2026 · 9:35 AM EDT

⚡ _Kalki Analysis Platform_`;

test("parseScoredAlert parses final scored compact alert", () => {
  const parsed = parseScoredAlert(SAMPLE_ALERT);

  assert.equal(parsed.sym, "TSLA");
  assert.equal(parsed.grade, "A");
  assert.equal(parsed.score, 6);
  assert.equal(parsed.scoreMax, 8);
  assert.equal(parsed.price, 181.04);
  assert.equal(parsed.entryLow, 176);
  assert.equal(parsed.entryHigh, 181);
  assert.equal(parsed.entryMid, 178.5);
  assert.equal(parsed.stop, 169.5);
  assert.deepEqual(parsed.targets, [190, 205]);
  assert.equal(parsed.entryDate, "2026-05-30");
  assert.equal(parsed.volume, 24500000);
  assert.equal(parsed.volumeRatio, 1.8);
});

test("buildD1Rows maps exact alert fields into only desired tables", () => {
  const alert = parseScoredAlert(SAMPLE_ALERT);
  const rows = buildD1Rows(alert, {
    id: "tg--1001-42",
    sourceChatId: "-1001",
    sourceMessageId: "42",
    updatedAt: "2026-05-30T13:35:00.000Z",
  });

  assert.equal(rows.position.id, "tg--1001-42");
  assert.equal(rows.position.sym, "TSLA");
  assert.equal(rows.position.entryPrice, 178.5);
  assert.equal(rows.position.invest, 1000);
  assert.equal(rows.position.supLow, 176);
  assert.equal(rows.position.supHigh, 181);
  assert.equal(rows.position.breakdown, 169.5);
  assert.deepEqual(rows.position.resistances, [190, 205]);
  assert.equal(rows.groupAlert.linked_portfolio_id, undefined);
  assert.equal(rows.groupAlert.portfolioId, "tg--1001-42");
  assert.equal(rows.watchlist.support_low, undefined);
  assert.equal(rows.watchlist.supLow, 176);
  assert.equal(rows.watchlist.brk, 169.5);
});

test("ingestText upserts watchlist, group alert, and portfolio without app_state writes", async () => {
  const db = new FakeD1();
  const result = await ingestText(
    { DB: db },
    { text: SAMPLE_ALERT, sourceChatId: "-1001", sourceMessageId: "42", receivedAt: "2026-05-30T13:35:00.000Z" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.portfolio_positions, 1);
  assert.deepEqual(db.tablesTouched.sort(), ["group_alerts", "portfolio_positions", "watchlist_items"]);
  assert.equal(db.sqlLog.some((sql) => /app_state/i.test(sql)), false);

  const position = db.table("portfolio_positions").get("tg--1001-42");
  assert.equal(position.sym, "TSLA");
  assert.equal(position.entry_price, 178.5);
  assert.equal(position.closed_price, null);

  const watchlist = db.table("watchlist_items").get("TSLA");
  assert.equal(watchlist.support_low, 176);
  assert.equal(watchlist.support_high, 181);
  assert.equal(watchlist.breakdown, 169.5);
});

test("ingestText is idempotent for the same Telegram message", async () => {
  const db = new FakeD1();
  const input = { text: SAMPLE_ALERT, sourceChatId: "-1001", sourceMessageId: "42" };

  await ingestText({ DB: db }, input);
  await ingestText({ DB: db }, input);

  assert.equal(db.table("portfolio_positions").size, 1);
  assert.equal(db.table("group_alerts").size, 1);
  assert.equal(db.table("watchlist_items").size, 1);
});

test("ingestText preserves an already closed portfolio position", async () => {
  const db = new FakeD1();
  db.table("portfolio_positions").set("tg--1001-42", {
    id: "tg--1001-42",
    state: "closed",
    closed_price: 192.25,
    raw_json: JSON.stringify({ id: "tg--1001-42", sym: "TSLA", state: "closed", closeDate: "2026-06-01" }),
  });

  await ingestText(
    { DB: db },
    { text: SAMPLE_ALERT, sourceChatId: "-1001", sourceMessageId: "42", receivedAt: "2026-05-30T13:35:00.000Z" },
  );

  const position = db.table("portfolio_positions").get("tg--1001-42");
  const raw = JSON.parse(position.raw_json);
  assert.equal(position.state, "closed");
  assert.equal(position.closed_price, 192.25);
  assert.equal(raw.closeDate, "2026-06-01");
});

test("worker rejects unauthorized manual ingestion", async () => {
  const response = await worker.fetch(new Request("https://example.com/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: SAMPLE_ALERT }),
  }), { DB: new FakeD1(), KALKI_INGEST_KEY: "secret" });

  assert.equal(response.status, 401);
});

test("reporting APIs read alerts, portfolio, watchlist, and summaries from D1", async () => {
  const db = new FakeD1();
  await ingestText(
    { DB: db },
    { text: SAMPLE_ALERT, sourceChatId: "-1001", sourceMessageId: "42", receivedAt: "2026-05-30T13:35:00.000Z" },
  );

  const alerts = await readJson(await worker.fetch(new Request("https://example.com/api/alerts?limit=5"), { DB: db }));
  const portfolio = await readJson(await worker.fetch(new Request("https://example.com/api/portfolio"), { DB: db }));
  const watchlist = await readJson(await worker.fetch(new Request("https://example.com/api/watchlist"), { DB: db }));
  const reports = await readJson(await worker.fetch(new Request("https://example.com/api/reports"), { DB: db }));

  assert.equal(alerts.ok, true);
  assert.equal(alerts.alerts.length, 1);
  assert.equal(alerts.alerts[0].sym, "TSLA");
  assert.equal(portfolio.positions.length, 1);
  assert.equal(portfolio.positions[0].entry_price, 178.5);
  assert.equal(watchlist.watchlist[0].sym, "TSLA");
  assert.equal(reports.reports.totals.alerts, 1);
  assert.equal(reports.reports.totals.open, 1);
});

test("manual portfolio correction safely merges one position row", async () => {
  const db = new FakeD1();
  await ingestText(
    { DB: db },
    { text: SAMPLE_ALERT, sourceChatId: "-1001", sourceMessageId: "42", receivedAt: "2026-05-30T13:35:00.000Z" },
  );

  const result = await upsertManualPortfolioPosition({ DB: db }, {
    id: "tg--1001-42",
    currentPrice: 192,
    notes: "Manual close review",
  });

  assert.equal(result.ok, true);
  assert.equal(result.position.sym, "TSLA");
  assert.equal(result.position.entry_price, 178.5);
  assert.equal(result.position.current_price, 192);
  assert.equal(result.position.notes, "Manual close review");
  assert.equal(db.table("group_alerts").size, 1);
  assert.equal(db.table("watchlist_items").size, 1);
});

test("manual portfolio endpoint requires auth when a key is configured", async () => {
  const response = await worker.fetch(new Request("https://example.com/api/portfolio", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sym: "MSFT", entryPrice: 400 }),
  }), { DB: new FakeD1(), KALKI_INGEST_KEY: "secret" });

  assert.equal(response.status, 401);
});

class FakeD1 {
  constructor() {
    this.data = new Map([
      ["portfolio_positions", new Map()],
      ["group_alerts", new Map()],
      ["watchlist_items", new Map()],
    ]);
    this.sqlLog = [];
    this.tablesTouched = [];
  }

  table(name) {
    return this.data.get(name);
  }

  prepare(sql) {
    this.sqlLog.push(sql);
    return new FakeStatement(this, sql);
  }

  mark(table) {
    if (!this.tablesTouched.includes(table)) this.tablesTouched.push(table);
  }
}

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async first() {
    if (/COUNT\(\*\) AS total FROM portfolio_positions/i.test(this.sql)) {
      return { total: this.db.table("portfolio_positions").size };
    }
    if (/FROM portfolio_positions\s+WHERE id = \?/i.test(this.sql)) {
      return this.db.table("portfolio_positions").get(this.params[0]) || null;
    }
    throw new Error(`Unexpected first SQL: ${this.sql}`);
  }

  async all() {
    if (/FROM group_alerts/i.test(this.sql)) {
      return { results: [...this.db.table("group_alerts").values()].slice(0, this.limitParam()) };
    }

    if (/FROM portfolio_positions/i.test(this.sql)) {
      let values = [...this.db.table("portfolio_positions").values()];
      if (/WHERE state = \?/i.test(this.sql)) {
        values = values.filter((row) => row.state === this.params[0]);
      }
      return { results: values.slice(0, this.limitParam()) };
    }

    if (/FROM watchlist_items/i.test(this.sql)) {
      return { results: [...this.db.table("watchlist_items").values()].slice(0, this.limitParam()) };
    }

    throw new Error(`Unexpected all SQL: ${this.sql}`);
  }

  async run() {
    if (/INSERT OR REPLACE INTO portfolio_positions/i.test(this.sql)) {
      this.db.mark("portfolio_positions");
      const [id, sym, grade, state, entry_date, entry_price, current_price, closed_price, pnl_pct, updated_at, raw_json] = this.params;
      this.db.table("portfolio_positions").set(id, { id, sym, grade, state, entry_date, entry_price, current_price, closed_price, pnl_pct, updated_at, raw_json });
      return { success: true };
    }

    if (/INSERT OR REPLACE INTO group_alerts/i.test(this.sql)) {
      this.db.mark("group_alerts");
      const [id, sym, note, entry_date, grade, linked_portfolio_id, status, pct_since_add, updated_at, added_at, raw_json] = this.params;
      this.db.table("group_alerts").set(id, { id, sym, note, entry_date, grade, linked_portfolio_id, status, pct_since_add, updated_at, added_at, raw_json });
      return { success: true };
    }

    if (/INSERT OR REPLACE INTO watchlist_items/i.test(this.sql)) {
      this.db.mark("watchlist_items");
      const [sym, grade, status, support_low, support_high, breakdown, resistances_json, updated_at, raw_json] = this.params;
      this.db.table("watchlist_items").set(sym, { sym, grade, status, support_low, support_high, breakdown, resistances_json, updated_at, raw_json });
      return { success: true };
    }

    throw new Error(`Unexpected run SQL: ${this.sql}`);
  }

  limitParam() {
    const last = this.params[this.params.length - 1];
    return Number.isFinite(Number(last)) ? Number(last) : 100;
  }
}

async function readJson(response) {
  assert.equal(response.status, 200);
  return response.json();
}
