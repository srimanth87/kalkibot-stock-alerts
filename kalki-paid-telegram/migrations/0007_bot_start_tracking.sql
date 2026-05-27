ALTER TABLE subscribers ADD COLUMN telegram_started_at TEXT;
ALTER TABLE subscribers ADD COLUMN telegram_start_raw_json TEXT;

CREATE INDEX IF NOT EXISTS idx_subscribers_telegram_started_at ON subscribers(telegram_started_at);
