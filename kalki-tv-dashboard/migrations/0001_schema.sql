CREATE TABLE IF NOT EXISTS tv_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hashes TEXT NOT NULL,
  access_code_hash TEXT NOT NULL,
  webhook_secret_hash TEXT NOT NULL UNIQUE,
  allocation_per_alert REAL NOT NULL DEFAULT 1000,
  default_tp_pct REAL NOT NULL DEFAULT 3,
  default_stop_pct REAL NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tv_alerts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ticker TEXT NOT NULL,
  price REAL,
  timeframe TEXT,
  grade TEXT,
  raw_json TEXT NOT NULL,
  raw_text TEXT,
  idempotency_key TEXT NOT NULL,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  duplicate INTEGER DEFAULT 0,
  filter_status TEXT,
  filter_reason TEXT,
  filter_details TEXT,
  FOREIGN KEY (profile_id) REFERENCES tv_profiles(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tv_alerts_profile_idempotency
  ON tv_alerts(profile_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_tv_alerts_profile_created
  ON tv_alerts(profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tv_trades (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  status TEXT NOT NULL,
  entry_alert_id TEXT,
  exit_alert_id TEXT,
  entry_price REAL NOT NULL,
  exit_price REAL,
  allocation REAL NOT NULL,
  shares REAL NOT NULL,
  tp1_price REAL NOT NULL,
  stop_price REAL NOT NULL,
  outcome TEXT,
  pnl REAL DEFAULT 0,
  pnl_pct REAL DEFAULT 0,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES tv_profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_tv_trades_profile_status
  ON tv_trades(profile_id, status, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_tv_trades_profile_closed
  ON tv_trades(profile_id, closed_at DESC);

CREATE TABLE IF NOT EXISTS tv_raw_trades (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  status TEXT NOT NULL,
  entry_alert_id TEXT,
  exit_alert_id TEXT,
  entry_price REAL NOT NULL,
  exit_price REAL,
  allocation REAL NOT NULL,
  shares REAL NOT NULL,
  tp1_price REAL NOT NULL,
  stop_price REAL NOT NULL,
  outcome TEXT,
  pnl REAL DEFAULT 0,
  pnl_pct REAL DEFAULT 0,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES tv_profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_tv_raw_trades_profile_status
  ON tv_raw_trades(profile_id, status, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_tv_raw_trades_profile_closed
  ON tv_raw_trades(profile_id, closed_at DESC);
