CREATE TABLE IF NOT EXISTS access_codes (
  code TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'stripe',
  active INTEGER NOT NULL DEFAULT 1,
  max_uses INTEGER,
  uses_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_access_codes_active ON access_codes(active);
CREATE INDEX IF NOT EXISTS idx_access_codes_group_key ON access_codes(group_key);
