-- Global counter when the current boundaries (current_boundaries) were put. A response that dropped the previous account's values after a boundary
-- move gets a counter (data_version) newer than before the switch, even before the body is re-put. Put in the same batch as the boundary save
ALTER TABLE public_state ADD COLUMN current_version INTEGER;

-- Fill existing rows: the body's counter if body boundaries equal current boundaries; otherwise (only the boundary had advanced) the current global counter
UPDATE public_state SET current_version = CASE
  WHEN boundaries IS current_boundaries THEN version
  ELSE coalesce((SELECT version FROM data_versions WHERE provider = 'all'), version)
END WHERE id = 1 AND current_version IS NULL;
