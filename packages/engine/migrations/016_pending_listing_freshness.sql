-- Keep the public minimum conservative until the current traversal completes.
-- A pending value of -infinity means the old minimum was removed or replaced.
ALTER TABLE idx.feeds ADD COLUMN pending_listing_ingested_at timestamptz;

-- A previous writer may have left committed pages from an unfinished traversal.
WITH actual AS (
  SELECT m.feed_id, min(l.ingested_at) AS ingested_at
  FROM idx.source_mappings m JOIN idx.listings l ON l.id = m.listing_id
  WHERE l.entire_listing_display
  GROUP BY m.feed_id
)
UPDATE idx.feeds f
SET pending_listing_ingested_at = COALESCE(actual.ingested_at, '-infinity')
FROM idx.feeds previous LEFT JOIN actual ON actual.feed_id = previous.id
WHERE f.id = previous.id
  AND f.oldest_listing_ingested_at IS DISTINCT FROM actual.ingested_at;
