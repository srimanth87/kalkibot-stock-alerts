import test from "node:test";
import assert from "node:assert/strict";
import worker, { checkOpenPositions, closePosition, evaluatePosition } from "../src/index.js";

test("evaluatePosition emits a target event when price crosses next target", () => {
  const result = evaluatePosition({
    sym: "TSLA",
    entryPrice: 178.5,
    resistances: [190, 205],
    breakdown: 169.5,
    tpsHit: 0,
  }, 191);

  assert.equal(result.alert, true);
  assert.equal(result.event, "target");
  assert.equal(result.label, "TP1 HIT");
  assert.equal(result.tpsHit, 1);
  assert.equal(result.nextTP, 205);
});

test("evaluatePosition does not repeat already recorded targets", () => {
  const result = evaluatePosition({
    sym: "TSLA",
    entryPrice: 178.5,
    resistances: [190, 205],
    breakdown: 169.5,
    tpsHit: 1,
  }, 191);

  assert.equal(result.alert, false);
  assert.equal(result.tpsHit, 1);
  assert.equal(result.nextTP, 205);
});

test("evaluatePosition emits one stop event", () => {
  const result = evaluatePosition({
    sym: "TSLA",
    entryPrice: 178.5,
    resistances: [190, 205],
    breakdown: 169.5,
    tpsHit: 0,
    stopAlerted: false,
  }, 168);

  assert.equal(result.alert, true);
  assert.equal(result.event, "stop");
  assert.equal(result.stopAlerted, true);
});

test("checkOpenPositions sends approval with original reply id and updates D1 after a target hit", async () => {
  const db = new FakeD1();
  db.addPosition({
    id: "tg--1001-42",
    sym: "TSLA",
    grade: "A",
    state: "open",
    entry_date: "2026-05-30",
    entry_price: 178.5,
    current_price: 181.04,
    raw_json: JSON.stringify({
      id: "tg--1001-42",
      sym: "TSLA",
      grade: "A",
      entryPrice: 178.5,
      currentPrice: 181.04,
      breakdown: 169.5,
      resistances: [190, 205],
      tpsHit: 0,
      sourceChatId: "-1003967721534",
      sourceMessageId: "777",
    }),
  });
  const fetches = [];
  const restoreFetch = mockFetch(fetches);

  try {
    const result = await checkOpenPositions({
      DB: db,
      NASDAQ_SCANNER_CHAT_ID: "1026720092",
    }, { prices: { TSLA: 191 } });

    assert.equal(result.ok, true);
    assert.equal(result.alerts, 1);
    assert.equal(fetches.length, 1);
    assert.match(fetches[0].url, /kalki-approval-gate/);
    assert.match(fetches[0].body.text, /TP1 HIT/);
    assert.match(fetches[0].body.text, /TSLA/);
    assert.equal(fetches[0].body.chat_id, "1026720092");
    assert.equal(fetches[0].body.reply_to_message_id, 777);

    const row = db.table("portfolio_positions").get("tg--1001-42");
    const raw = JSON.parse(row.raw_json);
    assert.equal(row.current_price, 191);
    assert.equal(raw.tpsHit, 1);
    assert.equal(raw.nextTP, 205);
    assert.equal(raw.status, "Watching TP2");
  } finally {
    restoreFetch();
  }
});

test("checkOpenPositions closes the trade and logs an event when the stop is hit", async () => {
  const db = new FakeD1();
  db.addPosition({
    id: "tg--1001-99",
    sym: "TSLA",
    grade: "A",
    state: "open",
    entry_date: "2026-05-30",
    entry_price: 178.5,
    current_price: 181.04,
    raw_json: JSON.stringify({
      breakdown: 169.5,
      resistances: [190, 205],
      tpsHit: 0,
      sourceChatId: "-1003967721534",
      sourceMessageId: "777",
    }),
  });
  const restoreFetch = mockFetch([]);

  try {
    await checkOpenPositions({ DB: db, NASDAQ_SCANNER_CHAT_ID: "1026720092" }, { prices: { TSLA: 168 } });

    const row = db.table("portfolio_positions").get("tg--1001-99");
    assert.equal(row.state, "closed", "stop-out must close the trade");
    assert.equal(row.closed_price, 168);
    assert.equal(JSON.parse(row.raw_json).closeReason, "stop");

    const event = db.table("alert_events").get("tg--1001-99:STOP_HIT");
    assert.ok(event, "a STOP_HIT event must be recorded");
    assert.equal(event.price, 168);
    assert.equal(event.telegram_message_id, "777");

    // A closed position must drop out of the next check entirely.
    const next = await checkOpenPositions({ DB: db, NASDAQ_SCANNER_CHAT_ID: "1026720092" }, { prices: { TSLA: 168 } });
    assert.equal(next.checked, 0);
  } finally {
    restoreFetch();
  }
});

test("checkOpenPositions closes the trade once the final target is hit", async () => {
  const db = new FakeD1();
  db.addPosition({
    id: "tg--1001-55",
    sym: "TSLA",
    state: "open",
    entry_date: "2026-05-30",
    entry_price: 178.5,
    raw_json: JSON.stringify({
      breakdown: 169.5,
      resistances: [190, 205],
      tpsHit: 1,
      sourceChatId: "-1003967721534",
      sourceMessageId: "777",
    }),
  });
  const restoreFetch = mockFetch([]);

  try {
    await checkOpenPositions({ DB: db, NASDAQ_SCANNER_CHAT_ID: "1026720092" }, { prices: { TSLA: 210 } });

    const row = db.table("portfolio_positions").get("tg--1001-55");
    assert.equal(row.state, "closed", "final target must close the trade");
    assert.equal(JSON.parse(row.raw_json).closeReason, "all_targets_hit");
    assert.ok(db.table("alert_events").get("tg--1001-55:TP2_HIT"));
  } finally {
    restoreFetch();
  }
});

test("alert_events are idempotent across repeated checks", async () => {
  const db = new FakeD1();
  db.addPosition({
    id: "tg--1001-77",
    sym: "TSLA",
    state: "open",
    entry_date: "2026-05-30",
    entry_price: 178.5,
    raw_json: JSON.stringify({
      breakdown: 169.5,
      resistances: [190, 205],
      tpsHit: 0,
      sourceChatId: "-1003967721534",
      sourceMessageId: "777",
    }),
  });
  const restoreFetch = mockFetch([]);

  try {
    const env = { DB: db, NASDAQ_SCANNER_CHAT_ID: "1026720092" };
    await checkOpenPositions(env, { prices: { TSLA: 191 } });
    // Re-running must not append a second TP1 row (cron retry safety).
    await checkOpenPositions(env, { prices: { TSLA: 191 } });

    const tp1 = [...db.table("alert_events").keys()].filter((key) => key.endsWith(":TP1_HIT"));
    assert.equal(tp1.length, 1);
  } finally {
    restoreFetch();
  }
});

test("tracks positions from any configured chat id, including a test group", async () => {
  const db = new FakeD1();
  db.addPosition({
    id: "tg--1003377752970-4242",
    sym: "TSLA",
    state: "open",
    entry_date: "2026-05-30",
    entry_price: 178.5,
    raw_json: JSON.stringify({
      breakdown: 169.5,
      resistances: [190, 205],
      tpsHit: 0,
      sourceChatId: "-1003377752970",
      sourceMessageId: "4242",
    }),
  });
  const fetches = [];
  const restoreFetch = mockFetch(fetches);

  try {
    const result = await checkOpenPositions({
      DB: db,
      NASDAQ_SCANNER_CHAT_ID: "1026720092",
      KALKI_STOCKS_CHAT_ID: "-1003967721534,-1003377752970",
    }, { prices: { TSLA: 191 } });

    assert.notEqual(result.results[0].reason, "missing original Kalki-stocks message id");
    assert.equal(result.alerts, 1);
    assert.equal(fetches[0].body.reply_to_message_id, 4242);
  } finally {
    restoreFetch();
  }
});

test("ignores positions from a chat id that is not configured", async () => {
  const db = new FakeD1();
  db.addPosition({
    id: "tg--999-1",
    sym: "TSLA",
    state: "open",
    entry_date: "2026-05-30",
    entry_price: 178.5,
    raw_json: JSON.stringify({
      breakdown: 169.5,
      resistances: [190, 205],
      tpsHit: 0,
      sourceChatId: "-999",
      sourceMessageId: "1",
    }),
  });
  const restoreFetch = mockFetch([]);

  try {
    const result = await checkOpenPositions({
      DB: db,
      NASDAQ_SCANNER_CHAT_ID: "1026720092",
      KALKI_STOCKS_CHAT_ID: "-1003967721534",
    }, { prices: { TSLA: 191 } });

    assert.equal(result.results[0].reason, "missing original Kalki-stocks message id");
    assert.equal(result.alerts, 0);
  } finally {
    restoreFetch();
  }
});

function openPosition(db, overrides = {}) {
  db.addPosition({
    id: "tg--1003377752970-164",
    sym: "MUU",
    state: "open",
    entry_date: "2026-09-04",
    entry_price: 30.5,
    raw_json: JSON.stringify({
      breakdown: 28,
      resistances: [32, 34, 36],
      tpsHit: 1,
      sourceChatId: "-1003377752970",
      sourceMessageId: "164",
      ...overrides,
    }),
  });
}

test("closePosition closes a trade at a manual exit price", async () => {
  const db = new FakeD1();
  openPosition(db);
  const fetches = [];
  const restoreFetch = mockFetch(fetches);
  const env = {
    DB: db,
    NASDAQ_SCANNER_CHAT_ID: "1026720092",
    KALKI_STOCKS_CHAT_ID: "-1003967721534,-1003377752970",
  };

  try {
    const result = await closePosition(env, { sym: "MUU", price: 33.5 });

    assert.equal(result.ok, true);
    assert.equal(result.exitPrice, 33.5);
    assert.equal(result.recorded, "MANUAL_EXIT");
    assert.equal(Math.round(result.pnlPct * 100) / 100, 9.84);

    // Approval must be queued, threaded under the original alert.
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].body.reply_to_message_id, 164);
    assert.match(fetches[0].body.text, /MUU CLOSED/);
    assert.match(fetches[0].body.text, /Exit: \$33\.50/);
    assert.match(fetches[0].body.text, /Profit: \+9\.84%/);

    const row = db.table("portfolio_positions").get("tg--1003377752970-164");
    assert.equal(row.state, "closed");
    assert.equal(row.closed_price, 33.5);
    assert.equal(JSON.parse(row.raw_json).closeReason, "manual");
    assert.ok(db.table("alert_events").get("tg--1003377752970-164:MANUAL_EXIT"));
  } finally {
    restoreFetch();
  }
});

test("published messages never leak approver-only instructions to customers", async () => {
  // The approval text IS the text posted to the groups, so any operator wording
  // here reaches paying subscribers. Regression guard: this line used to ship.
  const db = new FakeD1();
  openPosition(db);
  const fetches = [];
  const restoreFetch = mockFetch(fetches);
  const env = {
    DB: db,
    NASDAQ_SCANNER_CHAT_ID: "1026720092",
    KALKI_STOCKS_CHAT_ID: "-1003377752970",
  };

  try {
    await closePosition(env, { sym: "MUU", price: 33.5 });

    const db2 = new FakeD1();
    db2.addPosition({
      id: "tg--1003377752970-200",
      sym: "MUU",
      state: "open",
      entry_date: "2026-09-04",
      entry_price: 30.5,
      raw_json: JSON.stringify({
        breakdown: 28,
        resistances: [32, 34, 36],
        tpsHit: 0,
        sourceChatId: "-1003377752970",
        sourceMessageId: "200",
      }),
    });
    await checkOpenPositions({ ...env, DB: db2 }, { prices: { MUU: 33 } });

    assert.equal(fetches.length, 2, "expected a manual close and a TP hit");
    for (const call of fetches) {
      assert.doesNotMatch(call.body.text, /Accept to notify/i, `leaked operator text: ${call.body.text}`);
      assert.doesNotMatch(call.body.text, /approve|approval/i, `leaked operator text: ${call.body.text}`);
    }
  } finally {
    restoreFetch();
  }
});

test("manual close message keeps its blank-line formatting", async () => {
  const db = new FakeD1();
  openPosition(db);
  const fetches = [];
  const restoreFetch = mockFetch(fetches);

  try {
    await closePosition({
      DB: db,
      NASDAQ_SCANNER_CHAT_ID: "1026720092",
      KALKI_STOCKS_CHAT_ID: "-1003377752970",
    }, { sym: "MUU", price: 33.5, note: "booking profits" });

    assert.equal(fetches[0].body.text, [
      "🔔 <b>MUU CLOSED</b>",
      "",
      "Entry: $30.50",
      "Exit: $33.50",
      "",
      "Profit: +9.84% ✅",
      "",
      "booking profits",
    ].join("\n"));
  } finally {
    restoreFetch();
  }
});

test("closePosition reports a loss when exiting below entry", async () => {
  const db = new FakeD1();
  openPosition(db);
  const fetches = [];
  const restoreFetch = mockFetch(fetches);

  try {
    const result = await closePosition({
      DB: db,
      NASDAQ_SCANNER_CHAT_ID: "1026720092",
      KALKI_STOCKS_CHAT_ID: "-1003377752970",
    }, { sym: "MUU", price: 29 });

    assert.ok(result.pnlPct < 0);
    assert.match(fetches[0].body.text, /Loss: -4\.92% 🔻/);
  } finally {
    restoreFetch();
  }
});

test("closePosition falls back to the live price when none is given", async () => {
  const db = new FakeD1();
  openPosition(db);
  const restoreFetch = mockFetch([]);

  try {
    const result = await closePosition({
      DB: db,
      NASDAQ_SCANNER_CHAT_ID: "1026720092",
      KALKI_STOCKS_CHAT_ID: "-1003377752970",
      TEST_PRICES: JSON.stringify({ MUU: 31.75 }),
    }, { sym: "MUU" });

    assert.equal(result.ok, true);
    assert.equal(result.exitPrice, 31.75);
  } finally {
    restoreFetch();
  }
});

test("closePosition refuses an unknown or already closed position", async () => {
  const db = new FakeD1();
  openPosition(db);
  const restoreFetch = mockFetch([]);
  const env = {
    DB: db,
    NASDAQ_SCANNER_CHAT_ID: "1026720092",
    KALKI_STOCKS_CHAT_ID: "-1003377752970",
  };

  try {
    const missing = await closePosition(env, { sym: "NOPE", price: 10 });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /No open position/);

    await closePosition(env, { sym: "MUU", price: 33.5 });
    // Second close must fail rather than double-post or reopen the trade.
    const again = await closePosition(env, { sym: "MUU", price: 34 });
    assert.equal(again.ok, false);
    assert.match(again.error, /No open position/);
  } finally {
    restoreFetch();
  }
});

test("closePosition dry run does not write or notify", async () => {
  const db = new FakeD1();
  openPosition(db);
  const fetches = [];
  const restoreFetch = mockFetch(fetches);

  try {
    const result = await closePosition({
      DB: db,
      NASDAQ_SCANNER_CHAT_ID: "1026720092",
      KALKI_STOCKS_CHAT_ID: "-1003377752970",
    }, { sym: "MUU", price: 33.5, dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(fetches.length, 0);
    assert.equal(db.table("portfolio_positions").get("tg--1003377752970-164").state, "open");
  } finally {
    restoreFetch();
  }
});

test("prices each distinct ticker once and defers beyond the fetch budget", async () => {
  const db = new FakeD1();
  // Two positions share MUU; NVDA and TSLA are distinct.
  for (const [n, sym] of [[1, "MUU"], [2, "MUU"], [3, "NVDA"], [4, "TSLA"]]) {
    db.addPosition({
      id: `tg--1003377752970-${n}`,
      sym,
      state: "open",
      entry_date: "2026-09-04",
      entry_price: 30,
      raw_json: JSON.stringify({
        breakdown: 1,
        resistances: [999],
        tpsHit: 0,
        sourceChatId: "-1003377752970",
        sourceMessageId: String(n),
      }),
    });
  }

  const fetched = [];
  const restoreFetch = mockFetch([], (url) => {
    fetched.push(url);
    return { ok: true, result: { message_id: 1 } };
  });
  const env = {
    DB: db,
    NASDAQ_SCANNER_CHAT_ID: "1026720092",
    KALKI_STOCKS_CHAT_ID: "-1003377752970",
    TEST_PRICES: JSON.stringify({ MUU: 30, NVDA: 30, TSLA: 30 }),
    MAX_PRICE_FETCHES: "2",
  };

  try {
    const result = await checkOpenPositions(env, {});

    // MUU counts once (cached for the second row); budget of 2 allows one more.
    assert.equal(result.priceFetches, 2);
    assert.equal(result.deferred, 1, "the ticker past the budget must be deferred");
    const deferred = result.results.filter((r) => r.reason?.startsWith("price budget"));
    assert.equal(deferred.length, 1);
  } finally {
    restoreFetch();
  }
});

test("checkOpenPositions does not resend the same target alert", async () => {
  const db = new FakeD1();
  db.addPosition({
    id: "tg--1001-42",
    sym: "TSLA",
    grade: "A",
    state: "open",
    entry_date: "2026-05-30",
    entry_price: 178.5,
    current_price: 191,
    raw_json: JSON.stringify({
      id: "tg--1001-42",
      sym: "TSLA",
      entryPrice: 178.5,
      currentPrice: 191,
      breakdown: 169.5,
      resistances: [190, 205],
      tpsHit: 1,
    }),
  });
  const fetches = [];
  const restoreFetch = mockFetch(fetches);

  try {
    const result = await checkOpenPositions({
      DB: db,
      NASDAQ_SCANNER_CHAT_ID: "1026720092",
    }, { prices: { TSLA: 192 } });

    assert.equal(result.alerts, 0);
    assert.equal(fetches.length, 0);
    assert.equal(JSON.parse(db.table("portfolio_positions").get("tg--1001-42").raw_json).tpsHit, 1);
  } finally {
    restoreFetch();
  }
});

test("checkOpenPositions uses Yahoo proxy price source by default", async () => {
  const db = new FakeD1();
  db.addPosition({
    id: "tg--1001-42",
    sym: "TSLA",
    grade: "A",
    state: "open",
    entry_date: "2026-05-30",
    entry_price: 178.5,
    current_price: 181.04,
    raw_json: JSON.stringify({
      id: "tg--1001-42",
      sym: "TSLA",
      entryPrice: 178.5,
      breakdown: 169.5,
      resistances: [190, 205],
      tpsHit: 0,
      sourceChatId: "-1003967721534",
      sourceMessageId: "777",
    }),
  });
  const fetches = [];
  const restoreFetch = mockFetch(fetches, (url) => {
    if (String(url).includes("yahoo-proxy")) {
      return {
        chart: {
          result: [{
            meta: { regularMarketPrice: 191.25 },
            indicators: { quote: [{ close: [189, 190.5, 191.25] }] },
          }],
        },
      };
    }
    return { ok: true, approval_id: "approval-123", status: "pending" };
  });

  try {
    const result = await checkOpenPositions({
      DB: db,
      NASDAQ_SCANNER_CHAT_ID: "1026720092",
      YAHOO_PROXY_BASE_URL: "https://yahoo-proxy.srimanthgada87.workers.dev",
    });

    assert.equal(result.alerts, 1);
    assert.equal(result.results[0].price, 191.25);
    assert.equal(fetches.some((call) => call.url.includes("query1.finance.yahoo.com")), true);
    assert.equal(fetches.some((call) => call.url.includes("kalki-approval-gate")), true);
  } finally {
    restoreFetch();
  }
});

test("manual check endpoint supports authenticated dry runs without writes", async () => {
  const db = new FakeD1();
  db.addPosition({
    id: "tg--1001-42",
    sym: "TSLA",
    grade: "A",
    state: "open",
    entry_date: "2026-05-30",
    entry_price: 178.5,
    current_price: 181.04,
    raw_json: JSON.stringify({
      id: "tg--1001-42",
      sym: "TSLA",
      entryPrice: 178.5,
      breakdown: 169.5,
      resistances: [190],
      tpsHit: 0,
      sourceChatId: "-1003967721534",
      sourceMessageId: "777",
    }),
  });

  const response = await worker.fetch(new Request("https://example.com/check?dryRun=1", {
    headers: { "X-Kalki-Key": "secret" },
  }), {
    DB: db,
    KALKI_TRACKER_KEY: "secret",
    TEST_PRICES: JSON.stringify({ TSLA: 191 }),
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.dryRun, true);
  assert.equal(data.alerts, 1);
  assert.equal(JSON.parse(db.table("portfolio_positions").get("tg--1001-42").raw_json).tpsHit, 0);
});

test("manual check endpoint rejects missing key when configured", async () => {
  const response = await worker.fetch(new Request("https://example.com/check"), {
    DB: new FakeD1(),
    KALKI_TRACKER_KEY: "secret",
  });

  assert.equal(response.status, 401);
});

class FakeD1 {
  constructor() {
    this.data = new Map([["portfolio_positions", new Map()]]);
  }

  table(name) {
    if (!this.data.has(name)) {
      this.data.set(name, new Map());
    }
    return this.data.get(name);
  }

  addPosition(row) {
    this.table("portfolio_positions").set(row.id, {
      closed_price: null,
      pnl_pct: null,
      updated_at: "2026-05-30T13:35:00.000Z",
      ...row,
    });
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
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

  async all() {
    if (/FROM portfolio_positions/i.test(this.sql)) {
      const limit = Number(this.params[0] || 100);
      const results = [...this.db.table("portfolio_positions").values()]
        .filter((row) => row.state !== "closed")
        .slice(0, limit);
      return { results };
    }
    throw new Error(`Unexpected all SQL: ${this.sql}`);
  }

  async run() {
    if (/^\s*CREATE (TABLE|UNIQUE INDEX)/i.test(this.sql)) {
      return { success: true };
    }

    if (/INSERT OR IGNORE INTO alert_events/i.test(this.sql)) {
      const [position_id, sym, event, price, pnl_pct, telegram_message_id, created_at] = this.params;
      const events = this.db.table("alert_events");
      const key = `${position_id}:${event}`;
      // Mirrors the UNIQUE(position_id, event) index: re-running an event is a no-op.
      if (!events.has(key)) {
        events.set(key, { position_id, sym, event, price, pnl_pct, telegram_message_id, created_at });
      }
      return { success: true };
    }

    if (/INSERT OR REPLACE INTO portfolio_positions/i.test(this.sql)) {
      const [id, sym, grade, state, entry_date, entry_price, current_price, closed_price, pnl_pct, updated_at, raw_json] = this.params;
      this.db.table("portfolio_positions").set(id, {
        id,
        sym,
        grade,
        state,
        entry_date,
        entry_price,
        current_price,
        closed_price,
        pnl_pct,
        updated_at,
        raw_json,
      });
      return { success: true };
    }
    throw new Error(`Unexpected run SQL: ${this.sql}`);
  }
}

function mockFetch(calls, responder = null) {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    const url = typeof _url === "string" ? _url : _url.url;
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url, body });
    const payload = responder ? responder(url, init) : { ok: true, result: { message_id: 123 } };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return () => {
    globalThis.fetch = original;
  };
}
