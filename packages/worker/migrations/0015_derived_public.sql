-- Every provider's derived values of one generation in a single row, so the read endpoint reads three rows by primary key
-- (public_state, derived_public, data_generation) whatever the number of providers. Apply BEFORE deploying the Worker of this version:
-- it only adds, so the earlier Worker keeps working until the deploy (it keeps writing derived_metrics only; the next Cron of this
-- version rebuilds this row from them).
-- derived_public (one row):
-- - generation: the generation whose derived_metrics rows the body holds. The read endpoint uses the body only while it is the current
--   one (upgrade/after-deploy.sql moving the generation on hides it at once)
-- - body: JSON array of {provider, body, boundary}, rebuilt from the derived_metrics rows that are actually stored (never from values a
--   Worker read before), in the same batch as each save and by Cron when it was left behind
CREATE TABLE IF NOT EXISTS derived_public (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL,
  body       TEXT NOT NULL
);

INSERT INTO derived_public (id, generation, body)
  SELECT 1, g.generation, (SELECT json_group_array(json_object('provider', d.provider, 'body', d.body, 'boundary', d.boundary))
    FROM derived_metrics d WHERE d.generation = g.generation)
  FROM data_generation g WHERE g.id = 1
  ON CONFLICT (id) DO UPDATE SET generation = excluded.generation, body = excluded.body;
