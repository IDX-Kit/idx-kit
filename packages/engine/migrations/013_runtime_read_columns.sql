REVOKE SELECT ON idx.inquiries FROM idx_runtime;
-- Include lookup and conflict-target columns as well as receipt and replay values.
GRANT SELECT (id, site_id, received_at, idempotency_key, body_hash) ON idx.inquiries TO idx_runtime;

REVOKE SELECT ON idx.source_mappings FROM idx_runtime;
GRANT SELECT (feed_id, listing_id) ON idx.source_mappings TO idx_runtime;
