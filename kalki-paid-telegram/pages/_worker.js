const PROTECTED_PATHS = new Set(["/", "/index.html"]);
const COOKIE_NAME = "kalki_site_auth_v2";
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/_auth/login") {
      return await handleLogin(request, env);
    }

    if (PROTECTED_PATHS.has(url.pathname) && !(await hasValidSession(request, env))) {
      return loginPage();
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleLogin(request, env) {
  const form = await request.formData();
  const password = String(form.get("password") || "");
  if (!env.SITE_PASSWORD || password !== env.SITE_PASSWORD) {
    return loginPage("Wrong password.");
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const token = `${issuedAt}.${await sign(String(issuedAt), env.SITE_PASSWORD)}`;
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `${COOKIE_NAME}=${token}; Max-Age=${MAX_AGE_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`,
      "Cache-Control": "no-store",
    },
  });
}

async function hasValidSession(request, env) {
  if (!env.SITE_PASSWORD) return false;
  const token = cookieValue(request.headers.get("Cookie") || "", COOKIE_NAME);
  const [issuedAtText, signature] = token.split(".");
  const issuedAt = Number(issuedAtText);
  if (!issuedAt || !signature) return false;
  if (Math.floor(Date.now() / 1000) - issuedAt > MAX_AGE_SECONDS) return false;
  return timingSafeEqual(signature, await sign(issuedAtText, env.SITE_PASSWORD));
}

function cookieValue(cookieHeader, name) {
  return cookieHeader
    .split(";")
    .map(part => part.trim())
    .find(part => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) || "";
}

async function sign(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function loginPage(error = "") {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Kalki Alerts</title>
  <style>
    :root{color-scheme:dark;--bg:#070b14;--panel:#101827;--text:#f8fafc;--dim:#94a3b8;--line:#23314b;--gold:#f59e0b;--red:#f87171}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at top left,#11251d,#070b14 46%),#070b14;color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    form{width:min(420px,calc(100vw - 32px));padding:24px;border:1px solid var(--line);border-radius:10px;background:rgba(16,24,39,.9);box-shadow:0 20px 80px rgba(0,0,0,.24)}
    h1{margin:0 0 8px;font-size:32px;letter-spacing:0}.copy{margin:0 0 18px;color:var(--dim);line-height:1.5}label{display:block;margin-bottom:16px;color:#cbd5e1;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:1px}input{display:block;width:100%;margin-top:8px;padding:14px 15px;border-radius:8px;border:1px solid #30415f;background:#080d17;color:var(--text);font-size:16px}button{width:100%;border:0;border-radius:8px;background:var(--gold);color:#111827;font-weight:900;font-size:15px;padding:15px 18px;cursor:pointer;text-transform:uppercase;letter-spacing:1px}.error{min-height:20px;color:var(--red)}
  </style>
</head>
<body>
  <form method="post" action="/_auth/login">
    <h1>Kalki Alerts</h1>
    <p class="copy">Enter the access password to open the platform.</p>
    <label>Password<input name="password" type="password" required autofocus></label>
    <p class="error">${escapeHtml(error)}</p>
    <button type="submit">Open Platform</button>
  </form>
</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
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
