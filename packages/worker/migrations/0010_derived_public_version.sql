-- Counter of the latest-value row (public_state.version) used when computing derived values and series. Among computations with the same provider
-- counter, only the larger one (computed from the newer latest value) is kept (a late-finishing computation from an old latest value doesn't overwrite)
ALTER TABLE derived_metrics ADD COLUMN public_version INTEGER;
ALTER TABLE derived_history ADD COLUMN public_version INTEGER;
