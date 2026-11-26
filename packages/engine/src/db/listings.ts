import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { DisplayBlock, Listing } from "@idx-kit/client";
import {
  addressSchema,
  disclosureIds,
  disclosureSchema,
  genericPhotoAlt,
  normalize,
  sourceKeySchema,
  timestampSchema,
} from "../domain/normalize.ts";
import { addressProtection } from "../domain/withholding.ts";
import type {
  FixtureRecord,
  ListingRecord,
  NormalizedListing,
  WithheldField,
} from "../domain/normalize.ts";

export const listingPageLimit = 200;
// PostgreSQL stores this sentinel in the existing timestamp column. Source
// timestamps must be finite, so only the writer can mark order as unknown.
const orderUnknown = "infinity";

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

// Approved separately from records. These blocks contain feed or broker
// notices and assets and never incorporate facts or photos from a property.
export interface ListingPageDisclosures {
  approvedFeedBlocks: DisplayBlock[];
  approvedListingBlocks: DisplayBlock[];
  approvedPageBlocks: DisplayBlock[];
  requiredListingBlockIds: string[];
  requiredPageBlockIds: string[];
}

interface PageRow {
  source_key: string;
  revision: string | null;
  candidate: string;
  listing: NormalizedListing | null;
}

interface Stored {
  source_key: string;
  revision: string | null;
  withheld: WithheldField[] | null;
  address: Listing["address"];
}

interface Candidate extends PageRow {
  index: number;
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
  blocks?: DisplayBlock[],
) {
  await client.query(
    `UPDATE idx.feeds f SET oldest_listing_ingested_at = (
      SELECT min(l.ingested_at) FROM idx.source_mappings m
      JOIN idx.listings l ON l.id = m.listing_id
      WHERE m.feed_id = f.id AND l.entire_listing_display
    )${blocks ? ", display_blocks = $2::jsonb" : ""}
    WHERE f.id = ANY($1::text[])`,
    blocks ? [feedIds, JSON.stringify(blocks)] : [feedIds],
  );
}

async function writePage(client: pg.Client, feedId: string, rows: PageRow[]) {
  // Claim identities before touching facts. The feed lock holds the selected state.
  await client.query(
    `WITH incoming AS MATERIALIZED (
      SELECT source_key, revision, candidate, listing
      FROM jsonb_to_recordset($2::jsonb)
        AS (source_key text, revision timestamptz, candidate text, listing jsonb)
    ), accepted AS (
      INSERT INTO idx.source_mappings (feed_id, source_key, listing_id, source_revision)
      SELECT $1, source_key, candidate, revision FROM incoming
      ON CONFLICT (feed_id, source_key) DO UPDATE
      SET source_revision = EXCLUDED.source_revision
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
    SELECT count(*) FROM accepted`,
    [feedId, JSON.stringify(rows)],
  );
}

function revisionKey(value: string | null) {
  if (value === null) return null;
  const [time, fraction = ""] = value.slice(0, -1).split(".");
  const seconds = time.length === 16 ? time + ":00" : time;
  return `${seconds}.${fraction.padEnd(6, "0")}Z`;
}

async function readExisting(
  client: pg.Client,
  feedId: string,
  keys: string[],
  fixture = false,
) {
  const result = await client.query<Stored>(
    `SELECT m.source_key, l.address,
      CASE WHEN m.source_revision = '${orderUnknown}'::timestamptz THEN '${orderUnknown}'
        ELSE to_char(m.source_revision AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      END AS revision,
      CASE WHEN $3 OR l.entire_listing_display THEN l.withheld_fields END AS withheld
    FROM idx.source_mappings m LEFT JOIN idx.listings l ON l.id = m.listing_id
    WHERE m.feed_id = $1 AND m.source_key = ANY($2::text[])`,
    [feedId, keys, fixture],
  );
  return new Map(result.rows.map((row) => [row.source_key, row]));
}

function groupPage<T>(rows: readonly T[], sourceKey: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = sourceKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function validateNewKey(feedId: string, sourceKey: string, stored?: Stored) {
  // Existing keys have already fit the index. Leave headroom for new composite keys.
  const bytes = Buffer.byteLength(sourceKey);
  return (
    stored !== undefined ||
    (bytes <= 1024 && Buffer.byteLength(feedId) + bytes <= 2048)
  );
}

function selectChange(
  rows: Candidate[],
  stored: Stored | undefined,
  mode: "fixture" | "stream" | "snapshot",
) {
  const unknown = rows.find((row) => row.revision === orderUnknown);
  if (unknown) return unknown;
  const blocked = stored?.revision === orderUnknown;
  if (blocked && mode !== "snapshot") return;
  const previous = blocked ? undefined : stored;

  // Higher revisions win. Ties combine field restrictions, and a removal wins
  // a tie. Only a valid authoritative upsert clears an order-unknown tombstone.
  const revision = rows.reduce((latest, row) => {
    return row.revision !== null && (latest === null || row.revision > latest)
      ? row.revision
      : latest;
  }, previous?.revision ?? null);
  const latest = rows.filter((row) => row.revision === revision);
  const removal = latest.find((row) => row.listing === null);
  const sameRevision = previous !== undefined && previous.revision === revision;
  if (sameRevision && previous.withheld === null) return;
  if (removal) return blocked ? undefined : removal;

  const alive = latest.flatMap((row) => {
    return row.listing
      ? [{ row, listing: row.listing, text: JSON.stringify(row.listing) }]
      : [];
  });
  if (!alive.length) return;
  const fields = new Set<WithheldField>(
    sameRevision ? (previous.withheld ?? []) : [],
  );
  const before = fields.size;
  for (const { listing } of alive) {
    for (const field of listing.facts.withheldFields) fields.add(field);
  }
  if (sameRevision && fields.size === before && mode !== "fixture") return;

  const [winner] = alive.sort((a, b) => {
    const difference =
      b.listing.facts.withheldFields.length -
      a.listing.facts.withheldFields.length;
    return difference || (a.text < b.text ? -1 : Number(a.text > b.text));
  });
  const { facts } = winner.listing;
  for (const field of fields) facts[field] = null;
  facts.withheldFields = [...fields].sort();
  return winner.row;
}

// Seed already owns the transaction and locks. Equal revisions can refresh
// synthetic facts during reseeding, with tombstones still winning ties.
export async function writeFixturePages(
  client: pg.Client,
  feedId: string,
  records: FixtureRecord[],
) {
  for (let start = 0; start < records.length; start += listingPageLimit) {
    const candidates = records
      .slice(start, start + listingPageLimit)
      .map((record, index) => {
        if (
          record.synthetic !== true ||
          record.publicId.length > 128 ||
          !/^lst_[A-Za-z0-9_-]+$/.test(record.publicId)
        )
          throw new Error("Invalid fixture identity");
        const listing = normalize(record);
        return {
          index,
          source_key: record.source.ListingKey,
          revision: revisionKey(record.sourceUpdatedAt),
          candidate: record.publicId,
          listing: isRemoved(record.source, true) ? null : listing,
        };
      });
    const groups = groupPage(candidates, (row) => row.source_key);
    const existing = await readExisting(
      client,
      feedId,
      [...groups.keys()],
      true,
    );
    const rows: PageRow[] = [];
    for (const [key, changes] of groups) {
      const stored = existing.get(key);
      if (!validateNewKey(feedId, key, stored))
        throw new Error("Invalid source key");
      const selected = selectChange(changes, stored, "fixture");
      if (selected) rows.push(selected);
    }
    await writePage(client, feedId, rows);
  }
}

function disclosureResolver(blocks: DisplayBlock[], required: string[]) {
  const approved = new Map(
    disclosureSchema.parse(blocks).map((block) => [block.id, block]),
  );
  if (required.some((id) => !approved.has(id)))
    throw new Error("Required disclosure is not approved for this context");
  return (blocks: DisplayBlock[]) => {
    const ids = disclosureIds.parse(blocks).map(({ id }) => id);
    if (required.some((id) => !ids.includes(id)))
      throw new Error("Missing required disclosure");
    return ids.map((id) => {
      const block = approved.get(id);
      if (!block) throw new Error("Unapproved disclosure");
      return block;
    });
  };
}

export async function applyListingPage(
  client: pg.Client,
  feedId: string,
  changes: readonly ListingChange[],
  disclosures: ListingPageDisclosures,
  { authoritativeSnapshot = false }: { authoritativeSnapshot?: boolean } = {},
) {
  if (changes.length > listingPageLimit)
    throw new Error("Listing page too large");
  const feedBlocks = disclosureSchema
    .min(1)
    .parse(disclosures.approvedFeedBlocks);
  if (!disclosures.requiredListingBlockIds.length)
    throw new Error("Required listing disclosures must be configured");
  const listingBlocks = disclosureResolver(
    disclosures.approvedListingBlocks,
    disclosures.requiredListingBlockIds,
  );
  const pageBlocks = disclosureResolver(
    disclosures.approvedPageBlocks,
    disclosures.requiredPageBlockIds,
  );

  const rejected: { index: number; code: "invalid_key" | "invalid_change" }[] =
    [];
  const indexed = Array.from(changes, (change, index) => ({ change, index }));
  const groups = groupPage(indexed, ({ change }) => change?.sourceKey);
  await client.query("BEGIN");
  try {
    await lockListingFeeds(client, [feedId]);
    const keys = [...groups.keys()].filter(
      (key) => sourceKeySchema.safeParse(key).success,
    );
    const existing = await readExisting(client, feedId, keys);
    const rows: Candidate[] = [];
    for (const [key, group] of groups) {
      const stored = existing.get(key);
      if (
        !sourceKeySchema.safeParse(key).success ||
        !validateNewKey(feedId, key, stored)
      ) {
        for (const { index } of group)
          rejected.push({ index, code: "invalid_key" });
        continue;
      }
      const addresses = [stored?.address ?? null];
      const candidates = group.map(({ change, index }) => {
        const revision = timestampSchema.safeParse(change.revision);
        let listing: NormalizedListing | null = null;
        try {
          if (change.kind === "upsert") {
            const source = change.listing.source;
            const address = addressSchema.safeParse(source.Address);
            if (address.success) addresses.push(address.data);
            if (!revision.success) throw new Error("Invalid revision");
            if (!isRemoved(source, false)) {
              listing = normalize(
                {
                  ...change.listing,
                  source: { ...source, ListingKey: key },
                  blocks: listingBlocks(change.listing.blocks),
                  pageBlocks: pageBlocks(change.listing.pageBlocks),
                },
                true,
              );
            }
          } else if (
            !revision.success ||
            (change.kind !== "withdrawn" && change.kind !== "deleted")
          ) {
            throw new Error("Invalid removal");
          }
        } catch {
          rejected.push({ index, code: "invalid_change" });
        }
        return {
          index,
          source_key: key,
          revision: revision.success
            ? revisionKey(revision.data)
            : orderUnknown,
          candidate: `lst_${randomUUID()}`,
          listing,
        };
      });
      const selected = selectChange(
        candidates,
        stored,
        authoritativeSnapshot === true ? "snapshot" : "stream",
      );
      if (!selected) continue;
      const facts = selected.listing?.facts;
      if (facts?.images && facts.withheldFields.includes("address")) {
        const checks = addresses.map(addressProtection);
        facts.images = facts.images.flatMap(({ url }) => {
          try {
            for (const { checkReference } of checks) checkReference(url);
            return [{ url, alt: genericPhotoAlt }];
          } catch {
            return [];
          }
        });
      }
      rows.push(selected);
    }
    await writePage(client, feedId, rows);
    await updateListingFreshness(client, [feedId], feedBlocks);
    await client.query("COMMIT");
    const applied = new Set(rows.map((row) => row.index));
    return {
      rejected: rejected
        .sort((a, b) => a.index - b.index)
        .map((record) => ({
          ...record,
          hidden: applied.has(record.index),
        })),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
