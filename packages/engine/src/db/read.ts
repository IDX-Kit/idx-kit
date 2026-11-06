import type pg from "pg";
import type { DisplayBlock, Listing } from "@idx-kit/client";
import { HttpProblem } from "../http/problem.ts";
import { searchListings } from "./search.ts";
import type { SearchQuery } from "../domain/search-query.ts";

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
export async function readQuery<T extends pg.QueryResultRow>(
  pool: pg.Pool,
  sql: string,
  values: unknown[],
  operation: string,
) {
  try {
    return (await pool.query<T>(sql, values)).rows;
  } catch (cause) {
    throw new HttpProblem(
      503,
      "service_unavailable",
      "The service is temporarily unavailable.",
      { cause, operation },
    );
  }
}
export const listingSelect = `SELECT l.id, l.synthetic, l.status, l.price::text, l.currency,
  l.address, l.bedrooms::text, l.images, l.withheld_fields, l.display_blocks, l.page_blocks,
  l.source_updated_at, l.ingested_at, f.refreshed_at, f.expires_at, f.rules_version,
  f.display_blocks AS feed_blocks
  FROM idx.listings l JOIN idx.source_mappings m ON m.listing_id = l.id
  JOIN idx.feeds f ON f.id = m.feed_id
  JOIN idx.data_licenses d ON d.feed_id = f.id AND d.site_id = $1`;
export function repository(pool: pg.Pool) {
  const query = <T extends pg.QueryResultRow>(sql: string, values: unknown[], operation: string) =>
    readQuery<T>(pool, sql, values, operation);
  return {
    search: (query: SearchQuery) => searchListings(pool, query),
    async key(hash: string) {
      return (
        await query<{ site_id: string; scopes: string[] }>(
          "SELECT site_id, scopes FROM idx.site_secret_keys WHERE secret_hash = $1 AND revoked_at IS NULL",
          [hash],
          "key.lookup",
        )
      )[0];
    },
    async listing(site: string, id: string) {
      return (
        await query<ListingRow>(
          `${listingSelect}
        WHERE l.id = $2 AND l.entire_listing_display`,
          [site, id],
          "listing.read",
        )
      )[0];
    },
  };
}
export type Repository = ReturnType<typeof repository>;
