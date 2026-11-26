CREATE INDEX CONCURRENTLY listings_bedrooms ON idx.listings (bedrooms)
  WHERE entire_listing_display AND bedrooms IS NOT NULL;
