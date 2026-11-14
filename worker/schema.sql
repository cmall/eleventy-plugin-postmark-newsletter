-- Subscriber list for the newsletter Worker.
-- Apply with: npx wrangler d1 execute <database-name> --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS subscribers (
  email              TEXT PRIMARY KEY,                -- always lowercase
  first_name         TEXT NOT NULL DEFAULT '',
  last_name          TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'active', 'unsubscribed')),
  token              TEXT,                            -- confirmation token
  token_created_at   INTEGER,
  confirm_sent_at    INTEGER,                         -- last confirmation email (ms since epoch)
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  confirmed_at       INTEGER,
  unsubscribed_at    INTEGER,
  unsubscribe_reason TEXT,                            -- from Postmark: ManualSuppression, HardBounce, SpamComplaint
  source             TEXT NOT NULL DEFAULT 'form'     -- 'form' or 'import'
);

CREATE UNIQUE INDEX IF NOT EXISTS subscribers_token ON subscribers (token);
CREATE INDEX IF NOT EXISTS subscribers_status ON subscribers (status);
CREATE INDEX IF NOT EXISTS subscribers_confirm_sent ON subscribers (confirm_sent_at);
