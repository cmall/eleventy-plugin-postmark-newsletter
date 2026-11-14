const REGISTRY = Symbol.for("eleventy-plugin-postmark-newsletter");

const DEFAULTS = {
  // Folder (inside your Eleventy input folder) that holds newsletter files.
  dir: "newsletters",
  // Your site's public URL. Relative links and images are made absolute with it.
  siteUrl: "",
  // Time zone for sendDate values that don't include an offset, e.g. "America/Vancouver".
  timezone: "UTC",
  // Time used when sendDate is a date with no time, e.g. "2026-12-01".
  defaultSendTime: "09:00",
  // Sender, e.g. "Scott Mallinson <hello@scott.fyi>". Must be a verified sender in Postmark.
  from: "",
  replyTo: "",
  // Postmark broadcast message stream ID.
  messageStream: "broadcast",
  // Your own address(es). Each new version of a draft or scheduled newsletter is
  // emailed here once, so you can see it before subscribers do.
  // NEWSLETTER_PREVIEW_TO overrides this.
  previewTo: [],
  // Postmark stream for previews and tests. A transactional stream, so the
  // unsubscribe link can be turned off in your copies.
  previewStream: "outbound",
  // Where the subscriber list comes from: a URL that returns JSON, a path to a
  // .json or .csv file, or an async function that returns [{ email, name }].
  subscribers: null,
  // A newsletter with no sendDate goes out as soon as its file is committed
  // (the commit date is used as its send time). Set false to require a sendDate.
  sendUndated: true,
  // A newsletter is only sent automatically within this many days of its sendDate,
  // so an old file never goes out by surprise.
  maxAgeDays: 7,
  // Postmark tag prefix. The tag is how already-sent recipients are found.
  tagPrefix: "newsletter-",
  // Inline <style> rules into style="" attributes for email clients.
  inlineCss: true,
  // Render newsletters as normal pages while running `eleventy --serve`, for previews.
  previewInServe: true,
  trackOpens: false,
  trackLinks: "None",
};

function normalizeOptions(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  opts.dir = String(opts.dir).replace(/^\.?\/+|\/+$/g, "");
  opts.siteUrl = String(opts.siteUrl || "").replace(/\/+$/, "");
  return opts;
}

function setActiveOptions(opts) {
  globalThis[REGISTRY] = opts;
}

function getActiveOptions() {
  return globalThis[REGISTRY];
}

module.exports = { DEFAULTS, normalizeOptions, setActiveOptions, getActiveOptions };
