import type pg from "pg";
import { z } from "zod";
import {
  readScanCheckpoint,
  saveScanCheckpoint,
} from "../db/feed-scan-positions.ts";
import { allRejectedMessage, emptyCounts } from "../db/feed-sync-outcomes.ts";
import type { FeedNextStep, RecordCounts } from "../db/feed-sync-outcomes.ts";
import { FeedPositionChanged } from "../db/feed-sync-positions.ts";
import {
  applyListingPage,
  applyScanDisclosures,
  listingFeedTransaction,
} from "../db/listings.ts";
import { listingChangesFor, nextStepFor, readFeedPages } from "./pages.ts";
import type { StoppedRun, SyncFeed } from "./pages.ts";

type ScanFeed = SyncFeed &
  (
    | { removeMissing?: false; maxRemovals?: never }
    | { removeMissing: true; maxRemovals: number }
  );

type ScanOutcome =
  | { code: "complete" | "position_changed"; nextStep: { kind: "none" } }
  | { code: StoppedRun["code"]; nextStep: FeedNextStep }
  | { code: "invalid_removal_limit"; nextStep: { kind: "stop" } }
  | {
      code: "empty_scan";
      nextStep: { kind: "stop" };
      wouldRemove?: number;
      maxRemovals?: number;
    }
  | {
      code: "unreadable_keys";
      nextStep: { kind: "stop" };
      unreadableRecords: number;
    }
  | {
      code: "removal_limit_exceeded";
      nextStep: { kind: "stop" };
      wouldRemove: number;
      maxRemovals: number;
    };

type ScanResult = ScanOutcome & {
  pagesRead: number;
  recordsSeen: number;
  listingsRemoved: number;
  counts: RecordCounts;
  message?: string;
};

const removalLimit = z.int().nonnegative();

// Each run uses its own connected writer client.
export async function syncFullScan(
  client: pg.Client,
  feed: ScanFeed,
): Promise<ScanResult> {
  const { feedId, connector, disclosures } = feed;
  const maxRemovals = feed.removeMissing ? feed.maxRemovals : undefined;
  const progress = { pagesRead: 0, recordsSeen: 0, listingsRemoved: 0 };
  let counts = emptyCounts;
  function finish(outcome: ScanOutcome, traversed = false): ScanResult {
    return {
      ...progress,
      ...outcome,
      counts,
      ...(traversed &&
        counts.accepted === 0 &&
        counts.rejected > 0 && {
          message: allRejectedMessage,
        }),
    };
  }

  if (feed.removeMissing && !removalLimit.safeParse(maxRemovals).success) {
    return finish({
      code: "invalid_removal_limit",
      nextStep: { kind: "stop" },
    });
  }

  try {
    let checkpoint = await listingFeedTransaction(client, feedId, async () => {
      const start = await readScanCheckpoint(client, feedId);
      if (!start.active) {
        start.scanNumber += 1n;
        start.active = true;
        start.recordsSeen = 0;
        start.unreadableRecords = 0;
        start.counts = emptyCounts;
      }
      // Claim the continuation and apply the notices in the same transaction.
      await saveScanCheckpoint(client, feedId, start);
      await applyScanDisclosures(client, feedId, disclosures);
      return { ...start, version: start.version + 1n };
    });
    counts = checkpoint.counts ?? emptyCounts;
    const mapChanges = listingChangesFor(feed);
    let wouldRemove = 0;
    const outcome = await readFeedPages(
      connector,
      null,
      checkpoint.nextLink,
      async ({ records, nextLink }) => {
        progress.pagesRead += 1;
        progress.recordsSeen += records.length;
        const changes = mapChanges(records);
        const next = { ...checkpoint, active: nextLink !== null, nextLink };
        const page = await applyListingPage(
          client,
          feedId,
          changes,
          {
            authoritativeSnapshot: true,
            scan: { checkpoint: next, maxRemovals },
          },
        );
        if (!page.scanCheckpoint)
          throw new Error("Missing saved scan checkpoint");
        checkpoint = { ...page.scanCheckpoint, version: next.version + 1n };
        counts = page.counts;
        if (page.removal) {
          wouldRemove = page.removal.wouldRemove;
          progress.listingsRemoved = page.removal.listingsRemoved;
        }
      },
      async () => {
        const ended = {
          ...checkpoint,
          active: false,
          nextLink: null,
          counts: undefined,
        };
        await listingFeedTransaction(client, feedId, () =>
          saveScanCheckpoint(client, feedId, ended),
        );
      },
    );
    if (outcome.code !== "complete") {
      return finish({ code: outcome.code, nextStep: nextStepFor(outcome) });
    }
    if (checkpoint.recordsSeen === 0) {
      return finish({
        code: "empty_scan",
        nextStep: { kind: "stop" },
        ...(maxRemovals !== undefined && { wouldRemove, maxRemovals }),
      });
    }
    if (checkpoint.unreadableRecords > 0) {
      return finish(
        {
          code: "unreadable_keys",
          nextStep: { kind: "stop" },
          unreadableRecords: checkpoint.unreadableRecords,
        },
        true,
      );
    }
    if (maxRemovals !== undefined && wouldRemove > maxRemovals) {
      return finish(
        {
          code: "removal_limit_exceeded",
          nextStep: { kind: "stop" },
          wouldRemove,
          maxRemovals,
        },
        true,
      );
    }
    return finish({ code: "complete", nextStep: { kind: "none" } }, true);
  } catch (error) {
    if (error instanceof FeedPositionChanged) {
      return finish({
        code: "position_changed",
        nextStep: { kind: "none" },
      });
    }
    return finish({ code: "write_failed", nextStep: { kind: "retry" } });
  }
}
