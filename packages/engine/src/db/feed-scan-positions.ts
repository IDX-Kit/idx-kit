import type pg from "pg";
import { FeedPositionChanged } from "./feed-sync-positions.ts";

export interface ScanCheckpoint {
  version: bigint;
  scanNumber: bigint;
  active: boolean;
  nextLink: string | null;
  recordsSeen: number;
  unreadableRecords: number;
}

export async function readScanCheckpoint(
  client: pg.Client,
  feedId: string,
): Promise<ScanCheckpoint> {
  const { rows } = await client.query<{
    version: string;
    scan_number: string;
    active: boolean;
    next_link: string | null;
    records_seen: string;
    unreadable_records: string;
  }>("SELECT * FROM idx.feed_scan_positions WHERE feed_id = $1", [feedId]);
  const row = rows[0];
  return {
    version: row ? BigInt(row.version) : 0n,
    scanNumber: row ? BigInt(row.scan_number) : 0n,
    active: row?.active ?? false,
    nextLink: row?.next_link ?? null,
    recordsSeen: row ? Number(row.records_seen) : 0,
    unreadableRecords: row ? Number(row.unreadable_records) : 0,
  };
}

// The caller holds the listing writer's per-feed lock inside its transaction.
export async function saveScanCheckpoint(
  client: pg.Client,
  feedId: string,
  checkpoint: ScanCheckpoint,
) {
  const { version, scanNumber, active, nextLink, recordsSeen, unreadableRecords } =
    checkpoint;
  const sql =
    version === 0n
      ? `INSERT INTO idx.feed_scan_positions
          (feed_id, version, scan_number, active, next_link, records_seen, unreadable_records)
        VALUES ($1, $2::bigint + 1, $3, $4, $5, $6, $7)
        ON CONFLICT (feed_id) DO NOTHING`
      : `UPDATE idx.feed_scan_positions SET version = version + 1,
          scan_number = $3, active = $4, next_link = $5,
          records_seen = $6, unreadable_records = $7
        WHERE feed_id = $1 AND version = $2`;
  const result = await client.query(sql, [
    feedId,
    version.toString(),
    scanNumber.toString(),
    active,
    nextLink,
    recordsSeen,
    unreadableRecords,
  ]);
  if (!result.rowCount) throw new FeedPositionChanged();
}

export async function stampScanKeys(
  client: pg.Client,
  feedId: string,
  keys: string[],
  scanPage: boolean,
) {
  // The final scan page has already saved its position as inactive.
  await client.query(
    `INSERT INTO idx.listing_scan_stamps AS stamps (listing_id, scan_number)
    SELECT m.listing_id, s.scan_number FROM idx.feed_scan_positions s
    JOIN idx.source_mappings m ON m.feed_id = s.feed_id
    WHERE s.feed_id = $1 AND m.source_key = ANY($2::text[])
      AND (s.active OR $3)
    ON CONFLICT (listing_id) DO UPDATE SET scan_number = EXCLUDED.scan_number
    WHERE stamps.scan_number <> EXCLUDED.scan_number`,
    [feedId, keys, scanPage],
  );
}
