import type pg from "pg";
import {
  allRejectedMessage,
  emptyCounts,
  readFeedState,
  saveFeedOutcome,
} from "../db/feed-sync-outcomes.ts";
import type { FeedNextStep, RecordCounts } from "../db/feed-sync-outcomes.ts";
import {
  FeedPositionChanged,
  readFeedCheckpoint,
  saveFeedCheckpoint,
} from "../db/feed-sync-positions.ts";
import type { FeedCheckpoint } from "../db/feed-sync-positions.ts";
import { applyListingPage, listingFeedTransaction } from "../db/listings.ts";
import { logLine } from "../log.ts";
import { listingChangesFor, nextStepFor, readFeedPages } from "./pages.ts";
import type { SyncFeed } from "./pages.ts";

export function reportSyncStep(result: {
  code: string;
  counts: RecordCounts;
  nextStep?: FeedNextStep | { kind: "none" };
  message?: string;
  outcomeSaved?: false;
}) {
  const output = {
    code: result.code,
    nextStep: result.nextStep ?? { kind: "none" },
    counts: result.counts,
    ...(result.message && { message: result.message }),
  };
  console.log(
    logLine({
      operation: "listing.sync",
      ...output,
      ...(result.outcomeSaved === false && { outcomeSaved: false }),
    }),
  );
  return output;
}

function completedRun(counts: RecordCounts) {
  return {
    code: "complete",
    counts,
    ...(counts.accepted === 0 &&
      counts.rejected > 0 && { message: allRejectedMessage }),
  } as const;
}

// Each run uses its own connected writer client.
export async function syncIncrementally(
  client: pg.Client,
  feed: SyncFeed,
  pageLimit?: number,
  stepId?: string,
) {
  if (
    pageLimit !== undefined &&
    (!Number.isInteger(pageLimit) || pageLimit < 1)
  ) {
    throw new RangeError("Page limit must be a whole number of one or more");
  }
  const { feedId, disclosures, connector } = feed;
  if (stepId !== undefined) {
    const state = await readFeedState(client, feedId, stepId);
    if (state?.finishedCounts) return completedRun(state.finishedCounts);
    if (!state || state.status.lastOutcome?.nextStep === "stop") {
      return {
        code: state ? "stopped" : "missing_feed",
        nextStep: { kind: "stop" },
        counts: emptyCounts,
      } as const;
    }
    if (state.waitingSeconds) {
      return {
        code: "waiting",
        nextStep: { kind: "retry", afterSeconds: state.waitingSeconds },
        counts: emptyCounts,
      } as const;
    }
  }
  let checkpoint: FeedCheckpoint | undefined;
  let counts = emptyCounts;
  let writingFinalPage = false;
  let outcome: Awaited<ReturnType<typeof readFeedPages>>;
  try {
    const current = await readFeedCheckpoint(client, feedId);
    checkpoint = current;
    counts = current.position.counts ?? emptyCounts;
    const mapChanges = listingChangesFor(feed);
    outcome = await readFeedPages(
      connector,
      current.position.completedMark,
      current.position.nextLink,
      async ({ records, nextLink }) => {
        writingFinalPage = nextLink === null;
        const page = await applyListingPage(
          client,
          feedId,
          mapChanges(records),
          disclosures,
          { incremental: { checkpoint: current, nextLink, stepId } },
        );
        if (!page.savedPosition) throw new Error("Missing saved feed position");
        counts = page.counts;
        current.position = page.savedPosition;
        current.version += 1n;
      },
      async (rejected) => {
        const position = {
          ...current.position,
          nextLink: null,
          pendingMark: null,
          recordState: "empty" as const,
          counts: undefined,
        };
        await listingFeedTransaction(client, feedId, async () => {
          await saveFeedCheckpoint(client, feedId, { ...current, position });
          await saveFeedOutcome(
            client,
            feedId,
            current.version + 1n,
            rejected,
            nextStepFor(rejected),
            counts,
          );
        });
      },
      pageLimit,
    );
  } catch (error) {
    if (error instanceof FeedPositionChanged) {
      return {
        code: "position_changed",
        nextStep: { kind: "none" },
        counts,
      } as const;
    }
    // A Workflow retry can read the committed report if the final reply was lost.
    if (stepId !== undefined && writingFinalPage) throw error;
    outcome = { code: "write_failed" };
  }
  if (outcome.code === "page_limit") {
    const nextStep: FeedNextStep = { kind: "retry" };
    return { code: "page_limit", nextStep, counts } as const;
  }
  if (outcome.code === "complete") return completedRun(counts);
  const result = { code: outcome.code, nextStep: nextStepFor(outcome), counts };
  if (outcome.code === "continuation_rejected") return result;
  if (!checkpoint) return { ...result, outcomeSaved: false } as const;
  try {
    await saveFeedOutcome(
      client,
      feedId,
      checkpoint.version,
      outcome,
      result.nextStep,
    );
  } catch {
    return { ...result, outcomeSaved: false } as const;
  }
  return result;
}
