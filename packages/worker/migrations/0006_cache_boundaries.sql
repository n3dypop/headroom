-- Attaches to computed values (derived values, series) the history boundary they were computed under (per-provider since; empty string if none).
-- public_state holds the boundaries at that time. Reads compare the two and don't use computed values if they differ (so after an account switch
-- the previous account's series or forecast is never shown, even if replacement or counter updates after the boundary fail midway).
-- Cron recomputes providers whose boundary differs, even if the counter hasn't advanced
ALTER TABLE derived_metrics ADD COLUMN boundary TEXT;
ALTER TABLE derived_history ADD COLUMN boundary TEXT;
ALTER TABLE public_state ADD COLUMN boundaries TEXT;
