ALTER TABLE idx.feeds ADD COLUMN freshness_seconds integer CHECK (freshness_seconds > 0);

-- Feeds registered before setup keep their current window until configured.
CREATE OR REPLACE FUNCTION idx.renew_feed_freshness(target_feed text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$
  UPDATE idx.feeds
  SET refreshed_at = statement_timestamp(),
      expires_at = timezone('UTC', timezone('UTC', statement_timestamp())
        + COALESCE(freshness_seconds * interval '1 second', expires_at - refreshed_at))
  WHERE id = target_feed;
$$;
