-- Data generation and use. Apply BEFORE deploying the Worker of this version: it only adds, so the earlier Worker keeps working until the
-- deploy, and this version's Worker never runs without it.
-- data_generation (one row):
-- - generation: moved on by the one-time cleanup after an upgrade (upgrade/after-deploy.sql). Derived values (speeds, the weekly series)
--   carry the generation they were computed in; one of another generation is not shown and is computed again, and a computation that
--   read rows before the generation moved on never saves (also as a first row)
-- - used: whether a PC ever saved anything here. Counted now, before the cleanup removes any of it; set by the first save in a new
--   database. With no value left, a used database answers with an empty view (a withdrawal), a new one with "no value yet"
CREATE TABLE IF NOT EXISTS data_generation (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO data_generation (id, generation, used)
  SELECT 1, 1, (EXISTS (SELECT 1 FROM collector_names) OR EXISTS (SELECT 1 FROM collector_snapshots)
    OR EXISTS (SELECT 1 FROM observations) OR EXISTS (SELECT 1 FROM observation_hourly)
    OR EXISTS (SELECT 1 FROM derived_metrics) OR EXISTS (SELECT 1 FROM derived_weekly)
    OR EXISTS (SELECT 1 FROM public_state) OR EXISTS (SELECT 1 FROM data_versions));

-- Rows saved before this have generation 0: this version's Worker computes them again before showing them
ALTER TABLE derived_metrics ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE derived_weekly ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

-- Who wrote a row the cleanup holds (this version writes 2; earlier ones leave it empty). The cleanup adds triggers that refuse writes
-- without it, so a request the earlier Worker was still handling can't put back what the cleanup removed
ALTER TABLE collector_snapshots ADD COLUMN writer INTEGER;
ALTER TABLE observations ADD COLUMN writer INTEGER;
ALTER TABLE observation_hourly ADD COLUMN writer INTEGER;
ALTER TABLE public_state ADD COLUMN writer INTEGER;
