CREATE TABLE IF NOT EXISTS portfolio_positions (
  id TEXT PRIMARY KEY,
  sym TEXT NOT NULL,
  grade TEXT,
  state TEXT,
  entry_date TEXT,
  entry_price REAL,
  current_price REAL,
  closed_price REAL,
  pnl_pct REAL,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portfolio_positions_sym ON portfolio_positions(sym);
CREATE INDEX IF NOT EXISTS idx_portfolio_positions_entry ON portfolio_positions(entry_date DESC);

CREATE TABLE IF NOT EXISTS group_alerts (
  id TEXT PRIMARY KEY,
  sym TEXT NOT NULL,
  note TEXT,
  entry_date TEXT,
  grade TEXT,
  linked_portfolio_id TEXT,
  status TEXT,
  pct_since_add REAL,
  updated_at TEXT NOT NULL,
  added_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_group_alerts_sym ON group_alerts(sym);
CREATE INDEX IF NOT EXISTS idx_group_alerts_added ON group_alerts(added_at DESC);

CREATE TABLE IF NOT EXISTS watchlist_items (
  sym TEXT PRIMARY KEY,
  grade TEXT,
  status TEXT,
  support_low REAL,
  support_high REAL,
  breakdown REAL,
  resistances_json TEXT,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);
