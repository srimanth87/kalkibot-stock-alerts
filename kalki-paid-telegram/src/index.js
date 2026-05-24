const STRIPE_API_BASE = "https://api.stripe.com/v1";

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") return corsResponse(null, 204);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/join")) {
        return htmlResponse(joinPage(env));
      }
      if (request.method === "GET" && url.pathname === "/success") {
        return htmlResponse(successPage());
      }
      if (request.method === "GET" && url.pathname === "/cancel") {
        return htmlResponse(cancelPage());
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, service: "kalki-paid-telegram" });
      }
      if (request.method === "POST" && url.pathname === "/api/create-checkout-session") {
        return await createCheckoutSession(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/stripe-webhook") {
        return await handleStripeWebhook(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        return await getSessionStatus(url, env);
      }
      if (request.method === "GET" && url.pathname === "/admin") {
        return await adminList(url, env);
      }

      return jsonResponse({ ok: false, error: "Not found" }, 404);
    } catch (error) {
      return jsonResponse({ ok: false, error: error.message || "Server error" }, 500);
    }
  },
};

async function createCheckoutSession(request, env) {
  assertEnv(env, ["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID"]);
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const email = cleanEmail(body.email);
  const telegramUsername = cleanTelegramUsername(body.telegramUsername);
  if (!email) return jsonResponse({ ok: false, error: "Enter a valid email." }, 400);
  if (!telegramUsername) return jsonResponse({ ok: false, error: "Enter your Telegram username." }, 400);

  const baseUrl = publicBaseUrl(request, env);
  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("line_items[0][price]", env.STRIPE_PRICE_ID);
  params.set("line_items[0][quantity]", "1");
  params.set("customer_email", email);
  params.set("client_reference_id", telegramUsername);
  params.set("metadata[telegram_username]", telegramUsername);
  params.set("metadata[source]", "kalki-paid-telegram");
  params.set("subscription_data[metadata][telegram_username]", telegramUsername);
  params.set("success_url", checkoutSuccessUrl(env, baseUrl));
  params.set("cancel_url", env.PUBLIC_CANCEL_URL || `${baseUrl}/cancel`);
  params.set("allow_promotion_codes", "true");

  const stripeSession = await stripeRequest(env, "POST", "/checkout/sessions", params);
  await upsertSubscriber(env, {
    id: crypto.randomUUID(),
    checkout_session_id: stripeSession.id,
    email,
    telegram_username: telegramUsername,
    status: "checkout_created",
    raw_event_json: JSON.stringify({ checkout_session: stripeSession }),
  });

  return jsonResponse({ ok: true, url: stripeSession.url, sessionId: stripeSession.id });
}

async function handleStripeWebhook(request, env) {
  assertEnv(env, ["STRIPE_WEBHOOK_SECRET"]);
  const payload = await request.text();
  const signature = request.headers.get("Stripe-Signature") || "";
  const verified = await verifyStripeSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!verified.ok) return jsonResponse({ ok: false, error: verified.error }, 400);

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return jsonResponse({ ok: false, error: "Invalid webhook JSON" }, 400);
  }

  if (event.type === "checkout.session.completed") {
    await handleCheckoutCompleted(event.data.object, event, env);
  } else if (event.type === "customer.subscription.updated") {
    await handleSubscriptionStatus(event.data.object, event, env);
  } else if (event.type === "customer.subscription.deleted") {
    await handleSubscriptionStatus(event.data.object, event, env, "canceled");
  } else if (event.type === "invoice.payment_failed") {
    await handleInvoicePaymentFailed(event.data.object, event, env);
  }

  return jsonResponse({ ok: true, received: true });
}

async function handleCheckoutCompleted(session, event, env) {
  const telegramUsername = cleanTelegramUsername(session.metadata?.telegram_username || session.client_reference_id);
  const email = cleanEmail(session.customer_details?.email || session.customer_email);
  const inviteLink = await createTelegramInviteLink(env, session.id);
  await upsertSubscriber(env, {
    id: crypto.randomUUID(),
    checkout_session_id: session.id,
    stripe_customer_id: stringOrNull(session.customer),
    stripe_subscription_id: stringOrNull(session.subscription),
    email,
    telegram_username: telegramUsername,
    status: session.subscription ? "active" : session.payment_status || "paid",
    invite_link: inviteLink,
    invite_link_created_at: new Date().toISOString(),
    raw_event_json: JSON.stringify(event),
  });
}

async function handleSubscriptionStatus(subscription, event, env, forcedStatus = "") {
  const status = forcedStatus || subscription.status || "unknown";
  await env.DB.prepare(`
    UPDATE subscribers
    SET status = ?, updated_at = ?, raw_event_json = ?
    WHERE stripe_subscription_id = ?
  `).bind(status, new Date().toISOString(), JSON.stringify(event), stringOrNull(subscription.id)).run();
}

async function handleInvoicePaymentFailed(invoice, event, env) {
  const subscriptionId = stringOrNull(invoice.subscription);
  if (!subscriptionId) return;
  await env.DB.prepare(`
    UPDATE subscribers
    SET status = 'payment_failed', updated_at = ?, raw_event_json = ?
    WHERE stripe_subscription_id = ?
  `).bind(new Date().toISOString(), JSON.stringify(event), subscriptionId).run();
}

async function getSessionStatus(url, env) {
  const sessionId = url.searchParams.get("session_id") || "";
  if (!sessionId) return jsonResponse({ ok: false, error: "Missing session_id" }, 400);
  const row = await env.DB.prepare(`
    SELECT checkout_session_id, email, telegram_username, status, invite_link
    FROM subscribers
    WHERE checkout_session_id = ?
  `).bind(sessionId).first();
  if (!row) return jsonResponse({ ok: true, pending: true });
  return jsonResponse({
    ok: true,
    status: row.status,
    email: row.email,
    telegramUsername: row.telegram_username,
    inviteLink: isActiveStatus(row.status) ? row.invite_link : "",
    pending: !row.invite_link,
  });
}

async function adminList(url, env) {
  if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }
  const result = await env.DB.prepare(`
    SELECT email, telegram_username, status, invite_link_created_at, created_at, updated_at
    FROM subscribers
    ORDER BY updated_at DESC
    LIMIT 100
  `).all();
  return jsonResponse({ ok: true, subscribers: result.results || [] });
}

async function upsertSubscriber(env, data) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO subscribers (
      id, checkout_session_id, stripe_customer_id, stripe_subscription_id, email,
      telegram_username, status, invite_link, invite_link_created_at, created_at,
      updated_at, raw_event_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(checkout_session_id) DO UPDATE SET
      stripe_customer_id = COALESCE(excluded.stripe_customer_id, subscribers.stripe_customer_id),
      stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, subscribers.stripe_subscription_id),
      email = COALESCE(excluded.email, subscribers.email),
      telegram_username = COALESCE(excluded.telegram_username, subscribers.telegram_username),
      status = excluded.status,
      invite_link = COALESCE(excluded.invite_link, subscribers.invite_link),
      invite_link_created_at = COALESCE(excluded.invite_link_created_at, subscribers.invite_link_created_at),
      updated_at = excluded.updated_at,
      raw_event_json = COALESCE(excluded.raw_event_json, subscribers.raw_event_json)
  `).bind(
    data.id,
    data.checkout_session_id,
    stringOrNull(data.stripe_customer_id),
    stringOrNull(data.stripe_subscription_id),
    stringOrNull(data.email),
    stringOrNull(data.telegram_username),
    data.status || "pending",
    stringOrNull(data.invite_link),
    stringOrNull(data.invite_link_created_at),
    now,
    now,
    stringOrNull(data.raw_event_json),
  ).run();
}

async function createTelegramInviteLink(env, sessionId) {
  assertEnv(env, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_GROUP_ID"]);
  const ttl = Number(env.TELEGRAM_INVITE_TTL_SECONDS || 86400);
  const expireDate = Math.floor(Date.now() / 1000) + Math.max(300, ttl);
  const result = await telegramRequest(env, "createChatInviteLink", {
    chat_id: env.TELEGRAM_GROUP_ID,
    name: `Kalki paid ${sessionId.slice(-8)}`,
    expire_date: expireDate,
    member_limit: 1,
    creates_join_request: false,
  });
  if (!result.invite_link) throw new Error("Telegram did not return an invite link");
  return result.invite_link;
}

async function telegramRequest(env, methodName, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${methodName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram ${methodName} failed`);
  }
  return data.result;
}

async function stripeRequest(env, method, path, body) {
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Stripe request failed");
  return data;
}

async function verifyStripeSignature(payload, signatureHeader, secret) {
  const parts = Object.fromEntries(signatureHeader.split(",").map(part => {
    const [key, ...rest] = part.split("=");
    return [key, rest.join("=")];
  }));
  const timestamp = parts.t;
  const expected = parts.v1;
  if (!timestamp || !expected) return { ok: false, error: "Missing Stripe signature" };
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return { ok: false, error: "Stale Stripe signature" };
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const actual = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(actual, expected)
    ? { ok: true }
    : { ok: false, error: "Invalid Stripe signature" };
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function joinPage(env) {
  const productName = escapeHtml(env.PRODUCT_NAME || "Kalki Alerts Telegram Membership");
  return pageShell("Join Kalki Alerts", `
    <main class="wrap">
      <section class="hero">
        <div>
          <p class="eyebrow">Paid Telegram Membership</p>
          <h1>${productName}</h1>
          <p class="copy">Monthly access to watchlists, swing-trade alerts, technical analysis, and educational market commentary.</p>
        </div>
      </section>
      <form id="joinForm" class="panel">
        <label>Email<input name="email" type="email" required placeholder="you@example.com"></label>
        <label>Telegram username<input name="telegramUsername" required placeholder="@yourhandle"></label>
        <button type="submit">Subscribe with Stripe</button>
        <p id="msg" class="msg"></p>
        <p class="fine">Educational content only. Not personalized financial, investment, tax, or legal advice.</p>
      </form>
    </main>
    <script>
      const form = document.getElementById('joinForm');
      const msg = document.getElementById('msg');
      form.addEventListener('submit', async event => {
        event.preventDefault();
        msg.textContent = 'Opening secure checkout...';
        const data = Object.fromEntries(new FormData(form).entries());
        const res = await fetch('/api/create-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const json = await res.json();
        if (!json.ok) {
          msg.textContent = json.error || 'Could not start checkout.';
          return;
        }
        location.href = json.url;
      });
    </script>
  `);
}

function successPage() {
  return pageShell("Payment received", `
    <main class="wrap">
      <section class="panel">
        <p class="eyebrow">Payment received</p>
        <h1>Your Telegram access is being prepared.</h1>
        <p class="copy">This usually takes a few seconds after Stripe confirms the subscription.</p>
        <div id="result" class="result">Checking subscription...</div>
      </section>
    </main>
    <script>
      const result = document.getElementById('result');
      const sessionId = new URLSearchParams(location.search).get('session_id');
      async function check() {
        if (!sessionId) {
          result.textContent = 'Missing checkout session. Contact support.';
          return;
        }
        const res = await fetch('/api/session?session_id=' + encodeURIComponent(sessionId));
        const json = await res.json();
        if (json.inviteLink) {
          result.innerHTML = '<p>Your one-time invite link is ready:</p><a class="invite" href="' + json.inviteLink + '">Join Telegram group</a>';
          return;
        }
        result.textContent = 'Still waiting for Stripe confirmation. Refreshing...';
        setTimeout(check, 2500);
      }
      check();
    </script>
  `);
}

function cancelPage() {
  return pageShell("Checkout canceled", `
    <main class="wrap">
      <section class="panel">
        <p class="eyebrow">Checkout canceled</p>
        <h1>No payment was completed.</h1>
        <p class="copy"><a href="/join">Return to signup</a></p>
      </section>
    </main>
  `);
}

function pageShell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root{color-scheme:dark;--bg:#070b14;--panel:#101827;--text:#f8fafc;--dim:#94a3b8;--line:#23314b;--gold:#f59e0b;--green:#10b981}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#11251d,#070b14 42%),#070b14;color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .wrap{width:min(920px,calc(100vw - 32px));margin:0 auto;padding:72px 0}.hero{padding:28px 0 20px}.eyebrow{margin:0 0 10px;color:var(--gold);font-size:12px;text-transform:uppercase;letter-spacing:1.8px;font-weight:800}.hero h1,.panel h1{margin:0 0 12px;font-size:clamp(32px,6vw,58px);line-height:1.02;letter-spacing:0}.copy{color:var(--dim);font-size:17px;line-height:1.6;max-width:680px}
    .panel{background:rgba(16,24,39,.86);border:1px solid var(--line);border-radius:10px;padding:24px;box-shadow:0 20px 80px rgba(0,0,0,.22)}label{display:block;margin-bottom:16px;color:#cbd5e1;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:1px}input{display:block;width:100%;margin-top:8px;padding:14px 15px;border-radius:8px;border:1px solid #30415f;background:#080d17;color:var(--text);font-size:16px}button{width:100%;border:0;border-radius:8px;background:var(--gold);color:#111827;font-weight:900;font-size:15px;padding:15px 18px;cursor:pointer;text-transform:uppercase;letter-spacing:1px}.msg,.fine{color:var(--dim);line-height:1.5}.fine{font-size:12px}.result{margin-top:18px;padding:18px;border:1px solid var(--line);border-radius:8px;background:#080d17;color:#cbd5e1}.invite{display:inline-block;margin-top:8px;padding:13px 16px;border-radius:8px;background:var(--green);color:#03120c;text-decoration:none;font-weight:900}
    a{color:#93c5fd}
  </style>
</head>
<body>${body}</body>
</html>`;
}

function cleanEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function cleanTelegramUsername(value) {
  const username = String(value || "").trim().replace(/^@/, "");
  return /^[A-Za-z0-9_]{5,32}$/.test(username) ? `@${username}` : "";
}

function isActiveStatus(status) {
  return ["active", "trialing", "paid"].includes(String(status || ""));
}

function publicBaseUrl(request, env) {
  return String(env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");
}

function checkoutSuccessUrl(env, baseUrl) {
  const configured = String(env.PUBLIC_SUCCESS_URL || "").trim();
  if (!configured) return `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`;
  if (configured.includes("{CHECKOUT_SESSION_ID}")) return configured;
  const separator = configured.includes("?") ? "&" : "?";
  return `${configured}${separator}session_id={CHECKOUT_SESSION_ID}`;
}

function assertEnv(env, keys) {
  const missing = keys.filter(key => !env[key]);
  if (missing.length) throw new Error(`Missing env: ${missing.join(", ")}`);
}

function stringOrNull(value) {
  return value == null || value === "" ? null : String(value);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function jsonResponse(data, status = 200) {
  return corsResponse(JSON.stringify(data), status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
}

function htmlResponse(markup, status = 200) {
  return new Response(markup, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function corsResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Stripe-Signature",
      ...headers,
    },
  });
}
