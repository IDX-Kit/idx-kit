CREATE TABLE idx.feed_sync_outcomes (
  feed_id text PRIMARY KEY REFERENCES idx.feeds ON DELETE CASCADE,
  position_version bigint NOT NULL CHECK (position_version >= 0),
  code text NOT NULL,
  http_status smallint,
  next_step text,
  retry_after_seconds integer,
  saved_at timestamptz NOT NULL
);

REVOKE ALL ON idx.feed_sync_outcomes FROM PUBLIC, idx_runtime;
