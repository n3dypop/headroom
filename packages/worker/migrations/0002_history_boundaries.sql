-- History boundaries. Built from the time a PC accepted an account switch (ProviderSnapshot.history_since).
-- Observations before a boundary belong to another account, so they are deleted and not stored even if they arrive later. Times and PC names only; no account information.

-- Per-provider boundary (endpoint time). Observations are compared by min(observed_at, first_received_at). Moves forward only.
-- collector is the PC that created the boundary (its state is shown in the merge right after acceptance even without values)
CREATE TABLE IF NOT EXISTS history_boundaries (
  provider  TEXT PRIMARY KEY,
  since     TEXT NOT NULL,
  collector TEXT NOT NULL
);

-- Last history_since accepted per PC (repeats of the same value are not new acceptances)
CREATE TABLE IF NOT EXISTS boundary_sources (
  provider  TEXT NOT NULL,
  collector TEXT NOT NULL,
  source    TEXT NOT NULL,
  PRIMARY KEY (provider, collector)
);

-- Per-PC latest fetch time (that PC's clock) of observations deleted by the boundary and of current values saved at the boundary.
-- Observations and current-value windows at or before this are not brought back even if resent
CREATE TABLE IF NOT EXISTS boundary_watermarks (
  provider  TEXT NOT NULL,
  collector TEXT NOT NULL,
  until     TEXT NOT NULL,
  PRIMARY KEY (provider, collector)
);
