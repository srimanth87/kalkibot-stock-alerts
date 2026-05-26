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
        return await requestAccess(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/request-access") {
        return await requestAccess(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/stripe-webhook") {
        return await handleStripeWebhook(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        return await getSessionStatus(url, env);
      }
      if (request.method === "GET" && url.pathname === "/admin/codes") {
        return await adminCodesPage(url, env);
      }
      if (request.method === "POST" && url.pathname === "/admin/codes") {
        return await adminSaveCode(request, url, env);
      }
      if (request.method === "POST" && url.pathname === "/admin/codes/delete") {
        return await adminDeleteCode(request, url, env);
      }
      if (request.method === "POST" && url.pathname === "/admin/groups") {
        return await adminSaveGroup(request, url, env);
      }
      if (request.method === "POST" && url.pathname === "/admin/groups/delete") {
        return await adminDeleteGroup(request, url, env);
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

async function requestAccess(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const firstName = cleanPersonName(body.firstName);
  const lastName = cleanPersonName(body.lastName);
  const email = cleanEmail(body.email);
  const telegramUsername = cleanTelegramUsername(body.telegramUsername);
  const access = await resolveAccess(env, body);
  if (!firstName) return jsonResponse({ ok: false, error: "Enter your first name." }, 400);
  if (!lastName) return jsonResponse({ ok: false, error: "Enter your last name." }, 400);
  if (!email) return jsonResponse({ ok: false, error: "Enter a valid email." }, 400);
  if (!telegramUsername) return jsonResponse({ ok: false, error: "Enter your Telegram username." }, 400);
  if (!access.groupChatId) return jsonResponse({ ok: false, error: "Telegram group is not configured yet." }, 400);

  if (!access.requiresStripe) {
    return await createDirectInvite(env, { firstName, lastName, email, telegramUsername, access });
  }

  assertEnv(env, ["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID"]);
  return await createCheckoutSession(request, env, { firstName, lastName, email, telegramUsername, access });
}

async function createCheckoutSession(request, env, { firstName, lastName, email, telegramUsername, access }) {
  const baseUrl = publicBaseUrl(request, env);
  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("line_items[0][price]", env.STRIPE_PRICE_ID);
  params.set("line_items[0][quantity]", "1");
  params.set("customer_email", email);
  params.set("client_reference_id", telegramUsername);
  params.set("metadata[first_name]", firstName);
  params.set("metadata[last_name]", lastName);
  params.set("metadata[telegram_username]", telegramUsername);
  params.set("metadata[group_key]", access.groupKey);
  params.set("metadata[source]", "kalki-paid-telegram");
  params.set("subscription_data[metadata][first_name]", firstName);
  params.set("subscription_data[metadata][last_name]", lastName);
  params.set("subscription_data[metadata][telegram_username]", telegramUsername);
  params.set("subscription_data[metadata][group_key]", access.groupKey);
  params.set("success_url", checkoutSuccessUrl(env, baseUrl));
  params.set("cancel_url", env.PUBLIC_CANCEL_URL || `${baseUrl}/cancel`);
  params.set("allow_promotion_codes", "true");

  const stripeSession = await stripeRequest(env, "POST", "/checkout/sessions", params);
  await recordAccessCodeUse(env, access);
  await upsertSubscriber(env, {
    id: crypto.randomUUID(),
    checkout_session_id: stripeSession.id,
    first_name: firstName,
    last_name: lastName,
    email,
    telegram_username: telegramUsername,
    group_key: access.groupKey,
    group_chat_id: access.groupChatId,
    access_source: "stripe",
    status: "checkout_created",
    raw_event_json: JSON.stringify({ checkout_session: stripeSession, access_code: access.accessCode }),
  });

  return jsonResponse({ ok: true, url: stripeSession.url, sessionId: stripeSession.id });
}

async function createDirectInvite(env, { firstName, lastName, email, telegramUsername, access }) {
  const sessionId = `${access.accessSource}_${crypto.randomUUID()}`;
  const inviteLink = await createTelegramInviteLink(env, sessionId, access.groupChatId);
  await recordAccessCodeUse(env, access);
  await upsertSubscriber(env, {
    id: crypto.randomUUID(),
    checkout_session_id: sessionId,
    first_name: firstName,
    last_name: lastName,
    email,
    telegram_username: telegramUsername,
    group_key: access.groupKey,
    group_chat_id: access.groupChatId,
    access_source: access.accessSource,
    status: "active",
    invite_link: inviteLink,
    invite_link_created_at: new Date().toISOString(),
    raw_event_json: JSON.stringify({
      source: access.accessSource,
      submitted_access_code: access.submittedAccessCode,
    }),
  });

  return jsonResponse({
    ok: true,
    inviteLink,
    sessionId,
    accessSource: access.accessSource,
    groupKey: access.groupKey,
  });
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
  const firstName = cleanPersonName(session.metadata?.first_name);
  const lastName = cleanPersonName(session.metadata?.last_name);
  const telegramUsername = cleanTelegramUsername(session.metadata?.telegram_username || session.client_reference_id);
  const groupKey = cleanGroupKey(session.metadata?.group_key);
  const groupChatId = await groupIdForKey(env, groupKey);
  const email = cleanEmail(session.customer_details?.email || session.customer_email);
  const inviteLink = await createTelegramInviteLink(env, session.id, groupChatId);
  await upsertSubscriber(env, {
    id: crypto.randomUUID(),
    checkout_session_id: session.id,
    stripe_customer_id: stringOrNull(session.customer),
    stripe_subscription_id: stringOrNull(session.subscription),
    first_name: firstName,
    last_name: lastName,
    email,
    telegram_username: telegramUsername,
    group_key: groupKey,
    group_chat_id: groupChatId,
    access_source: "stripe",
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
    SELECT checkout_session_id, first_name, last_name, email, telegram_username, group_key, status, invite_link
    FROM subscribers
    WHERE checkout_session_id = ?
  `).bind(sessionId).first();
  if (!row) return jsonResponse({ ok: true, pending: true });
  return jsonResponse({
    ok: true,
    status: row.status,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    telegramUsername: row.telegram_username,
    groupKey: row.group_key,
    inviteLink: isActiveStatus(row.status) ? row.invite_link : "",
    pending: !row.invite_link,
  });
}

async function adminList(url, env) {
  if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }
  const result = await env.DB.prepare(`
    SELECT first_name, last_name, email, telegram_username, group_key, access_source, status, invite_link_created_at, created_at, updated_at
    FROM subscribers
    ORDER BY updated_at DESC
    LIMIT 100
  `).all();
  return jsonResponse({ ok: true, subscribers: result.results || [] });
}

async function adminCodesPage(url, env) {
  if (!isAdminRequest(url, env)) return adminUnauthorizedPage();
  const result = await env.DB.prepare(`
    SELECT code, group_key, mode, active, max_uses, uses_count, notes, created_at, updated_at
    FROM access_codes
    ORDER BY updated_at DESC
  `).all();
  const rows = result.results || [];
  const membersResult = await env.DB.prepare(`
    SELECT first_name, last_name, email, telegram_username, group_key, access_source, status, invite_link_created_at, created_at, updated_at
    FROM subscribers
    ORDER BY updated_at DESC
    LIMIT 100
  `).all();
  const members = membersResult.results || [];
  const key = escapeHtml(url.searchParams.get("key") || "");
  const message = escapeHtml(url.searchParams.get("msg") || "");
  const groups = await accessGroups(env, { includeInactive: true });
  const activeGroups = groups.filter(group => group.active);
  const groupLabels = Object.fromEntries(groups.map(group => [group.group_key, group.label]));
  const groupOptions = activeGroups.map(group => `<option value="${escapeHtml(group.group_key)}">${escapeHtml(group.label)}</option>`).join("");
  const groupsHtml = groups.length ? groups.map(group => `
    <tr>
      <td><code>${escapeHtml(group.group_key)}</code></td>
      <td>${escapeHtml(group.label)}</td>
      <td><code>${escapeHtml(group.chat_id)}</code></td>
      <td>${group.active ? "Active" : "Paused"}</td>
      <td>${escapeHtml(group.notes || "")}</td>
      <td>
        <form method="post" action="/admin/groups?key=${key}">
          <input type="hidden" name="groupKey" value="${escapeHtml(group.group_key)}">
          <input type="hidden" name="label" value="${escapeHtml(group.label)}">
          <input type="hidden" name="chatId" value="${escapeHtml(group.chat_id)}">
          <input type="hidden" name="active" value="${group.active ? "1" : ""}">
          <input name="notes" value="${escapeHtml(group.notes === "Configured in Worker" ? "" : group.notes || "")}" placeholder="notes">
          <button type="submit">Save Notes</button>
        </form>
        ${group.source === "config" ? "" : `
        <form method="post" action="/admin/groups/delete?key=${key}">
          <input type="hidden" name="groupKey" value="${escapeHtml(group.group_key)}">
          <button class="danger" type="submit">Delete</button>
        </form>`}
      </td>
    </tr>
  `).join("") : `<tr><td colspan="6" class="empty">No groups yet.</td></tr>`;
  const rowsHtml = rows.length ? rows.map(row => `
    <tr>
      <td><code>${escapeHtml(row.code)}</code></td>
      <td>${escapeHtml(labelForGroupKey(row.group_key))}</td>
      <td>${row.mode === "manual" ? "Manual/Zelle" : "Stripe"}</td>
      <td>${row.active ? "Active" : "Paused"}</td>
      <td>${row.max_uses == null ? "Unlimited" : `${Number(row.uses_count || 0)} / ${Number(row.max_uses)}`}</td>
      <td>${escapeHtml(row.notes || "")}</td>
      <td>
        <form method="post" action="/admin/codes/delete?key=${key}">
          <input type="hidden" name="code" value="${escapeHtml(row.code)}">
          <button class="danger" type="submit">Delete</button>
        </form>
      </td>
    </tr>
  `).join("") : `<tr><td colspan="7" class="empty">No codes yet.</td></tr>`;
  const membersHtml = members.length ? members.map(member => {
    const fullName = [member.first_name, member.last_name].filter(Boolean).join(" ") || "Unknown";
    const groupLabel = groupLabels[member.group_key] || labelForGroupKey(member.group_key);
    return `
      <tr>
        <td>${escapeHtml(fullName)}</td>
        <td>${escapeHtml(member.email || "")}</td>
        <td><code>${escapeHtml(member.telegram_username || "")}</code></td>
        <td>${escapeHtml(groupLabel)}</td>
        <td>${escapeHtml(labelForSource(member.access_source))}</td>
        <td>${escapeHtml(member.status || "")}</td>
        <td>${escapeHtml(formatAdminDate(member.invite_link_created_at || member.created_at))}</td>
        <td>${escapeHtml(formatAdminDate(member.updated_at))}</td>
      </tr>
    `;
  }).join("") : `<tr><td colspan="8" class="empty">No members yet.</td></tr>`;

  return htmlResponse(pageShell("Access Codes", `
    <main class="wrap admin-wrap">
      <section class="hero">
        <p class="eyebrow">Admin</p>
        <h1>Access Codes</h1>
        <p class="copy">Create codes that route people to the right Telegram group. Stripe codes send them to checkout. Manual/Zelle codes skip Stripe and generate an invite.</p>
      </section>
      ${message ? `<p class="notice">${message}</p>` : ""}
      <form class="panel grid-form" method="post" action="/admin/groups?key=${key}">
        <label>Group name<input name="label" required placeholder="Dallas Friends"></label>
        <label>Telegram group ID<input name="chatId" required placeholder="-1001234567890"></label>
        <label>Notes<input name="notes" placeholder="optional"></label>
        <label class="check"><input name="active" type="checkbox" value="1" checked> Active</label>
        <button type="submit">Save Group</button>
      </form>
      <section class="panel table-panel">
        <table>
          <thead><tr><th>Group key</th><th>Name</th><th>Telegram ID</th><th>Status</th><th>Notes</th><th>Edit notes</th></tr></thead>
          <tbody>${groupsHtml}</tbody>
        </table>
      </section>
      <form class="panel grid-form" method="post" action="/admin/codes?key=${key}">
        <label>Code<input name="code" required placeholder="cincy-friend-001"></label>
        <label>Group<select name="groupKey" required>${groupOptions}</select></label>
        <label>Mode
          <select name="mode" required>
            <option value="stripe">Stripe required</option>
            <option value="manual">Manual/Zelle skip Stripe</option>
          </select>
        </label>
        <label>Max uses<input name="maxUses" type="number" min="1" placeholder="blank = unlimited"></label>
        <label>Notes<input name="notes" placeholder="who this code is for"></label>
        <label class="check"><input name="active" type="checkbox" value="1" checked> Active</label>
        <button type="submit">Save Code</button>
      </form>
      <section class="panel table-panel">
        <table>
          <thead><tr><th>Code</th><th>Group</th><th>Mode</th><th>Status</th><th>Uses</th><th>Notes</th><th></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </section>
      <section class="panel table-panel">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Telegram</th><th>Group</th><th>Source</th><th>Status</th><th>Invite</th><th>Updated</th></tr></thead>
          <tbody>${membersHtml}</tbody>
        </table>
      </section>
    </main>
  `));
}

async function adminSaveCode(request, url, env) {
  if (!isAdminRequest(url, env)) return adminUnauthorizedPage();
  const form = await request.formData();
  const code = cleanAccessCode(form.get("code"));
  const groupKey = cleanGroupKey(form.get("groupKey"));
  const mode = String(form.get("mode") || "") === "manual" ? "manual" : "stripe";
  const maxUsesValue = String(form.get("maxUses") || "").trim();
  const maxUses = maxUsesValue ? Math.max(1, Number(maxUsesValue)) : null;
  const active = form.get("active") === "1" ? 1 : 0;
  const notes = String(form.get("notes") || "").trim().slice(0, 240);

  if (!code || !(await groupIdForKey(env, groupKey))) {
    return redirectToCodes(url, "Invalid code or group.");
  }

  await env.DB.prepare(`
    INSERT INTO access_codes (code, group_key, mode, active, max_uses, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      group_key = excluded.group_key,
      mode = excluded.mode,
      active = excluded.active,
      max_uses = excluded.max_uses,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).bind(code, groupKey, mode, active, maxUses, notes, new Date().toISOString(), new Date().toISOString()).run();

  return redirectToCodes(url, `Saved code ${code}.`);
}

async function adminDeleteCode(request, url, env) {
  if (!isAdminRequest(url, env)) return adminUnauthorizedPage();
  const form = await request.formData();
  const code = cleanAccessCode(form.get("code"));
  if (code) {
    await env.DB.prepare(`DELETE FROM access_codes WHERE code = ?`).bind(code).run();
  }
  return redirectToCodes(url, code ? `Deleted code ${code}.` : "Code not found.");
}

async function adminSaveGroup(request, url, env) {
  if (!isAdminRequest(url, env)) return adminUnauthorizedPage();
  const form = await request.formData();
  const label = String(form.get("label") || "").trim().slice(0, 80);
  const providedGroupKey = cleanGroupKey(form.get("groupKey"));
  const groupKey = providedGroupKey || cleanGroupKey(label);
  const chatId = cleanTelegramChatId(form.get("chatId"));
  const active = form.get("active") === "1" ? 1 : 0;
  const notes = String(form.get("notes") || "").trim().slice(0, 240);

  if (!groupKey || !label || !chatId) {
    return redirectToCodes(url, "Invalid group key, name, or Telegram ID.");
  }

  await env.DB.prepare(`
    INSERT INTO access_groups (group_key, label, chat_id, active, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_key) DO UPDATE SET
      label = excluded.label,
      chat_id = excluded.chat_id,
      active = excluded.active,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).bind(groupKey, label, chatId, active, notes, new Date().toISOString(), new Date().toISOString()).run();

  return redirectToCodes(url, `Saved group ${groupKey}.`);
}

async function adminDeleteGroup(request, url, env) {
  if (!isAdminRequest(url, env)) return adminUnauthorizedPage();
  const form = await request.formData();
  const groupKey = cleanGroupKey(form.get("groupKey"));
  if (groupKey) {
    await env.DB.prepare(`DELETE FROM access_groups WHERE group_key = ?`).bind(groupKey).run();
  }
  return redirectToCodes(url, groupKey ? `Deleted group ${groupKey}.` : "Group not found.");
}

async function upsertSubscriber(env, data) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO subscribers (
      id, checkout_session_id, stripe_customer_id, stripe_subscription_id, first_name, last_name, email,
      telegram_username, group_key, group_chat_id, access_source, status, invite_link,
      invite_link_created_at, created_at, updated_at, raw_event_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(checkout_session_id) DO UPDATE SET
      stripe_customer_id = COALESCE(excluded.stripe_customer_id, subscribers.stripe_customer_id),
      stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, subscribers.stripe_subscription_id),
      first_name = COALESCE(excluded.first_name, subscribers.first_name),
      last_name = COALESCE(excluded.last_name, subscribers.last_name),
      email = COALESCE(excluded.email, subscribers.email),
      telegram_username = COALESCE(excluded.telegram_username, subscribers.telegram_username),
      group_key = COALESCE(excluded.group_key, subscribers.group_key),
      group_chat_id = COALESCE(excluded.group_chat_id, subscribers.group_chat_id),
      access_source = COALESCE(excluded.access_source, subscribers.access_source),
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
    stringOrNull(data.first_name),
    stringOrNull(data.last_name),
    stringOrNull(data.email),
    stringOrNull(data.telegram_username),
    stringOrNull(data.group_key),
    stringOrNull(data.group_chat_id),
    stringOrNull(data.access_source),
    data.status || "pending",
    stringOrNull(data.invite_link),
    stringOrNull(data.invite_link_created_at),
    now,
    now,
    stringOrNull(data.raw_event_json),
  ).run();
}

async function createTelegramInviteLink(env, sessionId, groupChatId) {
  assertEnv(env, ["TELEGRAM_BOT_TOKEN"]);
  if (!groupChatId) throw new Error("Missing Telegram group for checkout session");
  const ttl = Number(env.TELEGRAM_INVITE_TTL_SECONDS || 86400);
  const expireDate = Math.floor(Date.now() / 1000) + Math.max(300, ttl);
  const result = await telegramRequest(env, "createChatInviteLink", {
    chat_id: groupChatId,
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
        <label>First name<input name="firstName" required placeholder="First name"></label>
        <label>Last name<input name="lastName" required placeholder="Last name"></label>
        <label>Email<input name="email" type="email" required placeholder="you@example.com"></label>
        <label>Telegram username<input name="telegramUsername" required placeholder="@yourhandle"></label>
        <label>Access code<input name="accessCode" placeholder="optional code"></label>
        <button id="submitBtn" type="submit">Continue</button>
        <p id="msg" class="msg"></p>
        <p class="fine">Educational content only. Not personalized financial, investment, tax, or legal advice.</p>
      </form>
    </main>
    <script>
      const form = document.getElementById('joinForm');
      const msg = document.getElementById('msg');
      form.addEventListener('submit', async event => {
        event.preventDefault();
        msg.textContent = 'Checking access...';
        const data = Object.fromEntries(new FormData(form).entries());
        const res = await fetch('/api/request-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const json = await res.json();
        if (!json.ok) {
          msg.textContent = json.error || 'Could not start checkout.';
          return;
        }
        if (json.inviteLink) {
          msg.innerHTML = '<p>Your invite is ready:</p><a class="invite" href="' + json.inviteLink + '">Join Telegram group</a>';
          return;
        }
        msg.textContent = 'Opening secure checkout...';
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
    .panel{background:rgba(16,24,39,.86);border:1px solid var(--line);border-radius:10px;padding:24px;box-shadow:0 20px 80px rgba(0,0,0,.22)}label{display:block;margin-bottom:16px;color:#cbd5e1;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:1px}input,select{display:block;width:100%;margin-top:8px;padding:14px 15px;border-radius:8px;border:1px solid #30415f;background:#080d17;color:var(--text);font-size:16px}button{width:100%;border:0;border-radius:8px;background:var(--gold);color:#111827;font-weight:900;font-size:15px;padding:15px 18px;cursor:pointer;text-transform:uppercase;letter-spacing:1px}.msg,.fine{color:var(--dim);line-height:1.5}.fine{font-size:12px}.result{margin-top:18px;padding:18px;border:1px solid var(--line);border-radius:8px;background:#080d17;color:#cbd5e1}.invite{display:inline-block;margin-top:8px;padding:13px 16px;border-radius:8px;background:var(--green);color:#03120c;text-decoration:none;font-weight:900}
    .admin-wrap{width:min(1180px,calc(100vw - 32px))}.grid-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;align-items:end}.grid-form label{margin:0}.grid-form button{align-self:end}.check{display:flex;gap:10px;align-items:center;height:49px}.check input{width:auto;margin:0}.notice{margin:0 0 18px;padding:12px 14px;border:1px solid rgba(16,185,129,.3);border-radius:8px;background:rgba(16,185,129,.12);color:#bbf7d0}.table-panel{margin-top:18px;overflow:auto}table{width:100%;border-collapse:collapse;min-width:860px}th,td{padding:12px;border-bottom:1px solid var(--line);text-align:left;color:#cbd5e1;font-size:14px}th{color:#94a3b8;text-transform:uppercase;letter-spacing:1px;font-size:11px}td form{display:flex;gap:8px;align-items:center;margin:0 0 8px}td form:last-child{margin-bottom:0}td input{min-width:220px;margin:0;padding:9px 10px;font-size:14px}td button{width:auto;padding:9px 12px;font-size:12px}code{color:#f8fafc}.danger{padding:9px 12px;background:#7f1d1d;color:#fecaca}.empty{text-align:center;color:var(--dim)}
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

function cleanPersonName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function cleanGroupKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function cleanTelegramChatId(value) {
  const chatId = String(value || "").trim();
  return /^-?\d{6,}$/.test(chatId) ? chatId : "";
}

function cleanAccessCode(value) {
  return cleanGroupKey(value);
}

async function resolveAccess(env, body) {
  const submittedAccessCode = cleanAccessCode(body.accessCode);

  const dbCode = submittedAccessCode ? await lookupAccessCode(env, submittedAccessCode) : null;
  if (dbCode) {
    const mode = dbCode.mode === "manual" ? "manual" : "stripe";
    return {
      requiresStripe: mode !== "manual",
      accessSource: mode === "manual" ? "manual_code" : "stripe_code",
      groupKey: dbCode.group_key,
      groupChatId: await groupIdForKey(env, dbCode.group_key),
      accessCode: dbCode.code,
      submittedAccessCode,
    };
  }

  const submittedCodeGroupId = submittedAccessCode ? await groupIdForKey(env, submittedAccessCode) : "";
  if (submittedAccessCode && submittedCodeGroupId) {
    return {
      requiresStripe: true,
      accessSource: "stripe",
      groupKey: submittedAccessCode,
      groupChatId: submittedCodeGroupId,
      accessCode: submittedAccessCode,
      submittedAccessCode,
    };
  }

  return {
    requiresStripe: true,
    accessSource: submittedAccessCode ? "stripe_other_invalid_code" : "stripe_other_no_code",
    groupKey: "other",
    groupChatId: await groupIdForKey(env, "other"),
    accessCode: "",
    submittedAccessCode,
  };
}

async function lookupAccessCode(env, code) {
  const row = await env.DB.prepare(`
    SELECT code, group_key, mode, active, max_uses, uses_count
    FROM access_codes
    WHERE code = ?
  `).bind(code).first();
  if (!row || !row.active) return null;
  if (row.max_uses != null && Number(row.uses_count || 0) >= Number(row.max_uses)) return null;
  if (!(await groupIdForKey(env, row.group_key))) return null;
  return row;
}

async function recordAccessCodeUse(env, access) {
  if (!access.accessCode) return;
  await env.DB.prepare(`
    UPDATE access_codes
    SET uses_count = uses_count + 1, updated_at = ?
    WHERE code = ?
  `).bind(new Date().toISOString(), access.accessCode).run();
}

function configGroupMap(env) {
  try {
    const parsed = JSON.parse(env.TELEGRAM_GROUP_MAP || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function accessGroups(env, { includeInactive = false } = {}) {
  const map = new Map();
  for (const [groupKey, chatId] of Object.entries(configGroupMap(env))) {
    const cleanKey = cleanGroupKey(groupKey);
    if (!cleanKey || !stringOrNull(chatId)) continue;
    map.set(cleanKey, {
      group_key: cleanKey,
      label: labelForGroupKey(cleanKey),
      chat_id: String(chatId),
      active: true,
      notes: "Configured in Worker",
      source: "config",
    });
  }

  const dbRows = await env.DB.prepare(`
    SELECT group_key, label, chat_id, active, notes, created_at, updated_at
    FROM access_groups
    ORDER BY group_key
  `).all();
  for (const row of dbRows.results || []) {
    const cleanKey = cleanGroupKey(row.group_key);
    if (!cleanKey) continue;
    const active = Boolean(row.active);
    if (!active && !includeInactive) {
      map.delete(cleanKey);
      continue;
    }
    map.set(cleanKey, {
      group_key: cleanKey,
      label: row.label || labelForGroupKey(cleanKey),
      chat_id: String(row.chat_id || ""),
      active,
      notes: row.notes || "",
      source: "db",
    });
  }

  return [...map.values()]
    .filter(group => includeInactive || group.active)
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function groupIdForKey(env, key) {
  const cleanKey = cleanGroupKey(key);
  const group = (await accessGroups(env)).find(item => item.group_key === cleanKey);
  return stringOrNull(group?.chat_id);
}

function labelForGroupKey(key) {
  return String(key || "").replace(/[-_]+/g, " ").replace(/\b\w/g, ch => ch.toUpperCase());
}

function labelForSource(source) {
  const value = String(source || "").replace(/_/g, " ");
  return value ? value.replace(/\b\w/g, ch => ch.toUpperCase()) : "";
}

function formatAdminDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  });
}

function isAdminRequest(url, env) {
  return Boolean(env.ADMIN_KEY && url.searchParams.get("key") === env.ADMIN_KEY);
}

function adminUnauthorizedPage() {
  return htmlResponse(pageShell("Unauthorized", `
    <main class="wrap">
      <section class="panel">
        <p class="eyebrow">Admin</p>
        <h1>Unauthorized</h1>
        <p class="copy">Add your admin key to the URL to manage access codes.</p>
      </section>
    </main>
  `), 401);
}

function redirectToCodes(url, message) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: `/admin/codes?key=${encodeURIComponent(url.searchParams.get("key") || "")}&msg=${encodeURIComponent(message)}`,
      "Cache-Control": "no-store",
    },
  });
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
