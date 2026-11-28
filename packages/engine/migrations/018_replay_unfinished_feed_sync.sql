-- Older traversals did not distinguish invalid revisions from invalid facts,
-- and scans could accept future revisions. Replay unfinished work on upgrade.
UPDATE idx.feed_sync_positions
SET version = version + 1, next_link = NULL, pending_mark = NULL,
  record_state = 'empty', record_counts = NULL
WHERE next_link IS NOT NULL;

UPDATE idx.feed_scan_positions
SET version = version + 1, active = false, next_link = NULL, record_counts = NULL
WHERE active;
