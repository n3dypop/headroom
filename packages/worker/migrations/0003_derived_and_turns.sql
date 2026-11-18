-- Precomputation for the read endpoint, fetch turns, and the daily D1 budget.
--
-- public_state: a single row. On each upload from a PC, holds the merged latest value with boundaries applied (mergeSnapshots) as JSON.
--   GET /v2/snapshot and /v2/view read only this and derived_metrics (fixing the rows per client read).
--   version is the data_versions('all') value read before computing. A computation with a smaller version doesn't overwrite
-- derived_metrics: one row per provider. Cron (every 5 min) puts, only for changed providers, per-window derived values of the merged latest value
--   (recent usage, rate, forecast, etc.; computeMetrics in @headroom/core) as JSON. version works as in public_state
-- data_versions: change counters (per provider and 'all'). Advanced by one after saving on each upload
-- fetch_turns: one row per provider. The PC (collector) that fetches now and its expiry. Other PCs skip fetching until then
-- observation_marks: per provider and PC, the latest observed_at (PC clock) of saved observations. Advanced on every observation save.
--   When creating a history boundary, the per-PC markers (boundary_watermarks) are built from here without gaps (no scan of the observation table)
-- d1_budget: per UTC day, D1 rows used by the write side (uploads, turns, Cron), as actually returned by D1. Refuses when near the limit.
--   The limit is kept in the table as a CHECK (same values as DAILY_BUDGET in budget.ts). A reservation adds and, if it hits the constraint, rolls back
--   the whole transaction, so reserving two days at once for a run crossing midnight is atomic
-- observations_by_provider_received: derived-value computation and old-row deletion read only that provider's range.
--   The received-time-only index (observations_by_received from 0001) is no longer used, so it's dropped (fewer writes per observation)

CREATE TABLE IF NOT EXISTS public_state (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  version  INTEGER NOT NULL,
  body     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS derived_metrics (
  provider     TEXT PRIMARY KEY,
  computed_at  TEXT NOT NULL,
  version      INTEGER NOT NULL,
  body         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS data_versions (
  provider  TEXT PRIMARY KEY,
  version   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fetch_turns (
  provider   TEXT PRIMARY KEY,
  collector  TEXT NOT NULL,
  until      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observation_marks (
  provider   TEXT NOT NULL,
  collector  TEXT NOT NULL,
  latest     TEXT NOT NULL,
  PRIMARY KEY (provider, collector)
);

CREATE TABLE IF NOT EXISTS d1_budget (
  day     TEXT PRIMARY KEY,
  reads   INTEGER NOT NULL CHECK (reads BETWEEN 0 AND 4000000),
  writes  INTEGER NOT NULL CHECK (writes BETWEEN 0 AND 80000)
);

CREATE INDEX IF NOT EXISTS observations_by_provider_received ON observations (provider, first_received_at);
DROP INDEX IF EXISTS observations_by_received;
