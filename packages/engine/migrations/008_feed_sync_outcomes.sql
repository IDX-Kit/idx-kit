-- Version zero holds a stopped run before any page has committed.
ALTER TABLE idx.feed_sync_positions
  DROP CONSTRAINT feed_sync_positions_version_check,
  ADD CHECK (version >= 0),
  ADD COLUMN outcome_code text,
  ADD COLUMN outcome_http_status smallint,
  ADD COLUMN outcome_next_step text,
  ADD COLUMN outcome_retry_after_seconds integer,
  ADD COLUMN consecutive_failures bigint NOT NULL DEFAULT 0,
  ADD COLUMN outcome_saved_at timestamptz;
