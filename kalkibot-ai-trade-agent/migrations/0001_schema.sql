CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  grade TEXT NOT NULL,
  score TEXT,
  structure TEXT,
  price REAL,
  entry_price REAL NOT NULL,
  entry_low REAL,
  entry_high REAL,
  stop_price REAL NOT NULL,
  t1 REAL NOT NULL,
  t2 REAL,
  t3 REAL,
  raw_text TEXT NOT NULL,
  source_chat_id TEXT,
  source_message_id TEXT,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alerts_received_at ON alerts(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_ticker ON alerts(ticker);

CREATE TABLE IF NOT EXISTS ai_decisions (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  risk_level TEXT NOT NULL,
  reason TEXT NOT NULL,
  strengths TEXT,
  concerns TEXT,
  similar_sample_size INTEGER DEFAULT 0,
  similar_win_rate REAL,
  expected_r_multiple REAL,
  model TEXT,
  prompt_version TEXT NOT NULL,
  raw_response TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(alert_id) REFERENCES alerts(id)
);

CREATE INDEX IF NOT EXISTS idx_ai_decisions_alert_id ON ai_decisions(alert_id);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_created_at ON ai_decisions(created_at DESC);

CREATE TABLE IF NOT EXISTS outcomes (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  status TEXT NOT NULL,
  entry_fill REAL,
  exit_price REAL,
  exit_reason TEXT,
  pnl REAL,
  r_multiple REAL,
  notes TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(alert_id) REFERENCES alerts(id)
);

CREATE INDEX IF NOT EXISTS idx_outcomes_alert_id ON outcomes(alert_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_status ON outcomes(status);

CREATE TABLE IF NOT EXISTS daily_reviews (
  id TEXT PRIMARY KEY,
  review_date TEXT NOT NULL,
  summary TEXT NOT NULL,
  recommendations TEXT,
  raw_response TEXT,
  model TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_reviews_date ON daily_reviews(review_date DESC);
