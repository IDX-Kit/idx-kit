import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Listing } from "@idx-kit/client";
import {
  normalize,
  sourceKeySchema,
  timestampSchema,
} from "../domain/normalize.ts";
import type {
  FixtureRecord,
  ListingRecord,
  NormalizedListing,
} from "../domain/normalize.ts";

export const listingPageLimit = 200;

type ListingChangeSource = Omit<ListingRecord["source"], "ListingKey">;

export type ListingChange = {
  sourceKey: string;
  revision: string;
} & (
  | { kind: "withdrawn" | "deleted" }
  | {
      kind: "upsert";
      listing: Omit<ListingRecord, "source"> & {
        source: ListingChangeSource;
      };
    }
);

interface PageRow {
  record_index: number;
  source_key: string;
  revision: string | null;
  candidate: string;
  listing: NormalizedListing | null;
}

function isRemoved(source: ListingChangeSource, fixture: boolean) {
  const status =
    typeof source.StandardStatus === "string"
      ? source.StandardStatus.trim().toLowerCase()
      : null;
  return (
    source.InternetEntireListingDisplayYN === false ||
    status === "withdrawn" ||
    status === "deleted" ||
    (!fixture && (status === "closed" || status === "sold"))
  );
}

export async function lockListingFeeds(client: pg.Client, feedIds: string[]) {
  // Sort by the lock key so hash collisions also preserve the lock order.
  await client.query(
    `SELECT pg_advisory_xact_lock(711002, hashtext(feed_id))
    FROM unnest($1::text[]) AS feeds(feed_id)
    ORDER BY hashtext(feed_id)`,
    [feedIds],
  );
}

export async function updateListingFreshness(
  client: pg.Client,
  feedIds: string[],
) {
  await client.query(
    `UPDATE idx.feeds f SET oldest_listing_ingested_at = (
      SELECT min(l.ingested_at) FROM idx.source_mappings m
      JOIN idx.listings l ON l.id = m.listing_id
      WHERE m.feed_id = f.id AND l.entire_listing_display
    ) WHERE f.id = ANY($1::text[])`,
    [feedIds],
  );
}

async function writePage(
  client: pg.Client,
  feedId: string,
  rows: PageRow[],
  fixture: boolean,
) {
  // Claim identities before touching facts. Rank removals first at the same revision.
  const result = await client.query<{ record_index: number }>(
    `WITH incoming AS MATERIALIZED (
      SELECT DISTINCT ON (source_key) source_key, revision, candidate, listing, record_index
      FROM jsonb_to_recordset($2::jsonb)
        AS (source_key text, revision timestamptz, candidate text, listing jsonb, record_index int)
      ORDER BY source_key, revision DESC NULLS FIRST, (listing IS NULL) DESC, record_index DESC
    ), accepted AS (
      INSERT INTO idx.source_mappings AS m (feed_id, source_key, listing_id, source_revision)
      SELECT $1, source_key, candidate, revision FROM incoming
      ON CONFLICT (feed_id, source_key) DO UPDATE
      SET source_revision = COALESCE(EXCLUDED.source_revision, m.source_revision)
      WHERE EXCLUDED.source_revision > m.source_revision
        OR (m.source_revision IS NULL AND EXCLUDED.source_revision IS NOT NULL)
        OR (
          EXISTS (SELECT 1 FROM idx.listings WHERE id = m.listing_id)
          AND (
            ($3 AND EXCLUDED.source_revision IS NOT DISTINCT FROM m.source_revision)
            OR (
              (EXCLUDED.source_revision IS NULL OR EXCLUDED.source_revision = m.source_revision)
              AND EXISTS (
                SELECT 1 FROM incoming WHERE source_key = m.source_key AND listing IS NULL
              )
            )
          )
        )
      RETURNING source_key, listing_id
    ), changes AS (
      SELECT accepted.listing_id, incoming.listing
      FROM accepted JOIN incoming USING (source_key)
    ), removed AS (
      DELETE FROM idx.listings l USING changes c
      WHERE l.id = c.listing_id AND c.listing IS NULL
    ), stored AS (
      INSERT INTO idx.listings
        (id, synthetic, status, price, currency, address, bedrooms, images,
         withheld_fields, entire_listing_display, display_blocks, page_blocks,
         source_updated_at, ingested_at)
      SELECT listing_id, (facts->>'synthetic')::boolean, facts->>'status',
        (facts->'price'->>'amount')::numeric, facts->'price'->>'currency',
        NULLIF(facts->'address', 'null'::jsonb), (facts->>'bedrooms')::bigint,
        NULLIF(facts->'images', 'null'::jsonb),
        ARRAY(SELECT jsonb_array_elements_text(facts->'withheldFields')),
        true, listing->'blocks', listing->'pageBlocks',
        (listing->>'sourceUpdatedAt')::timestamptz, (listing->>'ingestedAt')::timestamptz
      FROM changes CROSS JOIN LATERAL (SELECT listing->'facts' AS facts) projected
      WHERE listing IS NOT NULL
      ON CONFLICT (id) DO UPDATE SET
        synthetic=EXCLUDED.synthetic, status=EXCLUDED.status, price=EXCLUDED.price,
        currency=EXCLUDED.currency, address=EXCLUDED.address, bedrooms=EXCLUDED.bedrooms,
        images=EXCLUDED.images, withheld_fields=EXCLUDED.withheld_fields,
        entire_listing_display=EXCLUDED.entire_listing_display,
        display_blocks=EXCLUDED.display_blocks, page_blocks=EXCLUDED.page_blocks,
        source_updated_at=EXCLUDED.source_updated_at, ingested_at=EXCLUDED.ingested_at
    )
    SELECT record_index FROM accepted JOIN incoming USING (source_key)`,
    [feedId, JSON.stringify(rows), fixture],
  );
  return new Set(result.rows.map((row) => row.record_index));
}

// Seed already owns the transaction and locks. Equal revisions can refresh
// synthetic facts during reseeding, with tombstones still winning ties.
export async function writeFixturePages(
  client: pg.Client,
  feedId: string,
  records: FixtureRecord[],
) {
  for (let start = 0; start < records.length; start += listingPageLimit) {
    const rows = records
      .slice(start, start + listingPageLimit)
      .map((record, index) => {
        if (
          record.synthetic !== true ||
          !/^lst_[A-Za-z0-9_-]+$/.test(record.publicId)
        )
          throw new Error("Invalid fixture identity");
        const listing = normalize(record);
        return {
          record_index: index,
          source_key: record.source.ListingKey,
          revision: record.sourceUpdatedAt,
          candidate: record.publicId,
          listing: isRemoved(record.source, true) ? null : listing,
        };
      });
    await writePage(client, feedId, rows, true);
  }
}

// Feed disclosures are configured independently of listing facts.
// The connector supplies UTC revisions and full replacements for visible listings.
export async function applyListingPage(
  client: pg.Client,
  feedId: string,
  changes: readonly ListingChange[],
) {
  if (changes.length > listingPageLimit)
    throw new Error("Listing page too large");
  const rejected: { index: number; code: "invalid_key" | "invalid_change" }[] = [];
  await client.query("BEGIN");
  try {
    await lockListingFeeds(client, [feedId]);
    const keys = changes
      .map((change) => change?.sourceKey)
      .filter((key) => sourceKeySchema.safeParse(key).success);
    const previous = await client.query<{
      source_key: string;
      address: Listing["address"];
    }>(
      `SELECT m.source_key, l.address FROM idx.source_mappings m
      JOIN idx.listings l ON l.id = m.listing_id
      WHERE m.feed_id = $1 AND m.source_key = ANY($2::text[])`,
      [feedId, keys],
    );
    const addresses = new Map(
      previous.rows.map((row) => [row.source_key, row.address]),
    );
    const rows: PageRow[] = [];
    for (const [index, change] of changes.entries()) {
      if (!sourceKeySchema.safeParse(change?.sourceKey).success) {
        rejected.push({ index, code: "invalid_key" });
        continue;
      }
      const revision = timestampSchema.safeParse(change.revision);
      let listing: NormalizedListing | null = null;
      try {
        if (!revision.success) throw new Error("Invalid revision");
        if (change.kind === "upsert") {
          const source = change.listing.source;
          if (!isRemoved(source, false)) {
            listing = normalize(
              {
                ...change.listing,
                source: { ...source, ListingKey: change.sourceKey },
              },
              addresses.get(change.sourceKey),
            );
          }
        } else if (change.kind !== "withdrawn" && change.kind !== "deleted") {
          throw new Error("Invalid change kind");
        }
      } catch {
        rejected.push({ index, code: "invalid_change" });
      }
      rows.push({
        record_index: index,
        source_key: change.sourceKey,
        revision: revision.success ? revision.data : null,
        candidate: `lst_${randomUUID()}`,
        listing,
      });
    }
    const accepted = await writePage(client, feedId, rows, false);
    await updateListingFreshness(client, [feedId]);
    await client.query("COMMIT");
    return {
      rejected: rejected.map((record) => ({
        ...record,
        hidden: accepted.has(record.index),
      })),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
