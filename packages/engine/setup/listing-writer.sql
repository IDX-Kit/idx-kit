-- Run as the schema owner after creating a separate idx_listing_writer login.
-- Apply migrations first, then run this script, which is safe to run again.
GRANT USAGE ON SCHEMA idx TO idx_listing_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON idx.listings TO idx_listing_writer;
GRANT SELECT, INSERT, UPDATE (source_revision) ON idx.source_mappings TO idx_listing_writer;
GRANT SELECT (id), UPDATE (oldest_listing_ingested_at, display_blocks) ON idx.feeds TO idx_listing_writer;
GRANT SELECT, INSERT, UPDATE (version, completed_mark, next_link, pending_mark) ON idx.feed_sync_positions TO idx_listing_writer;
GRANT EXECUTE ON FUNCTION idx.renew_feed_freshness(text) TO idx_listing_writer;
GRANT SELECT, INSERT, UPDATE (position_version, code, http_status, next_step, retry_after_seconds, saved_at) ON idx.feed_sync_outcomes TO idx_listing_writer;
GRANT SELECT, INSERT, UPDATE (version, scan_number, active, next_link) ON idx.feed_scan_positions TO idx_listing_writer;
GRANT SELECT, INSERT, UPDATE (scan_number) ON idx.listing_scan_stamps TO idx_listing_writer;
