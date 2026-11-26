import type pg from "pg";

interface FeedPosition {
  completedMark: string | null;
  nextLink: string | null;
  pendingMark: string | null;
}

export interface FeedCheckpoint {
  position: FeedPosition;
  version: bigint;
}

export type FeedNextStep =
  { kind: "retry"; afterSeconds?: number } | { kind: "stop" };

export class FeedPositionChanged extends Error {}

export async function readFeedCheckpoint(
  client: pg.Client,
  feedId: string,
): Promise<FeedCheckpoint> {
  const { rows } = await client.query<FeedPosition & { version: string }>(
    `SELECT version::text, next_link AS "nextLink",
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
  ];
  const updates = `version = positions.version + 1,
    completed_mark = $3, next_link = $4, pending_mark = $5`;
  const sql =
    version === 0n
      ? `INSERT INTO idx.feed_sync_positions AS positions
          (feed_id, version, completed_mark, next_link, pending_mark)
        VALUES ($1, $2::bigint + 1, $3, $4, $5)
        ON CONFLICT (feed_id) DO UPDATE SET ${updates}
        WHERE positions.version = $2`
      : `UPDATE idx.feed_sync_positions AS positions SET ${updates}
        WHERE feed_id = $1 AND version = $2`;
  const result = await client.query(sql, values);
  if (!result.rowCount) throw new FeedPositionChanged();
}

// A single statement commits the outcome separately from listing pages.
export async function saveFeedOutcome(
  client: pg.Client,
  feedId: string,
  version: bigint,
  { code, status }: { code: string; status?: number },
  nextStep: FeedNextStep | null,
) {
  const updates = `outcome_code = $3, outcome_http_status = $4,
    outcome_next_step = $5, outcome_retry_after_seconds = $6,
    consecutive_failures = CASE WHEN $3 = 'complete' THEN 0
      ELSE positions.consecutive_failures + 1 END,
    outcome_saved_at = statement_timestamp()`;
  const sql =
    version === 0n
      ? `INSERT INTO idx.feed_sync_positions AS positions
          (feed_id, version, outcome_code, outcome_http_status, outcome_next_step,
            outcome_retry_after_seconds, consecutive_failures, outcome_saved_at)
        VALUES ($1, $2, $3, $4, $5, $6, 1, statement_timestamp())
        ON CONFLICT (feed_id) DO UPDATE SET ${updates}
        WHERE positions.version = $2`
      : `UPDATE idx.feed_sync_positions AS positions SET ${updates}
        WHERE feed_id = $1 AND version = $2`;
  await client.query(sql, [
    feedId,
    version.toString(),
    code,
    status ?? null,
    nextStep?.kind ?? null,
    nextStep?.kind === "retry" ? (nextStep.afterSeconds ?? null) : null,
  ]);
}
