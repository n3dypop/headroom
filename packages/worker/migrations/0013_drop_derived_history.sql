-- Removes the 24-hour series (derived_history); it can be added back if needed.
-- The widget reads only the weekly 7-day series (derived_weekly). It's a precomputed table, so dropping it loses no source data (observations).
-- In production, apply this after deploying a Worker that no longer writes this table (applying it first makes the old Worker's Cron fail to write)
-- To restore it, add a migration that recreates the table
DROP TABLE IF EXISTS derived_history;
