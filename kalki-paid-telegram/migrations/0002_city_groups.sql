ALTER TABLE subscribers ADD COLUMN group_key TEXT;
ALTER TABLE subscribers ADD COLUMN group_chat_id TEXT;
ALTER TABLE subscribers ADD COLUMN access_source TEXT;

CREATE INDEX IF NOT EXISTS idx_subscribers_group_key ON subscribers(group_key);
