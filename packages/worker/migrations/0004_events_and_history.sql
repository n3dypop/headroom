-- Events, history series, and PC liveness.
--
-- events: events judged by Cron. Recorded once per key (kind, provider, window, cycle's representative time, threshold) (INSERT OR IGNORE;
--   one row even if Crons overlap). visible = 0 is only a "done" marker (the lighter of crossed thresholds; not shown to clients).
--   Cron gradually deletes them after keep_until (the later of the cycle's end and 8 days; even monthly limits don't repeat within a cycle)
-- event_state: a single row. Judgment state (per-window cycle representative time and whether notified, provider stop reasons, collection stop).
--   Replaced only if token is unchanged since read, and events are recorded in the same batch only if the token became ours
--   (overlapping Crons never stack events made from an old state)
-- event_feed: a single row. Events shown to clients (8 days, newest first up to a limit) as JSON. GET /v2/events reads only this row
--   (fixing the rows per client read). last_seq is the largest seq in it
-- derived_history: one row per provider. Cron puts, along with derived values, each window's last-24-hour series (representatives only) as JSON.
--   GET /v2/history reads only this row. version works as in derived_metrics

CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,
  visible     INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  keep_until  TEXT NOT NULL,
  body        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_by_keep_until ON events (keep_until);

CREATE TABLE IF NOT EXISTS event_state (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  token  TEXT NOT NULL,
  body   TEXT NOT NULL
);

INSERT OR IGNORE INTO event_state (id, token, body) VALUES (1, '', '{"cycles":{},"errors":{},"stopped":false}');

CREATE TABLE IF NOT EXISTS event_feed (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  last_seq  INTEGER NOT NULL,
  body      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS derived_history (
  provider  TEXT PRIMARY KEY,
  version   INTEGER NOT NULL,
  body      TEXT NOT NULL
);
