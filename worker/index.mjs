// Newsletter signup service for Cloudflare Workers + D1.
//
// POST /subscribe          Signup form target. Double opt-in: sends a confirmation email.
// GET  /confirm?token=...  Shows a "Confirm" button (link scanners can't confirm by visiting).
// POST /confirm            Marks the subscriber active.
// GET  /subscribers        Active subscribers as JSON. Needs `Authorization: Bearer SUBSCRIBERS_TOKEN`.
// POST /webhooks/postmark  Postmark "Subscription change" webhook: keeps unsubscribes in sync.
// Cron trigger             Deletes signups that were never confirmed after 30 days.
//
// Bindings: DB (D1). Secrets: POSTMARK_SERVER_TOKEN, SUBSCRIBERS_TOKEN, WEBHOOK_SECRET,
// TURNSTILE_SECRET_KEY (optional). See wrangler.example.toml for the plain settings.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RESEND_AFTER = 10 * 60 * 1000; // one confirmation email per address per 10 minutes
const TOKEN_TTL = 7 * DAY;
const PENDING_TTL = 30 * DAY;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return cors(env, new Response(null, { status: 204 }));
      if (url.pathname === "/subscribe" && request.method === "POST") return cors(env, await subscribe(request, env, ctx));
      if (url.pathname === "/confirm" && request.method === "GET") return await confirmPage(url, env);
      if (url.pathname === "/confirm" && request.method === "POST") return await confirm(request, env);
      if (url.pathname === "/subscribers" && request.method === "GET") return await listSubscribers(request, env);
      if (url.pathname === "/webhooks/postmark" && request.method === "POST") return await postmarkWebhook(request, env);
      if (url.pathname === "/") return new Response("Newsletter signup service.\n", { headers: { "Content-Type": "text/plain" } });
      return new Response("Not found\n", { status: 404 });
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      if (url.pathname === "/subscribe") return cors(env, done(request, env, "error", "server"));
      return new Response("Something went wrong.\n", { status: 500 });
    }
  },

  async scheduled(event, env) {
    const cutoff = Date.now() - PENDING_TTL;
    await env.DB.prepare("DELETE FROM subscribers WHERE status = 'pending' AND confirmed_at IS NULL AND updated_at < ?")
      .bind(cutoff)
      .run();
  },
};

// ---------------------------------------------------------------- signup

async function subscribe(request, env, ctx) {
  const form = await readBody(request);
  const email = String(form.email || form.EMAIL || "").trim().toLowerCase();
  const firstName = clean(form.first_name || form.FNAME);
  const lastName = clean(form.last_name || form.LNAME);

  // Honeypot: real people never see this field. Pretend it worked.
  if (form.website || form.url || form.company_site) return done(request, env, "pending");

  if (env.TURNSTILE_SECRET_KEY) {
    const ok = await verifyTurnstile(form["cf-turnstile-response"], request, env);
    if (!ok) return done(request, env, "error", "verification");
  }

  if (email.length > 254 || !EMAIL.test(email)) return done(request, env, "error", "email");
  if (env.SKIP_MX_CHECK !== "true" && !(await domainAcceptsMail(email.split("@")[1]))) {
    return done(request, env, "error", "email");
  }

  const now = Date.now();
  const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?").bind(email).first();

  // Already subscribed: say nothing different, send nothing.
  if (row && row.status === "active") return done(request, env, "pending");
  if (row && row.status === "pending" && row.confirm_sent_at && now - row.confirm_sent_at < RESEND_AFTER) {
    return done(request, env, "pending");
  }

  // Cap confirmation emails overall so a flood can't burn through your Postmark quota.
  const max = Number(env.MAX_CONFIRMATIONS_PER_HOUR || 30);
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE confirm_sent_at > ?")
    .bind(now - HOUR)
    .first("n");
  if (recent >= max) return done(request, env, "error", "busy");

  const token = randomToken();
  await env.DB.prepare(
    `INSERT INTO subscribers (email, first_name, last_name, status, token, token_created_at, confirm_sent_at, created_at, updated_at, source)
     VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?5, ?5, ?5, 'form')
     ON CONFLICT(email) DO UPDATE SET
       first_name = CASE WHEN ?2 <> '' THEN ?2 ELSE first_name END,
       last_name = CASE WHEN ?3 <> '' THEN ?3 ELSE last_name END,
       status = 'pending', token = ?4, token_created_at = ?5, confirm_sent_at = ?5, updated_at = ?5`
  )
    .bind(email, firstName, lastName, token, now)
    .run();

  const link = `${new URL(request.url).origin}/confirm?token=${token}`;
  try {
    await sendConfirmation(env, { email, firstName, link });
  } catch (err) {
    console.error(err.message);
    // Let the person try again right away instead of waiting out the resend window.
    await env.DB.prepare("UPDATE subscribers SET confirm_sent_at = NULL WHERE email = ?").bind(email).run();
    return done(request, env, "error", "send");
  }
  return done(request, env, "pending");
}

async function confirmPage(url, env) {
  const token = url.searchParams.get("token") || "";
  const row = await findByToken(env, token);
  if (!row) return Response.redirect(pageUrl(env, "error", "link"), 303);
  if (row.status === "active") return Response.redirect(pageUrl(env, "confirmed"), 303);

  const site = escapeHtml(env.SITE_NAME || "this newsletter");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Confirm your subscription</title>
<style>body{font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;line-height:1.5;color:#1f2937}
button{font:inherit;font-weight:700;padding:.8rem 1.6rem;border:0;border-radius:6px;background:#1f2937;color:#fff;cursor:pointer}</style></head>
<body><h1>Confirm your subscription</h1><p>Press the button to start getting emails from ${site} at <strong>${escapeHtml(row.email)}</strong>.</p>
<form method="post" action="/confirm"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Confirm subscription</button></form></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

async function confirm(request, env) {
  const form = await readBody(request);
  const row = await findByToken(env, String(form.token || ""));
  if (!row) return Response.redirect(pageUrl(env, "error", "link"), 303);
  if (row.status !== "active") {
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE subscribers SET status = 'active', confirmed_at = ?1, updated_at = ?1, unsubscribed_at = NULL, unsubscribe_reason = NULL WHERE email = ?2"
    )
      .bind(now, row.email)
      .run();
    // Someone who unsubscribed and signed up again: lift Postmark's suppression if Postmark allows it.
    if (row.unsubscribed_at) await reactivateInPostmark(env, row.email);
  }
  return Response.redirect(pageUrl(env, "confirmed"), 303);
}

async function findByToken(env, token) {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const row = await env.DB.prepare("SELECT * FROM subscribers WHERE token = ?").bind(token).first();
  if (!row) return null;
  if (row.status === "pending" && Date.now() - row.token_created_at > TOKEN_TTL) return null;
  if (row.status === "unsubscribed") return null;
  return row;
}

// ---------------------------------------------------------------- list + webhook

async function listSubscribers(request, env) {
  if (!env.SUBSCRIBERS_TOKEN || !safeEqual(request.headers.get("Authorization") || "", `Bearer ${env.SUBSCRIBERS_TOKEN}`)) {
    return json({ error: "Unauthorized" }, 401);
  }
  const { results } = await env.DB.prepare(
    "SELECT email, first_name, last_name, confirmed_at FROM subscribers WHERE status = 'active' ORDER BY email"
  ).all();
  const subscribers = results.map((r) => ({ ...r, name: [r.first_name, r.last_name].filter(Boolean).join(" ") }));
  return json({ count: subscribers.length, subscribers });
}

async function postmarkWebhook(request, env) {
  if (!webhookAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
  const body = await request.json().catch(() => ({}));
  if (body.RecordType !== "SubscriptionChange" || !body.Recipient) return json({ ok: true, ignored: true });
  if (env.BROADCAST_STREAM && body.MessageStream && body.MessageStream !== env.BROADCAST_STREAM) {
    return json({ ok: true, ignored: true });
  }
  const email = String(body.Recipient).toLowerCase();
  const now = Date.now();
  if (body.SuppressSending) {
    await env.DB.prepare(
      "UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?1, unsubscribe_reason = ?2, updated_at = ?1 WHERE email = ?3 AND status <> 'unsubscribed'"
    )
      .bind(now, String(body.SuppressionReason || "Unsubscribe"), email)
      .run();
  } else {
    await env.DB.prepare(
      "UPDATE subscribers SET status = 'active', unsubscribed_at = NULL, unsubscribe_reason = NULL, updated_at = ?1 WHERE email = ?2 AND status = 'unsubscribed'"
    )
      .bind(now, email)
      .run();
  }
  return json({ ok: true });
}

function webhookAuthorized(request, env) {
  if (!env.WEBHOOK_SECRET) return false;
  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Basic ")) {
    try {
      const [, pass = ""] = atob(header.slice(6)).split(/:(.*)/s);
      return safeEqual(pass, env.WEBHOOK_SECRET);
    } catch {
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------- checks

async function verifyTurnstile(token, request, env) {
  if (!token) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.append("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const out = await res.json();
    return out.success === true;
  } catch {
    return false;
  }
}

// True if the domain can receive email (has MX records, or an A/AAAA record as a fallback).
// Fails open if DNS can't be checked, so a DNS hiccup never blocks a real signup.
async function domainAcceptsMail(domain) {
  const lookup = async (type) => {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(3000),
    });
    return res.json();
  };
  try {
    const mx = await lookup("MX");
    if (mx.Status === 3) return false; // domain doesn't exist
    const records = (mx.Answer || []).filter((a) => a.type === 15);
    if (records.length) return !records.every((a) => /^0\s+\.?$/.test(String(a.data).trim())); // "null MX" means no mail
    const a = await lookup("A");
    return (a.Answer || []).some((r) => r.type === 1);
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------- Postmark

async function postmark(env, path, body) {
  const base = (env.POSTMARK_API_URL || "https://api.postmarkapp.com").replace(/\/+$/, "");
  const res = await fetch(base + path, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": env.POSTMARK_SERVER_TOKEN },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Postmark ${path} failed (${res.status}): ${out.Message || ""}`);
  return out;
}

async function sendConfirmation(env, { email, firstName, link }) {
  const site = env.SITE_NAME || "our newsletter";
  const hi = firstName ? `Hi ${firstName},` : "Hi,";
  const text = `${hi}\n\nPlease confirm that you'd like to get emails from ${site}:\n\n${link}\n\nIf you didn't sign up, ignore this email and you won't hear from us again.\n`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px">
<tr><td style="padding:32px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:17px;line-height:1.6;color:#1f2937">
<p style="margin:0 0 16px">${escapeHtml(hi)}</p>
<p style="margin:0 0 24px">Please confirm that you'd like to get emails from ${escapeHtml(site)}.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 24px;background:#1f2937;color:#ffffff;text-decoration:none;font-weight:700;border-radius:6px">Confirm subscription</a></p>
<p style="margin:0;font-size:14px;color:#6b7280">If you didn't sign up, ignore this email and you won't hear from us again.</p>
</td></tr></table></td></tr></table></body></html>`;
  await postmark(env, "/email", {
    From: env.FROM_EMAIL,
    To: email,
    Subject: `Please confirm your subscription to ${site}`,
    TextBody: text,
    HtmlBody: html,
    MessageStream: env.CONFIRM_STREAM || "outbound",
    Tag: "newsletter-confirm",
    TrackLinks: "None",
    TrackOpens: false,
  });
}

async function reactivateInPostmark(env, email) {
  const stream = env.BROADCAST_STREAM || "broadcast";
  try {
    await postmark(env, `/message-streams/${encodeURIComponent(stream)}/suppressions/delete`, {
      Suppressions: [{ EmailAddress: email }],
    });
  } catch (err) {
    console.warn(`Couldn't lift Postmark suppression for ${email}: ${err.message}`);
  }
}

// ---------------------------------------------------------------- helpers

async function readBody(request) {
  const type = request.headers.get("Content-Type") || "";
  if (type.includes("application/json")) return (await request.json().catch(() => ({}))) || {};
  if (type.includes("form")) return Object.fromEntries(await request.formData());
  return {};
}

function done(request, env, page, reason) {
  const wantsJson = (request.headers.get("Accept") || "").includes("application/json");
  if (wantsJson) return json({ ok: page !== "error", status: page, reason: reason || null }, page === "error" ? 400 : 200);
  return Response.redirect(pageUrl(env, page, reason), 303);
}

function pageUrl(env, page, reason) {
  const site = (env.SITE_URL || "").replace(/\/+$/, "");
  const defaults = { pending: "/subscribe/check-email/", confirmed: "/subscribe/confirmed/", error: "/subscribe/problem/" };
  const custom = { pending: env.PENDING_URL, confirmed: env.CONFIRMED_URL, error: env.ERROR_URL }[page];
  const url = new URL(custom || site + defaults[page]);
  if (reason) url.searchParams.set("reason", reason);
  return url.toString();
}

function cors(env, response) {
  if (!env.SITE_URL) return response;
  const r = new Response(response.body, response);
  r.headers.set("Access-Control-Allow-Origin", new URL(env.SITE_URL).origin);
  r.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type, Accept");
  r.headers.set("Vary", "Origin");
  return r;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function clean(value) {
  return String(value || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 100);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
