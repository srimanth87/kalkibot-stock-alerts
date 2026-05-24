CREATE TABLE IF NOT EXISTS subscribers (
  id TEXT PRIMARY KEY,
  checkout_session_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  email TEXT,
  telegram_username TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  invite_link TEXT,
  invite_link_created_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  raw_event_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_subscribers_session ON subscribers(checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_subscribers_customer ON subscribers(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscribers_subscription ON subscribers(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status);
