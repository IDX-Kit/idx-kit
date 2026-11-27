import type pg from "pg";
import { z } from "zod";
import {
  readScanCheckpoint,
  saveScanCheckpoint,
  saveScanReport,
} from "../db/feed-scan-positions.ts";
import { allRejectedMessage, emptyCounts } from "../db/feed-sync-outcomes.ts";
import type { FeedNextStep, RecordCounts } from "../db/feed-sync-outcomes.ts";
import { FeedPositionChanged } from "../db/feed-sync-positions.ts";
import { applyListingPage, listingFeedTransaction } from "../db/listings.ts";
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
  outcomeSaved?: false;
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
  let version: bigint | undefined;
  async function finish(outcome: ScanOutcome, traversed = false): Promise<ScanResult> {
    const result = {
      ...progress,
      ...outcome,
      counts,
      ...(traversed && counts.accepted === 0 && counts.rejected > 0 && {
        message: allRejectedMessage,
      }),
    };
    if (version === undefined || outcome.code === "position_changed") return result;
    try {
      await saveScanReport(client, feedId, version, counts);
    } catch {
      return { ...result, outcomeSaved: false };
    }
    return result;
  }

  if (feed.removeMissing && !removalLimit.safeParse(maxRemovals).success) {
    return finish({
      code: "invalid_removal_limit",
      nextStep: { kind: "stop" },
    });
  }

  try {
    let checkpoint = await readScanCheckpoint(client, feedId);
    if (!checkpoint.active) {
      checkpoint.scanNumber += 1n;
      checkpoint.active = true;
      checkpoint.recordsSeen = 0;
      checkpoint.unreadableRecords = 0;
      checkpoint.counts = emptyCounts;
      await listingFeedTransaction(client, feedId, () =>
        saveScanCheckpoint(client, feedId, checkpoint),
      );
      checkpoint.version += 1n;
    }
    counts = checkpoint.counts ?? emptyCounts;
    version = checkpoint.version;
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
          disclosures,
          {
            authoritativeSnapshot: true,
            scan: { checkpoint: next, maxRemovals },
          },
        );
        if (!page.scanCheckpoint) throw new Error("Missing saved scan checkpoint");
        checkpoint = { ...page.scanCheckpoint, version: next.version + 1n };
        counts = page.counts;
        version = checkpoint.version;
        if (page.removal) {
          wouldRemove = page.removal.wouldRemove;
          progress.listingsRemoved = page.removal.listingsRemoved;
        }
      },
      async () => {
        const ended = { ...checkpoint, active: false, nextLink: null, counts: undefined };
        await listingFeedTransaction(client, feedId, () =>
          saveScanCheckpoint(client, feedId, ended),
        );
        version = checkpoint.version + 1n;
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
      return finish({
        code: "unreadable_keys",
        nextStep: { kind: "stop" },
        unreadableRecords: checkpoint.unreadableRecords,
      }, true);
    }
    if (maxRemovals !== undefined && wouldRemove > maxRemovals) {
      return finish({
        code: "removal_limit_exceeded",
        nextStep: { kind: "stop" },
        wouldRemove,
        maxRemovals,
      }, true);
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
