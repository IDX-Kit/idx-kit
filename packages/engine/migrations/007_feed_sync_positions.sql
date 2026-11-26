CREATE TABLE idx.feed_sync_positions (
  feed_id text PRIMARY KEY REFERENCES idx.feeds ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version > 0),
  completed_mark timestamptz,
  next_link text,
  pending_mark timestamptz CHECK (next_link IS NOT NULL OR pending_mark IS NULL)
);

REVOKE ALL ON idx.feed_sync_positions FROM PUBLIC, idx_runtime;

-- A completed poll renews the existing window. The writer cannot set dates.
CREATE FUNCTION idx.renew_feed_freshness(target_feed text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$
  UPDATE idx.feeds
  SET refreshed_at = statement_timestamp(),
      expires_at = timezone('UTC', timezone('UTC', statement_timestamp())
        + (expires_at - refreshed_at))
  WHERE id = target_feed;
$$;

REVOKE ALL ON FUNCTION idx.renew_feed_freshness(text) FROM PUBLIC, idx_runtime;
