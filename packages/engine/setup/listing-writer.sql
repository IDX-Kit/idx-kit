-- Run as the schema owner after creating a separate idx_listing_writer login.
GRANT USAGE ON SCHEMA idx TO idx_listing_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON idx.listings TO idx_listing_writer;
GRANT SELECT, INSERT, UPDATE (source_revision) ON idx.source_mappings TO idx_listing_writer;
GRANT SELECT (id), UPDATE (oldest_listing_ingested_at, display_blocks) ON idx.feeds TO idx_listing_writer;
REVOKE SELECT, INSERT ON idx.feed_sync_positions FROM idx_listing_writer;
GRANT SELECT (feed_id, version, completed_mark, next_link, pending_mark, consecutive_failures),
  INSERT (feed_id, version, completed_mark, next_link, pending_mark, outcome_code,
    outcome_http_status, outcome_next_step, outcome_retry_after_seconds, consecutive_failures, outcome_saved_at),
  UPDATE (version, completed_mark, next_link, pending_mark, outcome_code,
    outcome_http_status, outcome_next_step, outcome_retry_after_seconds, consecutive_failures, outcome_saved_at)
  ON idx.feed_sync_positions TO idx_listing_writer;
GRANT EXECUTE ON FUNCTION idx.renew_feed_freshness(text) TO idx_listing_writer;
