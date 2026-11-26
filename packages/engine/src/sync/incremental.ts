import type pg from "pg";
import { saveFeedOutcome } from "../db/feed-sync-outcomes.ts";
import type { FeedNextStep } from "../db/feed-sync-outcomes.ts";
import {
  FeedPositionChanged,
  readFeedCheckpoint,
  saveFeedCheckpoint,
} from "../db/feed-sync-positions.ts";
import type { FeedCheckpoint } from "../db/feed-sync-positions.ts";
import {
  applyListingPage,
  listingFeedTransaction,
  revisionKey,
} from "../db/listings.ts";
import { timestampSchema } from "../domain/normalize.ts";
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
  let outcome: Awaited<ReturnType<typeof readFeedPages>>;
  try {
    const current = await readFeedCheckpoint(client, feedId);
    checkpoint = current;
    const mapChanges = listingChangesFor(feed);
    outcome = await readFeedPages(
      connector,
      current.position.completedMark,
      current.position.nextLink,
      async (page) => {
        const changes = mapChanges(page.records);
        const { position } = current;
        const savedMark = position.pendingMark;
        let pendingMark = position.completedMark;
        if (
          savedMark !== null &&
          (pendingMark === null || savedMark > pendingMark)
        ) {
          pendingMark = savedMark;
        }
        for (const { revision } of changes) {
          const timestamp = timestampSchema.safeParse(revision);
          if (!timestamp.success) continue;
          const key = revisionKey(timestamp.data);
          if (key !== null && (pendingMark === null || key > pendingMark)) {
            pendingMark = key;
          }
        }
        const complete = page.nextLink === null;
        const next = {
          completedMark: complete ? pendingMark : position.completedMark,
          nextLink: page.nextLink,
          pendingMark: complete ? null : pendingMark,
        };
        await applyListingPage(client, feedId, changes, disclosures, {
          checkpoint: { position: next, version: current.version },
        });
        current.position = next;
        current.version += 1n;
      },
      async () => {
        const position = {
          ...current.position,
          nextLink: null,
          pendingMark: null,
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
      return { code: "position_changed", nextStep: { kind: "none" } } as const;
    }
    outcome = { code: "write_failed" };
  }
  if (outcome.code === "page_limit") {
    const nextStep: FeedNextStep = { kind: "retry" };
    return { code: "page_limit", nextStep } as const;
  }
  const result =
    outcome.code === "complete"
      ? ({ code: "complete" } as const)
      : { code: outcome.code, nextStep: nextStepFor(outcome) };
  if (!checkpoint) return { ...result, outcomeSaved: false } as const;
  try {
    const nextStep = result.code === "complete" ? null : result.nextStep;
    await saveFeedOutcome(
      client,
      feedId,
      checkpoint.version,
      outcome,
      nextStep,
    );
  } catch {
    return { ...result, outcomeSaved: false } as const;
  }
  return result;
}
