const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { getActiveOptions } = require("./options.js");
const { readFrontMatter } = require("./frontmatter.js");
const { parseSendDate } = require("./dates.js");
const { undatedSendTime } = require("./git.js");

const UNSUBSCRIBE = "pm:unsubscribe";

async function loadEleventy(cwd) {
  let resolved;
  try {
    resolved = require.resolve("@11ty/eleventy", { paths: [cwd] });
  } catch {
    throw new Error("Couldn't find @11ty/eleventy. Run this from your site's folder after `npm install`.");
  }
  const mod = await import(pathToFileURL(resolved).href);
  return mod.Eleventy || (mod.default && mod.default.Eleventy) || mod.default;
}

/**
 * Builds the site in memory (nothing is written to disk) and returns every
 * newsletter with its rendered email HTML, plain-text version and metadata.
 */
async function renderNewsletters({ cwd = process.cwd(), configPath } = {}) {
  process.env.ELEVENTY_NEWSLETTER_RENDER = "1";
  const Eleventy = await loadEleventy(cwd);
  const elev = new Eleventy(undefined, undefined, { quietMode: true, configPath });
  const items = await elev.toJSON();

  const opts = getActiveOptions();
  if (!opts) {
    throw new Error(
      "The newsletter plugin isn't loaded. Add `eleventyConfig.addPlugin(require(\"eleventy-plugin-postmark-newsletter\"), {...})` to your Eleventy config."
    );
  }

  const root = path.resolve(cwd, opts.newslettersPath) + path.sep;
  const newsletters = [];

  for (const item of items) {
    const abs = path.resolve(cwd, item.inputPath);
    if (!abs.startsWith(root)) continue;

    const data = readFrontMatter(abs);
    const base = path.basename(abs).replace(/\.[^.]+$/, "");
    const slug = String(data.slug || (base === "index" ? path.basename(path.dirname(abs)) : base));
    const nl = {
      slug,
      tag: opts.tagPrefix + slug,
      inputPath: path.relative(cwd, abs),
      previewUrl: item.url || null,
      subject: data.subject || data.title || "",
      draft: data.draft === true || data.draft === "true",
      sendDateRaw: data.sendDate,
      sendAt: null,
      sendAtSource: "sendDate",
      note: null,
      error: null,
      html: "",
      text: "",
      warnings: [],
    };

    try {
      nl.sendAt = parseSendDate(data.sendDate, opts);
    } catch (err) {
      nl.error = err.message;
    }
    const hasDate = !(data.sendDate === undefined || data.sendDate === null || data.sendDate === "");
    if (!hasDate && opts.sendUndated && !nl.draft) {
      const undated = undatedSendTime(abs, cwd);
      if (undated.sendAt) {
        nl.sendAt = undated.sendAt;
        nl.sendAtSource = "committed";
      } else if (undated.pending) nl.note = undated.pending;
      else nl.error = undated.error;
    }
    if (!nl.subject) nl.error = nl.error || "Missing `subject` in front matter.";

    nl.html = toEmailHtml(item.content, opts, nl.warnings);
    nl.text = toText(nl.html);
    if (!nl.html.includes(UNSUBSCRIBE)) {
      nl.warnings.push(
        "No {% newsletterUnsubscribeUrl %} in the email. Postmark will add its own unsubscribe link at the bottom."
      );
    }
    newsletters.push(nl);
  }

  newsletters.sort((a, b) => (a.sendAt ? a.sendAt.getTime() : Infinity) - (b.sendAt ? b.sendAt.getTime() : Infinity));
  return { options: opts, newsletters };
}

function toEmailHtml(html, opts, warnings) {
  let out = String(html || "");

  // Email needs absolute URLs for links and images.
  const attr = /(\s(?:src|href|poster|background)\s*=\s*)(["'])\/(?!\/)/gi;
  const cssUrl = /url\((["']?)\/(?!\/)/gi;
  if (opts.siteUrl) {
    out = out.replace(attr, `$1$2${opts.siteUrl}/`).replace(cssUrl, `url($1${opts.siteUrl}/`);
  } else if (attr.test(out)) {
    warnings.push("Set `siteUrl` in the plugin options so links and images starting with / work in email.");
  }

  if (opts.inlineCss) {
    const juice = require("juice");
    out = juice(out, {
      preserveMediaQueries: true,
      preserveFontFaces: true,
      removeStyleTags: true,
      // Keep width/height attributes exactly as written in the layout (e.g. width="600" for Outlook).
      applyWidthAttributes: false,
      applyHeightAttributes: false,
    });
  }
  return out;
}

function toText(html) {
  const { convert } = require("html-to-text");
  const plainHeading = (selector) => ({ selector, options: { uppercase: false } });
  return convert(html, {
    wordwrap: 78,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: ".preheader", format: "skip" },
      { selector: "[data-text-skip]", format: "skip" },
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      plainHeading("h1"),
      plainHeading("h2"),
      plainHeading("h3"),
      plainHeading("h4"),
    ],
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = { renderNewsletters, toEmailHtml, toText };
