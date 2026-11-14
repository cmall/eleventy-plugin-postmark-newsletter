const fs = require("node:fs");
const path = require("node:path");

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

/**
 * Loads subscribers from the `subscribers` option:
 *  - a URL returning JSON (sent with `Authorization: Bearer $NEWSLETTER_SUBSCRIBERS_TOKEN` when set)
 *  - a path to a .json or .csv file
 *  - an async function returning an array
 * Each entry can be a string or an object with `email` and optional
 * `name` / `first_name` / `last_name`. Returns a de-duplicated list.
 */
async function loadSubscribers(source, { cwd = process.cwd(), env = process.env } = {}) {
  const src = env.NEWSLETTER_SUBSCRIBERS || source;
  if (!src) throw new Error("No subscriber source. Set the plugin's `subscribers` option.");

  let raw;
  if (typeof src === "function") {
    raw = await src();
  } else if (/^https?:\/\//i.test(src)) {
    const headers = { Accept: "application/json" };
    if (env.NEWSLETTER_SUBSCRIBERS_TOKEN) headers.Authorization = `Bearer ${env.NEWSLETTER_SUBSCRIBERS_TOKEN}`;
    const res = await fetch(src, { headers });
    if (!res.ok) throw new Error(`Subscriber list request failed (${res.status} ${res.statusText}) from ${src}`);
    raw = await res.json();
  } else {
    const file = path.resolve(cwd, src);
    const text = fs.readFileSync(file, "utf8");
    raw = /\.csv$/i.test(file) ? parseCsv(text) : JSON.parse(text);
  }

  if (raw && !Array.isArray(raw)) raw = raw.subscribers;
  if (!Array.isArray(raw)) throw new Error("Subscriber source didn't return a list.");

  const seen = new Map();
  const invalid = [];
  for (const entry of raw) {
    const s = normalize(entry);
    if (!s) continue;
    if (!EMAIL.test(s.email)) {
      invalid.push(s.email);
      continue;
    }
    if (!seen.has(s.email)) seen.set(s.email, s);
  }
  return { subscribers: [...seen.values()], invalid };
}

function normalize(entry) {
  if (!entry) return null;
  if (typeof entry === "string") return { email: entry.trim().toLowerCase(), name: "" };
  const email = String(entry.email || entry.Email || entry.EmailAddress || entry["Email Address"] || "").trim().toLowerCase();
  if (!email) return null;
  const first = entry.first_name || entry.firstName || entry["First Name"] || "";
  const last = entry.last_name || entry.lastName || entry["Last Name"] || "";
  const name = String(entry.name || [first, last].filter(Boolean).join(" ")).trim();
  return { email, name };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((v) => v.trim()));
  if (!header) return [];
  const keys = header.map((h) => h.trim().replace(/^﻿/, ""));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] || "").trim()])));
}

function formatAddress({ email, name }) {
  if (!name) return email;
  const clean = name.replace(/["\\\r\n<>]/g, "").trim();
  return clean ? `"${clean}" <${email}>` : email;
}

module.exports = { loadSubscribers, parseCsv, formatAddress, EMAIL };
