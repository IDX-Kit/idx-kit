ALTER TABLE idx.feed_sync_positions
  ADD COLUMN record_state text NOT NULL DEFAULT 'empty'
    CHECK (record_state IN ('empty', 'rejected', 'accepted'));

UPDATE idx.feed_sync_positions SET record_state = 'accepted'
WHERE pending_mark IS NOT NULL;
