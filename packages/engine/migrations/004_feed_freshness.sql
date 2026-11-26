ALTER TABLE idx.feeds ADD COLUMN oldest_listing_ingested_at timestamptz;

UPDATE idx.feeds f
SET oldest_listing_ingested_at = oldest.ingested_at
FROM (
  SELECT m.feed_id, min(l.ingested_at) AS ingested_at
  FROM idx.source_mappings m JOIN idx.listings l ON l.id = m.listing_id
  GROUP BY m.feed_id
) oldest
WHERE f.id = oldest.feed_id;
