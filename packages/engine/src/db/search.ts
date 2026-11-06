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
    "search.feeds",
  );
  const rows: ListingRow[] = [];
  // Separate equality, strict price and null ranges keep each continuation seekable.
  const ranges =
    last?.price === null
      ? ["null"]
      : last
        ? ["tie", "price", "null"]
        : ["price", "null"];
  for (const range of ranges) {
    if (rows.length === c.limit + 1) break;
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
    if (range === "null") {
      where.push("l.price IS NULL");
      if (last?.price === null) where.push(`l.id > ${bind(last.id)}`);
    } else {
      where.push("l.price IS NOT NULL");
      if (last) {
        const price = bind(last.price);
        where.push(
          `l.price ${range === "tie" ? "=" : c.sort === "price" ? ">" : "<"} ${price}::numeric`,
        );
        if (range === "tie") where.push(`l.id > ${bind(last.id)}`);
      }
    }
    rows.push(
      ...(await readQuery<ListingRow>(
        pool,
        `${listingSelect} WHERE ${where.join(" AND ")}
      ORDER BY l.price ${c.sort === "price" ? "ASC" : "DESC"} NULLS LAST, l.id ASC LIMIT ${bind(c.limit + 1 - rows.length)}`,
        values,
        `search.${range}`,
      )),
    );
  }
  return { feeds, rows };
}
