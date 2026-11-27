ALTER TABLE idx.feed_sync_positions ADD COLUMN IF NOT EXISTS record_counts jsonb;
ALTER TABLE idx.feed_scan_positions
  ADD COLUMN IF NOT EXISTS record_counts jsonb,
  ADD COLUMN IF NOT EXISTS last_report jsonb;
ALTER TABLE idx.feed_sync_outcomes ADD COLUMN IF NOT EXISTS last_report jsonb;

-- Earlier pages have no counts to carry forward. Replay from the last
-- completed mark, or start a new scan so its stamps get a new scan number.
UPDATE idx.feed_sync_positions
SET version = version + 1, next_link = NULL, pending_mark = NULL, record_state = 'empty'
WHERE next_link IS NOT NULL AND record_counts IS NULL AND record_state <> 'empty';

UPDATE idx.feed_scan_positions
SET version = version + 1, active = false, next_link = NULL
WHERE active AND record_counts IS NULL;
