CREATE FUNCTION idx.charge_listing_request(target_key text, request_limit integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog
AS $$
DECLARE
  window_end timestamptz;
  current_count integer;
  checked_at timestamptz;
BEGIN
  -- Serialize admission without locking the budget row on refusal. A volatile
  -- function reads a fresh snapshot after waiting for a concurrent charge.
  PERFORM pg_advisory_xact_lock(711004, hashtext(target_key));

  SELECT window_start + interval '60 seconds', request_count
  INTO window_end, current_count
  FROM idx.listing_request_windows
  WHERE key_id = target_key;
  checked_at := clock_timestamp();

  IF window_end IS NULL OR checked_at >= window_end THEN
    INSERT INTO idx.listing_request_windows (key_id, window_start, request_count)
    VALUES (target_key, checked_at, 1)
    ON CONFLICT (key_id) DO UPDATE
    SET window_start = EXCLUDED.window_start, request_count = 1;
  ELSIF current_count < request_limit THEN
    UPDATE idx.listing_request_windows
    SET request_count = request_count + 1
    WHERE key_id = target_key;
  ELSE
    RETURN LEAST(60, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (window_end - checked_at)))))::integer;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION idx.charge_listing_request(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION idx.charge_listing_request(text, integer) TO idx_runtime;
