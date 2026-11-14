const { renderNewsletters } = require("./render.js");
const { PostmarkClient } = require("./postmark.js");
const { loadSubscribers, formatAddress } = require("./subscribers.js");
const { formatInZone } = require("./dates.js");
const { parseAddresses, previewVersion, previewMessage } = require("./preview.js");

const DAY = 24 * 60 * 60 * 1000;

function classify(nl, now, opts, { late = false } = {}) {
  if (nl.error) return "invalid";
  if (nl.draft) return "draft";
  if (!nl.sendAt) return "unscheduled";
  const age = now.getTime() - nl.sendAt.getTime();
  if (age < 0) return "scheduled";
  if (!late && age > opts.maxAgeDays * DAY) return "expired";
  return "due";
}

async function loadPlan({ now = new Date(), late = false, only, cwd, configPath } = {}) {
  const { options, newsletters } = await renderNewsletters({ cwd, configPath });
  let list = newsletters.map((nl) => ({ ...nl, status: classify(nl, now, options, { late }) }));
  if (only) {
    list = list.filter((nl) => nl.slug === only);
    if (!list.length) throw new Error(`No newsletter named "${only}". Run \`eleventy-newsletter list\` to see them.`);
  }
  return { options, newsletters: list };
}

function buildMessage(nl, options, to, overrides = {}) {
  const msg = {
    From: options.from,
    To: to,
    Subject: overrides.subject || nl.subject,
    HtmlBody: nl.html,
    TextBody: nl.text,
    MessageStream: options.messageStream,
    Tag: overrides.tag || nl.tag,
    TrackOpens: Boolean(options.trackOpens),
    TrackLinks: options.trackLinks || "None",
    Metadata: { newsletter: nl.slug },
  };
  if (options.replyTo) msg.ReplyTo = options.replyTo;
  return msg;
}

function tally(results) {
  const out = { sent: 0, suppressed: 0, failed: [] };
  for (const r of results) {
    if (r.ErrorCode === 0) out.sent++;
    else if (r.ErrorCode === 406) out.suppressed++;
    else out.failed.push(`${r.To || "?"}: ${r.Message} (code ${r.ErrorCode})`);
  }
  return out;
}

function requireSender(options) {
  if (!options.from) throw new Error("Set the plugin's `from` option, e.g. \"Your Name <you@example.com>\".");
}

/**
 * Sends every newsletter that is due. Safe to run as often as you like:
 * recipients who already got a newsletter (found by its Postmark tag) are skipped.
 * Also emails a preview of each new version of a draft or scheduled newsletter
 * to the `previewTo` addresses.
 */
async function sendDue({ dryRun = false, only, late = false, now = new Date(), cwd, configPath, env = process.env, log = console.log } = {}) {
  if (late && !only) throw new Error("--late needs --only <name>, so only that newsletter is sent late.");
  const { options, newsletters } = await loadPlan({ now, late, only, cwd, configPath });
  const due = newsletters.filter((nl) => nl.status === "due");
  const previewTo = parseAddresses(env.NEWSLETTER_PREVIEW_TO || options.previewTo, log);

  for (const nl of newsletters.filter((n) => n.status === "invalid")) log(`! ${nl.inputPath}: ${nl.error}`);
  if (!due.length && !previewTo.length) {
    log("Nothing is due to send.");
    return { newsletters: [], previews: 0, failed: 0 };
  }

  requireSender(options);
  const token = env.POSTMARK_SERVER_TOKEN;
  if (!token && !dryRun) throw new Error("POSTMARK_SERVER_TOKEN isn't set.");
  const pm = token ? new PostmarkClient(token, { baseUrl: env.POSTMARK_API_URL }) : null;
  if (!pm) log("(No POSTMARK_SERVER_TOKEN, so Postmark wasn't checked for earlier sends or unsubscribes.)");

  const report = [];
  let failed = 0;

  if (!due.length) log("Nothing is due to send.");
  else {
    const { subscribers, invalid } = await loadSubscribers(options.subscribers, { cwd, env });
    if (invalid.length) log(`Skipping ${invalid.length} invalid address(es).`);
    if (!subscribers.length) throw new Error("The subscriber list is empty, so nothing was sent. Check the `subscribers` source.");
    const suppressed = pm ? await pm.suppressed(options.messageStream) : new Set();

    for (const nl of due) {
      for (const w of nl.warnings) log(`  note (${nl.slug}): ${w}`);
      // If Postmark can't tell us who already got it, stop rather than risk duplicates.
      const already = pm ? await pm.sentRecipients(nl.tag, options.messageStream) : new Set();
      const recipients = subscribers.filter((s) => !suppressed.has(s.email) && !already.has(s.email));

      const when = formatInZone(nl.sendAt, options.timezone) + (nl.sendAtSource === "committed" ? ", when committed" : "");
      log(
        `${dryRun ? "[dry run] " : ""}"${nl.subject}" (${nl.slug}, scheduled ${when}): ` +
          `${recipients.length} to send, ${already.size} already sent, ` +
          `${subscribers.filter((s) => suppressed.has(s.email)).length} unsubscribed or suppressed.`
      );

      if (dryRun || !recipients.length) {
        report.push({ slug: nl.slug, toSend: recipients.length, sent: 0 });
        continue;
      }

      const messages = recipients.map((s) => buildMessage(nl, options, formatAddress(s)));
      const result = tally(await pm.sendBatch(messages));
      failed += result.failed.length;
      log(`  Sent ${result.sent}${result.suppressed ? `, ${result.suppressed} skipped by Postmark as inactive` : ""}${result.failed.length ? `, ${result.failed.length} failed` : ""}.`);
      for (const f of result.failed.slice(0, 10)) log(`    ${f}`);
      report.push({ slug: nl.slug, ...result });
    }
  }

  const previews = await sendPreviews({ newsletters, options, pm, to: previewTo, dryRun, log });
  failed += previews.failed;
  return { newsletters: report, previews: previews.sent, failed };
}

/** Emails each new version of a draft or scheduled newsletter to the preview addresses, once. */
async function sendPreviews({ newsletters, options, pm, to, dryRun, log }) {
  const out = { sent: 0, failed: 0 };
  if (!to.length) return out;
  const pending = newsletters.filter((nl) => ["draft", "scheduled", "unscheduled"].includes(nl.status));
  for (const nl of pending) {
    const tag = `${nl.tag}-preview-${previewVersion(nl)}`;
    const already = pm ? await pm.sentRecipients(tag, options.previewStream) : new Set();
    const recipients = to.filter((a) => !already.has(a));
    if (!recipients.length) continue;

    log(`${dryRun ? "[dry run] " : ""}Preview of "${nl.subject}" (${nl.slug}, ${nl.status}): new version, sending to ${recipients.length} preview address(es).`);
    if (dryRun) continue;
    const result = tally(await pm.sendBatch(recipients.map((a) => previewMessage(nl, options, a, { tag }))));
    out.sent += result.sent;
    out.failed += result.failed.length;
    for (const f of result.failed) log(`  ${f}`);
  }
  return out;
}

/** Sends a [Test] copy of one newsletter to the given addresses, with the unsubscribe link turned off. */
async function sendTest({ only, to = [], cwd, configPath, env = process.env, log = console.log, now = new Date() } = {}) {
  const addresses = parseAddresses(to);
  if (!addresses.length) throw new Error("Give one or more valid addresses with --to.");

  const { options, newsletters } = await loadPlan({ now, only, cwd, configPath });
  const nl = only ? newsletters[0] : newsletters.find((n) => n.status === "due" || n.status === "scheduled");
  if (!nl) throw new Error("No upcoming newsletter found. Pick one with --only <name>.");
  if (nl.error) throw new Error(`${nl.inputPath}: ${nl.error}`);

  requireSender(options);
  const pm = new PostmarkClient(env.POSTMARK_SERVER_TOKEN, { baseUrl: env.POSTMARK_API_URL });
  for (const w of nl.warnings) log(`  note: ${w}`);
  const messages = addresses.map((a) => previewMessage(nl, options, a, { kind: "test", tag: `${nl.tag}-test` }));
  const result = tally(await pm.sendBatch(messages));
  log(`Test of "${nl.subject}" sent to ${result.sent} address(es).${result.suppressed ? ` ${result.suppressed} skipped: that address is suppressed in Postmark.` : ""}`);
  for (const f of result.failed) log(`  ${f}`);
  return result;
}

async function listNewsletters({ cwd, configPath, env = process.env, log = console.log, now = new Date() } = {}) {
  const { options, newsletters } = await loadPlan({ now, cwd, configPath });
  if (!newsletters.length) {
    log(`No newsletters yet. Add Markdown files to ${options.newslettersPath}/.`);
    return newsletters;
  }
  const pm = env.POSTMARK_SERVER_TOKEN ? new PostmarkClient(env.POSTMARK_SERVER_TOKEN, { baseUrl: env.POSTMARK_API_URL }) : null;
  for (const nl of newsletters) {
    let sent = "";
    if (pm && nl.sendAt && nl.sendAt <= now) {
      const count = (await pm.sentRecipients(nl.tag, options.messageStream)).size;
      sent = ` · sent to ${count}`;
    }
    let when = nl.sendAt ? formatInZone(nl.sendAt, options.timezone) : "no sendDate";
    if (nl.sendAtSource === "committed") when += " (no sendDate, so the commit time)";
    log(`${nl.status.padEnd(11)} ${nl.slug}  "${nl.subject}"  ${when}${sent}`);
    if (nl.error) log(`            ! ${nl.error}`);
    if (nl.note) log(`            ${nl.note}`);
    if (nl.previewUrl) log(`            preview: ${nl.previewUrl} (while eleventy --serve is running)`);
  }
  return newsletters;
}

module.exports = { sendDue, sendTest, listNewsletters, classify, loadPlan };
