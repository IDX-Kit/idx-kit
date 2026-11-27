import type pg from "pg";
import type { RecordCounts } from "./feed-sync-outcomes.ts";

interface FeedPosition {
  completedMark: string | null;
  nextLink: string | null;
  pendingMark: string | null;
  recordState: "empty" | "rejected" | "accepted";
  counts?: RecordCounts;
}

export interface FeedCheckpoint {
  position: FeedPosition;
  version: bigint;
}

export class FeedPositionChanged extends Error {}

export async function readFeedCheckpoint(
  client: pg.Client,
  feedId: string,
): Promise<FeedCheckpoint> {
  const { rows } = await client.query<FeedPosition & { version: string }>(
    `SELECT version::text, next_link AS "nextLink", record_state AS "recordState", record_counts AS counts,
      to_char(completed_mark AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "completedMark",
      to_char(pending_mark AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "pendingMark"
    FROM idx.feed_sync_positions WHERE feed_id = $1`,
    [feedId],
  );
  const row = rows[0];
  return {
    version: row ? BigInt(row.version) : 0n,
    position: {
      completedMark: row?.completedMark ?? null,
      nextLink: row?.nextLink ?? null,
      pendingMark: row?.pendingMark ?? null,
      recordState: row?.recordState ?? "empty",
      ...(row?.counts && { counts: row.counts }),
    },
  };
}

// The caller holds the listing writer's per-feed lock inside its transaction.
export async function saveFeedCheckpoint(
  client: pg.Client,
  feedId: string,
  { position, version }: FeedCheckpoint,
) {
  const values = [
    feedId,
    version.toString(),
    position.completedMark,
    position.nextLink,
    position.pendingMark,
    position.recordState,
    position.counts ?? null,
  ];
  const sql =
    version === 0n
      ? `INSERT INTO idx.feed_sync_positions
          (feed_id, version, completed_mark, next_link, pending_mark, record_state, record_counts)
        VALUES ($1, $2::bigint + 1, $3, $4, $5, $6, $7)
        ON CONFLICT (feed_id) DO NOTHING`
      : `UPDATE idx.feed_sync_positions SET version = version + 1,
          completed_mark = $3, next_link = $4, pending_mark = $5, record_state = $6, record_counts = $7
        WHERE feed_id = $1 AND version = $2`;
  const result = await client.query(sql, values);
  if (!result.rowCount) throw new FeedPositionChanged();
}
