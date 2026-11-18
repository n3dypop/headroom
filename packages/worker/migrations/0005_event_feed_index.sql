-- Bounds reads when rebuilding the events shown to clients to the limit, counted from the newest visible event.
-- However many hidden markers or retained old rows there are, rebuilding event_feed walks this index from the newest and stops at 500
CREATE INDEX IF NOT EXISTS events_visible_by_created ON events (created_at, seq) WHERE visible = 1;
