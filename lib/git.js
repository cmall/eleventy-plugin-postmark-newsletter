const { execFileSync } = require("node:child_process");
const { parseFrontMatter } = require("./frontmatter.js");

// A newsletter with no sendDate is sent from the moment it was committed as
// "ready": not a draft, and no sendDate. Precisely, that's the oldest commit in
// the latest unbroken run of commits where the file was ready. So:
//   - fixing a typo later doesn't move the send time
//   - committing it as a draft and removing `draft: true` days later sends it then
//   - removing the sendDate from a scheduled newsletter sends it then
// The time comes from git history, so it never drifts, and the maxAgeDays window
// still keeps an old newsletter from going out again months later.

function git(args, cwd) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

const repoCache = new Map();

function repoInfo(cwd) {
  if (repoCache.has(cwd)) return repoCache.get(cwd);
  let info = null;
  try {
    git(["rev-parse", "--show-toplevel"], cwd);
    info = { shallow: git(["rev-parse", "--is-shallow-repository"], cwd).trim() === "true" };
  } catch {
    info = null;
  }
  repoCache.set(cwd, info);
  return info;
}

function isReady(content) {
  let data;
  try {
    data = parseFrontMatter(content);
  } catch {
    return false;
  }
  const draft = data.draft === true || data.draft === "true";
  const dated = !(data.sendDate === undefined || data.sendDate === null || data.sendDate === "");
  return !draft && !dated;
}

/** When the committed file became ready to send, or null if the latest commit doesn't have it ready. */
function readySince(file, cwd) {
  let out;
  try {
    out = git(["log", "--follow", "--format=%x00%H %ct", "--name-only", "--", file], cwd);
  } catch {
    return null;
  }
  const commits = out
    .split("\0")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n").filter(Boolean);
      const [hash, time] = lines[0].split(" ");
      // Merge commits list no file name; they don't change the file on their own.
      return lines.length < 2 ? null : { hash, time: Number(time), path: lines[lines.length - 1] };
    })
    .filter(Boolean); // newest first

  let since = null;
  for (const c of commits) {
    let content;
    try {
      content = git(["show", `${c.hash}:${c.path}`], cwd);
    } catch {
      break; // the file was deleted in this commit
    }
    if (!isReady(content)) break;
    since = c.time;
  }
  return since === null ? null : new Date(since * 1000);
}

/**
 * Works out when an undated newsletter should go out.
 * Returns { sendAt } when it can, { pending } when the ready version isn't committed
 * yet, or { error } when there's no usable git history.
 */
function undatedSendTime(file, cwd) {
  const repo = repoInfo(cwd);
  if (!repo) {
    return { error: "No sendDate. Add one, or keep the site in git so the commit time can be used." };
  }
  if (repo.shallow) {
    return {
      error:
        "No sendDate, and this is a shallow git clone, so the commit time can't be found. In GitHub Actions, set `fetch-depth: 0` on actions/checkout.",
    };
  }
  const since = readySince(file, cwd);
  if (!since) return { pending: "No sendDate: this goes out once it's committed and pushed." };
  return { sendAt: since };
}

module.exports = { undatedSendTime, readySince, repoInfo };
