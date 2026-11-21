-- One-time cleanup when upgrading from an earlier Worker. Run it AFTER deploying the Worker of this version and waiting a minute, during the
-- planned stop (docs/install.md): every PC stopped with its send queue discarded, and the deployed Worker refuses uploads from older agents,
-- so neither an older Worker nor a PC's queue brings back what this removes. Needs migration 0014. Safe to run again: a second run
-- changes nothing (it finds the mark of the first).
-- Rows an earlier Worker accepted that today's rules don't:
-- - observations at or before the marker it kept for that PC (boundary_watermarks: observations it removed at a boundary),
-- - observations stamped more than 2 minutes after their first receipt (a send time can be up to 2 minutes after the receipt, and
--   today's Worker keeps values stamped up to the send time; anything later was stamped by a clock it refuses),
-- - observations received before a history boundary or stamped before the boundary plus the 5-minute guard.
-- The weekly trend's hourly representatives are held to the same rules. Reads each table once; in a database without such rows nothing
-- is deleted.

CREATE TABLE IF NOT EXISTS upgrade_done (name TEXT PRIMARY KEY, at TEXT NOT NULL);

-- First with each marker as it was recorded
DELETE FROM observations WHERE NOT EXISTS (SELECT 1 FROM upgrade_done WHERE name = 'after-deploy') AND (observed_at > strftime('%Y-%m-%dT%H:%M:%fZ', julianday(first_received_at) + 120000 / 86400000.0)
  OR EXISTS (SELECT 1 FROM boundary_watermarks w
    WHERE w.provider = observations.provider AND w.collector = observations.collector AND observations.observed_at <= w.until)
  OR EXISTS (SELECT 1 FROM history_boundaries b WHERE b.provider = observations.provider AND (observations.first_received_at < b.since
    OR observations.observed_at < strftime('%Y-%m-%dT%H:%M:%fZ', julianday(b.since) + 300000 / 86400000.0))));

DELETE FROM observation_hourly WHERE NOT EXISTS (SELECT 1 FROM upgrade_done WHERE name = 'after-deploy') AND (observed_at > strftime('%Y-%m-%dT%H:%M:%fZ', julianday(first_received_at) + 120000 / 86400000.0)
  OR EXISTS (SELECT 1 FROM boundary_watermarks w
    WHERE w.provider = observation_hourly.provider AND w.collector = observation_hourly.collector AND observation_hourly.observed_at <= w.until)
  OR EXISTS (SELECT 1 FROM history_boundaries b WHERE b.provider = observation_hourly.provider AND (observation_hourly.first_received_at < b.since
    OR observation_hourly.observed_at < strftime('%Y-%m-%dT%H:%M:%fZ', julianday(b.since) + 300000 / 86400000.0))));

-- The saved latest value of a PC with a marker may hold windows from before it: removed (the PC sends a new one when it starts again)
DELETE FROM collector_snapshots WHERE NOT EXISTS (SELECT 1 FROM upgrade_done WHERE name = 'after-deploy') AND collector IN (SELECT collector FROM boundary_watermarks);

-- Then a marker recorded by a clock ahead is cut to now: a fetch after the clock was fixed is not held back (a value stamped after now
-- by that clock is dropped anyway: it is stamped after any send time; a queue that could hold one is discarded by the planned stop)
UPDATE boundary_watermarks SET until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE NOT EXISTS (SELECT 1 FROM upgrade_done WHERE name = 'after-deploy') AND until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- Derived values (speeds, the weekly series) computed before this may use the removed rows: the generation moves on, so they are not
-- shown from now on, and a computation that read the rows before this never saves (also as a first row). The next Cron computes them again
UPDATE data_generation SET generation = generation + 1 WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM upgrade_done WHERE name = 'after-deploy');

-- The served version moves past every one served before (the body's counter, and the counter its current boundaries were put under), and the
-- public body is withdrawn: values of a PC whose rows were removed don't show. The body keeps its counter (below C), so the empty body is
-- served as 2C - 1; the next Cron puts again what is left under C or above (served as 2C or more)
INSERT INTO data_versions (provider, version) SELECT 'all', 0 WHERE NOT EXISTS (SELECT 1 FROM upgrade_done WHERE name = 'after-deploy') ON CONFLICT (provider) DO NOTHING;
UPDATE data_versions SET version = max(version,
    coalesce((SELECT max(version, coalesce(current_version, 0)) FROM public_state WHERE id = 1), 0)) + 1
  WHERE provider = 'all' AND NOT EXISTS (SELECT 1 FROM upgrade_done WHERE name = 'after-deploy');
UPDATE public_state SET current_version = (SELECT version FROM data_versions WHERE provider = 'all'),
    body = json_set(body, '$.providers', json('{}'), '$.collectors', json('[]'))
  WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM upgrade_done WHERE name = 'after-deploy');
-- A used database whose public row an earlier Worker already removed gets the empty one too (served right away, not after a Cron)
INSERT INTO public_state (id, version, body, boundaries, current_boundaries, current_version)
  SELECT 1, 0, '{"schema_version":2,"generated_at":"1970-01-01T00:00:00.000Z","providers":{},"collectors":[]}', '{}', '{}',
    (SELECT version FROM data_versions WHERE provider = 'all')
  WHERE NOT EXISTS (SELECT 1 FROM upgrade_done WHERE name = 'after-deploy') AND (SELECT used FROM data_generation WHERE id = 1) = 1 AND NOT EXISTS (SELECT 1 FROM public_state);

-- Last: from now on only this Worker writes these rows: a write without its mark (a request an earlier Worker was still handling) is refused,
-- so it can't put back what this removes. Rows written before keep no mark, so an earlier Worker's update of one is refused too
UPDATE collector_snapshots SET writer = NULL WHERE writer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM upgrade_done WHERE name = 'after-deploy');
UPDATE observation_hourly SET writer = NULL WHERE writer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM upgrade_done WHERE name = 'after-deploy');
UPDATE public_state SET writer = NULL WHERE writer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM upgrade_done WHERE name = 'after-deploy');
CREATE TRIGGER IF NOT EXISTS writer_snapshots_insert BEFORE INSERT ON collector_snapshots WHEN NEW.writer IS NOT 2
  BEGIN SELECT RAISE(ABORT, 'written by an earlier Worker'); END;
CREATE TRIGGER IF NOT EXISTS writer_snapshots_update BEFORE UPDATE ON collector_snapshots WHEN NEW.writer IS NOT 2
  BEGIN SELECT RAISE(ABORT, 'written by an earlier Worker'); END;
CREATE TRIGGER IF NOT EXISTS writer_observations_insert BEFORE INSERT ON observations WHEN NEW.writer IS NOT 2
  BEGIN SELECT RAISE(ABORT, 'written by an earlier Worker'); END;
CREATE TRIGGER IF NOT EXISTS writer_hourly_insert BEFORE INSERT ON observation_hourly WHEN NEW.writer IS NOT 2
  BEGIN SELECT RAISE(ABORT, 'written by an earlier Worker'); END;
CREATE TRIGGER IF NOT EXISTS writer_hourly_update BEFORE UPDATE ON observation_hourly WHEN NEW.writer IS NOT 2
  BEGIN SELECT RAISE(ABORT, 'written by an earlier Worker'); END;
CREATE TRIGGER IF NOT EXISTS writer_public_insert BEFORE INSERT ON public_state WHEN NEW.writer IS NOT 2
  BEGIN SELECT RAISE(ABORT, 'written by an earlier Worker'); END;
CREATE TRIGGER IF NOT EXISTS writer_public_update BEFORE UPDATE ON public_state WHEN NEW.writer IS NOT 2
  BEGIN SELECT RAISE(ABORT, 'written by an earlier Worker'); END;
-- The public row is never deleted from now on (this Worker withdraws by an empty body; an earlier Worker's late DELETE of the withdrawal
-- is refused)
CREATE TRIGGER IF NOT EXISTS keep_public_row BEFORE DELETE ON public_state
  BEGIN SELECT RAISE(ABORT, 'written by an earlier Worker'); END;

-- Done: a second run finds this and changes nothing
INSERT OR IGNORE INTO upgrade_done (name, at) VALUES ('after-deploy', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
