ALTER TABLE access_codes ADD COLUMN trial_days INTEGER;

ALTER TABLE subscribers ADD COLUMN trial_started_at TEXT;
ALTER TABLE subscribers ADD COLUMN trial_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_subscribers_trial_expires_at ON subscribers(trial_expires_at);
