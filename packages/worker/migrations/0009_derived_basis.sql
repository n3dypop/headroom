-- Keeps the provider's latest value (that provider's part of the public_state body) used when computing derived values and series.
-- Cron recomputes if it differs from the current latest value, even if the counter hasn't advanced (so values computed from an old latest value
-- don't linger when an upload's re-put and Cron's computation interleave)
ALTER TABLE derived_metrics ADD COLUMN basis TEXT;
