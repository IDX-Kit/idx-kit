ALTER TABLE idx.feed_sync_positions
  ADD COLUMN record_state text NOT NULL DEFAULT 'empty'
    CHECK (record_state IN ('empty', 'rejected', 'accepted'));

UPDATE idx.feed_sync_positions
SET version = version + 1, next_link = NULL, pending_mark = NULL
WHERE next_link IS NOT NULL;
