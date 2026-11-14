const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const { mockPostmark } = require("./mock-postmark.js");

const fixture = path.join(__dirname, "fixture");
const NOW = new Date("2026-11-14T18:00:00Z");

test("previews: each new version of a draft or scheduled newsletter is emailed to you once", async (t) => {
  process.chdir(fixture);
  const { sendDue, sendTest } = require("../lib/send.js");
  const pm = await mockPostmark();
  t.after(() => pm.server.close());
  const env = { POSTMARK_SERVER_TOKEN: "test-token", POSTMARK_API_URL: pm.url, NEWSLETTER_PREVIEW_TO: "Me@Example.com, not-an-email" };
  const logs = [];
  const log = (m) => logs.push(m);
  const previews = () => pm.sent.filter((m) => m.MessageStream === "outbound");

  await sendDue({ env, log, now: NOW });
  assert.ok(logs.some((l) => /Ignoring preview address "not-an-email"/.test(l)));
  const first = previews();
  assert.deepStrictEqual(first.map((m) => m.Subject).sort(), ["[Draft] Draft", "[Scheduled] Future"]);
  for (const m of first) {
    assert.strictEqual(m.To, "me@example.com");
    assert.match(m.HtmlBody, /Subscribers haven(&#39;|')t received it/);
    assert.doesNotMatch(m.HtmlBody, /pm:unsubscribe/, "unsubscribe link is turned off in previews");
    assert.doesNotMatch(m.TextBody, /pm:unsubscribe/);
  }
  assert.match(first.find((m) => m.Subject === "[Scheduled] Future").TextBody, /^SCHEDULED: This is scheduled to go out Jan 1, 2099/);
  // The due newsletter still went to subscribers through the broadcast stream, and nobody else got a preview.
  assert.strictEqual(pm.sent.filter((m) => m.MessageStream === "broadcast").length, 3);

  // Nothing changed: no new previews.
  await sendDue({ env, log, now: NOW });
  assert.strictEqual(previews().length, 2);

  // Edit the draft: exactly one new preview, of the draft.
  const draft = path.join(fixture, "src/newsletters/draft.md");
  const original = fs.readFileSync(draft, "utf8");
  t.after(() => fs.writeFileSync(draft, original));
  fs.writeFileSync(draft, original.replace("Not yet.", "Not yet, but closer."));
  // Each real run is its own process (Eleventy caches file contents within one), so run the CLI.
  await execFile(process.execPath, [path.join(__dirname, "..", "bin", "cli.js"), "send"], {
    cwd: fixture,
    env: { ...process.env, ...env },
  });
  assert.strictEqual(previews().length, 3);
  assert.strictEqual(previews()[2].Subject, "[Draft] Draft");
  assert.match(previews()[2].HtmlBody, /Not yet, but closer\./);

  // A test send is safe too: transactional stream, unsubscribe link off.
  await sendTest({ env, log, now: NOW, only: "due", to: ["me@example.com"] });
  const testMsg = pm.sent[pm.sent.length - 1];
  assert.strictEqual(testMsg.Subject, "[Test] Due newsletter");
  assert.strictEqual(testMsg.MessageStream, "outbound");
  assert.strictEqual(testMsg.Tag, "newsletter-due-test");
  assert.doesNotMatch(testMsg.HtmlBody, /pm:unsubscribe/);
});

test("previews are off when no preview address is set", async (t) => {
  process.chdir(fixture);
  const { sendDue } = require("../lib/send.js");
  const pm = await mockPostmark();
  t.after(() => pm.server.close());
  await sendDue({ env: { POSTMARK_SERVER_TOKEN: "test-token", POSTMARK_API_URL: pm.url }, log: () => {}, now: NOW });
  assert.strictEqual(pm.sent.filter((m) => m.MessageStream === "outbound").length, 0);
});
