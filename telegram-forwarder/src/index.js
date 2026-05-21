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
        report_sync_enabled: isReportSyncEnabled(env),
        report_sync_url: getReportSyncUrl(env) || null,
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

  const forwardMode = normalizeForwardMode(env.FORWARD_MODE);
  const reportSync = await syncReportFromPost(env, post, sourceChatId);
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
      report_sync: reportSync,
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
        report_sync: reportSync,
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
    report_sync: reportSync,
    results: successes,
    failures,
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

function getReportSyncUrl(env) {
  return String(env.REPORT_SYNC_URL || "").trim().replace(/\/+$/, "");
}

function getReportSyncKey(env) {
  return String(env.REPORT_SYNC_KEY || env.KALKI_SYNC_KEY || "").trim();
}

function isReportSyncEnabled(env) {
  if (String(env.REPORT_SYNC_ENABLED || "").trim()) {
    return parseBoolean(env.REPORT_SYNC_ENABLED);
  }
  return Boolean(getReportSyncUrl(env) && getReportSyncKey(env));
}

async function syncReportFromPost(env, post, sourceChatId) {
  if (!isReportSyncEnabled(env)) {
    return { ok: true, skipped: true, reason: "Report sync is not configured" };
  }

  const text = getPostText(post);
  const alert = parseScoredAlert(text);
  if (alert) {
    try {
      await upsertAlertToReportCloud(env, alert, post, sourceChatId);
      return { ok: true, ticker: alert.sym, type: "alert" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown report sync error";
      console.error("Report sync failed", {
        source_chat_id: sourceChatId,
        message_id: post.message_id,
        error: message,
      });
      return { ok: false, ticker: alert.sym, type: "alert", error: message };
    }
  }

  const command = parseTradeCommand(text, getReplyText(post));
  if (!command) {
    return { ok: true, skipped: true, reason: "No scored stock alert or trade command found" };
  }
  try {
    await upsertCommandToReportCloud(env, command, post, sourceChatId);
    return { ok: true, ticker: command.ticker, type: "command", action: command.action };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown report sync error";
    console.error("Report sync failed", {
      source_chat_id: sourceChatId,
      message_id: post.message_id,
      error: message,
    });
    return { ok: false, ticker: command.ticker, type: "command", action: command.action, error: message };
  }
}

function getPostText(post) {
  return String(post?.text || post?.caption || "").trim();
}

function getReplyText(post) {
  return String(post?.reply_to_message?.text || post?.reply_to_message?.caption || "").trim();
}

function parseScoredAlert(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const ticker = raw.match(/(?:^|\n)\s*⚡\s*\*?([A-Z][A-Z0-9.]{0,9})\*?/i)
    || raw.match(/\b([A-Z]{1,6})\b/);
  const entry = extractFirstMoneyAfter(raw, /Entry\s*:/i);
  const stop = extractFirstMoneyAfter(raw, /Stop\s*:/i);
  const targets = [...raw.matchAll(/T\d+\s*:\s*\$?\s*(\d+(?:\.\d+)?)/gi)]
    .map((match) => Number.parseFloat(match[1]))
    .filter(Number.isFinite);

  if (!ticker || !entry || !stop || targets.length === 0) {
    return null;
  }

  const sym = ticker[1].toUpperCase().replace(/[^A-Z0-9.]/g, "");
  const grade = (raw.match(/Grade\s*:\s*([A-D][+-]?)/i)?.[1] || "").toUpperCase();
  const score = Number.parseFloat(raw.match(/Score\s*:\s*(\d+(?:\.\d+)?)/i)?.[1] || "");
  const pattern = raw.match(/Pattern\s*:\s*([^\n]+)/i)?.[1]?.trim() || "";
  const volumeContext = parseVolumeContext(raw);
  const entryMid = (entry.low + entry.high) / 2;
  const supportLow = Math.min(stop.low, stop.high);
  const supportHigh = Math.min(entryMid, Math.max(stop.low, stop.high));
  const resistances = [...new Set(targets.filter((target) => target > entryMid).map((target) => roundPrice(target)))];

  return {
    sym,
    grade,
    score: Number.isFinite(score) ? score : null,
    pattern,
    entryLow: roundPrice(entry.low),
    entryHigh: roundPrice(entry.high),
    entryMid: roundPrice(entryMid),
    stop: roundPrice(supportLow),
    supLow: roundPrice(supportLow),
    supHigh: roundPrice(supportHigh),
    brk: roundPrice(supportLow),
    res: resistances,
    volume: volumeContext.volume,
    volumeRatio: volumeContext.volumeRatio,
    avgVolume20: volumeContext.avgVolume20,
    raw,
  };
}

function parseVolumeContext(text) {
  const raw = String(text || "");
  const line = raw.match(/Volume\s*:\s*([0-9.,]+)\s*([KMB])?(?:\s*shares?)?(?:\s*[·|,-]\s*([0-9.]+)\s*x\s*avg)?/i);
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

function extractFirstMoneyAfter(text, labelPattern) {
  const label = text.match(labelPattern);
  if (!label) return null;
  const tail = text.slice(label.index + label[0].length, label.index + label[0].length + 80);
  const range = tail.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (range) {
    const a = Number.parseFloat(range[1]);
    const b = Number.parseFloat(range[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return { low: Math.min(a, b), high: Math.max(a, b) };
    }
  }
  const single = tail.match(/\$?\s*(\d+(?:\.\d+)?)/);
  if (!single) return null;
  const value = Number.parseFloat(single[1]);
  return Number.isFinite(value) ? { low: value, high: value } : null;
}

function roundPrice(value) {
  return Math.round(Number(value) * 100) / 100;
}

function parseTradeCommand(text, replyText = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const ticker = extractTickerFromText(replyText) || extractTickerFromCommand(raw);
  if (!ticker) return null;

  if (/\b(move|raise|update)\s+stop\b|\bstop\s+(to\s+)?(breakeven|break even|be)\b/i.test(raw)) {
    return { action: "move_stop", ticker, percent: null, label: "Move stop", raw, replyText };
  }
  if (/\bcancel\b|\bcancel\s+orders?\b/i.test(raw)) {
    return { action: "cancel_orders", ticker, percent: null, label: "Cancel orders", raw, replyText };
  }
  if (/\b(close|exit|sell\s+all|full\s+exit)\b/i.test(raw)) {
    return { action: "close", ticker, percent: 100, label: "Close position", raw, replyText };
  }
  if (/\b(take\s+profits?|take\s+profit|trim|scale\s+out|sell\s+(half|partial|some))\b/i.test(raw)) {
    const percent = extractCommandPercent(raw) || 50;
    const clamped = clampNumber(percent, 1, 100);
    return { action: "trim", ticker, percent: clamped, label: `Trim ${clamped}%`, raw, replyText };
  }
  return null;
}

function extractTickerFromText(text) {
  const raw = String(text || "");
  const match = raw.match(/(?:^|\n)\s*⚡\s*\*?([A-Z][A-Z0-9.]{0,9})\*?/i)
    || raw.match(/\bTicker:\s*([A-Z]{1,10})\b/i);
  return match ? match[1].toUpperCase().replace(/[^A-Z0-9.]/g, "") : "";
}

function extractTickerFromCommand(text) {
  const raw = String(text || "").toUpperCase();
  const explicit = raw.match(/\b(?:FOR|ON|TICKER)\s+([A-Z][A-Z0-9.]{0,9})\b/)
    || raw.match(/\b(?:TRIM|CLOSE|EXIT|CANCEL)\s+([A-Z][A-Z0-9.]{0,9})\b/);
  if (explicit) return explicit[1].replace(/[^A-Z0-9.]/g, "");
  const leading = raw.match(/^([A-Z][A-Z0-9.]{0,9})\b/);
  if (leading && !["TAKE", "TRIM", "CLOSE", "EXIT", "SELL", "CANCEL", "MOVE", "STOP", "TARGET", "PROFIT", "PROFITS", "REACHED"].includes(leading[1])) {
    return leading[1].replace(/[^A-Z0-9.]/g, "");
  }
  return "";
}

function extractCommandPercent(text) {
  const raw = String(text || "");
  const pct = raw.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return Number.parseFloat(pct[1]);
  if (/\bhalf\b/i.test(raw)) return 50;
  if (/\bquarter\b/i.test(raw)) return 25;
  return null;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

async function upsertAlertToReportCloud(env, alert, post, sourceChatId) {
  const baseUrl = getReportSyncUrl(env);
  const key = getReportSyncKey(env);
  const headers = { "X-Kalki-Key": key };
  const loadResponse = await fetch(`${baseUrl}/d1/load`, { headers });
  const loadData = await loadResponse.json().catch(() => ({}));
  if (!loadResponse.ok || loadData.ok === false) {
    throw new Error(loadData.error || loadData.message || `D1 load failed with ${loadResponse.status}`);
  }

  const record = loadData.record && typeof loadData.record === "object" ? loadData.record : {};
  const updatedAt = new Date().toISOString();
  const messageId = String(post.message_id || Date.now());
  const reportId = `tg-${sourceChatId}-${messageId}`;
  const watchlist = Array.isArray(record.watchlist) ? record.watchlist : [];
  const groupTracker = Array.isArray(record.groupTracker) ? record.groupTracker : [];
  const existingWatchIndex = watchlist.findIndex((item) => String(item?.sym || "").toUpperCase() === alert.sym);

  const watchItem = {
    ...(existingWatchIndex >= 0 ? watchlist[existingWatchIndex] : {}),
    sym: alert.sym,
    supLow: alert.supLow,
    supHigh: alert.supHigh,
    brk: alert.brk,
    res: alert.res,
    price: null,
    status: "neutral",
    monitorTrend: existingWatchIndex >= 0 ? Boolean(watchlist[existingWatchIndex]?.monitorTrend) : false,
    grade: alert.grade || (existingWatchIndex >= 0 ? watchlist[existingWatchIndex]?.grade || "" : ""),
    volume: alert.volume,
    volumeRatio: alert.volumeRatio,
    avgVolume20: alert.avgVolume20,
    source: "telegram-forwarder",
    sourceChatId,
    sourceMessageId: messageId,
    syncedAt: updatedAt,
  };

  if (existingWatchIndex >= 0) {
    watchlist[existingWatchIndex] = watchItem;
  } else {
    watchlist.unshift(watchItem);
  }

  const trackerIndex = groupTracker.findIndex((item) => String(item?.id || "") === reportId);
  const trackerItem = {
    ...(trackerIndex >= 0 ? groupTracker[trackerIndex] : {}),
    id: reportId,
    sym: alert.sym,
    note: alert.pattern || "Telegram scored alert",
    addedIso: updatedAt,
    addedLabel: new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" }),
    addedPrice: alert.entryMid,
    currentPrice: null,
    pctSinceAdd: null,
    catalystScore: alert.score,
    grade: alert.grade,
    volume: alert.volume,
    volumeRatio: alert.volumeRatio,
    avgVolume20: alert.avgVolume20,
    updatedAt,
    source: "telegram-forwarder",
    sourceChatId,
    sourceMessageId: messageId,
    rawAlert: alert.raw,
  };

  if (trackerIndex >= 0) {
    groupTracker[trackerIndex] = trackerItem;
  } else {
    groupTracker.unshift(trackerItem);
  }

  const payload = {
    ...record,
    watchlist,
    groupTracker,
    updatedAt,
  };

  const saveResponse = await fetch(`${baseUrl}/d1/save`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const saveData = await saveResponse.json().catch(() => ({}));
  if (!saveResponse.ok || saveData.ok === false) {
    throw new Error(saveData.error || saveData.message || `D1 save failed with ${saveResponse.status}`);
  }
}

async function upsertCommandToReportCloud(env, command, post, sourceChatId) {
  const baseUrl = getReportSyncUrl(env);
  const key = getReportSyncKey(env);
  const headers = { "X-Kalki-Key": key };
  const loadResponse = await fetch(`${baseUrl}/d1/load`, { headers });
  const loadData = await loadResponse.json().catch(() => ({}));
  if (!loadResponse.ok || loadData.ok === false) {
    throw new Error(loadData.error || loadData.message || `D1 load failed with ${loadResponse.status}`);
  }

  const record = loadData.record && typeof loadData.record === "object" ? loadData.record : {};
  const updatedAt = new Date().toISOString();
  const messageId = String(post.message_id || Date.now());
  const commandEvent = {
    id: `cmd-${sourceChatId}-${messageId}`,
    sym: command.ticker,
    action: command.action,
    label: command.label,
    percent: command.percent,
    text: command.raw,
    source: "telegram-forwarder",
    sourceChatId,
    sourceMessageId: messageId,
    replyToMessageId: post.reply_to_message?.message_id || null,
    createdAt: updatedAt,
  };

  const commandEvents = Array.isArray(record.commandEvents) ? record.commandEvents : [];
  if (!commandEvents.some((event) => String(event?.id) === commandEvent.id)) {
    commandEvents.unshift(commandEvent);
  }

  const groupTracker = Array.isArray(record.groupTracker) ? record.groupTracker : [];
  let tracker = groupTracker.find((item) => String(item?.sym || "").toUpperCase() === command.ticker);
  if (!tracker) {
    tracker = {
      id: `tg-command-${command.ticker}`,
      sym: command.ticker,
      note: "Telegram command",
      addedIso: updatedAt,
      addedLabel: new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" }),
      addedPrice: null,
      currentPrice: null,
      pctSinceAdd: null,
      catalystScore: null,
      grade: "",
    };
    groupTracker.unshift(tracker);
  }
  tracker.updatedAt = updatedAt;
  tracker.latestCommand = commandEvent;
  tracker.commandEvents = [commandEvent, ...(Array.isArray(tracker.commandEvents) ? tracker.commandEvents : [])]
    .filter((event, index, arr) => arr.findIndex((candidate) => candidate.id === event.id) === index)
    .slice(0, 10);

  const payload = {
    ...record,
    groupTracker,
    commandEvents: commandEvents.slice(0, 250),
    updatedAt,
  };

  const saveResponse = await fetch(`${baseUrl}/d1/save`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const saveData = await saveResponse.json().catch(() => ({}));
  if (!saveResponse.ok || saveData.ok === false) {
    throw new Error(saveData.error || saveData.message || `D1 save failed with ${saveResponse.status}`);
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
    allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post"],
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
