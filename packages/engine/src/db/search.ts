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

type SearchListingRow = Omit<ListingRow, "feed_blocks">;

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
  const bounded = c.minPrice !== null || c.maxPrice !== null;
  // Separate equality, strict price and null ranges keep each continuation seekable.
  const ranges =
    last?.price === null ? [] : last ? ["tie", "price"] : ["price"];
  if (!bounded) ranges.push("unpriced");
  if (!feeds.length || !ranges.length) return { feeds, rows: [] };

  // Give the planner the licensed feed IDs so it can start with a small feed.
  const values: unknown[] = [c.site, feeds.map((feed) => feed.id)];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const filters = ["l.entire_listing_display", "m.feed_id = ANY($2::text[])"];
  if (c.city !== null)
    filters.push(`lower(l.address->>'city') = ${bind(c.city)}`);
  if (c.minBedrooms !== null)
    filters.push(`l.bedrooms >= ${bind(c.minBedrooms)}::bigint`);
  if (bounded) filters.push("l.currency = 'USD'");
  if (c.minPrice !== null)
    filters.push(`l.price >= ${bind(c.minPrice)}::numeric`);
  if (c.maxPrice !== null)
    filters.push(`l.price <= ${bind(c.maxPrice)}::numeric`);
  const limit = `${bind(c.limit + 1)}::int`;
  const queries = ranges.map((range, index) => {
    const where = [...filters];
    if (range === "unpriced") {
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
        c.minBedrooms !== null && range !== "unpriced"
          ? "DESC"
          : "DESC NULLS LAST";
    }
    const seek = `${licensedListing} WHERE ${where.join(" AND ")}
      ORDER BY l.price ${direction}, l.id ASC LIMIT ${limit}`;
    if (index === 0) return seek;
    // Plan the seek with a fixed page size. The remaining limit can read
    // fewer rows from the CTE, or skip it if earlier ranges filled the page.
    const previous = ranges
      .slice(0, index)
      .map((name) => `(SELECT count(*) FROM ${name})`);
    return `WITH candidates AS MATERIALIZED (${seek})
      SELECT * FROM candidates
      LIMIT (${limit} - ${previous.join(" - ")})`;
  });
  let sql = queries[0];
  if (queries.length > 1) {
    const ctes = ranges.map(
      (range, index) => `${range} AS MATERIALIZED (${queries[index]})`,
    );
    const parts = ranges.map(
      (range, index) => `SELECT ${index} AS range_order, * FROM ${range}`,
    );
    sql = `WITH ${ctes.join(", ")}
      SELECT * FROM (${parts.join(" UNION ALL ")}) AS page
      ORDER BY range_order, price::numeric ${c.sort === "price" ? "ASC" : "DESC"}, id`;
  }
  const rows = await readQuery<SearchListingRow>(
    pool,
    sql,
    values,
    "search.listings",
  );
  return { feeds, rows };
}
