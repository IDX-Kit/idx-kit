import type pg from "pg";

export type FeedNextStep =
  { kind: "retry"; afterSeconds?: number } | { kind: "stop" };

export async function readFeedState(client: pg.Client, feedId: string) {
  const { rows } = await client.query<{
    status: object;
    waitingSeconds: number | null;
  }>(
    `SELECT jsonb_build_object(
      'feedId', f.id, 'refreshedAt', f.refreshed_at, 'expiresAt', f.expires_at,
      'completedMark', to_char(p.completed_mark AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'incrementalInProgress', p.next_link IS NOT NULL,
      'scanNumber', s.scan_number::text, 'scanInProgress', COALESCE(s.active, false),
      'recordsSeen', s.records_seen, 'unreadableRecords', s.unreadable_records,
      'lastOutcome', CASE WHEN o.feed_id IS NOT NULL THEN jsonb_build_object(
        'code', o.code, 'httpStatus', o.http_status, 'nextStep', o.next_step,
        'retrySeconds', o.retry_after_seconds, 'savedAt', o.saved_at
      ) END
    ) AS status,
    CASE WHEN o.next_step = 'retry' AND o.retry_after_seconds IS NOT NULL THEN
      GREATEST(0, CEIL(o.retry_after_seconds + EXTRACT(EPOCH FROM (o.saved_at - statement_timestamp()))))::integer
    END AS "waitingSeconds"
    FROM idx.feeds f
    LEFT JOIN idx.feed_sync_positions p ON p.feed_id = f.id
    LEFT JOIN idx.feed_scan_positions s ON s.feed_id = f.id
    LEFT JOIN idx.feed_sync_outcomes o ON o.feed_id = f.id
    WHERE f.id = $1`,
    [feedId],
  );
  return rows[0];
}

export async function saveFeedOutcome(
  client: pg.Client,
  feedId: string,
  version: bigint,
  { code, status }: { code: string; status?: number },
  nextStep: FeedNextStep | null,
) {
  const step = nextStep?.kind ?? null;
  const seconds =
    nextStep?.kind === "retry" ? (nextStep.afterSeconds ?? null) : null;
  // A completion produced its version, so any stop at that version came later.
  await client.query(
    `INSERT INTO idx.feed_sync_outcomes AS outcomes
      (feed_id, position_version, code, http_status, next_step, retry_after_seconds, saved_at)
    VALUES ($1, $2, $3, $4, $5, $6, statement_timestamp())
    ON CONFLICT (feed_id) DO UPDATE SET position_version = EXCLUDED.position_version,
      code = EXCLUDED.code, http_status = EXCLUDED.http_status, next_step = EXCLUDED.next_step,
      retry_after_seconds = EXCLUDED.retry_after_seconds, saved_at = EXCLUDED.saved_at
    WHERE outcomes.position_version < EXCLUDED.position_version
       OR (outcomes.position_version = EXCLUDED.position_version AND EXCLUDED.code <> 'complete')`,
    [feedId, version.toString(), code, status ?? null, step, seconds],
  );
}
