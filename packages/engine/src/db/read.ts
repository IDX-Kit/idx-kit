import type pg from "pg";
import type { DisplayBlock, Listing } from "@idx-kit/client";
import { HttpProblem } from "../http/problem.ts";
import { inquiryQueries } from "./inquiries.ts";
import { searchListings } from "./search.ts";
import type { SearchQuery } from "../domain/search-query.ts";

export interface Database {
  query<T extends pg.QueryResultRow>(
    sql: string,
    values: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

interface SiteKey {
  site_id: string;
  scopes: string[];
  key_id?: string;
  retry_after?: number | null;
}

// The conflicting row can be newer than this statement's snapshot. Return its
// window from the upsert even when a refusal leaves both values unchanged.
const listingKey = `WITH matched_key AS (
  SELECT id, site_id, scopes, listing_request_limit
  FROM idx.site_secret_keys
  WHERE secret_hash = $1 AND revoked_at IS NULL
), charged AS (
  INSERT INTO idx.listing_request_windows AS budget (key_id, window_start, request_count)
  SELECT id, clock_timestamp(), 1
  FROM matched_key
  WHERE 'listings:read' = ANY(scopes)
  ON CONFLICT (key_id) DO UPDATE
  SET (window_start, request_count) = (
    SELECT CASE WHEN expired THEN checked_at ELSE budget.window_start END,
      CASE
        WHEN expired THEN 1
        WHEN budget.request_count < (SELECT listing_request_limit FROM matched_key)
          THEN budget.request_count + 1
        ELSE budget.request_count
      END
    FROM (SELECT clock_timestamp() AS checked_at) AS request
    CROSS JOIN LATERAL (
      SELECT checked_at >= budget.window_start + interval '60 seconds' AS expired
    ) AS timing
  )
  RETURNING key_id, CASE
    WHEN OLD.window_start = NEW.window_start AND OLD.request_count = NEW.request_count
      THEN LEAST(60, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
        NEW.window_start + interval '60 seconds' - clock_timestamp()
      )))))::integer
  END AS retry_after
)
SELECT site_id, scopes, charged.key_id, charged.retry_after
FROM matched_key LEFT JOIN charged ON charged.key_id = matched_key.id
WHERE NOT ('listings:read' = ANY(scopes)) OR charged.key_id IS NOT NULL`;

export interface ListingRow {
  id: string;
  synthetic: boolean;
  status: string | null;
  price: string | null;
  currency: string | null;
  address: Listing["address"];
  bedrooms: string | null;
  images: Listing["images"];
  withheld_fields: string[];
  display_blocks: DisplayBlock[];
  page_blocks: DisplayBlock[];
  feed_blocks: DisplayBlock[];
  source_updated_at: Date | null;
  ingested_at: Date;
  refreshed_at: Date;
  expires_at: Date;
  rules_version: string;
}

function unavailable(cause: unknown, operation: string) {
  return new HttpProblem(
    503,
    "service_unavailable",
    "The service is temporarily unavailable.",
    { cause, operation },
  );
}

export async function readQuery<T extends pg.QueryResultRow>(
  pool: Database,
  sql: string,
  values: unknown[],
  operation: string,
) {
  try {
    return (await pool.query<T>(sql, values)).rows;
  } catch (cause) {
    throw unavailable(cause, operation);
  }
}
export const listingSelect = `SELECT l.id, l.synthetic, l.status, l.price::text, l.currency,
  l.address, l.bedrooms::text, l.images, l.withheld_fields, l.display_blocks, l.page_blocks,
  l.source_updated_at, l.ingested_at, f.refreshed_at, f.expires_at, f.rules_version,
  f.display_blocks AS feed_blocks
  FROM idx.listings l`;

// The unique mapping and the site/feed license key give at most one row per listing.
export const licensedListing = `${listingSelect}
  JOIN idx.source_mappings m ON m.listing_id = l.id
  JOIN idx.feeds f ON f.id = m.feed_id
  JOIN idx.data_licenses d ON d.feed_id = m.feed_id AND d.site_id = $1`;
export function repository(
  pool: Database,
  connectSearch?: () => Promise<pg.PoolClient>,
) {
  const query = <T extends pg.QueryResultRow>(
    sql: string,
    values: unknown[],
    operation: string,
  ) => readQuery<T>(pool, sql, values, operation);
  return {
    ...inquiryQueries(pool),
    async search(query: SearchQuery) {
      const client = await connectSearch?.().catch((cause: unknown) => {
        throw unavailable(cause, "search.connect");
      });
      const db = client ?? pool;
      let discard = false;
      try {
        await readQuery(
          db,
          "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
          [],
          "search.begin",
        );
        const result = await searchListings(db, query);
        await readQuery(db, "COMMIT", [], "search.commit");
        return result;
      } catch (error) {
        try {
          await db.query("ROLLBACK", []);
        } catch {
          discard = true;
        }
        throw error;
      } finally {
        client?.release(discard);
      }
    },
    async key(hash: string, scope: string): Promise<SiteKey | undefined> {
      return (
        await query<SiteKey>(
          scope === "listings:read"
            ? listingKey
            : "SELECT site_id, scopes FROM idx.site_secret_keys WHERE secret_hash = $1 AND revoked_at IS NULL",
          [hash],
          "key.lookup",
        )
      )[0];
    },
    async listing(site: string, id: string): Promise<ListingRow | undefined> {
      return (
        await query<ListingRow>(
          `${listingSelect}
        JOIN LATERAL (
          SELECT f.* FROM idx.source_mappings m
          JOIN idx.feeds f ON f.id = m.feed_id
          JOIN idx.data_licenses d ON d.feed_id = f.id AND d.site_id = $1
          WHERE m.listing_id = l.id LIMIT 1
        ) f ON true
        WHERE l.id = $2 AND l.entire_listing_display`,
          [site, id],
          "listing.read",
        )
      )[0];
    },
  };
}
export type Repository = ReturnType<typeof repository>;
