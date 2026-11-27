import type pg from "pg";
import {
  allRejectedMessage,
  emptyCounts,
  saveFeedOutcome,
} from "../db/feed-sync-outcomes.ts";
import type { FeedNextStep } from "../db/feed-sync-outcomes.ts";
import {
  FeedPositionChanged,
  readFeedCheckpoint,
  saveFeedCheckpoint,
} from "../db/feed-sync-positions.ts";
import type { FeedCheckpoint } from "../db/feed-sync-positions.ts";
import { applyListingPage, listingFeedTransaction } from "../db/listings.ts";
import { listingChangesFor, nextStepFor, readFeedPages } from "./pages.ts";
import type { SyncFeed } from "./pages.ts";

// Each run uses its own connected writer client.
export async function syncIncrementally(
  client: pg.Client,
  feed: SyncFeed,
  pageLimit?: number,
) {
  if (
    pageLimit !== undefined &&
    (!Number.isInteger(pageLimit) || pageLimit < 1)
  ) {
    throw new RangeError("Page limit must be a whole number of one or more");
  }
  const { feedId, disclosures, connector } = feed;
  let checkpoint: FeedCheckpoint | undefined;
  let counts = emptyCounts;
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
        const page = await applyListingPage(
          client,
          feedId,
          mapChanges(records),
          disclosures,
          { incremental: { checkpoint: current, nextLink } },
        );
        if (!page.savedPosition) throw new Error("Missing saved feed position");
        counts = page.counts;
        current.position = page.savedPosition;
        current.version += 1n;
      },
      async () => {
        const position = {
          ...current.position,
          nextLink: null,
          pendingMark: null,
          recordState: "empty" as const,
          counts: undefined,
        };
        await listingFeedTransaction(client, feedId, () =>
          saveFeedCheckpoint(client, feedId, { ...current, position }),
        );
        current.version += 1n;
      },
      pageLimit,
    );
  } catch (error) {
    if (error instanceof FeedPositionChanged) {
      return { code: "position_changed", nextStep: { kind: "none" }, counts } as const;
    }
    outcome = { code: "write_failed" };
  }
  if (outcome.code === "page_limit") {
    const nextStep: FeedNextStep = { kind: "retry" };
    return { code: "page_limit", nextStep, counts } as const;
  }
  const result =
    outcome.code === "complete"
      ? ({
          code: "complete",
          counts,
          ...(counts.accepted === 0 && counts.rejected > 0 && {
            message: allRejectedMessage,
          }),
        } as const)
      : { code: outcome.code, nextStep: nextStepFor(outcome), counts };
  if (!checkpoint) return { ...result, outcomeSaved: false } as const;
  try {
    const nextStep = result.code === "complete" ? null : result.nextStep;
    await saveFeedOutcome(
      client,
      feedId,
      checkpoint.version,
      outcome,
      nextStep,
      counts,
    );
  } catch {
    return { ...result, outcomeSaved: false } as const;
  }
  return result;
}
