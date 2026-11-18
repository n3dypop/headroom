-- Keeps the current boundaries (current_boundaries) separately from the boundaries when the latest value (public_state body) was merged (boundaries).
-- current_boundaries is put in the same upload batch (one transaction) that saves the boundary. Reads compare the two and
-- don't expose latest values, derived values, or series of providers that differ (even if re-putting the latest value fails after saving the boundary).
-- Cron re-puts the latest value if they differ
ALTER TABLE public_state ADD COLUMN current_boundaries TEXT;
-- Fill in the current boundaries at migration time. For pre-migration rows without body boundaries, latest values of providers with a boundary are
-- dropped and the previous account's values aren't shown until the first Cron re-puts them
UPDATE public_state SET current_boundaries = (
  SELECT json_group_object(provider, since) FROM (SELECT provider, since FROM history_boundaries ORDER BY provider)
) WHERE id = 1;
