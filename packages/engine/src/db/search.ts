import type { DisplayBlock } from "@idx-kit/client";
import type { SearchQuery } from "../domain/search-query.ts";
import { licensedListing, readQuery } from "./read.ts";
import type { Database, ListingRow } from "./read.ts";

export interface FeedRow {
  id: string;
  display_blocks: DisplayBlock[];
  ingested_at: Date;
  refreshed_at: Date;
  expires_at: Date;
  rules_version: string;
}
export async function searchListings(
  pool: Database,
  { context: c, last }: SearchQuery,
) {
  const feeds = await readQuery<FeedRow>(
    pool,
    `SELECT f.id, f.display_blocks, f.refreshed_at, f.expires_at, f.rules_version,
    COALESCE(f.oldest_listing_ingested_at, f.refreshed_at) AS ingested_at
    FROM idx.feeds f JOIN idx.data_licenses d ON d.feed_id = f.id
    WHERE d.site_id = $1 ORDER BY f.id`,
    [c.site],
    "search.feeds",
  );
  // Give the planner the licensed feed IDs so it can start with a small feed.
  // The query's license join still rechecks authorization for each range.
  const feedIds = feeds.map((feed) => feed.id);
  const rows: ListingRow[] = [];
  // Separate equality, strict price and null ranges keep each continuation seekable.
  const combined =
    process.env.IDX_TEST_SEARCH_VOLUME === "1" && last?.price != null;
  const ranges = combined
    ? ["combined"]
    : last?.price === null
      ? ["null"]
      : last
        ? ["tie", "price", "null"]
        : ["price", "null"];
  for (const range of ranges) {
    if (rows.length === c.limit + 1) break;
    const values: unknown[] = [c.site, feedIds];
    const bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const where = ["l.entire_listing_display", "m.feed_id = ANY($2::text[])"];
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
    if (range === "combined") {
      if (last?.price === null) {
        where.push("l.price IS NULL", `l.id > ${bind(last.id)}`);
      } else if (last) {
        const price = bind(last.price);
        const operator = c.sort === "price" ? ">" : "<";
        where.push(`(l.price IS NULL OR l.price ${operator} ${price}::numeric
          OR (l.price = ${price}::numeric AND l.id > ${bind(last.id)}))`);
      }
    } else if (range === "null") {
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
    // A non-null descending bedroom search can scan the price/bedroom index backward.
    let direction = "ASC NULLS LAST";
    if (c.sort === "-price") {
      direction =
        c.minBedrooms !== null && range !== "null" && !combined
          ? "DESC"
          : "DESC NULLS LAST";
    }
    rows.push(
      ...(await readQuery<ListingRow>(
        pool,
        `${licensedListing} WHERE ${where.join(" AND ")}
      ORDER BY l.price ${direction}, l.id ASC LIMIT ${bind(c.limit + 1 - rows.length)}`,
        values,
        `search.${range}`,
      )),
    );
  }
  return { feeds, rows };
}
