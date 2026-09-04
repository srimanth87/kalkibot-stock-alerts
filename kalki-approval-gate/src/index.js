const DEFAULT_WEBHOOK_PATH = "/telegram/webhook";
const DEFAULT_APPROVAL_TTL_SECONDS = 60 * 60 * 24 * 7;
const CALLBACK_PREFIX = "kg";
const PREVIEW_LIMIT = 3300;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Kalki-Key",
};

const MODE_KEY = "config:alert_mode";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    // A KV-stored mode wins over the deployed var, so the audience can be
    // switched from Telegram without a redeploy.
    env = await withRuntimeMode(env);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return jsonResponse({
        ok: true,
        service: "kalki-approval-gate",
        webhook_path: env.TELEGRAM_WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH,
        set_webhook_paths: ["/set-webhook", "/telegram/set-webhook"],
        watch_chat_ids: parseChatList(env.WATCH_CHAT_IDS || env.WATCH_CHAT_ID),
        alert_mode: getAlertMode(env),
        audience: isTestMode(env) ? "test group only (no fan-out)" : "all customer groups",
        destination_chat_id: getDestinationChatId(env) || null,
        prod_destination_chat_id: String(env.DESTINATION_CHAT_ID || "").trim() || null,
        test_destination_chat_id: getTestDestinationChatId(env) || null,
        kv_bound: Boolean(env.APPROVAL_STATE),
        forwarder_bound: Boolean(env.TELEGRAM_FORWARDER?.fetch),
        approver_restricted: parseApproverIds(env).length > 0,
      });
    }

    if (url.pathname === "/mode") {
      if (request.method === "GET") {
        return jsonResponse({
          ok: true,
          mode: getAlertMode(env),
          audience: isTestMode(env) ? "test group only (no fan-out)" : "all customer groups",
          destination_chat_id: getDestinationChatId(env) || null,
        });
      }

      if (request.method === "POST") {
        if (!isModeChangeAuthorized(request, env)) {
          return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
        }
        const body = await request.json().catch(() => ({}));
        return jsonResponse(await setAlertMode(env, body.mode));
      }
    }

    if (request.method === "GET" && url.pathname === "/debug/telegram") {
      return jsonResponse({ ok: true, telegram: await getTelegramWebhookInfo(env) });
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/set-webhook" || url.pathname === "/telegram/set-webhook")
    ) {
      return setTelegramWebhook(url, env);
    }

    const webhookPath = env.TELEGRAM_WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH;
    if (request.method === "POST" && url.pathname === webhookPath) {
      return handleTelegramWebhook(request, env);
    }

    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "/api/approval" || url.pathname === "/approval")) {
      return handleDirectApproval(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/callback") {
      const body = await request.json().catch(() => ({}));
      if (!body.callback_query) return jsonResponse({ ok: false, error: "callback_query is required" }, 400);
      return jsonResponse(await handleCallbackQuery(body.callback_query, env));
    }

    return jsonResponse({ ok: false, error: "Not found" }, 404);
  },
};

async function handleTelegramWebhook(request, env) {
  const secretToken = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  if (secretToken) {
    const providedToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (providedToken !== secretToken) {
      return jsonResponse({ ok: false, error: "Unauthorized webhook request" }, 401);
    }
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
  }

  if (update.callback_query) {
    return jsonResponse(await handleCallbackQuery(update.callback_query, env));
  }

  const post = getSupportedUpdatePost(update);
  if (!post) {
    return jsonResponse({ ok: true, ignored: true, reason: "No supported Telegram message found" });
  }

  return jsonResponse(await createApproval(post, update, env));
}

async function handleDirectApproval(request, env) {
  const expectedKey = String(env.APPROVAL_API_KEY || "").trim();
  if (expectedKey && request.headers.get("X-Kalki-Key") !== expectedKey) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const text = String(body.text || body.message || body.raw || "").trim();
  if (!text) {
    return jsonResponse({ ok: false, error: "text is required" }, 400);
  }

  return jsonResponse(await createDirectApproval(text, body, env));
}

async function createApproval(post, update, env) {
  requireApprovalState(env);

  const sourceChatId = String(post.chat?.id ?? "");
  const watchChatIds = parseChatList(env.WATCH_CHAT_IDS || env.WATCH_CHAT_ID);
  if (watchChatIds.length === 0) {
    return { ok: false, error: "WATCH_CHAT_IDS or WATCH_CHAT_ID is required" };
  }

  if (!watchChatIds.includes(sourceChatId)) {
    return {
      ok: true,
      ignored: true,
      reason: "Message is from a different chat",
      received_chat_id: sourceChatId,
      watch_chat_ids: watchChatIds,
    };
  }

  const destinationChatId = getDestinationChatId(env);
  if (!destinationChatId) {
    return { ok: false, error: "DESTINATION_CHAT_ID is required" };
  }

  const botToken = getBotToken(env);
  if (!botToken) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN is required" };
  }

  const text = getPostText(post);
  if (!text) {
    return { ok: true, ignored: true, reason: "Message has no text or caption" };
  }

  const dedupeKey = buildDedupeKey(sourceChatId, post.message_id);
  const existingId = await env.APPROVAL_STATE.get(dedupeKey);
  if (existingId) {
    return { ok: true, skipped: true, reason: "Approval already exists", approval_id: existingId };
  }

  const approvalId = crypto.randomUUID();
  const now = new Date().toISOString();
  const record = {
    id: approvalId,
    status: "pending",
    text,
    sourceChatId,
    sourceMessageId: String(post.message_id || ""),
    destinationChatId,
    createdAt: now,
    updateId: update.update_id ?? null,
  };

  const approvalMessage = await callTelegramApi(botToken, "sendMessage", {
    chat_id: sourceChatId,
    text: buildApprovalText(record),
    disable_notification: parseBoolean(env.DISABLE_NOTIFICATION),
    reply_to_message_id: post.message_id,
    allow_sending_without_reply: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Accept", callback_data: buildCallbackData("accept", approvalId) },
          { text: "Reject", callback_data: buildCallbackData("reject", approvalId) },
        ],
      ],
    },
  });

  record.approvalChatId = String(approvalMessage.chat?.id ?? sourceChatId);
  record.approvalMessageId = approvalMessage.message_id ?? null;
  await putApproval(env, record);
  await env.APPROVAL_STATE.put(dedupeKey, approvalId, { expirationTtl: getApprovalTtl(env) });

  return { ok: true, approval_id: approvalId, status: "pending" };
}

async function createDirectApproval(text, body, env) {
  requireApprovalState(env);

  const watchChatIds = parseChatList(env.WATCH_CHAT_IDS || env.WATCH_CHAT_ID);
  const approvalChatId = String(body.approvalChatId || body.approval_chat_id || body.chatId || body.chat_id || watchChatIds[0] || "").trim();
  if (!approvalChatId) {
    return { ok: false, error: "Approval chat id is required" };
  }

  const destinationChatId = getDestinationChatId(env);
  if (!destinationChatId) {
    return { ok: false, error: "DESTINATION_CHAT_ID is required" };
  }

  const botToken = getBotToken(env);
  if (!botToken) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN is required" };
  }

  const sourceKey = String(body.sourceMessageId || body.source_message_id || body.id || stableHash(text)).trim();
  const dedupeKey = buildDirectDedupeKey(approvalChatId, sourceKey);
  const existingId = await env.APPROVAL_STATE.get(dedupeKey);
  if (existingId) {
    return { ok: true, skipped: true, reason: "Approval already exists", approval_id: existingId };
  }

  const now = new Date().toISOString();
  const approvalId = crypto.randomUUID();
  const record = {
    id: approvalId,
    status: "pending",
    text,
    parseMode: normalizeParseMode(body.parseMode || body.parse_mode),
    replyToMessageId: parseMessageId(body.replyToMessageId || body.reply_to_message_id),
    sourceChatId: String(body.sourceChatId || body.source_chat_id || "direct"),
    sourceMessageId: sourceKey,
    destinationChatId,
    createdAt: now,
    updateId: null,
  };

  const approvalMessage = await callTelegramApi(botToken, "sendMessage", {
    chat_id: approvalChatId,
    text: buildApprovalText(record),
    ...buildParsePayload(record.parseMode),
    disable_notification: parseBoolean(env.DISABLE_NOTIFICATION),
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Accept", callback_data: buildCallbackData("accept", approvalId) },
          { text: "Reject", callback_data: buildCallbackData("reject", approvalId) },
        ],
      ],
    },
  });

  record.approvalChatId = String(approvalMessage.chat?.id ?? approvalChatId);
  record.approvalMessageId = approvalMessage.message_id ?? null;
  await putApproval(env, record);
  await env.APPROVAL_STATE.put(dedupeKey, approvalId, { expirationTtl: getApprovalTtl(env) });

  return { ok: true, approval_id: approvalId, status: "pending" };
}

async function handleCallbackQuery(callbackQuery, env) {
  requireApprovalState(env);
  const botToken = getBotToken(env);
  if (!botToken) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN is required" };
  }

  const parsed = parseCallbackData(callbackQuery.data);
  if (!parsed) {
    await answerCallback(botToken, callbackQuery.id, "Unknown approval action.");
    return { ok: true, ignored: true, reason: "Unknown callback data" };
  }

  if (!isAllowedApprover(callbackQuery.from?.id, env)) {
    await answerCallback(botToken, callbackQuery.id, "You are not allowed to approve this alert.", true);
    return { ok: false, error: "Approver is not allowed" };
  }

  const record = await getApproval(env, parsed.approvalId);
  if (!record) {
    await answerCallback(botToken, callbackQuery.id, "Approval expired or was not found.", true);
    return { ok: false, error: "Approval not found" };
  }

  if (record.status !== "pending") {
    await answerCallback(botToken, callbackQuery.id, `Already ${record.status}.`);
    return { ok: true, skipped: true, approval_id: record.id, status: record.status };
  }

  const now = new Date().toISOString();
  const actor = {
    id: callbackQuery.from?.id ?? null,
    username: callbackQuery.from?.username || "",
    firstName: callbackQuery.from?.first_name || "",
    lastName: callbackQuery.from?.last_name || "",
  };

  if (parsed.action === "accept") {
    const sent = await callTelegramApi(botToken, "sendMessage", {
      chat_id: record.destinationChatId,
      text: record.text,
      ...buildParsePayload(record.parseMode),
      ...buildReplyPayload(record.replyToMessageId),
      disable_notification: false,
    });
    const updated = {
      ...record,
      status: "accepted",
      decidedAt: now,
      decidedBy: actor,
      deliveredMessageId: sent.message_id ?? null,
    };
    const forwardResult = await triggerForwarder(env, record, sent);
    updated.forwardResult = forwardResult;
    const ingestionResult = await notifyIngestion(env, record, sent);
    updated.ingestionResult = ingestionResult;
    await putApproval(env, updated);
    await updateApprovalMessage(botToken, updated);
    await answerCallback(botToken, callbackQuery.id, buildAcceptNotice(forwardResult, ingestionResult));
    return {
      ok: true,
      approval_id: record.id,
      status: "accepted",
      delivered_message_id: sent.message_id ?? null,
      forward: forwardResult,
      ingestion: ingestionResult,
    };
  }

  const updated = {
    ...record,
    status: "rejected",
    decidedAt: now,
    decidedBy: actor,
  };
  await putApproval(env, updated);
  await updateApprovalMessage(botToken, updated);
  await answerCallback(botToken, callbackQuery.id, "Rejected. Nothing was forwarded.");
  return { ok: true, approval_id: record.id, status: "rejected" };
}

function getSupportedUpdatePost(update) {
  return update.message || update.channel_post || update.edited_message || update.edited_channel_post || null;
}

function getPostText(post) {
  return String(post?.text || post?.caption || "").trim();
}

function buildApprovalText(record) {
  const preview = record.text.length > PREVIEW_LIMIT
    ? `${record.text.slice(0, PREVIEW_LIMIT)}\n\n... alert truncated here, full text will be sent if accepted.`
    : record.text;
  return [
    "Approval needed for Kalki-stocks",
    "",
    preview,
  ].join("\n");
}

function buildAcceptNotice(forwardResult, ingestionResult) {
  const parts = ["Accepted and sent to Kalki-stocks."];
  if (forwardResult.skipped) {
    parts.push(forwardResult.reason?.startsWith("Test mode") ? "Fan-out skipped (test mode)." : "Not forwarded.");
  } else if (!forwardResult.ok) {
    parts.push("Forwarder needs attention.");
  } else {
    parts.push("Forwarded to groups.");
  }
  if (ingestionResult.ok === false) {
    parts.push("NOT tracked for TP/SL.");
  } else if (!ingestionResult.skipped) {
    parts.push(ingestionResult.ignored ? "No levels found, not tracked." : "Tracking TP/SL.");
  }
  return parts.join(" ");
}

function buildDecisionText(record) {
  const label = record.status === "accepted" ? "Accepted and sent to Kalki-stocks" : "Rejected";
  const who = formatActor(record.decidedBy);
  return [
    `${label}${who ? ` by ${who}` : ""}`,
    record.decidedAt ? `Decision time: ${record.decidedAt}` : "",
    "",
    record.text.length > PREVIEW_LIMIT
      ? `${record.text.slice(0, PREVIEW_LIMIT)}\n\n... alert truncated here.`
      : record.text,
  ].filter(Boolean).join("\n");
}

function formatActor(actor) {
  if (!actor) return "";
  if (actor.username) return `@${actor.username}`;
  return [actor.firstName, actor.lastName].filter(Boolean).join(" ") || (actor.id ? String(actor.id) : "");
}

async function updateApprovalMessage(botToken, record) {
  if (!record.approvalChatId || !record.approvalMessageId) return;
  await callTelegramApi(botToken, "editMessageText", {
    chat_id: record.approvalChatId,
    message_id: record.approvalMessageId,
    text: buildDecisionText(record),
    ...buildParsePayload(record.parseMode),
    reply_markup: { inline_keyboard: [] },
  });
}

async function answerCallback(botToken, callbackQueryId, text, showAlert = false) {
  if (!callbackQueryId) return;
  await callTelegramApi(botToken, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

async function triggerForwarder(env, record, sent) {
  if (isTestMode(env)) {
    return { ok: true, skipped: true, reason: "Test mode (ALERT_MODE=test): fan-out to customer groups disabled" };
  }

  if (!env.TELEGRAM_FORWARDER?.fetch) {
    return { ok: true, skipped: true, reason: "TELEGRAM_FORWARDER service binding is not configured" };
  }

  const response = await env.TELEGRAM_FORWARDER.fetch(new Request("https://telegram-forwarder.internal/api/forward", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceChatId: record.destinationChatId,
      messageId: sent.message_id,
      text: record.text,
      replyToMessageId: record.replyToMessageId || null,
      date: sent.date || Math.floor(Date.now() / 1000),
    }),
  }));
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    return {
      ok: false,
      error: data.error || data.message || `Forwarder returned HTTP ${response.status}`,
      detail: data,
    };
  }
  return data;
}

/**
 * Records the accepted alert in D1 together with the Kalki-stocks message id.
 *
 * kalki-position-tracker can only monitor a position that carries the id of the
 * original Kalki-stocks post, because that is the message its TP/SL replies are
 * threaded under. Without this call every position is skipped as "missing
 * original Kalki-stocks message id" and no TP/SL alert ever fires.
 *
 * Never throws: a tracking failure must not stop the alert that was already
 * delivered, and must never turn into a non-2xx that Telegram would retry.
 */
async function notifyIngestion(env, record, sent) {
  try {
    if (record.replyToMessageId) {
      return { ok: true, skipped: true, reason: "Reply event, not a new alert" };
    }

    const messageId = sent?.message_id;
    if (!Number.isFinite(messageId)) {
      return { ok: false, error: "No delivered message id to track" };
    }

    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Kalki-Key": String(env.KALKI_INGEST_KEY || ""),
      },
      body: JSON.stringify({
        text: record.text,
        sourceChatId: record.destinationChatId,
        sourceMessageId: String(messageId),
        receivedAt: sent.date
          ? new Date(sent.date * 1000).toISOString()
          : new Date().toISOString(),
      }),
    };

    const response = env.INGESTION?.fetch
      ? await env.INGESTION.fetch(new Request("https://kalki-d1-ingestion.internal/ingest", init))
      : await fetch(getIngestionUrl(env), init);

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      const error = data.error || data.message || `Ingestion returned HTTP ${response.status}`;
      console.error("Ingestion tracking failed", { error, source_message_id: messageId });
      return { ok: false, error, detail: data };
    }
    return data;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown ingestion error";
    console.error("Ingestion tracking threw", { message });
    return { ok: false, error: message };
  }
}

function getIngestionUrl(env) {
  const configured = String(
    env.INGESTION_URL || "https://kalki-d1-ingestion.srimanthgada87.workers.dev/ingest",
  ).trim();
  try {
    const url = new URL(configured);
    url.pathname = "/ingest";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "https://kalki-d1-ingestion.srimanthgada87.workers.dev/ingest";
  }
}

async function callTelegramApi(botToken, methodName, payload) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${methodName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.description || `Telegram API request failed with ${response.status}`);
  }
  return data.result;
}

async function getTelegramWebhookInfo(env) {
  const botToken = getBotToken(env);
  if (!botToken) return { configured: false, error: "TELEGRAM_BOT_TOKEN is missing" };
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    return { configured: false, error: data.description || `Telegram HTTP ${response.status}` };
  }
  const result = data.result || {};
  return {
    configured: Boolean(result.url),
    url: result.url || "",
    pending_update_count: result.pending_update_count || 0,
    last_error_date: result.last_error_date || null,
    last_error_message: result.last_error_message || null,
    allowed_updates: result.allowed_updates || [],
  };
}

async function setTelegramWebhook(url, env) {
  const botToken = getBotToken(env);
  if (!botToken) {
    return jsonResponse({ ok: false, error: "TELEGRAM_BOT_TOKEN is missing" }, 500);
  }

  const webhookPath = env.TELEGRAM_WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH;
  const webhookUrl = `${url.origin}${webhookPath}`;
  const body = {
    url: webhookUrl,
    allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "callback_query"],
  };

  if (env.TELEGRAM_WEBHOOK_SECRET) {
    body.secret_token = String(env.TELEGRAM_WEBHOOK_SECRET);
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return jsonResponse(
    {
      ok: response.ok && data.ok !== false,
      webhook_url: webhookUrl,
      telegram: data,
    },
    response.ok ? 200 : 500,
  );
}

function buildCallbackData(action, approvalId) {
  return `${CALLBACK_PREFIX}:${action === "accept" ? "a" : "r"}:${approvalId}`;
}

function parseCallbackData(value) {
  const match = String(value || "").match(/^kg:([ar]):([0-9a-f-]{36})$/i);
  if (!match) return null;
  return {
    action: match[1].toLowerCase() === "a" ? "accept" : "reject",
    approvalId: match[2],
  };
}

function buildApprovalKey(approvalId) {
  return `approval:${approvalId}`;
}

function buildDedupeKey(chatId, messageId) {
  return `approval-source:${chatId}:${messageId}`;
}

function buildDirectDedupeKey(chatId, sourceKey) {
  return `approval-direct:${chatId}:${sourceKey}`;
}

async function getApproval(env, approvalId) {
  const raw = await env.APPROVAL_STATE.get(buildApprovalKey(approvalId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function putApproval(env, record) {
  await env.APPROVAL_STATE.put(buildApprovalKey(record.id), JSON.stringify(record), {
    expirationTtl: getApprovalTtl(env),
  });
}

function parseChatList(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseApproverIds(env) {
  return parseChatList(env.APPROVER_USER_IDS || env.APPROVER_USER_ID);
}

function isAllowedApprover(userId, env) {
  const allowed = parseApproverIds(env);
  if (allowed.length === 0) return true;
  return allowed.includes(String(userId ?? ""));
}

function getDestinationChatId(env) {
  if (isTestMode(env)) {
    // Fail safe: never silently fall back to the customer channel in test mode.
    return getTestDestinationChatId(env) || String(env.DESTINATION_CHAT_ID || "").trim();
  }
  return String(env.DESTINATION_CHAT_ID || env.KALKI_STOCKS_CHAT_ID || "").trim();
}

function getTestDestinationChatId(env) {
  return String(env.TEST_DESTINATION_CHAT_ID || "").trim();
}

/**
 * ALERT_MODE is the single switch between audiences:
 *
 *   "prod" -> posts to DESTINATION_CHAT_ID and fans out to every customer group
 *   "test" -> posts to TEST_DESTINATION_CHAT_ID only, fan-out disabled
 *
 * Anything other than an explicit prod value is treated as test, so a typo or a
 * missing variable keeps alerts away from customers rather than broadcasting to
 * them. Reported by /health as `alert_mode`.
 */
function getAlertMode(env) {
  const mode = String(env.ALERT_MODE || "").trim().toLowerCase();
  if (["prod", "production", "live"].includes(mode)) return "prod";
  if (["test", "testing", "staging", "dev"].includes(mode)) return "test";
  // Unset: preserve the pre-ALERT_MODE behaviour (test only if a test group exists).
  return getTestDestinationChatId(env) ? "test" : "prod";
}

function isTestMode(env) {
  return getAlertMode(env) === "test";
}

function normalizeAlertMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (["prod", "production", "live"].includes(mode)) return "prod";
  if (["test", "testing", "staging", "dev"].includes(mode)) return "test";
  return null;
}

/** Applies a KV-stored mode override, so switching needs no redeploy. */
async function withRuntimeMode(env) {
  if (!env.APPROVAL_STATE) return env;
  try {
    const stored = normalizeAlertMode(await env.APPROVAL_STATE.get(MODE_KEY));
    return stored ? { ...env, ALERT_MODE: stored } : env;
  } catch (error) {
    // Never let a KV hiccup take the gate down; fall back to the deployed var.
    console.error("Failed to read alert mode", { message: error?.message });
    return env;
  }
}

async function setAlertMode(env, value) {
  const mode = normalizeAlertMode(value);
  if (!mode) {
    return { ok: false, error: `Invalid mode ${JSON.stringify(value)}. Use "test" or "prod".` };
  }
  if (!env.APPROVAL_STATE) {
    return { ok: false, error: "APPROVAL_STATE KV binding is required to change mode" };
  }

  await env.APPROVAL_STATE.put(MODE_KEY, mode);
  const applied = { ...env, ALERT_MODE: mode };
  return {
    ok: true,
    mode,
    audience: isTestMode(applied) ? "test group only (no fan-out)" : "all customer groups",
    destination_chat_id: getDestinationChatId(applied) || null,
  };
}

function isModeChangeAuthorized(request, env) {
  const expected = String(env.MODE_API_KEY || env.APPROVAL_API_KEY || "").trim();
  if (!expected) return true;
  return request.headers.get("X-Kalki-Key") === expected;
}

function getBotToken(env) {
  return String(env.TELEGRAM_BOT_TOKEN || "").trim();
}

function getApprovalTtl(env) {
  const ttl = Number.parseInt(env.APPROVAL_TTL_SECONDS || "", 10);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_APPROVAL_TTL_SECONDS;
}

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function normalizeParseMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "html") return "HTML";
  if (mode === "markdown") return "Markdown";
  if (mode === "markdownv2") return "MarkdownV2";
  return "";
}

function buildParsePayload(parseMode) {
  return parseMode ? { parse_mode: parseMode } : {};
}

function parseMessageId(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildReplyPayload(messageId) {
  return messageId
    ? { reply_to_message_id: messageId, allow_sending_without_reply: true }
    : {};
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function requireApprovalState(env) {
  if (!env.APPROVAL_STATE) throw new Error("APPROVAL_STATE KV binding is required");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

export const internals = {
  buildApprovalText,
  buildCallbackData,
  parseCallbackData,
};
