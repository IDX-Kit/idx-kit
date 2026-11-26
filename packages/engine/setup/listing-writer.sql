-- Run as the schema owner after creating a separate idx_listing_writer login.
GRANT USAGE ON SCHEMA idx TO idx_listing_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON idx.listings TO idx_listing_writer;
GRANT SELECT, INSERT, UPDATE (source_revision) ON idx.source_mappings TO idx_listing_writer;
GRANT SELECT (id), UPDATE (oldest_listing_ingested_at, display_blocks) ON idx.feeds TO idx_listing_writer;
GRANT SELECT, INSERT, UPDATE (version, completed_mark, next_link, pending_mark) ON idx.feed_sync_positions TO idx_listing_writer;
GRANT EXECUTE ON FUNCTION idx.renew_feed_freshness(text) TO idx_listing_writer;
