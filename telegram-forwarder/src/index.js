const DEFAULT_WEBHOOK_PATH = "/telegram/webhook";
const DEFAULT_DEDUPE_TTL_SECONDS = 60 * 60 * 24 * 7;
const DEFAULT_MESSAGE_MAP_TTL_SECONDS = 60 * 60 * 24 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      const hasForwardState = Boolean(env.FORWARD_STATE);
      return jsonResponse({
        ok: true,
        service: "telegram-channel-forwarder",
        webhook_path: env.TELEGRAM_WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH,
        set_webhook_paths: ["/set-webhook", "/telegram/set-webhook"],
        source_chat_id: getSourceChatId(env) || null,
        source_chat_ids: getSourceChatIds(env),
        target_count: parseChatList(env.TARGET_CHANNEL_IDS).length,
        forward_mode: normalizeForwardMode(env.FORWARD_MODE),
        d1_ingestion: "separate-worker",
        ingest_enabled: isIngestEnabled(env),
        ingest_url: getIngestUrl(env) || null,
        dedupe_enabled: hasForwardState,
        reply_threading_enabled: hasForwardState,
        warnings: hasForwardState
          ? []
          : [
              "FORWARD_STATE KV binding is missing. Messages will copy, but reply threading and safe per-target retries are disabled.",
            ],
      });
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

    return jsonResponse(
      {
        ok: false,
        error: "Not found",
      },
      404,
    );
  },
};

async function handleTelegramWebhook(request, env) {
  const secretToken = env.TELEGRAM_WEBHOOK_SECRET;
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

  const post = getSupportedUpdatePost(update, env);

  if (update.callback_query) {
    return handleApprovalCallback(update.callback_query, env);
  }

  if (!post) {
    return jsonResponse({
      ok: true,
      ignored: true,
      reason: "Update does not contain a supported message or channel post",
    });
  }

  const sourceChatId = String(post.chat?.id ?? "");
  const sourceChatIds = getSourceChatIds(env);
  if (sourceChatIds.length === 0) {
    return jsonResponse({ ok: false, error: "SOURCE_CHAT_IDS, SOURCE_CHAT_ID, or SOURCE_CHANNEL_ID is required" }, 500);
  }

  if (!sourceChatIds.includes(sourceChatId)) {
    return jsonResponse({
      ok: true,
      ignored: true,
      reason: "Message is from a different source chat",
      received_chat_id: sourceChatId,
      source_chat_ids: sourceChatIds,
    });
  }

  const targetChannelIds = parseChatList(env.TARGET_CHANNEL_IDS).filter(
    (channelId) => channelId !== sourceChatId,
  );

  if (targetChannelIds.length === 0) {
    return jsonResponse({ ok: false, error: "TARGET_CHANNEL_IDS is required" }, 500);
  }

  const botToken = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!botToken) {
    return jsonResponse({ ok: false, error: "TELEGRAM_BOT_TOKEN is required" }, 500);
  }

  const ingestResult = await ingestPost(env, post, sourceChatId);
  const forwardMode = normalizeForwardMode(env.FORWARD_MODE);
  const basePayload = {
    from_chat_id: sourceChatId,
    message_id: post.message_id,
    disable_notification: parseBoolean(env.DISABLE_NOTIFICATION),
    protect_content: parseBoolean(env.PROTECT_CONTENT),
  };

  const successes = [];
  const failures = [];

  for (const targetChannelId of targetChannelIds) {
    try {
      const dedupeKey = buildDedupeKey(post, targetChannelId);
      if (await hasAlreadyForwarded(env, dedupeKey)) {
        successes.push({
          target_channel_id: targetChannelId,
          skipped: true,
          reason: "Already forwarded",
        });
        continue;
      }

      const methodName = forwardMode === "forward" ? "forwardMessage" : "copyMessage";
      const replyPayload = await buildReplyPayload(env, post, targetChannelId);
      const result = await callTelegramApi(botToken, methodName, {
        ...basePayload,
        chat_id: targetChannelId,
        ...replyPayload,
      });

      await markForwarded(env, dedupeKey);
      await rememberMessageMapping(env, post, targetChannelId, result);
      successes.push({
        target_channel_id: targetChannelId,
        skipped: false,
        telegram_result: result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown forwarding error";
      console.error("Forwarding failed", {
        source_chat_id: sourceChatId,
        target_channel_id: targetChannelId,
        message_id: post.message_id,
        error: message,
      });
      failures.push({
        target_channel_id: targetChannelId,
        error: message,
      });
    }
  }

  if (failures.length === 0) {
    return jsonResponse({
      ok: true,
      forwarded_count: successes.length,
      failed_count: 0,
      ingest: ingestResult,
      results: successes,
    });
  }

  if (env.FORWARD_STATE) {
    return jsonResponse(
      {
        ok: false,
        error: "Some target channel deliveries failed and will be retried by Telegram",
        forwarded_count: successes.length,
        failed_count: failures.length,
        ingest: ingestResult,
        results: successes,
        failures,
      },
      500,
    );
  }

  return jsonResponse({
    ok: true,
    warning:
      "Some target deliveries failed. Configure a KV binding named FORWARD_STATE if you want safe per-target retries.",
    forwarded_count: successes.length,
    failed_count: failures.length,
    ingest: ingestResult,
    results: successes,
    failures,
  });
}

async function handleApprovalCallback(callbackQuery, env) {
  const data = String(callbackQuery?.data || "");
  if (!data.startsWith("kg:")) {
    return jsonResponse({ ok: true, ignored: true, reason: "Unknown callback data" });
  }

  if (!env.APPROVAL_GATE?.fetch) {
    return jsonResponse({ ok: false, error: "APPROVAL_GATE service binding is required for approval callbacks" }, 500);
  }

  const response = await env.APPROVAL_GATE.fetch(new Request("https://approval-gate.internal/api/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query: callbackQuery }),
  }));
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") || "application/json; charset=utf-8" },
  });
}

function parseChatList(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getSourceChatId(env) {
  return String(env.SOURCE_CHAT_ID || env.SOURCE_CHANNEL_ID || "").trim();
}

function getSourceChatIds(env) {
  const explicitList = parseChatList(env.SOURCE_CHAT_IDS);
  if (explicitList.length > 0) {
    return explicitList;
  }

  const singleSource = getSourceChatId(env);
  return singleSource ? [singleSource] : [];
}

function getSupportedUpdatePost(update, env) {
  const allowEdits = parseBoolean(env.FORWARD_EDITED_POSTS);
  return (
    update.message ||
    (allowEdits ? update.edited_message : null) ||
    update.channel_post ||
    (allowEdits ? update.edited_channel_post : null)
  );
}

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function getIngestUrl(env) {
  return String(env.INGEST_URL || env.D1_INGEST_URL || "").trim().replace(/\/+$/, "");
}

function getIngestKey(env) {
  return String(env.INGEST_KEY || env.KALKI_INGEST_KEY || env.REPORT_SYNC_KEY || "").trim();
}

function isIngestEnabled(env) {
  if (String(env.INGEST_ENABLED || "").trim()) {
    return parseBoolean(env.INGEST_ENABLED);
  }
  return Boolean(getIngestUrl(env) && getIngestKey(env));
}

function getPostText(post) {
  return String(post?.text || post?.caption || "").trim();
}

function messageDateToIso(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

async function ingestPost(env, post, sourceChatId) {
  if (!isIngestEnabled(env)) {
    return { ok: true, skipped: true, reason: "Ingestion is not configured" };
  }

  const text = getPostText(post);
  if (!text) {
    return { ok: true, skipped: true, reason: "Telegram post has no text or caption" };
  }

  const baseUrl = getIngestUrl(env);
  const key = getIngestKey(env);
  try {
    const response = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Kalki-Key": key,
      },
      body: JSON.stringify({
        text,
        sourceChatId,
        sourceMessageId: String(post.message_id || ""),
        receivedAt: messageDateToIso(post.date),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || data.message || `Ingest failed with HTTP ${response.status}`);
    }
    return data;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown ingestion error";
    console.error("D1 ingestion call failed", {
      source_chat_id: sourceChatId,
      message_id: post.message_id,
      error: message,
    });
    return { ok: false, error: message };
  }
}

function normalizeForwardMode(value) {
  return String(value || "copy").trim().toLowerCase() === "forward" ? "forward" : "copy";
}

async function callTelegramApi(botToken, methodName, payload) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${methodName}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    const description = data?.description || `Telegram API request failed with ${response.status}`;
    throw new Error(description);
  }

  return data.result;
}

async function getTelegramWebhookInfo(env) {
  const botToken = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!botToken) return { configured: false, error: "TELEGRAM_BOT_TOKEN is missing" };
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) return { configured: false, error: data.description || `Telegram HTTP ${response.status}` };
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
  const botToken = String(env.TELEGRAM_BOT_TOKEN || "").trim();
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
    body.secret_token = env.TELEGRAM_WEBHOOK_SECRET;
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function buildDedupeKey(post, targetChannelId) {
  return `delivery:${post.chat.id}:${post.message_id}:${targetChannelId}`;
}

function buildMessageMapKey(sourceChatId, sourceMessageId, targetChatId) {
  return `map:${sourceChatId}:${sourceMessageId}:${targetChatId}`;
}

function extractTelegramMessageId(result) {
  if (Number.isFinite(result?.message_id)) {
    return result.message_id;
  }
  return Number.isFinite(result?.message_id?.message_id) ? result.message_id.message_id : null;
}

async function buildReplyPayload(env, post, targetChatId) {
  const sourceReplyId = post.reply_to_message?.message_id;
  if (!sourceReplyId) {
    return {};
  }

  const targetReplyId = await getMappedTargetMessageId(env, String(post.chat?.id ?? ""), sourceReplyId, targetChatId);
  if (!targetReplyId) {
    return {};
  }

  return {
    reply_to_message_id: targetReplyId,
    allow_sending_without_reply: true,
  };
}

async function hasAlreadyForwarded(env, dedupeKey) {
  if (!env.FORWARD_STATE) {
    return false;
  }

  return (await env.FORWARD_STATE.get(dedupeKey)) === "1";
}

async function markForwarded(env, dedupeKey) {
  if (!env.FORWARD_STATE) {
    return;
  }

  const expirationTtl = Number.parseInt(env.DEDUPE_TTL_SECONDS || "", 10);
  await env.FORWARD_STATE.put(dedupeKey, "1", {
    expirationTtl: Number.isFinite(expirationTtl)
      ? expirationTtl
      : DEFAULT_DEDUPE_TTL_SECONDS,
  });
}

async function rememberMessageMapping(env, post, targetChatId, telegramResult) {
  if (!env.FORWARD_STATE) {
    return;
  }

  const targetMessageId = extractTelegramMessageId(telegramResult);
  if (!targetMessageId) {
    return;
  }

  const mappingTtl = Number.parseInt(env.MESSAGE_MAP_TTL_SECONDS || "", 10);
  await env.FORWARD_STATE.put(
    buildMessageMapKey(String(post.chat?.id ?? ""), post.message_id, targetChatId),
    String(targetMessageId),
    {
      expirationTtl: Number.isFinite(mappingTtl) ? mappingTtl : DEFAULT_MESSAGE_MAP_TTL_SECONDS,
    },
  );
}

async function getMappedTargetMessageId(env, sourceChatId, sourceMessageId, targetChatId) {
  if (!env.FORWARD_STATE) {
    return null;
  }

  const value = await env.FORWARD_STATE.get(
    buildMessageMapKey(sourceChatId, sourceMessageId, targetChatId),
  );
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}
