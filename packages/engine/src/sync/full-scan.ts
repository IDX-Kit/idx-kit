import type pg from "pg";
import { z } from "zod";
import {
  readScanCheckpoint,
  saveScanCheckpoint,
} from "../db/feed-scan-positions.ts";
import type { FeedNextStep } from "../db/feed-sync-outcomes.ts";
import { FeedPositionChanged } from "../db/feed-sync-positions.ts";
import { applyListingPage, listingFeedTransaction } from "../db/listings.ts";
import { listingChangesFor, nextStepFor, readFeedPages } from "./pages.ts";
import type { StoppedRun, SyncFeed } from "./pages.ts";

type ScanFeed = SyncFeed &
  (
    | { removeMissing?: false; maxRemovals?: never }
    | { removeMissing: true; maxRemovals: number }
  );

type ScanResult = {
  pagesRead: number;
  recordsSeen: number;
  listingsRemoved: number;
} & (
  | { code: "complete" | "position_changed"; nextStep: { kind: "none" } }
  | { code: StoppedRun["code"]; nextStep: FeedNextStep }
  | { code: "invalid_removal_limit"; nextStep: { kind: "stop" } }
  | {
      code: "removal_limit_exceeded";
      nextStep: { kind: "stop" };
      wouldRemove: number;
      maxRemovals: number;
    }
);

const removalLimit = z.int().nonnegative();

// Each run uses its own connected writer client. Counts cover this invocation.
export async function syncFullScan(
  client: pg.Client,
  feed: ScanFeed,
): Promise<ScanResult> {
  const { feedId, connector, disclosures } = feed;
  const maxRemovals = feed.removeMissing ? feed.maxRemovals : undefined;
  const counts = { pagesRead: 0, recordsSeen: 0, listingsRemoved: 0 };
  if (feed.removeMissing && !removalLimit.safeParse(maxRemovals).success) {
    return {
      ...counts,
      code: "invalid_removal_limit",
      nextStep: { kind: "stop" },
    };
  }

  try {
    let checkpoint = await readScanCheckpoint(client, feedId);
    if (!checkpoint.active) {
      checkpoint.scanNumber += 1n;
      checkpoint.active = true;
      await listingFeedTransaction(client, feedId, () =>
        saveScanCheckpoint(client, feedId, checkpoint),
      );
      checkpoint.version += 1n;
    }
    const mapChanges = listingChangesFor(feed);
    let wouldRemove = 0;
    const outcome = await readFeedPages(
      connector,
      null,
      checkpoint.nextLink,
      async ({ records, nextLink }) => {
        counts.pagesRead += 1;
        counts.recordsSeen += records.length;
        const { rows } = await client.query<{ ingestedAt: string }>(
          `SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "ingestedAt"`,
        );
        const changes = mapChanges(records, rows[0].ingestedAt);
        const next = { ...checkpoint, active: nextLink !== null, nextLink };
        const { removal } = await applyListingPage(
          client,
          feedId,
          changes,
          disclosures,
          {
            authoritativeSnapshot: true,
            scan: { checkpoint: next, maxRemovals },
          },
        );
        checkpoint = { ...next, version: next.version + 1n };
        if (removal) {
          wouldRemove = removal.wouldRemove;
          counts.listingsRemoved = removal.listingsRemoved;
        }
      },
      async () => {
        const ended = { ...checkpoint, active: false, nextLink: null };
        await listingFeedTransaction(client, feedId, () =>
          saveScanCheckpoint(client, feedId, ended),
        );
      },
    );
    if (outcome.code !== "complete") {
      return { ...counts, code: outcome.code, nextStep: nextStepFor(outcome) };
    }
    if (maxRemovals !== undefined && wouldRemove > maxRemovals) {
      return {
        ...counts,
        code: "removal_limit_exceeded",
        nextStep: { kind: "stop" },
        wouldRemove,
        maxRemovals,
      };
    }
    return { ...counts, code: "complete", nextStep: { kind: "none" } };
  } catch (error) {
    if (error instanceof FeedPositionChanged) {
      return {
        ...counts,
        code: "position_changed",
        nextStep: { kind: "none" },
      };
    }
    return { ...counts, code: "write_failed", nextStep: { kind: "retry" } };
  }
}
