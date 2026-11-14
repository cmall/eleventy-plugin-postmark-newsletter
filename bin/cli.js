#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { sendDue, sendTest, listNewsletters } = require("../lib/send.js");
const { csvToSql } = require("../lib/import.js");

const HELP = `eleventy-newsletter <command> [options]

Commands
  list                     Show each newsletter, its status and send time
  send                     Send every newsletter that is due (safe to run repeatedly)
  test --to you@site.com   Send a [Test] copy of the next newsletter (or --only <name>),
                           with the unsubscribe link turned off
  init                     Add a starter layout and newsletters folder to your site
  import <file.csv>        Print SQL that loads a CSV (e.g. a Mailchimp export) into the
                           Worker's database. Add --unsubscribed for an unsubscribe export.

Options
  --dry-run       Show what would be sent without sending
  --only <name>   Limit to one newsletter (its file name without .md)
  --late          With --only, send even if the sendDate is older than maxAgeDays
  --to <emails>   Comma-separated addresses for \`test\`
  --config <file> Eleventy config file, if it isn't found automatically
  --input <dir>   Input folder for \`init\` (default: src if it exists, else .)

Environment
  POSTMARK_SERVER_TOKEN         Postmark server API token
  NEWSLETTER_SUBSCRIBERS_TOKEN  Bearer token for a subscriber-list URL
  NEWSLETTER_PREVIEW_TO         Your address(es): new versions of drafts and scheduled
                                newsletters are emailed here by \`send\`
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--late") args.late = true;
    else if (a === "--unsubscribed") args.unsubscribed = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else if (/^--(only|to|config|input)$/.test(a)) args[a.slice(2)] = argv[++i];
    else if (/^--(only|to|config|input)=/.test(a)) {
      const [k, ...v] = a.slice(2).split("=");
      args[k] = v.join("=");
    } else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
    else args._.push(a);
  }
  return args;
}

function init(input) {
  const dir = input || (fs.existsSync("src") ? "src" : ".");
  const tpl = (name) => fs.readFileSync(path.join(__dirname, "..", "templates", name), "utf8");
  const files = [
    [path.join(dir, "_includes", "layouts", "newsletter.njk"), tpl("newsletter.njk")],
    [path.join(dir, "newsletters", "newsletters.11tydata.json"), tpl("newsletters.11tydata.json")],
    [path.join(dir, "newsletters", "example.md"), tpl("example.md")],
  ];
  for (const [file, content] of files) {
    if (fs.existsSync(file)) {
      console.log(`exists  ${file}`);
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    console.log(`created ${file}`);
  }
  console.log(`
Next, add the plugin to your Eleventy config:

  const newsletter = require("eleventy-plugin-postmark-newsletter");
  eleventyConfig.addPlugin(newsletter, {
    siteUrl: "https://example.com",
    from: "Your Name <you@example.com>",
    timezone: "America/Vancouver",
    subscribers: "https://your-worker.workers.dev/subscribers",
  });
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (args.help || !cmd || cmd === "help") return console.log(HELP);

  const common = { configPath: args.config, only: args.only };
  if (cmd === "init") return init(args.input);
  if (cmd === "import") {
    if (!args._[1]) throw new Error("Give the CSV file: eleventy-newsletter import members.csv > import.sql");
    const { sql, count, skipped } = csvToSql(args._[1], { status: args.unsubscribed ? "unsubscribed" : "active" });
    process.stdout.write(sql);
    console.error(`${count} subscriber(s) written${skipped ? `, ${skipped} row(s) skipped (no valid email or duplicate)` : ""}.`);
    return;
  }
  if (cmd === "list") return listNewsletters(common);
  if (cmd === "send") {
    const res = await sendDue({ ...common, dryRun: args.dryRun, late: args.late });
    if (res.failed) process.exitCode = 1;
    return;
  }
  if (cmd === "test") return sendTest({ ...common, to: String(args.to || "").split(",") });
  throw new Error(`Unknown command "${cmd}". Run eleventy-newsletter --help.`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
