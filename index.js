const path = require("node:path");
const { normalizeOptions, setActiveOptions } = require("./lib/options.js");

const UNSUBSCRIBE_PLACEHOLDER = "{{{ pm:unsubscribe }}}";

/**
 * Eleventy plugin.
 *
 * Newsletters live in `<input>/<dir>/`. They are left out of normal builds, so a
 * scheduled newsletter is never published to your site before it is sent. They
 * render as preview pages while `eleventy --serve` runs, and the
 * `eleventy-newsletter` CLI renders them in memory when it's time to send.
 */
module.exports = function postmarkNewsletter(eleventyConfig, options = {}) {
  const opts = normalizeOptions(options);

  // Eleventy 3 exposes `directories`; Eleventy 2 exposes `dir` once the config has run.
  const input =
    (eleventyConfig.directories && eleventyConfig.directories.input) ||
    (eleventyConfig.dir && eleventyConfig.dir.input) ||
    ".";
  opts.inputDir = input;
  opts.newslettersPath = path.join(input, opts.dir);
  setActiveOptions(opts);

  const runMode = process.env.ELEVENTY_RUN_MODE;
  const rendering =
    process.env.ELEVENTY_NEWSLETTER_RENDER === "1" ||
    (opts.previewInServe && (runMode === "serve" || runMode === "watch"));

  if (!rendering) {
    const glob = path.join(input, opts.dir, "**").replace(/\\/g, "/").replace(/^\.\//, "");
    eleventyConfig.ignores.add(glob);
  }

  // Postmark swaps this placeholder for each recipient's unsubscribe link.
  // Use it as {% newsletterUnsubscribeUrl %} in your newsletter layout.
  eleventyConfig.addShortcode("newsletterUnsubscribeUrl", () => UNSUBSCRIBE_PLACEHOLDER);
};

module.exports.UNSUBSCRIBE_PLACEHOLDER = UNSUBSCRIBE_PLACEHOLDER;
