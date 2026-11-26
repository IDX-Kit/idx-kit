CREATE INDEX listings_price_bedrooms_id ON idx.listings (price, bedrooms, id)
  WHERE entire_listing_display AND bedrooms IS NOT NULL;
