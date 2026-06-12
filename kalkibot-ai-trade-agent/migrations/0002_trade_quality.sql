ALTER TABLE ai_decisions ADD COLUMN trade_quality TEXT;
ALTER TABLE ai_decisions ADD COLUMN best_trade_score INTEGER;
ALTER TABLE ai_decisions ADD COLUMN entry_timing TEXT;
ALTER TABLE ai_decisions ADD COLUMN c13_score INTEGER;
ALTER TABLE ai_decisions ADD COLUMN c1_score INTEGER;
ALTER TABLE ai_decisions ADD COLUMN volume_score REAL;
ALTER TABLE ai_decisions ADD COLUMN market_score REAL;
ALTER TABLE ai_decisions ADD COLUMN relative_strength_score REAL;
ALTER TABLE ai_decisions ADD COLUMN catalyst_score REAL;
ALTER TABLE ai_decisions ADD COLUMN confirmations TEXT;
ALTER TABLE ai_decisions ADD COLUMN red_flags TEXT;
ALTER TABLE ai_decisions ADD COLUMN alpha_scanner TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_decisions_trade_quality ON ai_decisions(trade_quality);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_best_trade_score ON ai_decisions(best_trade_score DESC);
