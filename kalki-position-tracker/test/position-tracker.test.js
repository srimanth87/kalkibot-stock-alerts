import test from "node:test";
import assert from "node:assert/strict";
import worker, { checkOpenPositions, evaluatePosition } from "../src/index.js";

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
