const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const pluginRoot = path.join(__dirname, "..");
const NOW = new Date("2026-11-14T18:00:00Z");

function git(args, cwd, date) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  if (date) env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = date;
  return execFileSync("git", args, { cwd, env, stdio: "pipe", encoding: "utf8" });
}

function write(dir, file, content) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

function makeSite(dir) {
  write(dir, "eleventy.config.js", `const nl = require(${JSON.stringify(pluginRoot)});
module.exports = (c) => {
  c.addPlugin(nl, { siteUrl: "https://example.com", from: "T <t@example.com>", timezone: "UTC", subscribers: "subs.csv" });
  return { dir: { input: "src", output: "_site" } };
};`);
  write(dir, ".gitignore", "node_modules\n_site\n");
  write(dir, "src/index.md", "Home\n");
  write(dir, "src/_includes/layouts/newsletter.njk", '<html><body>{{ content | safe }}<a href="{% newsletterUnsubscribeUrl %}">Unsubscribe</a></body></html>');
  write(dir, "src/newsletters/newsletters.11tydata.json", fs.readFileSync(path.join(pluginRoot, "templates/newsletters.11tydata.json"), "utf8"));
  fs.symlinkSync(path.join(pluginRoot, "node_modules"), path.join(dir, "node_modules"), "dir");
}

async function plan(dir) {
  process.chdir(dir);
  const { loadPlan } = require("../lib/send.js");
  const { newsletters } = await loadPlan({ now: NOW });
  return Object.fromEntries(newsletters.map((n) => [n.slug, n]));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nl-undated-"));
test.after(() => {
  process.chdir(os.tmpdir());
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("no sendDate: sends from when it was committed ready to send", async () => {
  const repo = path.join(tmp, "repo");
  makeSite(repo);
  git(["init", "-q"], repo);
  git(["add", "."], repo);
  git(["commit", "-qm", "site"], repo, "2026-09-01T12:00:00Z");

  write(repo, "src/newsletters/old.md", "---\nsubject: Old\n---\nOld news.\n");
  git(["add", "."], repo);
  git(["commit", "-qm", "old"], repo, "2026-10-01T12:00:00Z");

  write(repo, "src/newsletters/fresh.md", "---\nsubject: Fresh\n---\nJust posted.\n");
  git(["add", "."], repo);
  git(["commit", "-qm", "fresh"], repo, "2026-11-14T17:00:00Z");
  // A later edit (e.g. a typo fix) doesn't move the send time.
  write(repo, "src/newsletters/fresh.md", "---\nsubject: Fresh\n---\nJust posted, typo fixed.\n");
  git(["commit", "-qam", "typo"], repo, "2026-11-14T17:40:00Z");

  // Committed as a draft long ago, made ready today: sends from today.
  write(repo, "src/newsletters/was-draft.md", "---\nsubject: Was draft\ndraft: true\n---\nWriting.\n");
  git(["add", "."], repo);
  git(["commit", "-qm", "draft"], repo, "2026-10-02T12:00:00Z");
  write(repo, "src/newsletters/was-draft.md", "---\nsubject: Was draft\n---\nDone.\n");
  git(["commit", "-qam", "ready"], repo, "2026-11-14T17:20:00Z");

  // Scheduled far ahead, then the sendDate was removed today: sends from today.
  write(repo, "src/newsletters/was-dated.md", "---\nsubject: Was dated\nsendDate: 2026-12-25\n---\nHi.\n");
  git(["add", "."], repo);
  git(["commit", "-qm", "dated"], repo, "2026-10-03T12:00:00Z");
  write(repo, "src/newsletters/was-dated.md", "---\nsubject: Was dated\n---\nHi.\n");
  git(["commit", "-qam", "send now"], repo, "2026-11-14T17:30:00Z");

  // Draft committed, made ready but not committed yet: waits.
  write(repo, "src/newsletters/ready-locally.md", "---\nsubject: Ready locally\ndraft: true\n---\nHi.\n");
  git(["add", "."], repo);
  git(["commit", "-qm", "draft 2"], repo, "2026-11-14T17:35:00Z");
  write(repo, "src/newsletters/ready-locally.md", "---\nsubject: Ready locally\n---\nHi.\n");

  write(repo, "src/newsletters/unpushed.md", "---\nsubject: Not committed\n---\nStill writing.\n");
  write(repo, "src/newsletters/wip.md", "---\nsubject: Draft\ndraft: true\n---\nDraft.\n");
  git(["add", "src/newsletters/wip.md"], repo);
  git(["commit", "-qm", "wip"], repo, "2026-11-14T17:50:00Z");

  const n = await plan(repo);
  assert.strictEqual(n.fresh.status, "due");
  assert.strictEqual(n.fresh.sendAt.toISOString(), "2026-11-14T17:00:00.000Z");
  assert.strictEqual(n.fresh.sendAtSource, "committed");
  assert.strictEqual(n.old.status, "expired", "older than maxAgeDays, so it never goes out again");
  assert.strictEqual(n.unpushed.status, "unscheduled");
  assert.match(n.unpushed.note, /once it's committed/);
  assert.strictEqual(n["was-draft"].status, "due");
  assert.strictEqual(n["was-draft"].sendAt.toISOString(), "2026-11-14T17:20:00.000Z");
  assert.strictEqual(n["was-dated"].status, "due");
  assert.strictEqual(n["was-dated"].sendAt.toISOString(), "2026-11-14T17:30:00.000Z");
  assert.strictEqual(n["ready-locally"].status, "unscheduled");
  assert.strictEqual(n.wip.status, "draft");
});

test("no sendDate in a shallow clone is an error, not a send", async () => {
  const shallow = path.join(tmp, "shallow");
  git(["clone", "-q", "--depth", "1", `file://${path.join(tmp, "repo")}`, shallow], tmp);
  fs.symlinkSync(path.join(pluginRoot, "node_modules"), path.join(shallow, "node_modules"), "dir");
  const n = await plan(shallow);
  assert.strictEqual(n.fresh.status, "invalid");
  assert.match(n.fresh.error, /fetch-depth: 0/);
});

test("no sendDate outside git is an error, not a send", async () => {
  const plain = path.join(tmp, "plain");
  makeSite(plain);
  write(plain, "src/newsletters/fresh.md", "---\nsubject: Fresh\n---\nHi.\n");
  const n = await plan(plain);
  assert.strictEqual(n.fresh.status, "invalid");
  assert.match(n.fresh.error, /keep the site in git/);
});
