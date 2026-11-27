UPDATE idx.listings
SET images = '[]'::jsonb
WHERE 'address' = ANY(withheld_fields)
  AND NOT ('images' = ANY(withheld_fields))
  AND images IS DISTINCT FROM '[]'::jsonb;
