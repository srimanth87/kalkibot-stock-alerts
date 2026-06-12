const DEFAULT_MIN_GRADE = "B";
const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
const DEFAULT_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com";
const DEFAULT_YAHOO_PROXY_BASE_URL = "https://yahoo-proxy.srimanthgada87.workers.dev";
const PROMPT_VERSION = "chart-confirmation-v2";
const GRADE_RANK = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return corsResponse(null, 204);

    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
        return htmlResponse(renderDashboard());
      }

      if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
        const aiConfig = getAiConfig(env);
        return corsJson({
          ok: true,
          service: "kalkibot-ai-trade-agent",
          mode: "shadow-only",
          db_bound: Boolean(env.AI_DB),
          ai_enabled: Boolean(aiConfig.apiKey),
          ai_provider: aiConfig.provider,
          ai_base_url: aiConfig.baseUrl,
          has_ai_key: Boolean(aiConfig.apiKey),
          has_openai_key: Boolean(env.OPENAI_API_KEY),
          model: aiConfig.model,
          yahoo_proxy_configured: Boolean(getYahooProxyBaseUrl(env)),
          yahoo_proxy_bound: Boolean(env.YAHOO_PROXY),
          source_chat_id: getSourceChatId(env) || null,
          webhook_path: `/telegram/${getSecretPath(env)}`,
        });
      }

      if (request.method === "POST" && (url.pathname === "/test" || url.pathname === "/api/test")) {
        const body = await request.json().catch(() => ({}));
        const alert = parseKalkiAlert(body.text || "");
        if (!alert) return corsJson({ ok: false, error: "not a Kalki alert or missing grade/entry/stop/T1" }, 400);
        const decision = await analyzeAlert(env, alert);
        return corsJson({ ok: true, preview: true, alert, decision });
      }

      if (request.method === "GET" && url.pathname === "/api/market-context") {
        const ticker = String(url.searchParams.get("ticker") || "").trim().toUpperCase();
        if (!/^[A-Z.\-^]{1,12}$/.test(ticker)) return corsJson({ ok: false, error: "ticker is required" }, 400);
        const marketContext = await buildMarketContext(env, { ticker });
        return corsJson({ ok: true, marketContext });
      }

      if (request.method === "GET" && url.pathname === "/api/alerts") {
        return corsJson({ ok: true, alerts: await listAlerts(env, Number(url.searchParams.get("limit") || 50)) });
      }

      if (request.method === "GET" && url.pathname === "/api/summary") {
        return corsJson({ ok: true, summary: await buildSummary(env), reviews: await listDailyReviews(env, 5) });
      }

      if (request.method === "POST" && url.pathname === "/api/outcome") {
        return await handleOutcome(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/daily-review") {
        return corsJson({ ok: true, review: await generateDailyReview(env) });
      }

      if (request.method === "POST" && url.pathname === `/telegram/${getSecretPath(env)}`) {
        return await handleTelegramWebhook(request, env);
      }

      return corsJson({ ok: false, error: "not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("AI trade agent error", { message });
      return corsJson({ ok: false, error: message }, 500);
    }
  },

  async scheduled(_controller, env) {
    await generateDailyReview(env);
  },
};

async function handleTelegramWebhook(request, env) {
  requireDb(env);
  const payload = await request.json().catch(() => ({}));
  const { text, chatId, messageId } = readTelegramPayload(payload);
  const sourceChatId = getSourceChatId(env);

  if (sourceChatId && chatId !== sourceChatId) {
    return corsJson({ ok: true, ignored: "wrong source chat", chatId });
  }

  const alert = parseKalkiAlert(text);
  if (!alert) {
    return corsJson({ ok: true, ignored: "not a Kalki alert", chatId });
  }

  const existing = messageId ? await findAlertBySource(env, chatId, messageId) : null;
  if (existing) {
    return corsJson({ ok: true, duplicate: true, alertId: existing.id });
  }

  const savedAlert = await saveAlert(env, {
    ...alert,
    sourceChatId: chatId,
    sourceMessageId: messageId,
  });
  const decision = await analyzeAlert(env, savedAlert);
  await saveDecision(env, savedAlert.id, decision);

  return corsJson({
    ok: true,
    stage: "shadow_analyzed",
    alertId: savedAlert.id,
    ticker: savedAlert.ticker,
    decision: decision.decision,
    tradeQuality: decision.trade_quality,
    bestTradeScore: decision.best_trade_score,
    confidence: decision.confidence,
    traded: false,
  });
}

async function handleOutcome(request, env) {
  requireDb(env);
  const body = await request.json().catch(() => ({}));
  const alertId = String(body.alertId || "").trim();
  if (!alertId) return corsJson({ ok: false, error: "alertId is required" }, 400);

  const now = new Date().toISOString();
  const outcome = {
    id: crypto.randomUUID(),
    alertId,
    status: normalizeOutcomeStatus(body.status),
    entryFill: nullableNumber(body.entryFill),
    exitPrice: nullableNumber(body.exitPrice),
    exitReason: String(body.exitReason || "").trim() || null,
    pnl: nullableNumber(body.pnl),
    rMultiple: nullableNumber(body.rMultiple),
    notes: String(body.notes || "").trim() || null,
    closedAt: body.closedAt ? new Date(body.closedAt).toISOString() : null,
    createdAt: now,
    updatedAt: now,
  };

  await env.AI_DB.prepare(
    `INSERT INTO outcomes (id, alert_id, status, entry_fill, exit_price, exit_reason, pnl, r_multiple, notes, closed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      outcome.id,
      outcome.alertId,
      outcome.status,
      outcome.entryFill,
      outcome.exitPrice,
      outcome.exitReason,
      outcome.pnl,
      outcome.rMultiple,
      outcome.notes,
      outcome.closedAt,
      outcome.createdAt,
      outcome.updatedAt,
    )
    .run();

  return corsJson({ ok: true, outcome });
}

async function analyzeAlert(env, alert) {
  const marketContext = await buildMarketContext(env, alert);
  const deterministic = buildAlphaDecision(env, alert, marketContext);
  const aiConfig = getAiConfig(env);
  if (!aiConfig.apiKey) {
    return {
      ...deterministic,
      model: "deterministic-fallback",
      raw_response: null,
      prompt_version: PROMPT_VERSION,
    };
  }

  const context = env.AI_DB ? await buildPerformanceContext(env, alert) : { sample_size: 0, rows: [] };
  const prompt = buildAgentPrompt(env, alert, deterministic, context);
  const result = await callAiChat(env, [
    {
      role: "system",
      content:
        "You are a shadow-mode chart-trade confirmation agent. You never place trades. A human sent the chart alert; decide TAKE, WATCH, or SKIP using alert evidence, Alpha Scanner scores, and history. TAKE only when this looks like a best-quality setup now. Return only compact JSON.",
    },
    { role: "user", content: prompt },
  ]);

  if (!result.ok) {
    return {
      ...deterministic,
      reason: `${deterministic.reason} AI unavailable: ${result.error}`,
      model: "deterministic-fallback",
      raw_response: result.raw_response,
      prompt_version: PROMPT_VERSION,
    };
  }

  const parsed = safeJson(result.content);
  return normalizeAiDecision(parsed, deterministic, result.model, result.content);
}

function buildAlphaDecision(env, alert, marketContext = null) {
  const minGrade = normalizeMinGrade(env.MIN_GRADE || DEFAULT_MIN_GRADE);
  const gradeOk = isTradeableGrade(alert.grade, minGrade);
  const scanner = calculateAlphaScannerScores(alert, marketContext);
  const risk = alert.entryPrice - alert.stopPrice;
  const reward = alert.t1 - alert.entryPrice;
  const rr = risk > 0 ? reward / risk : 0;

  let decision = "watch";
  let confidence = Math.max(55, scanner.bestTradeScore - 5);
  const concerns = [...scanner.redFlags];
  const strengths = [...scanner.confirmations];

  if (!gradeOk) concerns.push(`grade ${alert.grade} is below ${minGrade}`);

  if (risk <= 0) concerns.push("stop is not below entry");
  if (reward <= 0) concerns.push("T1 is not above entry");
  if (rr >= 1.5) strengths.push(`acceptable reward/risk at ${rr.toFixed(2)}R`);
  if (rr > 0 && rr < 0.8) concerns.push(`thin reward to T1 at ${rr.toFixed(2)}R`);

  if (!gradeOk || risk <= 0 || reward <= 0 || scanner.bestTradeScore < 40) {
    decision = "skip";
    confidence = Math.max(72, confidence);
  } else if (scanner.tradeQuality === "A+" && scanner.c13Score >= 5 && scanner.c1Score >= 6 && scanner.entryTiming === "ready") {
    decision = "take";
    confidence = Math.min(94, Math.max(78, scanner.bestTradeScore));
  }

  return {
    decision,
    confidence,
    risk_level: scanner.riskLevel,
    trade_quality: scanner.tradeQuality,
    best_trade_score: scanner.bestTradeScore,
    entry_timing: scanner.entryTiming,
    c13_score: scanner.c13Score,
    c1_score: scanner.c1Score,
    volume_score: scanner.volumeScore,
    market_score: scanner.marketScore,
    relative_strength_score: scanner.relativeStrengthScore,
    catalyst_score: scanner.catalystScore,
    alpha_scanner: scanner,
    market_context: marketContext,
    confirmations: scanner.confirmations,
    red_flags: concerns,
    reason: scanner.reason,
    strengths,
    concerns,
    similar_sample_size: 0,
    similar_win_rate: null,
    expected_r_multiple: rr || null,
  };
}

function calculateAlphaScannerScores(alert, marketContext = null) {
  const confirmations = [];
  const redFlags = [];
  const gradeScore = gradeStrength(alert.grade);
  const alertScore = parseAlertScore(alert.score);
  const structurePct = parsePercent(alert.structure);
  const live = marketContext?.ticker || null;
  const livePrice = live?.currentPrice || alert.price || null;
  const priceDistancePct = livePrice && alert.entryPrice ? ((livePrice - alert.entryPrice) / alert.entryPrice) * 100 : null;
  const entryRangePct =
    alert.entryLow && alert.entryHigh && alert.entryLow > 0 ? ((alert.entryHigh - alert.entryLow) / alert.entryLow) * 100 : 0;
  const risk = alert.entryPrice - alert.stopPrice;
  const reward = alert.t1 - alert.entryPrice;
  const rr = risk > 0 ? reward / risk : null;

  let c13Score = 0;
  if (gradeScore >= 4) {
    c13Score += 3;
    confirmations.push(`alert grade ${alert.grade}`);
  } else if (gradeScore >= 3) {
    c13Score += 2;
    confirmations.push(`alert grade ${alert.grade}`);
  } else if (gradeScore >= 2) {
    c13Score += 1;
  }

  if (structurePct != null) {
    if (structurePct >= 90) {
      c13Score += 3;
      confirmations.push(`structure ${structurePct}%`);
    } else if (structurePct >= 80) {
      c13Score += 2;
      confirmations.push(`structure ${structurePct}%`);
    } else if (structurePct >= 70) {
      c13Score += 1;
    } else {
      redFlags.push(`structure only ${structurePct}%`);
    }
  }

  if (alertScore) {
    if (alertScore.ratio >= 0.75) {
      c13Score += 2;
      confirmations.push(`score ${alert.score}`);
    } else if (alertScore.ratio >= 0.6) {
      c13Score += 1;
    } else {
      redFlags.push(`score only ${alert.score}`);
    }
  }

  if (entryRangePct <= 1.5) {
    c13Score += 1;
    confirmations.push("tight entry zone");
  } else if (entryRangePct > 3) {
    redFlags.push(`wide entry range ${entryRangePct.toFixed(1)}%`);
  }
  c13Score = Math.min(9, c13Score);

  let c1Score = 0;
  let entryTiming = "unknown";
  if (priceDistancePct != null) {
    const absDistance = Math.abs(priceDistancePct);
    if (absDistance <= 0.75) {
      c1Score += 4;
      entryTiming = "ready";
      confirmations.push("price is near entry");
    } else if (priceDistancePct < -0.75 && priceDistancePct >= -3) {
      c1Score += 2;
      entryTiming = "early";
      redFlags.push("price has not reached entry yet");
    } else if (priceDistancePct > 0.75 && priceDistancePct <= 3) {
      c1Score += 2;
      entryTiming = "late";
      redFlags.push(`price is ${priceDistancePct.toFixed(1)}% above entry`);
    } else if (priceDistancePct > 3) {
      c1Score += 1;
      entryTiming = "extended";
      redFlags.push(`price is extended ${priceDistancePct.toFixed(1)}% above entry`);
    }
  } else {
    c1Score += 2;
  }

  if (gradeScore >= 4) c1Score += 2;
  else if (gradeScore >= 3) c1Score += 1;
  if (alertScore?.ratio >= 0.75) c1Score += 2;
  else if (alertScore?.ratio >= 0.6) c1Score += 1;
  if (rr != null && rr >= 1.2) c1Score += 1;
  c1Score = Math.min(9, c1Score);

  const volumeRatio = live?.volumeRatio ?? null;
  let volumeScore = null;
  if (volumeRatio != null) {
    if (volumeRatio >= 2) {
      volumeScore = 9;
      confirmations.push(`volume ${volumeRatio.toFixed(1)}x average`);
    } else if (volumeRatio >= 1.2) {
      volumeScore = 7;
      confirmations.push(`volume ${volumeRatio.toFixed(1)}x average`);
    } else if (volumeRatio >= 0.8) {
      volumeScore = 4;
      redFlags.push(`volume only ${volumeRatio.toFixed(1)}x average`);
    } else {
      volumeScore = 2;
      redFlags.push(`weak volume ${volumeRatio.toFixed(1)}x average`);
    }
  }

  let marketScore = null;
  if (marketContext?.market) {
    const { spyChangePct, qqqChangePct, condition } = marketContext.market;
    if (condition === "bullish") {
      marketScore = 8;
      confirmations.push(`market supportive SPY ${formatSigned(spyChangePct)}%, QQQ ${formatSigned(qqqChangePct)}%`);
    } else if (condition === "mixed") {
      marketScore = 5;
      redFlags.push(`market mixed SPY ${formatSigned(spyChangePct)}%, QQQ ${formatSigned(qqqChangePct)}%`);
    } else {
      marketScore = 2;
      redFlags.push(`market weak SPY ${formatSigned(spyChangePct)}%, QQQ ${formatSigned(qqqChangePct)}%`);
    }
  }

  let relativeStrengthScore = null;
  if (marketContext?.relativeStrength) {
    const rs = marketContext.relativeStrength.vsQqqPct;
    if (rs >= 1) {
      relativeStrengthScore = 8;
      confirmations.push(`relative strength vs QQQ ${formatSigned(rs)}%`);
    } else if (rs >= 0) {
      relativeStrengthScore = 6;
      confirmations.push("holding in line with QQQ");
    } else {
      relativeStrengthScore = 3;
      redFlags.push(`lagging QQQ by ${Math.abs(rs).toFixed(1)}%`);
    }
  }

  if (live?.intradayTrend === "up") confirmations.push("intraday trend up");
  if (live?.intradayTrend === "down") redFlags.push("intraday trend down");

  const catalystScore = null;
  const knownScores = [c13Score, c1Score, volumeScore, marketScore, relativeStrengthScore].filter((value) => value != null);
  const baseScore = Math.round((knownScores.reduce((sum, value) => sum + value, 0) / (knownScores.length * 9)) * 100);
  const alertBoost = gradeScore >= 4 ? 8 : gradeScore >= 3 ? 4 : 0;
  const rrPenalty = rr != null && rr < 0.8 ? 8 : 0;
  const timingPenalty = entryTiming === "extended" ? 15 : entryTiming === "late" ? 8 : 0;
  const bestTradeScore = clampInt(baseScore + alertBoost - rrPenalty - timingPenalty, 0, 100, 50);
  const tradeQuality = bestTradeScore >= 80 && c13Score >= 5 && c1Score >= 6 ? "A+" : bestTradeScore >= 68 ? "A" : bestTradeScore >= 52 ? "B" : "C";
  const riskLevel = tradeQuality === "A+" && entryTiming === "ready" ? "low" : bestTradeScore >= 60 ? "medium" : "high";

  if (volumeScore == null) redFlags.push("live volume confirmation unavailable");
  if (marketScore == null) redFlags.push("market condition confirmation unavailable");

  const reason =
    tradeQuality === "A+"
      ? "Alpha Scanner baseline says this is an A+ chart setup if live context confirms."
      : tradeQuality === "A"
        ? "Strong chart alert, but one or more best-trade confirmations are missing."
        : tradeQuality === "B"
          ? "Interesting setup for watchlist, not a best trade yet."
          : "Insufficient confirmation for a best-trade decision.";

  return {
    c13Score,
    c1Score,
    volumeScore,
    marketScore,
    relativeStrengthScore,
    catalystScore,
    bestTradeScore,
    tradeQuality,
    entryTiming,
    riskLevel,
    rewardRisk: rr,
    entryRangePct,
    priceDistancePct,
    livePrice,
    volumeRatio,
    marketContext,
    structurePct,
    alertScore,
    confirmations: [...new Set(confirmations)].slice(0, 8),
    redFlags: [...new Set(redFlags)].slice(0, 8),
    reason,
  };
}

function buildAgentPrompt(env, alert, deterministic, context) {
  return JSON.stringify({
    task: "Decide whether to TAKE, WATCH, or SKIP this chart-based Telegram trade alert. The alert came from a human charting process; confirm if this is one of the best trades to proceed with now.",
    hard_rules: {
      min_grade: env.MIN_GRADE || DEFAULT_MIN_GRADE,
      take_definition: "TAKE only for A+ or strong A quality setups with Alpha Scanner confirmation and clean entry timing.",
      watch_definition: "WATCH means the setup is interesting but needs better entry, volume, market, or catalyst confirmation.",
      skip_definition: "SKIP means the setup is weak, invalid, too extended, or missing too many confirmations.",
      trade_execution: "handled by a separate auto-trader later; this service is confirmation and learning only",
    },
    alert,
    alpha_scanner_baseline: deterministic,
    market_context: deterministic.market_context,
    recent_performance_context: context,
    required_json: {
      decision: "take | watch | skip",
      trade_quality: "A+ | A | B | C",
      best_trade_score: "integer 0-100",
      confidence: "integer 0-100",
      risk_level: "low | medium | high",
      entry_timing: "ready | early | extended | late | unknown",
      reason: "one short explanation",
      confirmations: ["short strings"],
      red_flags: ["short strings"],
      strengths: ["short strings"],
      concerns: ["short strings"],
      c13_score: "integer 0-9",
      c1_score: "integer 0-9",
      similar_sample_size: "integer",
      similar_win_rate: "number or null",
      expected_r_multiple: "number or null",
    },
  });
}

function normalizeAiDecision(parsed, fallback, model, rawResponse) {
  const decision = ["take", "watch", "skip", "approve"].includes(String(parsed.decision || "").toLowerCase())
    ? normalizeDecision(parsed.decision)
    : fallback.decision;
  const confidence = clampInt(parsed.confidence, 0, 100, fallback.confidence);
  const riskLevel = ["low", "medium", "high"].includes(String(parsed.risk_level || "").toLowerCase())
    ? String(parsed.risk_level).toLowerCase()
    : fallback.risk_level;
  const tradeQuality = normalizeTradeQuality(parsed.trade_quality || fallback.trade_quality);
  const c13Score = clampInt(parsed.c13_score, 0, 9, fallback.c13_score || 0);
  const c1Score = clampInt(parsed.c1_score, 0, 9, fallback.c1_score || 0);
  const bestTradeScore = clampInt(parsed.best_trade_score, 0, 100, fallback.best_trade_score || 0);
  const entryTiming = normalizeEntryTiming(parsed.entry_timing || fallback.entry_timing);

  return {
    decision,
    confidence,
    risk_level: riskLevel,
    trade_quality: tradeQuality,
    best_trade_score: bestTradeScore,
    entry_timing: entryTiming,
    c13_score: c13Score,
    c1_score: c1Score,
    volume_score: nullableNumber(parsed.volume_score) ?? fallback.volume_score ?? null,
    market_score: nullableNumber(parsed.market_score) ?? fallback.market_score ?? null,
    relative_strength_score: nullableNumber(parsed.relative_strength_score) ?? fallback.relative_strength_score ?? null,
    catalyst_score: nullableNumber(parsed.catalyst_score) ?? fallback.catalyst_score ?? null,
    alpha_scanner: fallback.alpha_scanner || null,
    market_context: fallback.market_context || null,
    confirmations: normalizeStringArray(parsed.confirmations || fallback.confirmations),
    red_flags: normalizeStringArray(parsed.red_flags || fallback.red_flags),
    reason: String(parsed.reason || fallback.reason || "").slice(0, 700),
    strengths: normalizeStringArray(parsed.strengths || fallback.strengths),
    concerns: normalizeStringArray(parsed.concerns || fallback.concerns),
    similar_sample_size: clampInt(parsed.similar_sample_size, 0, 100000, fallback.similar_sample_size || 0),
    similar_win_rate: nullableNumber(parsed.similar_win_rate),
    expected_r_multiple: nullableNumber(parsed.expected_r_multiple),
    model,
    raw_response: rawResponse,
    prompt_version: PROMPT_VERSION,
  };
}

async function callAiChat(env, messages) {
  const config = getAiConfig(env);
  if (!config.apiKey) {
    return {
      ok: false,
      error: "AI_API_KEY is not configured",
      model: "deterministic-fallback",
      raw_response: null,
      content: "{}",
    };
  }

  const body = {
    model: config.model,
    temperature: 0.2,
    messages,
  };

  if (config.provider === "openai") {
    body.response_format = { type: "json_object" };
  } else {
    body.messages = messages.map((message, index) => {
      if (index !== messages.length - 1 || message.role !== "user") return message;
      return {
        ...message,
        content: `${message.content}\n\nReturn valid JSON only. No markdown, no prose outside JSON.`,
      };
    });
  }

  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  const content = extractJsonText(data?.choices?.[0]?.message?.content || "{}");
  return {
    ok: response.ok,
    error: response.ok ? "" : data?.error?.message || data?.error || `HTTP ${response.status}`,
    model: config.model,
    raw_response: JSON.stringify(data),
    content,
  };
}

function getAiConfig(env) {
  const provider = normalizeAiProvider(env.AI_PROVIDER || (env.AI_API_KEY ? "nvidia" : "openai"));
  return {
    provider,
    apiKey: String(env.AI_API_KEY || env.OPENAI_API_KEY || "").trim(),
    baseUrl: normalizeBaseUrl(env.AI_API_BASE_URL || (provider === "nvidia" ? DEFAULT_NVIDIA_BASE_URL : DEFAULT_OPENAI_BASE_URL)),
    model: String(env.AI_MODEL || env.OPENAI_MODEL || DEFAULT_MODEL).trim(),
  };
}

function normalizeAiProvider(value) {
  const provider = String(value || "openai").trim().toLowerCase();
  return provider === "nvidia" ? "nvidia" : "openai";
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function extractJsonText(value) {
  const text = String(value || "{}").trim();
  if (text.startsWith("{") && text.endsWith("}")) return text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return "{}";
}

async function buildMarketContext(env, alert) {
  const proxyBaseUrl = getYahooProxyBaseUrl(env);
  if (!proxyBaseUrl) return null;

  const [tickerFetch, spyFetch, qqqFetch, tickerDailyFetch, spyDailyFetch, qqqDailyFetch] = await Promise.all([
    fetchYahooChart(env, proxyBaseUrl, alert.ticker),
    fetchYahooChart(env, proxyBaseUrl, "SPY"),
    fetchYahooChart(env, proxyBaseUrl, "QQQ"),
    fetchYahooChart(env, proxyBaseUrl, alert.ticker, "3mo", "1d"),
    fetchYahooChart(env, proxyBaseUrl, "SPY", "3mo", "1d"),
    fetchYahooChart(env, proxyBaseUrl, "QQQ", "3mo", "1d"),
  ]);

  const tickerMetrics = chartMetrics(tickerFetch.result, tickerDailyFetch.result);
  const spyMetrics = chartMetrics(spyFetch.result, spyDailyFetch.result);
  const qqqMetrics = chartMetrics(qqqFetch.result, qqqDailyFetch.result);
  const market = marketMetrics(spyMetrics, qqqMetrics);
  const relativeStrength =
    tickerMetrics && qqqMetrics
      ? {
          vsQqqPct: (tickerMetrics.dayChangePct || 0) - (qqqMetrics.dayChangePct || 0),
          vsSpyPct: spyMetrics ? (tickerMetrics.dayChangePct || 0) - (spyMetrics.dayChangePct || 0) : null,
        }
      : null;

  return {
    provider: "yahoo-proxy",
    ticker: tickerMetrics,
    spy: spyMetrics,
    qqq: qqqMetrics,
    market,
    relativeStrength,
    errors: [tickerFetch.error, spyFetch.error, qqqFetch.error, tickerDailyFetch.error, spyDailyFetch.error, qqqDailyFetch.error].filter(Boolean),
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchYahooChart(env, proxyBaseUrl, symbol, range = "1d", interval = "5m") {
  const encodedSymbol = encodeURIComponent(symbol);
  const params = `range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=true&cb=${Date.now()}`;
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
        lastError = `${symbol}: proxy HTTP ${response.status}`;
        continue;
      }
      const text = await response.text();
      const data = parseMaybeJson(text);
      const result = data?.chart?.result?.[0] || null;
      const yahooError = data?.chart?.error?.description || data?.chart?.error?.code || null;
      if (result) return { result, error: null };
      lastError = yahooError ? `${symbol}: ${yahooError}` : `${symbol}: no chart result`;
    } catch (error) {
      lastError = `${symbol}: ${error instanceof Error ? error.message : "chart fetch failed"}`;
    }
  }

  return { result: null, error: lastError || `${symbol}: chart fetch failed` };
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

function parseMaybeJson(text) {
  const trimmed = String(text || "").trim();
  const start = Math.min(
    trimmed.indexOf("{") >= 0 ? trimmed.indexOf("{") : Number.POSITIVE_INFINITY,
    trimmed.indexOf("[") >= 0 ? trimmed.indexOf("[") : Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(start)) return null;
  return JSON.parse(trimmed.slice(start));
}

function chartMetrics(result, dailyResult = null) {
  if (!result?.meta) return null;
  const meta = result.meta;
  const quote = result.indicators?.quote?.[0] || {};
  const dailyQuote = dailyResult?.indicators?.quote?.[0] || {};
  const close = compactNumbers(quote.close);
  const volume = compactNumbers(quote.volume);
  const dailyVolume = compactNumbers(dailyQuote.volume).filter((value) => value > 0);
  const currentPrice = nullableNumber(meta.regularMarketPrice) ?? close.at(-1) ?? null;
  const previousClose = nullableNumber(meta.previousClose) ?? nullableNumber(meta.chartPreviousClose);
  const dayChangePct = currentPrice != null && previousClose ? ((currentPrice - previousClose) / previousClose) * 100 : null;
  const regularMarketVolume = nullableNumber(meta.regularMarketVolume) ?? volume.reduce((sum, value) => sum + value, 0);
  const averageBarVolume = volume.filter((value) => value > 0).length ? average(volume.filter((value) => value > 0)) : null;
  const averageDailyVolume = dailyVolume.length ? average(dailyVolume.slice(0, -1).slice(-20)) || average(dailyVolume.slice(-20)) : null;
  const expectedBars = 78;
  const projectedVolume = averageBarVolume ? averageBarVolume * expectedBars : null;
  const volumeRatio =
    averageDailyVolume && regularMarketVolume
      ? regularMarketVolume / averageDailyVolume
      : projectedVolume && regularMarketVolume
        ? regularMarketVolume / projectedVolume
        : null;
  const intradayTrend = close.length >= 12 && close.at(-1) > close.at(-12) ? "up" : close.length >= 12 && close.at(-1) < close.at(-12) ? "down" : "flat";

  return {
    symbol: meta.symbol,
    name: meta.shortName || meta.longName || meta.symbol,
    currentPrice,
    previousClose,
    dayChangePct,
    dayHigh: nullableNumber(meta.regularMarketDayHigh),
    dayLow: nullableNumber(meta.regularMarketDayLow),
    regularMarketVolume,
    averageBarVolume,
    averageDailyVolume,
    projectedVolume,
    volumeRatio,
    intradayTrend,
    fiftyTwoWeekHigh: nullableNumber(meta.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: nullableNumber(meta.fiftyTwoWeekLow),
    regularMarketTime: meta.regularMarketTime || null,
  };
}

function marketMetrics(spy, qqq) {
  if (!spy || !qqq) return null;
  const spyChangePct = spy.dayChangePct ?? 0;
  const qqqChangePct = qqq.dayChangePct ?? 0;
  const avgChangePct = (spyChangePct + qqqChangePct) / 2;
  const condition = spyChangePct >= 0 && qqqChangePct >= 0 ? "bullish" : avgChangePct > -0.35 ? "mixed" : "weak";
  return { condition, spyChangePct, qqqChangePct, avgChangePct };
}

function getYahooProxyBaseUrl(env) {
  return normalizeBaseUrl(env.YAHOO_PROXY_BASE_URL || DEFAULT_YAHOO_PROXY_BASE_URL);
}

async function buildPerformanceContext(env, alert) {
  const result = await env.AI_DB.prepare(
    `SELECT a.ticker, a.grade, a.entry_price, a.stop_price, a.t1, d.decision, d.confidence, o.status, o.pnl, o.r_multiple
     FROM alerts a
     LEFT JOIN ai_decisions d ON d.alert_id = a.id
     LEFT JOIN outcomes o ON o.alert_id = a.id
     WHERE a.ticker = ? OR a.grade = ?
     ORDER BY a.received_at DESC
     LIMIT 40`,
  )
    .bind(alert.ticker, alert.grade)
    .all();

  const rows = result.results || [];
  const closed = rows.filter((row) => row.status === "win" || row.status === "loss");
  const wins = closed.filter((row) => row.status === "win").length;
  return {
    sample_size: rows.length,
    closed_sample_size: closed.length,
    win_rate: closed.length ? wins / closed.length : null,
    average_r_multiple: average(closed.map((row) => Number(row.r_multiple)).filter(Number.isFinite)),
    rows: rows.slice(0, 12),
  };
}

async function saveAlert(env, alert) {
  requireDb(env);
  const saved = {
    ...alert,
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
  };
  await env.AI_DB.prepare(
    `INSERT INTO alerts (id, ticker, grade, score, structure, price, entry_price, entry_low, entry_high, stop_price, t1, t2, t3, raw_text, source_chat_id, source_message_id, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      saved.id,
      saved.ticker,
      saved.grade,
      saved.score,
      saved.structure,
      saved.price,
      saved.entryPrice,
      saved.entryLow,
      saved.entryHigh,
      saved.stopPrice,
      saved.t1,
      saved.t2,
      saved.t3,
      saved.raw,
      saved.sourceChatId,
      saved.sourceMessageId,
      saved.receivedAt,
    )
    .run();
  return saved;
}

async function saveDecision(env, alertId, decision) {
  requireDb(env);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.AI_DB.prepare(
    `INSERT INTO ai_decisions (
       id, alert_id, decision, confidence, risk_level, trade_quality, best_trade_score, entry_timing,
       c13_score, c1_score, volume_score, market_score, relative_strength_score, catalyst_score,
       reason, confirmations, red_flags, strengths, concerns, similar_sample_size, similar_win_rate,
       expected_r_multiple, alpha_scanner, model, prompt_version, raw_response, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      alertId,
      decision.decision,
      decision.confidence,
      decision.risk_level,
      decision.trade_quality,
      decision.best_trade_score,
      decision.entry_timing,
      decision.c13_score,
      decision.c1_score,
      decision.volume_score,
      decision.market_score,
      decision.relative_strength_score,
      decision.catalyst_score,
      decision.reason,
      JSON.stringify(decision.confirmations || []),
      JSON.stringify(decision.red_flags || []),
      JSON.stringify(decision.strengths || []),
      JSON.stringify(decision.concerns || []),
      decision.similar_sample_size || 0,
      decision.similar_win_rate,
      decision.expected_r_multiple,
      JSON.stringify({ ...(decision.alpha_scanner || {}), market_context: decision.market_context || null }),
      decision.model || null,
      decision.prompt_version || PROMPT_VERSION,
      decision.raw_response || null,
      now,
    )
    .run();
  return { id, alertId, ...decision, created_at: now };
}

async function findAlertBySource(env, chatId, messageId) {
  if (!chatId || !messageId) return null;
  const row = await env.AI_DB.prepare("SELECT * FROM alerts WHERE source_chat_id = ? AND source_message_id = ? LIMIT 1")
    .bind(chatId, messageId)
    .first();
  return row || null;
}

async function listAlerts(env, limit = 50) {
  requireDb(env);
  const safeLimit = Math.max(1, Math.min(200, limit || 50));
  const result = await env.AI_DB.prepare(
    `SELECT a.*, d.decision, d.confidence, d.risk_level, d.trade_quality, d.best_trade_score, d.entry_timing,
            d.c13_score, d.c1_score, d.volume_score, d.market_score, d.relative_strength_score, d.catalyst_score,
            d.reason, d.confirmations, d.red_flags, d.strengths, d.concerns, d.alpha_scanner, d.model, d.created_at AS decided_at,
            o.status AS outcome_status, o.pnl, o.r_multiple, o.exit_reason
     FROM alerts a
     LEFT JOIN ai_decisions d ON d.alert_id = a.id
     LEFT JOIN outcomes o ON o.alert_id = a.id
     ORDER BY a.received_at DESC
     LIMIT ?`,
  )
    .bind(safeLimit)
    .all();
  return (result.results || []).map(hydrateAlertRow);
}

async function buildSummary(env) {
  requireDb(env);
  const totals = await env.AI_DB.prepare(
    `SELECT
       COUNT(*) AS alerts,
       COALESCE(SUM(CASE WHEN d.decision IN ('take', 'approve') THEN 1 ELSE 0 END), 0) AS approved,
       COALESCE(SUM(CASE WHEN d.decision = 'take' THEN 1 ELSE 0 END), 0) AS takes,
       COALESCE(SUM(CASE WHEN d.decision = 'watch' THEN 1 ELSE 0 END), 0) AS watched,
       COALESCE(SUM(CASE WHEN d.decision = 'skip' THEN 1 ELSE 0 END), 0) AS skipped,
       AVG(d.confidence) AS avg_confidence,
       AVG(d.best_trade_score) AS avg_best_trade_score
     FROM alerts a
     LEFT JOIN ai_decisions d ON d.alert_id = a.id`,
  ).first();
  const outcomes = await env.AI_DB.prepare(
    `SELECT
       COUNT(*) AS closed,
       COALESCE(SUM(CASE WHEN status = 'win' THEN 1 ELSE 0 END), 0) AS wins,
       COALESCE(SUM(CASE WHEN status = 'loss' THEN 1 ELSE 0 END), 0) AS losses,
       COALESCE(SUM(pnl), 0) AS pnl,
       AVG(r_multiple) AS avg_r
     FROM outcomes
     WHERE status IN ('win', 'loss')`,
  ).first();
  const byGrade = await env.AI_DB.prepare(
    `SELECT COALESCE(d.trade_quality, a.grade) AS grade, COUNT(*) AS alerts, AVG(d.confidence) AS avg_confidence,
            AVG(d.best_trade_score) AS avg_best_trade_score,
            SUM(CASE WHEN o.status = 'win' THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN o.status = 'loss' THEN 1 ELSE 0 END) AS losses,
            AVG(o.r_multiple) AS avg_r
     FROM alerts a
     LEFT JOIN ai_decisions d ON d.alert_id = a.id
     LEFT JOIN outcomes o ON o.alert_id = a.id
     GROUP BY a.grade
     ORDER BY a.grade`,
  ).all();
  return { totals, outcomes, by_grade: byGrade.results || [] };
}

async function generateDailyReview(env) {
  requireDb(env);
  const summary = await buildSummary(env);
  const alerts = await listAlerts(env, 80);
  const reviewDate = todayKey();
  const aiConfig = getAiConfig(env);

  if (!aiConfig.apiKey) {
    const fallback = {
      summary: "AI daily review skipped because AI_API_KEY is not configured.",
      recommendations: ["Configure AI_API_KEY to enable daily learning summaries."],
      raw_response: null,
      model: "deterministic-fallback",
    };
    return await saveDailyReview(env, reviewDate, fallback);
  }

  const result = await callAiChat(env, [
    { role: "system", content: "You summarize shadow-mode trading performance. Return compact JSON with summary and recommendations array." },
    { role: "user", content: JSON.stringify({ review_date: reviewDate, summary, recent_alerts: alerts.slice(0, 30) }) },
  ]);
  const parsed = result.ok ? safeJson(result.content) : {};
  return await saveDailyReview(env, reviewDate, {
    summary: String(parsed.summary || result.error || "Daily review could not be generated.").slice(0, 2000),
    recommendations: normalizeStringArray(parsed.recommendations),
    raw_response: result.raw_response,
    model: result.model,
  });
}

async function saveDailyReview(env, reviewDate, review) {
  const row = {
    id: crypto.randomUUID(),
    review_date: reviewDate,
    summary: review.summary,
    recommendations: JSON.stringify(review.recommendations || []),
    raw_response: review.raw_response,
    model: review.model,
    created_at: new Date().toISOString(),
  };
  await env.AI_DB.prepare(
    "INSERT INTO daily_reviews (id, review_date, summary, recommendations, raw_response, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(row.id, row.review_date, row.summary, row.recommendations, row.raw_response, row.model, row.created_at)
    .run();
  return row;
}

async function listDailyReviews(env, limit = 5) {
  requireDb(env);
  const result = await env.AI_DB.prepare("SELECT * FROM daily_reviews ORDER BY created_at DESC LIMIT ?")
    .bind(Math.max(1, Math.min(20, limit)))
    .all();
  return (result.results || []).map((row) => ({
    ...row,
    recommendations: safeJson(row.recommendations || "[]"),
  }));
}

function parseKalkiAlert(text) {
  if (!text || typeof text !== "string") return null;
  const tickerMatch =
    text.match(/(?:^|\n)\s*(?:[^\w\s]|\u26a1)?\s*([A-Z]{1,6})(?:\s|$)/) ||
    text.match(/\bTicker:\s*([A-Z]{1,6})\b/i);
  const gradeMatch = text.match(/Grade:\s*([ABC][+-]?)/i);
  const scoreMatch = text.match(/Score:\s*([0-9]+\/[0-9]+)/i);
  const structureMatch = text.match(/Structure:\s*([0-9]+%?)/i);
  const priceMatch = text.match(/Price:\s*\$?([0-9]+(?:\.[0-9]+)?)/i);
  const entryMatch = text.match(/Entry:\s*\$?([0-9]+(?:\.[0-9]+)?)(?:\s*[-–]\s*\$?([0-9]+(?:\.[0-9]+)?))?/i);
  const stopMatch = text.match(/Stop:\s*\$?([0-9]+(?:\.[0-9]+)?)/i);
  const t1Match = text.match(/T1:\s*\$?([0-9]+(?:\.[0-9]+)?)/i);
  if (!tickerMatch || !gradeMatch || !entryMatch || !stopMatch || !t1Match) return null;

  const entryLow = Number(entryMatch[1]);
  const entryHigh = Number(entryMatch[2] || entryMatch[1]);
  const alert = {
    ticker: tickerMatch[1].toUpperCase(),
    grade: normalizeGrade(gradeMatch[1]),
    score: scoreMatch?.[1] || null,
    structure: structureMatch?.[1] || null,
    price: nullableNumber(priceMatch?.[1]),
    entryPrice: midpoint(entryLow, entryHigh),
    entryLow,
    entryHigh,
    stopPrice: Number(stopMatch[1]),
    t1: Number(t1Match[1]),
    t2: nullableNumber(text.match(/T2:\s*\$?([0-9]+(?:\.[0-9]+)?)/i)?.[1]),
    t3: nullableNumber(text.match(/T3:\s*\$?([0-9]+(?:\.[0-9]+)?)/i)?.[1]),
    raw: text,
  };

  if (
    !Number.isFinite(alert.entryPrice) ||
    !Number.isFinite(alert.stopPrice) ||
    !Number.isFinite(alert.t1) ||
    alert.entryPrice <= 0 ||
    alert.stopPrice <= 0 ||
    alert.t1 <= 0
  ) {
    return null;
  }
  return alert;
}

function readTelegramPayload(body) {
  const post = body?.message || body?.channel_post || body?.edited_message || body?.edited_channel_post || null;
  return {
    text: body?.text || post?.text || post?.caption || "",
    chatId: post?.chat?.id != null ? String(post.chat.id) : null,
    messageId: post?.message_id != null ? String(post.message_id) : null,
  };
}

function hydrateAlertRow(row) {
  return {
    ...row,
    confirmations: safeJson(row.confirmations || "[]"),
    red_flags: safeJson(row.red_flags || "[]"),
    strengths: safeJson(row.strengths || "[]"),
    concerns: safeJson(row.concerns || "[]"),
    alpha_scanner: safeJson(row.alpha_scanner || "null"),
  };
}

function corsJson(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function corsResponse(body, status = 200) {
  return new Response(body, { status, headers: corsHeaders() });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

function requireDb(env) {
  if (!env.AI_DB) throw new Error("AI_DB D1 binding is required");
}

function getSecretPath(env) {
  return String(env.SECRET_PATH || "kalki2026").replace(/^\/+|\/+$/g, "");
}

function getSourceChatId(env) {
  return env.SOURCE_CHAT_ID ? String(env.SOURCE_CHAT_ID).trim() : "";
}

function normalizeGrade(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeDecision(value) {
  const decision = String(value || "").trim().toLowerCase();
  if (decision === "approve") return "take";
  return ["take", "watch", "skip"].includes(decision) ? decision : "watch";
}

function normalizeTradeQuality(value) {
  const quality = String(value || "").trim().toUpperCase();
  return ["A+", "A", "B", "C"].includes(quality) ? quality : "B";
}

function normalizeEntryTiming(value) {
  const timing = String(value || "").trim().toLowerCase();
  return ["ready", "early", "extended", "late", "unknown"].includes(timing) ? timing : "unknown";
}

function normalizeMinGrade(value) {
  const grade = String(value || DEFAULT_MIN_GRADE).trim().toUpperCase().charAt(0);
  return ["A", "B", "C"].includes(grade) ? grade : DEFAULT_MIN_GRADE;
}

function isTradeableGrade(grade, minGrade) {
  const gradeIndex = GRADE_RANK.indexOf(normalizeGrade(grade));
  const thresholdIndex = maxGradeIndexForThreshold(minGrade);
  return gradeIndex >= 0 && gradeIndex <= thresholdIndex;
}

function maxGradeIndexForThreshold(minGrade) {
  const letter = String(minGrade || DEFAULT_MIN_GRADE).trim().toUpperCase().charAt(0);
  if (letter === "A") return GRADE_RANK.indexOf("A-");
  if (letter === "C") return GRADE_RANK.indexOf("C-");
  return GRADE_RANK.indexOf("B-");
}

function gradeBonus(grade) {
  const normalized = normalizeGrade(grade);
  if (normalized.startsWith("A")) return 10;
  if (normalized.startsWith("B")) return 4;
  return 0;
}

function gradeStrength(grade) {
  const normalized = normalizeGrade(grade);
  if (normalized === "A+") return 5;
  if (normalized === "A") return 4;
  if (normalized === "A-") return 3.5;
  if (normalized === "B+") return 3;
  if (normalized === "B") return 2.5;
  if (normalized === "B-") return 2;
  if (normalized.startsWith("C")) return 1;
  return 0;
}

function parseAlertScore(value) {
  const match = String(value || "").match(/([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const earned = Number(match[1]);
  const possible = Number(match[2]);
  if (!Number.isFinite(earned) || !Number.isFinite(possible) || possible <= 0) return null;
  return { earned, possible, ratio: earned / possible };
}

function parsePercent(value) {
  const number = nullableNumber(String(value || "").replace("%", ""));
  return number == null ? null : number;
}

function midpoint(low, high) {
  if (!Number.isFinite(low)) return null;
  if (!Number.isFinite(high)) return low;
  return (low + high) / 2;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactNumbers(values) {
  return Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : [];
}

function formatSigned(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0.0";
  return `${number >= 0 ? "+" : ""}${number.toFixed(1)}`;
}

function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeStringArray(value) {
  const array = Array.isArray(value) ? value : [];
  return array.map((item) => String(item).trim()).filter(Boolean).slice(0, 6);
}

function normalizeOutcomeStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return ["open", "win", "loss", "breakeven", "canceled"].includes(status) ? status : "open";
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function todayKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

function renderDashboard() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kalki AI Trade Agent</title>
  <style>
    :root{color-scheme:dark;--bg:#050a0f;--surface:#0a1520;--surface2:#0f1e2e;--border:#1a3040;--accent:#00d4ff;--good:#00ff88;--danger:#ff3b6b;--warn:#ffb347;--text:#d4e6ef;--muted:#6e8798;--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--ui:Inter,system-ui,Arial,sans-serif}
    *{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;background:linear-gradient(rgba(0,212,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,255,.035) 1px,transparent 1px),var(--bg);background-size:40px 40px;color:var(--text);font:14px/1.45 var(--ui)}
    .container{max-width:1320px;margin:0 auto;padding:18px 20px 36px}header{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:4px 0 16px;border-bottom:1px solid var(--border);margin-bottom:20px}.logo{display:flex;gap:12px;align-items:center}.logo-icon{width:38px;height:38px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--good));display:grid;place-items:center;color:#001018;font-weight:900;box-shadow:0 0 22px rgba(0,212,255,.25)}h1{font-size:22px;letter-spacing:2px;text-transform:uppercase;color:var(--accent);line-height:1}.logo span{display:block;margin-top:5px;font:10px var(--mono);letter-spacing:4px;color:var(--muted);text-transform:uppercase}.mode-badge{font:11px var(--mono);letter-spacing:2px;padding:6px 10px;border:1px solid var(--warn);border-radius:4px;color:var(--warn);background:rgba(255,179,71,.08);text-transform:uppercase}
    .stats{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:18px}.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;position:relative;overflow:hidden}.stat-card:after{content:'';position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--accent);opacity:.55}.stat-card.green:after{background:var(--good)}.stat-card.warn:after{background:var(--warn)}.stat-label{font:10px var(--mono);letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:7px}.stat-value{font:27px var(--mono);font-weight:800;color:var(--text);line-height:1}.green-text{color:var(--good)}.red-text{color:var(--danger)}.accent-text{color:var(--accent)}
    .grid{display:grid;grid-template-columns:1.1fr .9fr;gap:16px;margin-bottom:18px}.panel{background:var(--surface);border:1px solid var(--border);border-radius:9px;overflow:hidden}.panel-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--surface2);border-bottom:1px solid var(--border)}.panel-title{font:12px var(--mono);letter-spacing:2px;text-transform:uppercase;color:var(--accent)}.panel-body{min-height:160px;max-height:480px;overflow:auto}.empty{padding:34px 16px;text-align:center;color:var(--muted);font:12px var(--mono);letter-spacing:1px}
    .alert-item{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;padding:13px 16px;border-bottom:1px solid rgba(26,48,64,.55)}.badge{width:42px;height:42px;border-radius:6px;display:grid;place-items:center;border:1px solid rgba(0,212,255,.35);background:rgba(0,212,255,.12);color:var(--accent);font-weight:900}.ticker{font:15px var(--mono);font-weight:900;color:#fff}.meta{font:11px var(--mono);color:var(--muted);margin-top:3px}.reason{margin-top:6px;color:var(--text);font-size:12px}.prices{display:flex;gap:10px;flex-wrap:wrap;font:11px var(--mono);margin-top:4px}.stop{color:var(--danger)}.target{color:var(--good)}.pill{font:10px var(--mono);letter-spacing:1px;padding:4px 8px;border-radius:4px;border:1px solid rgba(0,255,136,.25);color:var(--good);background:rgba(0,255,136,.08);text-transform:uppercase}.pill.watch{border-color:rgba(255,179,71,.25);color:var(--warn);background:rgba(255,179,71,.08)}.pill.skip{border-color:rgba(255,59,107,.25);color:var(--danger);background:rgba(255,59,107,.08)}
    .manual{background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:18px;margin-bottom:18px}.manual-title{font:11px var(--mono);letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:12px}.manual-row{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:start}textarea,input,select{width:100%;border:1px solid var(--border);background:var(--surface2);color:var(--text);border-radius:6px;padding:10px 12px;font:13px var(--mono);outline:none}textarea{min-height:110px;resize:vertical}button{border:1px solid var(--border);background:var(--surface2);color:var(--accent);border-radius:6px;padding:10px 15px;font-weight:800;cursor:pointer;white-space:nowrap}button.primary{background:linear-gradient(135deg,var(--accent),#0099cc);border-color:transparent;color:#001018}
    .summary-list{display:grid;gap:10px;padding:14px 16px}.summary-item{padding:12px;border:1px solid rgba(26,48,64,.75);background:rgba(15,30,46,.55);border-radius:8px}.summary-item h3{font:13px var(--mono);color:#fff;margin-bottom:6px}.summary-item p{color:var(--muted);font-size:13px}#toast{position:fixed;right:22px;bottom:22px;display:grid;gap:8px;z-index:30}.toast{background:var(--surface2);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;padding:12px 14px;font:12px var(--mono);max-width:360px}.toast.err{border-left-color:var(--danger)}.toast.ok{border-left-color:var(--good)}
    @media(max-width:900px){.stats,.grid,.manual-row{grid-template-columns:1fr}.stat-value{font-size:23px}}
  </style>
</head>
<body>
<main class="container">
  <header>
    <div class="logo"><div class="logo-icon">AI</div><div><h1>Kalki AI Trade Agent</h1><span>Shadow Confirmation Engine</span></div></div>
    <div class="mode-badge" id="mode">Shadow Mode</div>
  </header>

  <section class="stats">
    <div class="stat-card"><div class="stat-label">Alerts</div><div class="stat-value" id="alerts">0</div></div>
    <div class="stat-card green"><div class="stat-label">Take</div><div class="stat-value green-text" id="approved">0</div></div>
    <div class="stat-card warn"><div class="stat-label">Watch</div><div class="stat-value" id="watched">0</div></div>
    <div class="stat-card"><div class="stat-label">Best Score</div><div class="stat-value accent-text" id="confidence">--</div></div>
    <div class="stat-card green"><div class="stat-label">Closed P&L</div><div class="stat-value green-text" id="pnl">$0.00</div></div>
  </section>

  <section class="grid">
    <div class="panel">
      <div class="panel-header"><span class="panel-title">Latest AI Decisions</span><button onclick="loadAll()">Refresh</button></div>
      <div class="panel-body" id="decisions"><div class="empty">Waiting for Telegram alerts...</div></div>
    </div>
    <div class="panel">
      <div class="panel-header"><span class="panel-title">What Is Working</span><button onclick="dailyReview()">Review</button></div>
      <div class="panel-body"><div class="summary-list" id="summary"><div class="empty">No performance data yet</div></div></div>
    </div>
  </section>

  <section class="manual">
    <div class="manual-title">Test Alert Without Saving</div>
    <div class="manual-row">
      <textarea id="alert">⚡ CRDO
📊 Grade: B | Score: 6/8
🧩 Structure: 92%
💰 Price: $181.04
📈 Entry: $181.04
🛑 Stop: $176 (-2.8%)
🎯 T1: $185 (+2.2%)</textarea>
      <button class="primary" onclick="preview()">Preview AI</button>
    </div>
  </section>
</main>
<div id="toast"></div>
<script>
function toast(msg,type){const box=document.getElementById('toast');const el=document.createElement('div');el.className='toast '+(type||'');el.textContent=msg;box.appendChild(el);setTimeout(()=>el.remove(),4300);}
function fmtMoney(v){const n=Number(v||0);return '$'+n.toFixed(2);}
function fmtPct(v){if(v===null||v===undefined)return '--';return Math.round(Number(v)*100)+'%';}
function et(value){if(!value)return '-';return new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}).format(new Date(value));}
async function health(){const r=await fetch('/api/health');const data=await r.json();document.getElementById('mode').textContent=data.ai_enabled?(String(data.ai_provider||'AI').toUpperCase()+' Shadow'):'Rules Shadow';}
async function loadAll(){await Promise.all([loadSummary(),loadAlerts()]);}
async function loadSummary(){const r=await fetch('/api/summary');const data=await r.json();if(!data.ok){toast(data.error,'err');return;}const s=data.summary;document.getElementById('alerts').textContent=s.totals?.alerts||0;document.getElementById('approved').textContent=s.totals?.takes||s.totals?.approved||0;document.getElementById('watched').textContent=s.totals?.watched||0;document.getElementById('confidence').textContent=s.totals?.avg_best_trade_score?Math.round(s.totals.avg_best_trade_score):'--';document.getElementById('pnl').textContent=fmtMoney(s.outcomes?.pnl||0);renderWorking(s,data.reviews||[]);}
function renderWorking(s,reviews){const box=document.getElementById('summary');const grades=(s.by_grade||[]).map(g=>'<div class="summary-item"><h3>Grade '+g.grade+'</h3><p>'+g.alerts+' alerts · '+(g.wins||0)+' wins · '+(g.losses||0)+' losses · avg R '+(g.avg_r?Number(g.avg_r).toFixed(2):'--')+'</p></div>').join('');const review=reviews[0]?'<div class="summary-item"><h3>Latest Review</h3><p>'+reviews[0].summary+'</p></div>':'';box.innerHTML=review+grades||'<div class="empty">No performance data yet</div>';}
async function loadAlerts(){const r=await fetch('/api/alerts?limit=60');const data=await r.json();if(!data.ok){toast(data.error,'err');return;}const box=document.getElementById('decisions');if(!data.alerts.length){box.innerHTML='<div class="empty">Waiting for Telegram alerts...</div>';return;}box.innerHTML=data.alerts.map(a=>{const decision=(a.decision==='approve'?'take':a.decision)||'pending';const cls=decision==='skip'?'skip':decision==='watch'?'watch':'';const flags=(a.red_flags||[]).slice(0,2).join(' · ');const confirms=(a.confirmations||[]).slice(0,2).join(' · ');const mc=a.alpha_scanner?.market_context||a.alpha_scanner?.marketContext;const live=mc?.ticker;const market=mc?.market;const rs=mc?.relativeStrength;const liveBits=[live?.currentPrice?('Live $'+Number(live.currentPrice).toFixed(2)):'',live?.volumeRatio?('Vol '+Number(live.volumeRatio).toFixed(1)+'x'):'',market?.condition?('Mkt '+market.condition):'',rs?.vsQqqPct!=null?('RS QQQ '+Number(rs.vsQqqPct).toFixed(1)+'%'):''].filter(Boolean).join(' · ');return '<div class="alert-item"><div class="badge">'+(a.trade_quality||a.grade||'--')+'</div><div><div class="ticker">'+a.ticker+' <span class="meta">'+et(a.received_at)+'</span></div><div class="prices"><span>Entry $'+Number(a.entry_price).toFixed(2)+'</span><span class="stop">Stop $'+Number(a.stop_price).toFixed(2)+'</span><span class="target">T1 $'+Number(a.t1).toFixed(2)+'</span><span>Score '+(a.best_trade_score??'--')+'</span><span>C13 '+(a.c13_score??'--')+'</span><span>C1 '+(a.c1_score??'--')+'</span><span>'+(a.entry_timing||'unknown')+'</span></div><div class="meta">'+liveBits+'</div><div class="reason">'+(a.reason||'No decision yet')+'</div><div class="meta">'+(confirms?('✓ '+confirms+' '):'')+(flags?('⚠ '+flags+' '):'')+(a.model||'')+'</div></div><div><span class="pill '+cls+'">'+decision+' '+(a.confidence||'--')+'%</span></div></div>';}).join('');}
async function preview(){const r=await fetch('/api/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:document.getElementById('alert').value})});const data=await r.json();toast(data.ok?(data.decision.decision+' '+(data.decision.trade_quality||'')+' score '+(data.decision.best_trade_score??'--')+': '+data.decision.reason):data.error,data.ok?'ok':'err');}
async function dailyReview(){const r=await fetch('/api/daily-review',{method:'POST'});const data=await r.json();toast(data.ok?'Daily review saved':data.error,data.ok?'ok':'err');await loadSummary();}
health();loadAll();
</script>
</body>
</html>`;
}
