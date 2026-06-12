const KALKI_ALERT_API = "https://api.kalkianalysis.com/api/alerts/lux";

let kalkiWebhookSecret = localStorage.getItem("lux_kalki_secret") || "";

function setKalkiWebhookSecret(secret) {
  kalkiWebhookSecret = String(secret || "").trim();
  localStorage.setItem("lux_kalki_secret", kalkiWebhookSecret);
}

function buildKalkiLuxPayload({ ticker, score, grade, price, entry, stop, t1, t2, timeframe, signal, vwapLabel, vwapDev, raw }) {
  return {
    ticker,
    score,
    scoreMax: 8,
    grade,
    timeframe,
    price,
    entry,
    stop,
    t1,
    t2,
    pattern: "Lux confluence alert",
    signal,
    vwapLabel,
    vwapDev,
    raw,
    receivedAt: new Date().toISOString(),
  };
}

async function sendKalkiLuxAlert(payload) {
  if (!kalkiWebhookSecret) return { ok: false, skipped: "Kalki webhook secret is not configured" };

  const response = await fetch(KALKI_ALERT_API, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${kalkiWebhookSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Kalki alert webhook failed with HTTP ${response.status}`);
  }
  return data;
}

