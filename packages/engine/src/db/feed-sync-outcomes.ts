import type pg from "pg";

export type FeedNextStep =
  { kind: "retry"; afterSeconds?: number } | { kind: "stop" };

export type RejectionCode =
  "invalid_key" | "invalid_change" | "future_revision";

export type RecordCounts = {
  accepted: number;
  rejected: number;
  rejectedByCode: Partial<Record<RejectionCode, number>>;
};

export const emptyCounts: RecordCounts = {
  accepted: 0,
  rejected: 0,
  rejectedByCode: {},
};

export const allRejectedMessage =
  "Feed freshness stayed unchanged because no feed record could be used. Check the rejection codes.";

export async function readFeedState(
  client: pg.Client,
  feedId: string,
  stepId?: string,
) {
  const { rows } = await client.query<{
    status: {
      lastOutcome: { nextStep: "retry" | "stop" | null } | null;
      lastRun: { kind: "incremental" | "scan"; counts: RecordCounts } | null;
    };
    finishedCounts: RecordCounts | null;
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
      ) END,
      'lastRun', CASE
        WHEN s.last_report IS NULL OR
          (o.last_report->>'finishedAt')::timestamptz >= (s.last_report->>'finishedAt')::timestamptz
        THEN o.last_report - 'stepId' ELSE s.last_report END
    ) AS status,
    CASE WHEN o.last_report->>'stepId' = $2 THEN o.last_report->'counts' END AS "finishedCounts",
    CASE WHEN o.next_step = 'retry' AND o.retry_after_seconds IS NOT NULL THEN
      GREATEST(0, CEIL(o.retry_after_seconds + EXTRACT(EPOCH FROM (o.saved_at - statement_timestamp()))))::integer
    END AS "waitingSeconds"
    FROM idx.feeds f
    LEFT JOIN idx.feed_sync_positions p ON p.feed_id = f.id
    LEFT JOIN idx.feed_scan_positions s ON s.feed_id = f.id
    LEFT JOIN idx.feed_sync_outcomes o ON o.feed_id = f.id
    WHERE f.id = $1`,
    [feedId, stepId ?? null],
  );
  return rows[0];
}

export async function saveFeedOutcome(
  client: pg.Client,
  feedId: string,
  version: bigint,
  { code, status }: { code: string; status?: number },
  nextStep: FeedNextStep | null,
  counts?: RecordCounts,
  stepId?: string,
) {
  const step = nextStep?.kind ?? null;
  const seconds =
    nextStep?.kind === "retry" ? (nextStep.afterSeconds ?? null) : null;
  await client.query(
    `INSERT INTO idx.feed_sync_outcomes AS outcomes
      (feed_id, position_version, code, http_status, next_step, retry_after_seconds, saved_at, last_report)
    VALUES ($1, $2, $3, $4, $5, $6, statement_timestamp(), CASE WHEN $7::jsonb IS NOT NULL THEN
      jsonb_build_object('kind', 'incremental', 'finishedAt', statement_timestamp(), 'counts', $7::jsonb, 'stepId', $8::text) END)
    ON CONFLICT (feed_id) DO UPDATE SET position_version = EXCLUDED.position_version,
      code = EXCLUDED.code, http_status = EXCLUDED.http_status, next_step = EXCLUDED.next_step,
      retry_after_seconds = EXCLUDED.retry_after_seconds, saved_at = EXCLUDED.saved_at,
      last_report = COALESCE(EXCLUDED.last_report, outcomes.last_report)
    WHERE outcomes.position_version <= EXCLUDED.position_version`,
    [
      feedId,
      version.toString(),
      code,
      status ?? null,
      step,
      seconds,
      counts ?? null,
      stepId ?? null,
    ],
  );
}
