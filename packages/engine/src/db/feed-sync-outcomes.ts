import type pg from "pg";

export type FeedNextStep =
  { kind: "retry"; afterSeconds?: number } | { kind: "stop" };

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
