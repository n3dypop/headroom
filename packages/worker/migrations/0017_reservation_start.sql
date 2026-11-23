-- A fetch attempt that is only reserved: an agent that tells the start of its attempt (kind "start", right before its query) holds
-- only a reservation until then, and one left unstarted past its window (2 minutes) goes to the next PC that asks. The column holds
-- the pending attempt's id while it is only reserved; null once started, or for an agent that doesn't tell its start (an earlier
-- version: as before, never given to another PC). Apply BEFORE deploying the Worker of this version. The earlier Worker never writes
-- it, so a grant it makes meanwhile names another attempt and reads as started.
ALTER TABLE provider_holds ADD COLUMN pending_reserved TEXT;
