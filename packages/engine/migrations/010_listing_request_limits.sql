ALTER TABLE idx.site_secret_keys
  ADD COLUMN listing_request_limit integer NOT NULL DEFAULT 60 CHECK (listing_request_limit >= 1);

CREATE TABLE idx.listing_request_windows (
  key_id text PRIMARY KEY REFERENCES idx.site_secret_keys ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 1)
);

GRANT SELECT, INSERT ON idx.listing_request_windows TO idx_runtime;
GRANT UPDATE (window_start, request_count) ON idx.listing_request_windows TO idx_runtime;
