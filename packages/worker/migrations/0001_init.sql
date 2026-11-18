-- Headroom's delivery store (D1). Only what the schema defines is stored.
-- Account information (tokens, email addresses, account IDs and their hashes), raw CLI output, and file paths are never stored.

-- Latest snapshot per PC (repacked at upload time to only the schema's fields).
-- Replaced only by uploads whose seq (upload sequence number) is greater than the saved one.
CREATE TABLE IF NOT EXISTS collector_snapshots (
  collector   TEXT PRIMARY KEY,
  seq         INTEGER NOT NULL,
  snapshot    TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- Per-window observation history (8 days). Resends of the same observation from the same PC are ignored via the unique key.
-- observed_at is kept as recorded by the PC; computations use the time clamped by first_received_at.
CREATE TABLE IF NOT EXISTS observations (
  provider          TEXT NOT NULL,
  window_id         TEXT NOT NULL,
  collector         TEXT NOT NULL,
  observed_at       TEXT NOT NULL,
  first_received_at TEXT NOT NULL,
  resets_at         TEXT,
  used_percent      REAL NOT NULL,
  PRIMARY KEY (provider, window_id, collector, observed_at)
);

CREATE INDEX IF NOT EXISTS observations_by_received ON observations (first_received_at);
