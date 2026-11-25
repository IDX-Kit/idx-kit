CREATE TABLE idx.inquiries (
  id text PRIMARY KEY CHECK (id ~ '^inq_[A-Za-z0-9_-]+$'),
  site_id text NOT NULL REFERENCES idx.sites,
  -- Keep the receipt usable even if its listing is removed later.
  listing_id text NOT NULL,
  visitor_name text NOT NULL,
  visitor_email text NOT NULL,
  message text NOT NULL,
  context jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idempotency_key text NOT NULL,
  body_hash text NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT inquiries_site_key UNIQUE (site_id, idempotency_key) NOT DEFERRABLE
);
GRANT SELECT, INSERT ON idx.inquiries TO idx_runtime;
