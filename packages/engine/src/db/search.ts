import type pg from "pg";
import type { DisplayBlock } from "@idx-kit/client";
import type { SearchQuery } from "../domain/search-query.ts";
import { listingSelect, readQuery } from "./read.ts";
import type { ListingRow } from "./read.ts";

export interface FeedRow {
  display_blocks: DisplayBlock[];
  ingested_at: Date;
  refreshed_at: Date;
  expires_at: Date;
  rules_version: string;
}
export async function searchListings(
  pool: pg.Pool,
  { context: c, last }: SearchQuery,
) {
  const feeds = await readQuery<FeedRow>(
    pool,
    `SELECT f.display_blocks, f.refreshed_at, f.expires_at, f.rules_version,
    COALESCE((SELECT min(l.ingested_at) FROM idx.listings l
      JOIN idx.source_mappings m ON m.listing_id = l.id WHERE m.feed_id = f.id), f.refreshed_at) AS ingested_at
    FROM idx.feeds f JOIN idx.data_licenses d ON d.feed_id = f.id
    WHERE d.site_id = $1 ORDER BY f.id`,
    [c.site],
  );
  const values: unknown[] = [c.site];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const where = ["l.entire_listing_display"];
  if (c.city !== null)
    where.push(`lower(l.address->>'city') = ${bind(c.city)}`);
  if (c.minBedrooms !== null)
    where.push(`l.bedrooms >= ${bind(c.minBedrooms)}::bigint`);
  if (c.minPrice !== null || c.maxPrice !== null)
    where.push("l.currency = 'USD'");
  if (c.minPrice !== null)
    where.push(`l.price >= ${bind(c.minPrice)}::numeric`);
  if (c.maxPrice !== null)
    where.push(`l.price <= ${bind(c.maxPrice)}::numeric`);
  if (last) {
    const id = bind(last.id);
    if (last.price === null) where.push(`(l.price IS NULL AND l.id > ${id})`);
    else {
      const price = bind(last.price);
      where.push(`(l.price ${c.sort === "price" ? ">" : "<"} ${price}::numeric OR
        (l.price = ${price}::numeric AND l.id > ${id}) OR l.price IS NULL)`);
    }
  }
  const rows = await readQuery<ListingRow>(
    pool,
    `${listingSelect} WHERE ${where.join(" AND ")}
    ORDER BY l.price ${c.sort === "price" ? "ASC" : "DESC"} NULLS LAST, l.id ASC LIMIT ${bind(c.limit + 1)}`,
    values,
  );
  return { feeds, rows };
}
