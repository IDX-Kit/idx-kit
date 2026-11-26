-- A source identity survives removal of the public listing and its facts.
ALTER TABLE idx.source_mappings
  ADD COLUMN source_revision timestamptz,
  DROP CONSTRAINT source_mappings_listing_id_fkey;

UPDATE idx.source_mappings m
SET source_revision = l.source_updated_at
FROM idx.listings l
WHERE l.id = m.listing_id AND l.source_updated_at IS NOT NULL;

DELETE FROM idx.listings WHERE NOT entire_listing_display;

UPDATE idx.feeds f SET oldest_listing_ingested_at = (
  SELECT min(l.ingested_at) FROM idx.source_mappings m
  JOIN idx.listings l ON l.id = m.listing_id WHERE m.feed_id = f.id
);
