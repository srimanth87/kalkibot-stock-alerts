ALTER TABLE subscribers ADD COLUMN telegram_user_id TEXT;
ALTER TABLE subscribers ADD COLUMN telegram_join_username TEXT;
ALTER TABLE subscribers ADD COLUMN telegram_join_first_name TEXT;
ALTER TABLE subscribers ADD COLUMN telegram_join_last_name TEXT;
ALTER TABLE subscribers ADD COLUMN telegram_join_chat_id TEXT;
ALTER TABLE subscribers ADD COLUMN telegram_joined_at TEXT;
ALTER TABLE subscribers ADD COLUMN telegram_join_raw_json TEXT;

CREATE INDEX IF NOT EXISTS idx_subscribers_telegram_user_id ON subscribers(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_subscribers_telegram_joined_at ON subscribers(telegram_joined_at);
