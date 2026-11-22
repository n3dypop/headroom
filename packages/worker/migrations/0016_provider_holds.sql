-- Fetch turns, attempts and the shared stops of each provider (agents of protocol 3). Apply BEFORE deploying the Worker of this
-- version: it only adds (the earlier Worker keeps using fetch_turns until the deploy; this version doesn't use it).
-- provider_holds: one row per provider, written only when unchanged since read (version):
-- - holder, holder_attempt, holder_until: the normal turn's lease, taken only by the result of a successful fetch
-- - pending_*: the attempt granted and not yet reported (no other attempt of the provider is granted meanwhile)
-- - rate_stage, rate_until: the rate limit's stage (1-4) and the time every PC waits until
-- - denied, denied_gen, denied_since: an access denial stops the provider on every PC until a resume of that stop succeeds
-- - result_attempt: the mark of the batch that applied the last result (the batch's own statements follow only its own update)
-- - retired: the attempts that ended (a result applied) or were replaced, the latest 8 (JSON): a late request of one is never granted
-- No account information: PC names (registered), random attempt ids, times and counters.
-- public_state.holds: the stops shown (provider -> {since, gen}), marked in the same batch as the result that starts or ends one; the
-- read endpoint applies them to the merged value (it keeps reading the same three rows).
CREATE TABLE IF NOT EXISTS provider_holds (
  provider           TEXT PRIMARY KEY,
  version            INTEGER NOT NULL,
  holder             TEXT,
  holder_attempt     TEXT,
  holder_until       TEXT,
  pending_collector  TEXT,
  pending_attempt    TEXT,
  pending_kind       TEXT,
  pending_since      TEXT,
  rate_stage         INTEGER NOT NULL DEFAULT 0,
  rate_until         TEXT,
  denied             INTEGER NOT NULL DEFAULT 0,
  denied_gen         INTEGER NOT NULL DEFAULT 0,
  denied_since       TEXT,
  result_attempt     TEXT,
  retired            TEXT
);

ALTER TABLE public_state ADD COLUMN holds TEXT;
