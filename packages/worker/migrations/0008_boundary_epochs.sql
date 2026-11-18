-- A per-provider number that advances on every history-boundary acceptance. Even when the boundary time (since) doesn't change (e.g. a second PC
-- switching at the same received time), changed per-PC exclusion markers change the valid observation range, so the computed values' boundary stamp changes.
-- The boundary stamp is "since#epoch". Advanced in the same batch that saves the acceptance
CREATE TABLE IF NOT EXISTS boundary_epochs (
  provider  TEXT PRIMARY KEY,
  epoch     INTEGER NOT NULL
);

-- The stamp format changes, so re-fill the current boundaries in the new format (body boundaries stay old; providers with a boundary are dropped until Cron re-puts them)
UPDATE public_state SET current_boundaries = (
  SELECT json_group_object(provider, stamp) FROM (
    SELECT p.provider, coalesce(b.since, '') || '#' || coalesce(e.epoch, 0) AS stamp
    FROM (SELECT provider FROM history_boundaries UNION SELECT provider FROM boundary_epochs) p
    LEFT JOIN history_boundaries b ON b.provider = p.provider
    LEFT JOIN boundary_epochs e ON e.provider = p.provider
    ORDER BY p.provider
  )
) WHERE id = 1;
