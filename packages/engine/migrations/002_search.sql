CREATE INDEX listings_price_desc_id ON idx.listings (price DESC NULLS LAST, id ASC)
  WHERE entire_listing_display;
