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

export type FeedPositionRow = FeedPosition & { version: string | null };

export const feedPositionColumns = `p.version::text, p.next_link AS "nextLink",
  p.record_state AS "recordState", p.record_counts AS counts,
  to_char(p.completed_mark AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "completedMark",
  to_char(p.pending_mark AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "pendingMark"`;

export async function readFeedCheckpoint(
  client: pg.Client,
  feedId: string,
): Promise<FeedCheckpoint> {
  const { rows } = await client.query<FeedPositionRow>(
    `SELECT ${feedPositionColumns}
    FROM idx.feed_sync_positions p WHERE p.feed_id = $1`,
    [feedId],
  );
  return feedCheckpoint(rows[0]);
}

export function feedCheckpoint(row?: FeedPositionRow): FeedCheckpoint {
  const legacy = row?.nextLink && !row.counts;
  return {
    version: row?.version ? BigInt(row.version) : 0n,
    position: {
      completedMark: row?.completedMark ?? null,
      nextLink: legacy ? null : (row?.nextLink ?? null),
      pendingMark: legacy ? null : (row?.pendingMark ?? null),
      recordState: legacy ? "empty" : (row?.recordState ?? "empty"),
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
