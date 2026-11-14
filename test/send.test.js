const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const fixture = path.join(__dirname, "fixture");
const NOW = new Date("2026-11-14T18:00:00Z");

const { mockPostmark } = require("./mock-postmark.js");

test("a normal build leaves newsletters out of the site", () => {
  const out = path.join(fixture, "_site");
  fs.rmSync(out, { recursive: true, force: true });
  const env = { ...process.env };
  delete env.ELEVENTY_NEWSLETTER_RENDER;
  const cmd = path.join(path.dirname(require.resolve("@11ty/eleventy")), "..", "cmd.cjs");
  const r = spawnSync(process.execPath, [cmd, "--quiet"], { cwd: fixture, env, encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(out, "index.html")));
  assert.ok(!fs.existsSync(path.join(out, "newsletters")), "newsletters folder must not be built");
  fs.rmSync(out, { recursive: true, force: true });
});

test("send: renders, filters, sends once, and never twice", async (t) => {
  process.chdir(fixture);
  const { sendDue, listNewsletters } = require("../lib/send.js");
  const pm = await mockPostmark();
  t.after(() => pm.server.close());
  const env = { POSTMARK_SERVER_TOKEN: "test-token", POSTMARK_API_URL: pm.url };
  const logs = [];
  const log = (m) => logs.push(m);

  const listed = await listNewsletters({ env, log, now: NOW });
  const status = Object.fromEntries(listed.map((n) => [n.slug, n.status]));
  assert.deepStrictEqual(status, { due: "due", scheduled: "scheduled", draft: "draft", old: "expired", broken: "invalid" });

  // Dry run sends nothing.
  await sendDue({ env, log, now: NOW, dryRun: true });
  assert.strictEqual(pm.sent.length, 0);

  const first = await sendDue({ env, log, now: NOW });
  assert.strictEqual(first.failed, 0);
  const to = pm.sent.map((m) => m.To).sort();
  assert.deepStrictEqual(to, ['"Ann Lee" <a@example.com>', '"OBrien, Pat" <quoted@example.com>', "b@example.com"]);

  const msg = pm.sent[0];
  assert.strictEqual(msg.Subject, "Due newsletter");
  assert.strictEqual(msg.MessageStream, "broadcast");
  assert.strictEqual(msg.Tag, "newsletter-due");
  assert.strictEqual(msg.From, "Test Sender <sender@example.com>");
  assert.match(msg.HtmlBody, /href="https:\/\/example\.com\/posts\/hello\/"/, "links are absolute");
  assert.match(msg.HtmlBody, /src="https:\/\/example\.com\/img\/photo\.jpg"/, "images are absolute");
  assert.match(msg.HtmlBody, /<p style="color: #123456;?"/, "CSS is inlined");
  assert.match(msg.HtmlBody, /@media \(max-width: 600px\)/, "media queries are kept");
  assert.match(msg.HtmlBody, /href="\{\{\{ pm:unsubscribe \}\}\}"/, "unsubscribe placeholder survives");
  assert.match(msg.TextBody, /\{\{\{ pm:unsubscribe \}\}\}/, "text version has the unsubscribe link");
  assert.doesNotMatch(msg.TextBody, /Hidden preview text/, "preheader is left out of the text version");

  // Running again (e.g. the next scheduled check) sends nothing new.
  await sendDue({ env, log, now: NOW });
  assert.strictEqual(pm.sent.length, 3);

  // A newly added subscriber gets it on the next run; nobody else does.
  const csv = path.join(fixture, "subscribers.csv");
  const original = fs.readFileSync(csv, "utf8");
  t.after(() => fs.writeFileSync(csv, original));
  fs.writeFileSync(csv, original + "new@example.com,New,\r\n");
  await sendDue({ env, log, now: NOW });
  assert.strictEqual(pm.sent.length, 4);
  assert.strictEqual(pm.sent[3].To, '"New" <new@example.com>');

  // Expired newsletters only go out with --late and --only.
  await assert.rejects(sendDue({ env, log, now: NOW, late: true }), /--late needs --only/);
  await sendDue({ env, log, now: NOW, late: true, only: "old" });
  assert.strictEqual(pm.sent.filter((m) => m.Tag === "newsletter-old").length, 4);
});
