const fs = require("node:fs");
const { parseCsv, EMAIL } = require("./subscribers.js");

/**
 * Turns a CSV export (Mailchimp's, or any CSV with an email column) into SQL
 * for the Worker's D1 database. Existing rows are left alone, so it's safe to re-run.
 */
function csvToSql(file, { status = "active", now = Date.now() } = {}) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const pick = (row, names) => {
    for (const key of Object.keys(row)) if (names.includes(key.trim().toLowerCase())) return row[key];
    return "";
  };
  const seen = new Set();
  const lines = [];
  let skipped = 0;
  for (const row of rows) {
    const email = String(pick(row, ["email address", "email", "e-mail"]) || "").trim().toLowerCase();
    if (!EMAIL.test(email) || seen.has(email)) {
      skipped++;
      continue;
    }
    seen.add(email);
    const first = pick(row, ["first name", "first_name", "fname", "firstname"]);
    const last = pick(row, ["last name", "last_name", "lname", "lastname"]);
    const confirmed = status === "active" ? now : "NULL";
    const unsub = status === "unsubscribed" ? now : "NULL";
    lines.push(
      `INSERT INTO subscribers (email, first_name, last_name, status, created_at, updated_at, confirmed_at, unsubscribed_at, source) ` +
        `VALUES (${q(email)}, ${q(first)}, ${q(last)}, ${q(status)}, ${now}, ${now}, ${confirmed}, ${unsub}, 'import') ` +
        `ON CONFLICT(email) DO NOTHING;`
    );
  }
  return { sql: lines.join("\n") + "\n", count: lines.length, skipped };
}

function q(value) {
  return `'${String(value || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 254).replace(/'/g, "''")}'`;
}

module.exports = { csvToSql };
