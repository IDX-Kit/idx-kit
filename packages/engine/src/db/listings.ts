import type pg from "pg";
import type { DisplayBlock } from "@idx-kit/client";
import {
  listingDisclosures,
  listingStatus,
  normalize,
  sourceKeySchema,
  timestampSchema,
} from "../domain/normalize.ts";
import type {
  FixtureRecord,
  ListingRecord,
  NormalizedListing,
  WithheldField,
} from "../domain/normalize.ts";
import { emptyCounts, saveFeedOutcome } from "./feed-sync-outcomes.ts";
import type { RecordCounts, RejectionCode } from "./feed-sync-outcomes.ts";
import { saveFeedCheckpoint } from "./feed-sync-positions.ts";
import type { FeedCheckpoint } from "./feed-sync-positions.ts";
import { saveScanCheckpoint, stampScanKeys } from "./feed-scan-positions.ts";
import type { ScanCheckpoint } from "./feed-scan-positions.ts";

export const listingPageLimit = 200;
const clockSkewAllowanceMs = 5 * 60 * 1000;
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
      listing: Omit<
        ListingRecord,
        "source" | "ingestedAt" | "blocks" | "pageBlocks"
      > & {
        ingestedAt: string | null;
        source: ListingChangeSource;
      };
    }
);

// Approved separately from records. These blocks contain feed or broker
// notices and assets and never incorporate facts or photos from a property.
export interface ListingPageDisclosures {
  approvedFeedBlocks: DisplayBlock[];
  approvedListingBlocks: DisplayBlock[];
  approvedPageBlocks?: DisplayBlock[];
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
}

interface Candidate extends PageRow {
  index: number;
}

function isRemoved(source: ListingChangeSource, fixture: boolean) {
  return (
    source.InternetEntireListingDisplayYN === false ||
    listingStatus(source.StandardStatus, fixture).removed
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

export async function listingFeedTransaction<T>(
  client: pg.Client,
  feedId: string,
  write: () => Promise<T>,
) {
  await client.query("BEGIN");
  try {
    await lockListingFeeds(client, [feedId]);
    const result = await write();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function applyScanDisclosures(
  client: pg.Client,
  feedId: string,
  disclosures: ListingPageDisclosures,
) {
  const applied = JSON.stringify(validatedDisclosures(disclosures));
  const { rows } = await client.query<{ changed: boolean }>(
    `SELECT applied_disclosures IS DISTINCT FROM $2::jsonb AS changed
    FROM idx.feeds WHERE id = $1`,
    [feedId, applied],
  );
  if (!rows.length) throw new Error("Missing feed");
  if (rows[0].changed) await writeAppliedDisclosures(client, feedId, applied);
}

function validatedDisclosures(disclosures: ListingPageDisclosures) {
  const { approvedPageBlocks = [], ...blocks } =
    listingDisclosures.parse(disclosures);
  return { ...blocks, approvedPageBlocks };
}
type AppliedDisclosures = ReturnType<typeof validatedDisclosures>;

// The caller holds the feed lock. Update the public copies with the configuration.
async function writeAppliedDisclosures(
  client: pg.Client,
  feedId: string,
  disclosures: string,
) {
  await client.query(
    `WITH feed_notice AS (
      UPDATE idx.feeds SET applied_disclosures = $2::jsonb,
        display_blocks = $2::jsonb->'approvedFeedBlocks' WHERE id = $1
    )
    UPDATE idx.listings l SET display_blocks = $2::jsonb->'approvedListingBlocks',
      page_blocks = $2::jsonb->'approvedPageBlocks'
    FROM idx.source_mappings m
    WHERE m.feed_id = $1 AND m.listing_id = l.id`,
    [feedId, disclosures],
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
    )
    WHERE f.id = ANY($1::text[])`,
    [feedIds],
  );
}

const deleteListings = `DELETE FROM idx.listings l USING changes c
  WHERE l.id = c.listing_id AND c.listing IS NULL`;

async function writePage(client: pg.Client, feedId: string, rows: PageRow[]) {
  if (!rows.length) return;
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
      ${deleteListings}
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
        (listing->>'sourceUpdatedAt')::timestamptz,
        COALESCE((listing->>'ingestedAt')::timestamptz, statement_timestamp())
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

async function removeMissingListings(
  client: pg.Client,
  feedId: string,
  scanNumber: bigint,
  maxRemovals: number | null,
) {
  // Absence withdraws at the stored revision. Keep the mapping and revision
  // as the tombstone, just as for an explicit withdrawal at that revision.
  // A null limit counts missing listings without withdrawing them.
  const { rows } = await client.query<{ missing: string; removed: string }>(
    `WITH missing AS MATERIALIZED (
      SELECT m.listing_id FROM idx.source_mappings m
      JOIN idx.listings l ON l.id = m.listing_id
      LEFT JOIN idx.listing_scan_stamps s ON s.listing_id = m.listing_id
      WHERE m.feed_id = $1 AND l.entire_listing_display
        AND s.scan_number IS DISTINCT FROM $2::bigint
    ), total AS (
      SELECT count(*) AS count FROM missing
    ), changes AS (
      SELECT listing_id, NULL::jsonb AS listing FROM missing, total
      WHERE total.count <= $3::bigint
    ), removed AS (
      ${deleteListings}
      RETURNING 1
    )
    SELECT total.count AS missing, (SELECT count(*) FROM removed) AS removed
    FROM total`,
    [feedId, scanNumber.toString(), maxRemovals],
  );
  return {
    wouldRemove: Number(rows[0].missing),
    listingsRemoved: Number(rows[0].removed),
  };
}

export function revisionKey(value: string | null) {
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
  // A reset or older checkpoint may have committed pages without counts.
  // A matching completion proves those pages were already accounted for.
  const unfinishedPoll = `EXISTS (
    SELECT 1 FROM idx.feed_sync_positions p
    LEFT JOIN idx.feed_sync_outcomes o ON o.feed_id = p.feed_id
      AND o.position_version = p.version AND o.code = 'complete'
    WHERE p.feed_id = $1 AND o.feed_id IS NULL
  )`;
  const { rows } = await client.query<
    | Stored
    | {
        source_key: null;
        applied_disclosures: AppliedDisclosures | null;
        unfinished_poll: boolean;
      }
  >(
    `${
      keys.length
        ? `SELECT m.source_key,
      CASE WHEN m.source_revision = '${orderUnknown}'::timestamptz THEN '${orderUnknown}'
        ELSE to_char(m.source_revision AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      END AS revision,
      CASE WHEN $3 OR l.entire_listing_display THEN l.withheld_fields END AS withheld,
      NULL::jsonb AS applied_disclosures, false AS unfinished_poll
    FROM idx.source_mappings m LEFT JOIN idx.listings l ON l.id = m.listing_id
    WHERE m.feed_id = $1 AND m.source_key = ANY($2::text[])
    UNION ALL`
        : ""
    }
    SELECT NULL AS source_key, NULL AS revision, NULL AS withheld, applied_disclosures,
      ${keys.length ? "false" : unfinishedPoll} AS unfinished_poll
    FROM idx.feeds WHERE id = $1`,
    keys.length ? [feedId, keys, fixture] : [feedId],
  );
  const existing = new Map<string, Stored>();
  let feed;
  for (const row of rows) {
    if (row.source_key === null) feed = row;
    else existing.set(row.source_key, row);
  }
  return { existing, feed };
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

  const alive = latest.flatMap((row) =>
    row.listing ? [{ row, listing: row.listing }] : [],
  );
  if (!alive.length) return;
  const fields = new Set<WithheldField>(
    sameRevision ? (previous.withheld ?? []) : [],
  );
  const before = fields.size;
  for (const { listing } of alive) {
    for (const field of listing.facts.withheldFields) fields.add(field);
  }
  if (sameRevision && fields.size === before && mode !== "fixture") return;

  let winner = alive[0];
  let winnerText: string | undefined;
  for (const candidate of alive.slice(1)) {
    const difference =
      candidate.listing.facts.withheldFields.length -
      winner.listing.facts.withheldFields.length;
    if (difference < 0) continue;
    let text: string | undefined;
    if (difference === 0) {
      text = JSON.stringify(candidate.listing);
      winnerText ??= JSON.stringify(winner.listing);
      if (text >= winnerText) continue;
    }
    winner = candidate;
    winnerText = text;
  }
  const { facts } = winner.listing;
  if (fields.has("address")) facts.images = [];
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
    const { existing } = await readExisting(
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

type PageOptions = {
  authoritativeSnapshot?: boolean;
  initialDisclosures?: ListingPageDisclosures;
} & (
  | {
      incremental?: {
        checkpoint: FeedCheckpoint;
        nextLink: string | null;
      };
      scan?: never;
    }
  | {
      incremental?: never;
      scan: { checkpoint: ScanCheckpoint; maxRemovals?: number };
    }
);

export async function applyListingPage(
  client: pg.Client,
  feedId: string,
  changes: readonly ListingChange[],
  {
    authoritativeSnapshot = false,
    initialDisclosures,
    incremental,
    scan,
  }: PageOptions = {},
) {
  if (changes.length > listingPageLimit)
    throw new Error("Listing page too large");
  const rejected: {
    index: number;
    code: RejectionCode;
  }[] = [];
  const indexed = Array.from(changes, (change, index) => ({ change, index }));
  const groups = groupPage(indexed, ({ change }) => change?.sourceKey);
  const previous = incremental?.checkpoint.position;
  const completedMark = previous?.completedMark ?? null;
  const latestAllowed = incremental
    ? revisionKey(new Date(Date.now() + clockSkewAllowanceMs).toISOString())
    : null;
  return listingFeedTransaction(client, feedId, async () => {
    let pendingMark = previous?.pendingMark ?? null;
    const keys = [...groups.keys()].filter(
      (key) => sourceKeySchema.safeParse(key).success,
    );
    const { existing, feed } = await readExisting(client, feedId, keys);
    let disclosures = feed?.applied_disclosures;
    if (!disclosures) {
      if (!initialDisclosures) throw new Error("Missing applied disclosures");
      disclosures = validatedDisclosures(initialDisclosures);
      await writeAppliedDisclosures(
        client,
        feedId,
        JSON.stringify(disclosures),
      );
    }
    const { approvedListingBlocks: blocks, approvedPageBlocks: pageBlocks } =
      disclosures;
    const rows: Candidate[] = [];
    const futureRemovals = new Map<string, number>();
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
      const candidates: Candidate[] = [];
      for (const { change, index } of group) {
        const timestamp = timestampSchema.safeParse(change.revision);
        const revision = timestamp.success ? revisionKey(timestamp.data) : null;
        if (latestAllowed && revision && revision > latestAllowed) {
          rejected.push({ index, code: "future_revision" });
          if (
            change.kind !== "upsert" ||
            isRemoved(change.listing.source, false)
          ) {
            futureRemovals.set(key, index);
          }
          continue;
        }
        if (latestAllowed && revision) {
          pendingMark ??= completedMark;
          if (pendingMark === null || revision > pendingMark)
            pendingMark = revision;
        }
        let listing: NormalizedListing | null = null;
        try {
          if (change.kind === "upsert") {
            const source = change.listing.source;
            if (revision === null) throw new Error("Invalid revision");
            if (!isRemoved(source, false)) {
              listing = normalize(
                {
                  ...change.listing,
                  source: { ...source, ListingKey: key },
                  blocks,
                  pageBlocks,
                },
                true,
              );
            }
          } else if (
            revision === null ||
            (change.kind !== "withdrawn" && change.kind !== "deleted")
          ) {
            throw new Error("Invalid removal");
          }
        } catch {
          rejected.push({ index, code: "invalid_change" });
        }
        candidates.push({
          index,
          source_key: key,
          revision: revision ?? orderUnknown,
          candidate: `lst_${crypto.randomUUID()}`,
          listing,
        });
      }
      if (candidates.length) futureRemovals.delete(key);
      const selected = selectChange(
        candidates,
        stored,
        authoritativeSnapshot === true ? "snapshot" : "stream",
      );
      if (!selected) continue;
      rows.push(selected);
    }
    const priorCounts =
      previous?.counts ?? scan?.checkpoint.counts ?? emptyCounts;
    const counts: RecordCounts = {
      accepted: priorCounts.accepted + changes.length - rejected.length,
      rejected: priorCounts.rejected + rejected.length,
      rejectedByCode: { ...priorCounts.rejectedByCode },
    };
    for (const { code } of rejected) {
      counts.rejectedByCode[code] = (counts.rejectedByCode[code] ?? 0) + 1;
    }
    const scanCheckpoint = scan && {
      ...scan.checkpoint,
      counts,
      recordsSeen: scan.checkpoint.recordsSeen + changes.length,
      unreadableRecords: counts.rejectedByCode.invalid_key ?? 0,
    };
    if (scanCheckpoint)
      await saveScanCheckpoint(client, feedId, scanCheckpoint);
    let savedPosition: FeedCheckpoint["position"] | undefined;
    let renewFreshness = false;
    const incrementalContinues = incremental?.nextLink != null;
    if (incremental) {
      let recordState: FeedCheckpoint["position"]["recordState"] = "empty";
      if (counts.accepted > 0) recordState = "accepted";
      else if (counts.rejected > 0) recordState = "rejected";
      savedPosition = {
        completedMark: incrementalContinues
          ? completedMark
          : (pendingMark ?? completedMark),
        nextLink: incremental.nextLink,
        pendingMark: incrementalContinues ? pendingMark : null,
        recordState: incrementalContinues ? recordState : "empty",
        ...(incrementalContinues && { counts }),
      };
      await saveFeedCheckpoint(client, feedId, {
        position: savedPosition,
        version: incremental.checkpoint.version,
      });
      renewFreshness = !incrementalContinues && recordState !== "rejected";
    }
    await writePage(client, feedId, rows);
    const applied = new Set(rows.map(({ index }) => index));
    if (futureRemovals.size) {
      const { rows: hidden } = await client.query<{ source_key: string }>(
        `DELETE FROM idx.listings l USING idx.source_mappings m
        WHERE l.id = m.listing_id AND m.feed_id = $1
          AND m.source_key = ANY($2::text[])
        RETURNING m.source_key`,
        [feedId, [...futureRemovals.keys()]],
      );
      for (const { source_key } of hidden)
        applied.add(futureRemovals.get(source_key)!);
    }
    if (keys.length)
      await stampScanKeys(client, feedId, keys, scan !== undefined);
    const removal =
      scan &&
      scanCheckpoint &&
      !scanCheckpoint.active &&
      scanCheckpoint.unreadableRecords === 0 &&
      scan.maxRemovals !== undefined
        ? await removeMissingListings(
            client,
            feedId,
            scanCheckpoint.scanNumber,
            scanCheckpoint.recordsSeen > 0 ? scan.maxRemovals : null,
          )
        : undefined;
    // Rejected records can also withdraw a listing. Carry both counts over
    // page boundaries, even when the final page contains no records.
    const mayHaveChanged =
      (!incremental && !scan) ||
      counts.accepted > 0 ||
      counts.rejected > 0 ||
      (scanCheckpoint?.recordsSeen ?? 0) > 0 ||
      (removal?.listingsRemoved ?? 0) > 0 ||
      feed?.unfinished_poll;
    if (mayHaveChanged && !incrementalContinues && !scanCheckpoint?.active)
      await updateListingFreshness(client, [feedId]);
    if (renewFreshness) {
      await client.query("SELECT idx.renew_feed_freshness($1)", [feedId]);
    }
    if (incremental && !incrementalContinues) {
      await saveFeedOutcome(
        client,
        feedId,
        incremental.checkpoint.version + 1n,
        { code: "complete" },
        null,
        counts,
      );
    }
    return {
      counts,
      ...(savedPosition && { savedPosition }),
      ...(scanCheckpoint && { scanCheckpoint }),
      ...(removal && { removal }),
      rejected: rejected
        .sort((a, b) => a.index - b.index)
        .map((record) => ({
          ...record,
          hidden: applied.has(record.index),
        })),
    };
  });
}
