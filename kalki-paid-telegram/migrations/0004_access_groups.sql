CREATE TABLE IF NOT EXISTS access_groups (
  group_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_access_groups_active ON access_groups(active);
