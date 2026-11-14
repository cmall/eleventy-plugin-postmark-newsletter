const crypto = require("node:crypto");
const { formatInZone } = require("./dates.js");
const { EMAIL } = require("./subscribers.js");

// Previews and tests go to you, not your subscribers. They're sent through a
// transactional stream with the unsubscribe link turned off, so clicking it in
// a preview can't unsubscribe you from your own newsletter.

const UNSUBSCRIBE = /\{\{\{\s*pm:unsubscribe\s*\}\}\}/g;

function parseAddresses(value, log = () => {}) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const a = String(raw || "").trim().toLowerCase();
    if (!a) continue;
    if (!EMAIL.test(a)) {
      log(`! Ignoring preview address "${a}": not a valid email.`);
      continue;
    }
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

// Changes whenever the email itself changes, so each new version is previewed once.
function previewVersion(nl) {
  return crypto.createHash("sha256").update(`${nl.subject}\0${nl.html}`).digest("hex").slice(0, 12);
}

function describe(nl, options) {
  if (nl.draft) return { label: "Draft", detail: "This is a draft" };
  if (nl.status === "scheduled") {
    return { label: "Scheduled", detail: `This is scheduled to go out ${formatInZone(nl.sendAt, options.timezone)}` };
  }
  return { label: "Preview", detail: "This hasn't been sent yet" };
}

function previewMessage(nl, options, to, { kind = "preview", tag } = {}) {
  const { label, detail } =
    kind === "test" ? { label: "Test", detail: "This is a test copy" } : describe(nl, options);
  const note = `${detail}. Subscribers haven't received it. The unsubscribe link is turned off in this copy.`;
  const banner =
    `<div style="background:#fff7d6;border-bottom:1px solid #e6d48a;padding:12px 16px;` +
    `font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.4;color:#4d3d00;text-align:center;">` +
    `<strong>${label}:</strong> ${escapeHtml(note)}</div>`;

  const html = nl.html.replace(UNSUBSCRIBE, "#");
  const withBanner = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (m) => m + banner) : banner + html;

  const msg = {
    From: options.from,
    To: to,
    Subject: `[${label}] ${nl.subject}`,
    HtmlBody: withBanner,
    TextBody: `${label.toUpperCase()}: ${note}\n\n${nl.text.replace(UNSUBSCRIBE, "#")}`,
    MessageStream: options.previewStream,
    Tag: tag,
    TrackOpens: false,
    TrackLinks: "None",
    Metadata: { newsletter: nl.slug, kind },
  };
  if (options.replyTo) msg.ReplyTo = options.replyTo;
  return msg;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

module.exports = { parseAddresses, previewVersion, previewMessage };
