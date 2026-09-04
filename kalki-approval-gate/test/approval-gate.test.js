import assert from "node:assert/strict";
import test from "node:test";
import worker, { internals } from "../src/index.js";

class MemoryKv {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.get(key) || null;
  }

  async put(key, value) {
    this.values.set(key, value);
  }
}

function env(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    WATCH_CHAT_IDS: "1026720092",
    DESTINATION_CHAT_ID: "-1003967721534",
    APPROVAL_STATE: new MemoryKv(),
    ...overrides,
  };
}

function webhookRequest(body) {
  return new Request("https://approval.example.test/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "secret",
    },
    body: JSON.stringify(body),
  });
}

test("creates an approval message for watched chat alerts", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({
      ok: true,
      result: {
        message_id: 88,
        chat: { id: 1026720092 },
      },
    });
  });

  const testEnv = env();
  const response = await worker.fetch(webhookRequest({
    update_id: 1,
    message: {
      message_id: 44,
      date: 1780850000,
      chat: { id: 1026720092 },
      text: "NVDA\nEntry: $120-122\nStop: $115\nT1: $130",
    },
  }), testEnv);
  const data = await response.json();

  assert.equal(data.ok, true);
  assert.equal(data.status, "pending");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendMessage$/);
  assert.equal(calls[0].body.chat_id, "1026720092");
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].text, "Accept");
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][1].text, "Reject");
});

test("accept callback sends stored alert to Kalki-stocks once", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    return Response.json({
      ok: true,
      result: method === "sendMessage"
        ? { message_id: calls.length, chat: { id: body.chat_id } }
        : true,
    });
  });

  const testEnv = env();
  const create = await worker.fetch(webhookRequest({
    update_id: 1,
    message: {
      message_id: 44,
      chat: { id: 1026720092 },
      text: "NVDA\nEntry: $120-122\nStop: $115\nT1: $130",
    },
  }), testEnv);
  const created = await create.json();
  const callbackData = internals.buildCallbackData("accept", created.approval_id);

  const accept = await worker.fetch(webhookRequest({
    update_id: 2,
    callback_query: {
      id: "cb-1",
      from: { id: 123, username: "approver" },
      data: callbackData,
      message: { message_id: 88, chat: { id: 1026720092 } },
    },
  }), testEnv);
  const accepted = await accept.json();

  assert.equal(accepted.ok, true);
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(calls.map((call) => call.method), [
    "sendMessage",
    "sendMessage",
    "ingest",
    "editMessageText",
    "answerCallbackQuery",
  ]);
  assert.equal(calls[1].body.chat_id, "-1003967721534");
  assert.equal(calls[1].body.text, "NVDA\nEntry: $120-122\nStop: $115\nT1: $130");

  // The position must be recorded against the Kalki-stocks message id, otherwise
  // kalki-position-tracker skips it and no TP/SL alert can ever fire.
  assert.equal(calls[2].body.sourceChatId, "-1003967721534");
  assert.equal(calls[2].body.sourceMessageId, "2");
  assert.equal(calls[2].body.text, "NVDA\nEntry: $120-122\nStop: $115\nT1: $130");

  const second = await worker.fetch(webhookRequest({
    update_id: 3,
    callback_query: {
      id: "cb-2",
      from: { id: 123, username: "approver" },
      data: callbackData,
      message: { message_id: 88, chat: { id: 1026720092 } },
    },
  }), testEnv);
  const skipped = await second.json();

  assert.equal(skipped.skipped, true);
  assert.equal(calls.filter((call) => call.method === "sendMessage" && call.body.chat_id === "-1003967721534").length, 1);
});

async function acceptDirectApproval(t, testEnv, body) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const method = String(url).split("/").pop();
    const payload = JSON.parse(init.body);
    calls.push({ method, body: payload });
    return Response.json({
      ok: true,
      result: method === "sendMessage"
        ? { message_id: calls.length, chat: { id: payload.chat_id } }
        : true,
    });
  });

  const create = await worker.fetch(new Request("https://approval.example.test/api/approval", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), testEnv);
  const created = await create.json();

  await worker.fetch(webhookRequest({
    update_id: 2,
    callback_query: {
      id: "cb-1",
      from: { id: 123, username: "approver" },
      data: internals.buildCallbackData("accept", created.approval_id),
      message: { message_id: 88, chat: { id: 1026720092 } },
    },
  }), testEnv);

  return calls;
}

function forwarderSpy(calls) {
  return {
    fetch: async (request) => {
      calls.push(request.url);
      return Response.json({ ok: true });
    },
  };
}

test("ALERT_MODE=prod posts to Kalki-stocks and fans out to customers", async (t) => {
  const forwarded = [];
  const testEnv = env({
    ALERT_MODE: "prod",
    TEST_DESTINATION_CHAT_ID: "-1003377752970",
    TELEGRAM_FORWARDER: forwarderSpy(forwarded),
  });

  const calls = await acceptDirectApproval(t, testEnv, {
    text: "NVDA\nEntry: $120-122\nStop: $115\nT1: $130",
  });

  const delivery = calls.find((call) => call.method === "sendMessage" && call.body.text.startsWith("NVDA"));
  assert.equal(delivery.body.chat_id, "-1003967721534", "prod must go to Kalki-stocks");
  assert.equal(forwarded.length, 1, "prod must fan out to the customer groups");
});

test("ALERT_MODE=test overrides an explicit prod destination", async (t) => {
  const forwarded = [];
  const testEnv = env({
    ALERT_MODE: "test",
    TEST_DESTINATION_CHAT_ID: "-1003377752970",
    TELEGRAM_FORWARDER: forwarderSpy(forwarded),
  });

  const calls = await acceptDirectApproval(t, testEnv, {
    text: "NVDA\nEntry: $120-122\nStop: $115\nT1: $130",
  });

  const delivery = calls.find((call) => call.method === "sendMessage" && call.body.text.startsWith("NVDA"));
  assert.equal(delivery.body.chat_id, "-1003377752970");
  assert.equal(forwarded.length, 0);
});

test("an unrecognised ALERT_MODE falls back to test, never to customers", async (t) => {
  const forwarded = [];
  // A typo must not broadcast to paying subscribers.
  const testEnv = env({
    ALERT_MODE: "prodd",
    TEST_DESTINATION_CHAT_ID: "-1003377752970",
    TELEGRAM_FORWARDER: forwarderSpy(forwarded),
  });

  const calls = await acceptDirectApproval(t, testEnv, {
    text: "NVDA\nEntry: $120-122\nStop: $115\nT1: $130",
  });

  const delivery = calls.find((call) => call.method === "sendMessage" && call.body.text.startsWith("NVDA"));
  assert.equal(delivery.body.chat_id, "-1003377752970", "typo must stay in the test group");
  assert.equal(forwarded.length, 0);
});

test("health reports the live audience", async () => {
  const res = await worker.fetch(
    new Request("https://approval.example.test/health"),
    env({ ALERT_MODE: "test", TEST_DESTINATION_CHAT_ID: "-1003377752970" }),
  );
  const body = await res.json();

  assert.equal(body.alert_mode, "test");
  assert.match(body.audience, /test group only/);
  assert.equal(body.destination_chat_id, "-1003377752970");
  assert.equal(body.prod_destination_chat_id, "-1003967721534");
});

function modeRequest(method, body) {
  return new Request("https://approval.example.test/mode", {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("POST /mode switches the audience without a redeploy", async () => {
  // Deployed var says test; the KV override must win.
  const testEnv = env({ ALERT_MODE: "test", TEST_DESTINATION_CHAT_ID: "-1003377752970" });

  const before = await (await worker.fetch(modeRequest("GET"), testEnv)).json();
  assert.equal(before.mode, "test");

  const set = await (await worker.fetch(modeRequest("POST", { mode: "prod" }), testEnv)).json();
  assert.equal(set.ok, true);
  assert.equal(set.mode, "prod");
  assert.equal(set.destination_chat_id, "-1003967721534");

  const after = await (await worker.fetch(modeRequest("GET"), testEnv)).json();
  assert.equal(after.mode, "prod", "override must persist across requests");
  assert.match(after.audience, /all customer groups/);
});

test("POST /mode rejects anything that is not test or prod", async () => {
  const testEnv = env({ TEST_DESTINATION_CHAT_ID: "-1003377752970" });

  for (const bad of ["prodd", "", "yes", "PRODUCTION!"]) {
    const res = await (await worker.fetch(modeRequest("POST", { mode: bad }), testEnv)).json();
    assert.equal(res.ok, false, `${JSON.stringify(bad)} must be rejected`);
  }

  // A rejected value must not have changed anything.
  const now = await (await worker.fetch(modeRequest("GET"), testEnv)).json();
  assert.equal(now.mode, "test");
});

test("a stored prod mode actually fans out to customers", async (t) => {
  const forwarded = [];
  const testEnv = env({
    ALERT_MODE: "test",
    TEST_DESTINATION_CHAT_ID: "-1003377752970",
    TELEGRAM_FORWARDER: forwarderSpy(forwarded),
  });
  await worker.fetch(modeRequest("POST", { mode: "prod" }), testEnv);

  const calls = await acceptDirectApproval(t, testEnv, {
    text: "NVDA\nEntry: $120-122\nStop: $115\nT1: $130",
  });

  const delivery = calls.find((call) => call.method === "sendMessage" && call.body.text.startsWith("NVDA"));
  assert.equal(delivery.body.chat_id, "-1003967721534");
  assert.equal(forwarded.length, 1);
});

test("test mode routes accepted alerts to the test group and skips fan-out", async (t) => {
  const forwarderCalls = [];
  const testEnv = env({
    TEST_DESTINATION_CHAT_ID: "-1003377752970",
    TELEGRAM_FORWARDER: {
      fetch: async (request) => {
        forwarderCalls.push(request.url);
        return Response.json({ ok: true });
      },
    },
  });

  const calls = await acceptDirectApproval(t, testEnv, {
    text: "NVDA\nEntry: $120-122\nStop: $115\nT1: $130",
  });

  const delivery = calls.find((call) => call.method === "sendMessage" && call.body.text.startsWith("NVDA"));
  assert.equal(delivery.body.chat_id, "-1003377752970", "must go to the test group, not Kalki-stocks");
  assert.equal(forwarderCalls.length, 0, "fan-out to customer groups must be skipped in test mode");
});

test("TP/SL replies do not create a new tracked position", async (t) => {
  const calls = await acceptDirectApproval(t, env(), {
    text: "TP1 HIT NVDA",
    replyToMessageId: 777,
  });

  assert.equal(calls.some((call) => call.method === "ingest"), false);
});

test("a failing ingestion does not break the accepted alert", async (t) => {
  const testEnv = env({
    INGESTION: {
      fetch: async () => Response.json({ ok: false, error: "D1 unavailable" }, { status: 500 }),
    },
  });

  const calls = await acceptDirectApproval(t, testEnv, {
    text: "NVDA\nEntry: $120-122\nStop: $115\nT1: $130",
  });

  // The alert still lands and the approval still resolves — a tracking failure
  // must never escalate into a non-2xx that Telegram would retry.
  assert.ok(calls.some((call) => call.method === "sendMessage" && call.body.text.startsWith("NVDA")));
  assert.ok(calls.some((call) => call.method === "answerCallbackQuery"));
});

test("direct approval endpoint sends accept reject message", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({
      ok: true,
      result: {
        message_id: 99,
        chat: { id: 1026720092 },
      },
    });
  });

  const response = await worker.fetch(new Request("https://approval.example.test/api/approval", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "SOXS\nEntry: $10\nStop: $9\nT1: $12",
      sourceMessageId: "soxs-test",
    }),
  }), env());
  const data = await response.json();

  assert.equal(data.ok, true);
  assert.equal(data.status, "pending");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendMessage$/);
  assert.equal(calls[0].body.chat_id, "1026720092");
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].text, "Accept");
});

test("accept callback can reply to original Kalki-stocks message", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    return Response.json({
      ok: true,
      result: method === "sendMessage"
        ? { message_id: calls.length, chat: { id: body.chat_id } }
        : true,
    });
  });

  const testEnv = env();
  const create = await worker.fetch(new Request("https://approval.example.test/api/approval", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "TSLA TP1 HIT",
      sourceMessageId: "tsla-tp1",
      reply_to_message_id: 777,
    }),
  }), testEnv);
  const created = await create.json();

  await worker.fetch(webhookRequest({
    update_id: 4,
    callback_query: {
      id: "cb-reply",
      from: { id: 123, username: "approver" },
      data: internals.buildCallbackData("accept", created.approval_id),
    },
  }), testEnv);

  const downstream = calls.find((call) => call.method === "sendMessage" && call.body.chat_id === "-1003967721534");
  assert.equal(downstream.body.reply_to_message_id, 777);
  assert.equal(downstream.body.allow_sending_without_reply, true);
});

test("reject callback does not send to Kalki-stocks", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    return Response.json({
      ok: true,
      result: method === "sendMessage"
        ? { message_id: calls.length, chat: { id: body.chat_id } }
        : true,
    });
  });

  const testEnv = env();
  const create = await worker.fetch(webhookRequest({
    update_id: 1,
    message: {
      message_id: 55,
      chat: { id: 1026720092 },
      text: "MSFT\nEntry: $410\nStop: $400\nT1: $430",
    },
  }), testEnv);
  const created = await create.json();

  const reject = await worker.fetch(webhookRequest({
    update_id: 2,
    callback_query: {
      id: "cb-3",
      from: { id: 123 },
      data: internals.buildCallbackData("reject", created.approval_id),
    },
  }), testEnv);
  const rejected = await reject.json();

  assert.equal(rejected.ok, true);
  assert.equal(rejected.status, "rejected");
  assert.equal(calls.some((call) => call.method === "sendMessage" && call.body.chat_id === "-1003967721534"), false);
});
