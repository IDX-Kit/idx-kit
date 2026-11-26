CREATE TABLE idx.feed_scan_positions (
  feed_id text PRIMARY KEY REFERENCES idx.feeds ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version > 0),
  scan_number bigint NOT NULL CHECK (scan_number > 0),
  active boolean NOT NULL,
  next_link text CHECK (active OR next_link IS NULL)
);

CREATE TABLE idx.listing_scan_stamps (
  listing_id text PRIMARY KEY REFERENCES idx.source_mappings (listing_id) ON DELETE CASCADE,
  scan_number bigint NOT NULL CHECK (scan_number > 0)
);

REVOKE ALL ON idx.feed_scan_positions, idx.listing_scan_stamps FROM PUBLIC, idx_runtime;
