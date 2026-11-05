CREATE SCHEMA idx AUTHORIZATION CURRENT_USER;
REVOKE ALL ON SCHEMA idx FROM PUBLIC;
CREATE TABLE idx.feeds (
  id text PRIMARY KEY,
  refreshed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > refreshed_at),
  display_blocks jsonb NOT NULL,
  rules_version text NOT NULL
);
CREATE TABLE idx.sites (id text PRIMARY KEY);
CREATE TABLE idx.data_licenses (
  site_id text REFERENCES idx.sites NOT NULL,
  feed_id text REFERENCES idx.feeds NOT NULL,
  PRIMARY KEY (site_id, feed_id)
);
CREATE TABLE idx.site_secret_keys (
  id text PRIMARY KEY,
  site_id text REFERENCES idx.sites NOT NULL,
  secret_hash text NOT NULL UNIQUE CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0 AND
    scopes <@ ARRAY['listings:read', 'inquiries:read', 'inquiries:write']::text[]),
  revoked_at timestamptz
);
CREATE TABLE idx.listings (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]+$'),
  synthetic boolean NOT NULL,
  status text,
  price numeric CHECK (price >= 0),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  address jsonb,
  bedrooms bigint CHECK (bedrooms BETWEEN 0 AND 9007199254740991),
  images jsonb,
  withheld_fields text[] NOT NULL,
  entire_listing_display boolean NOT NULL,
  display_blocks jsonb NOT NULL,
  page_blocks jsonb NOT NULL,
  source_updated_at timestamptz,
  ingested_at timestamptz NOT NULL,
  CHECK ((price IS NULL) = (currency IS NULL))
);
CREATE TABLE idx.source_mappings (
  feed_id text REFERENCES idx.feeds NOT NULL,
  source_key text NOT NULL,
  listing_id text REFERENCES idx.listings NOT NULL UNIQUE,
  PRIMARY KEY (feed_id, source_key)
);
CREATE INDEX listings_price_id ON idx.listings (price, id);
CREATE INDEX listings_city ON idx.listings (lower(address->>'city'));
GRANT USAGE ON SCHEMA idx TO idx_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA idx TO idx_runtime;
