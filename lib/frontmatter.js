const fs = require("node:fs");
const yaml = require("js-yaml");

// Reads front matter straight from the source. YAML is parsed with the core
// schema so dates stay as written ("2026-12-01 09:00") instead of being turned
// into UTC midnight; dates.js then reads them in your time zone.
function parseFrontMatter(src, label = "newsletter") {
  const text = String(src).replace(/^﻿/, "");
  const m = text.match(/^---[ \t]*(\w+)?[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return {};
  const [, lang = "yaml", body] = m;
  if (lang === "json") return JSON.parse(body.trim().startsWith("{") ? body : `{${body}}`);
  if (lang === "yaml") return yaml.load(body, { schema: yaml.CORE_SCHEMA }) || {};
  throw new Error(`${label}: only YAML and JSON front matter are supported for newsletters.`);
}

function readFrontMatter(filePath) {
  return parseFrontMatter(fs.readFileSync(filePath, "utf8"), filePath);
}

module.exports = { readFrontMatter, parseFrontMatter };
