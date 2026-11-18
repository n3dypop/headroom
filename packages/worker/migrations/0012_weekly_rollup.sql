-- 7-day trend of the weekly limit. Only creates tables (no backfill:
-- doesn't scan existing observations or add D1 usage. The chart fills from observations received after deployment)
--
-- observation_hourly: the representative weekly-limit observation per hour (one row per provider, window, and hour (UTC YYYY-MM-DDTHH)).
--   On upload, for the observations in that upload, saved observations are looked up by primary key (boundary checks are done when saving observations).
--   observed_at is the observation time recorded by the PC (used for per-PC exclusion); effective_at is the earlier of observation and first receipt
--   (used for hour buckets and the chart; never creates future points). Written only for a newer observation (or, at the same time, from a
--   higher-priority PC). Limited to times from 8 days before to 5 minutes after receipt, so rows stay under about 200 per provider and window.
--   A primary-key-only table (WITHOUT ROWID) so each write is one row once
-- derived_weekly: the 7-day series Cron builds from observation_hourly once an hour (one row per provider).
--   Holds the boundary stamp, hour (UTC), and time it was built. Not replaced with a stamp differing from the current boundary or an older computation
CREATE TABLE IF NOT EXISTS observation_hourly (
  provider          TEXT NOT NULL,
  window_id         TEXT NOT NULL,
  hour              TEXT NOT NULL,
  used_percent      REAL NOT NULL,
  resets_at         TEXT,
  observed_at       TEXT NOT NULL,
  effective_at      TEXT NOT NULL,
  first_received_at TEXT NOT NULL,
  collector         TEXT NOT NULL,
  priority          INTEGER NOT NULL,
  PRIMARY KEY (provider, window_id, hour)
) WITHOUT ROWID;

-- collector_names: PC names registered in D1 (up to 32; slot 0-31) and the last accepted seq (used to detect old resends;
--   survives the latest value expiring after 30 days, so an old resend after that doesn't advance the boundary). Names are never deleted (deleting
--   would drop that name's exclusion markers and acceptance records, bringing back the previous account's values or turning a past acceptance into
--   a new switch). A new name is registered in the first statement of the upload batch; the CHECK on the number keeps it within the limit. This bounds per-PC table names.
--   Existing names are registered from the small per-PC tables, reading at most 33 distinct names per table (tables with one row per provider
--   scan at most about 66 rows; plus one primary-key row per name for the latest value's seq; the observation table is not read). If there are
--   more than 32 names, this migration fails on the CHECK
CREATE TABLE IF NOT EXISTS collector_names (
  name TEXT PRIMARY KEY,
  slot INTEGER NOT NULL UNIQUE CHECK (slot >= 0 AND slot < 32),
  seq  INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

INSERT INTO collector_names (name, slot, seq)
SELECT e.collector, row_number() OVER (ORDER BY e.collector) - 1,
  coalesce((SELECT c.seq FROM collector_snapshots c WHERE c.collector = e.collector), 0)
FROM (
  SELECT collector FROM (SELECT collector FROM collector_snapshots LIMIT 33)
  UNION SELECT collector FROM (SELECT DISTINCT collector FROM boundary_sources LIMIT 33)
  UNION SELECT collector FROM (SELECT DISTINCT collector FROM boundary_watermarks LIMIT 33)
  UNION SELECT collector FROM (SELECT DISTINCT collector FROM observation_marks LIMIT 33)
) AS e
WHERE NOT EXISTS (SELECT 1 FROM collector_names)
ORDER BY e.collector;

CREATE TABLE IF NOT EXISTS derived_weekly (
  provider    TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  boundary    TEXT NOT NULL,
  built_hour  TEXT NOT NULL,
  computed_at TEXT NOT NULL
);
